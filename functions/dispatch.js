'use strict';

/**
 * functions/dispatch.js — Realtime booking dispatch engine
 *
 * Implements Uber/Bolt-style sequential artisan matching:
 *
 *   1. Booking created  → initialise dispatch fields → run dispatchRound()
 *   2. dispatchRound()  → find best eligible artisan → notify them → set deadline
 *   3. Artisan rejects  → log rejection → run dispatchRound() immediately
 *   4. Deadline expires → log timeout  → run dispatchRound() (scheduler every 1 min)
 *   5. No artisans left → mark unfulfilled → notify customer
 *   6. Artisan accepts  → Firestore rules handle it; bookings.js sends customer notif
 *   7. Step 1 never ran, or a round stalled → the same scheduler rescues it
 *      (rescueStalledBookings); claimForDispatch keeps it to one round
 *
 * Timeout constants: STANDARD_TIMEOUT_S, EMERGENCY_TIMEOUT_S and
 * SCHEDULED_TIMEOUT_S below (the offer notification quotes them).
 *
 * Race-condition safety:
 *   dispatchRound() runs inside a Firestore transaction. Only one round can be
 *   active at a time (locked by dispatchStatus == 'dispatched'). Concurrent
 *   triggers that arrive before a round completes are silently dropped.
 */

const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onSchedule }    = require('firebase-functions/v2/scheduler');
const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { FIRESTORE_DB_ID, FUNCTIONS_REGION, MAX_DISPATCH_ROUNDS, BURST_CPU } = require('./config');
const { sendNotification, sendArtisanNotification } = require('./notifications');
const { geohashQueryBounds } = require('geofire-common');
const jobOffers = require('./jobOffers');
const performanceMetrics = require('./shared/performanceMetrics');
// Generated mirror of shared/js/domain/bookingSchedule.js — see
// scripts/build-functions-shared.cjs. Dispatch asks it when a booking's
// appointment is, and when its search must end.
const bookingSchedule = require('./shared/bookingSchedule');

// How long ONE artisan holds a request before it moves to the next.
//
// Dispatch is sequential, so this value MULTIPLIES: with MAX_DISPATCH_ROUNDS at
// 10, the customer's worst case is 10x this. It was 3 hours, which meant a
// single unresponsive artisan could sit on a booking all afternoon and the
// ceiling before 'unfulfilled' was thirty hours — while the request screen told
// the customer it "usually takes a few minutes".
//
// 3 minutes is the balance: long enough for an artisan with their hands full to
// notice a push notification, short enough that the customer gets a real answer
// — including an honest "nobody is available" — in minutes rather than hours.
//
// Both values exceed the 60 s scheduler period, so checkExpiredDispatches always
// catches an expired deadline within one tick (no 90-second worst case).
const STANDARD_TIMEOUT_S  = 3 * 60;   // 3 minutes
const EMERGENCY_TIMEOUT_S = 65;       // ~1 minute — someone needs help now

// A BOOKED APPOINTMENT IS NOT A SUMMONS.
//
// The three-minute deadline above exists because a customer waiting for help
// now deserves a fast answer — an unanswered request must move on to the next
// professional quickly. None of that reasoning applies to a request for next
// Saturday. Holding an artisan to three minutes on a booking eight days out
// simply loses good matches: the artisan is up a ladder, the round expires, and
// the customer ends up with the fourth-best professional for no reason at all.
//
// Twenty minutes is the balance. It is still far inside the customer's tolerance
// (they are not waiting by the phone — they have booked a slot and closed the
// app), and it is long enough for a working artisan to reach a stopping point,
// check their calendar, and decide properly.
const SCHEDULED_TIMEOUT_S = 20 * 60;  // 20 minutes

// Generated mirror of shared/js/domain/bookingSchedule.js — see
// scripts/build-functions-shared.cjs. Dispatch asks it one question: does this
// booking have an appointment, and when?

// A booking the creation trigger never reached is picked up by the sweep in
// checkExpiredDispatches once it is this old. Long enough that a trigger which
// is merely slow (a cold start) gets there first; the claim below makes the
// race harmless either way.
const RESCUE_AFTER_MS = 2 * 60 * 1000;
// The search deadline (shared/js/domain/bookingSchedule.js searchDeadlineMs):
// an immediate request is searched for at most SEARCH_WINDOW_MS, a booked
// appointment until it starts. The rescue only works inside it; past it,
// expireStaleSearches closes the request. Kept under its old name for callers.
const RESCUE_WINDOW_MS = bookingSchedule.SEARCH_WINDOW_MS;
// Bounds on one tick. Pending bookings are scanned newest first.
const RESCUE_SCAN_LIMIT = 200;
const RESCUE_BATCH      = 25;
const EXPIRE_SCAN_LIMIT = 500;   // pending requests are few; oldest are the point

/** The artisan a customer chose, if any — `artisanId` on a legacy write. */
function requestedArtisanOf(b) {
    return b.requestedArtisanId || b.artisanId || null;
}

/**
 * True when no dispatch step has touched the booking: no round claimed and no
 * offer opened. dispatchStatus and currentArtisanId are server-only fields
 * (bookingSystemFields in firestore.rules), so a client cannot fake either.
 */
function isUnstarted(b) {
    return !b.dispatchStatus && !b.currentArtisanId;
}

function toMs(v) {
    if (!v) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; }
    if (typeof v.toMillis === 'function') return v.toMillis();
    return null;
}

// ── Firestore singleton ───────────────────────────────────────────────────────
let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

// ── Haversine distance (km) ───────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
    const R   = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a   = Math.sin(dLat / 2) ** 2 +
                Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
                Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Find and rank eligible artisans ──────────────────────────────────────────
//
// TWO-PHASE DISPATCH LOOKUP
//
// Phase 1 — artisan_index (cheap, small docs, ~400 bytes each):
//   Query artisan_index by geohash range. Returns only the fields needed for
//   candidate selection + dispatch notification. Never touches artisans collection.
//
// Phase 2 — artisans full profile (only for the chosen artisan):
//   Fetched by dispatchRound() after this function returns, when writing the
//   booking assignment. Not done here — dispatch notification data is already
//   in the index (name, profileImage, specialty, rating).
//
// Read budget per dispatch round:
//   artisan_index reads : ~45–90 (9 cells × ~5–10 results each)
//   artisans reads      : 0 (Phase 2 handled by caller for chosen artisan only)
//   Total               : < 100 — target met at any scale.
//
// Fallback: booking has no coordinates → capped index scan, max 200 docs.
// artisan_index is far smaller than artisans, so even the fallback is cheap.
async function findEligibleArtisans(booking, excludeIds) {
    const bookingLat  = booking.lat || booking.userLat || null;
    const bookingLng  = booking.lng || booking.userLng || null;
    const serviceType = (booking.serviceType || booking.service || '').toLowerCase();

    let candidates = [];

    if (bookingLat != null && bookingLng != null) {
        // ── Phase 1: artisan_index geohash proximity queries ─────────────────
        // 25 km cast net — wider than max workRadius (20 km) to catch edge artisans.
        // Exact distance enforced in the filter step below.
        const bounds = geohashQueryBounds([bookingLat, bookingLng], 25_000);

        const snaps = await Promise.all(
            bounds.map(([start, end]) =>
                db().collection('artisan_index')
                    .where('isAvailable',        '==', true)
                    .where('status',             '==', 'active')
                    .where('verificationStatus', '==', 'approved')
                    .where('geohash',            '>=', start)
                    .where('geohash',            '<=', end)
                    .limit(50)
                    .get()
            )
        );

        const seen = new Set();
        for (const snap of snaps) {
            for (const doc of snap.docs) {
                if (!seen.has(doc.id)) {
                    seen.add(doc.id);
                    candidates.push({ id: doc.id, ...doc.data() });
                }
            }
        }
    } else {
        // ── Fallback: no booking coordinates ─────────────────────────────────
        // artisan_index docs are ~400 bytes; 200-doc scan is ~80 KB, not dangerous.
        console.warn(`[dispatch] No booking coordinates — fallback index scan (booking=${booking.id || '?'})`);
        const snap = await db().collection('artisan_index')
            .where('isAvailable',        '==', true)
            .where('status',             '==', 'active')
            .where('verificationStatus', '==', 'approved')
            .limit(200)
            .get();
        candidates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    }

    // ── Filter, rank, hard-limit ──────────────────────────────────────────────
    // HARD_LIMIT: never consider more than 20 candidates per round.
    // Dispatch is sequential (one artisan at a time). 20 rounds of rejection
    // before a booking is unfulfilled is already a generous ceiling.
    const HARD_LIMIT = 20;

    const eligible = candidates
        .filter(a => {
            if (excludeIds.includes(a.id)) return false;

            // Skill match: artisan_index.skills[] holds the VERIFIED trade
            // terms (category, specialty, synonyms — artisanIndex._buildSkills),
            // all lower-case. First keyword of serviceType matched against them;
            // lower-cased too, so "Plumbing" matches "plumbing".
            if (serviceType) {
                const keyword = serviceType.split(/[\s,/]+/)[0].toLowerCase();
                if (keyword.length > 2 &&
                    !(a.skills || []).some(s => String(s).includes(keyword))) return false;
            }

            // Exact distance check — geohash cells are rectangular, not circular.
            if (bookingLat != null && bookingLng != null && a.lat && a.lng) {
                const dist = haversineKm(bookingLat, bookingLng, a.lat, a.lng);
                if (dist > (a.workRadius || 20)) return false;
                a._distKm = dist;
            }

            return true;
        });

    // Ranking: shared/js/domain/performanceMetrics.js (AR-12). Same weights as
    // before; the inputs are now measured where there is enough data and a
    // neutral value — the same for everyone — where there is not. Previously
    // `a.rating || 4.0` scored every unrated artisan as a 4.0, and response and
    // completion were never computed, so both were constants for everyone.
    return performanceMetrics.rankCandidates(eligible).slice(0, HARD_LIMIT);
}

// ── Core dispatch round (transaction-safe) ────────────────────────────────────
async function dispatchRound(bookingId) {
    const bookingRef = db().collection('bookings').doc(bookingId);
    // Hoisted out of the transaction so the post-transaction notification can
    // use them. customerFirstName lets the artisan tell one simultaneous
    // request from another.
    let chosen, isEmergency, round, customerId, serviceType, customerFirstName, appointment;
    let offerExpiresAtMs = null;   // the responseDeadline, carried to the push so it can expire with the offer

    const result = await db().runTransaction(async (txn) => {
        const snap    = await txn.get(bookingRef);
        if (!snap.exists) return { skipped: 'not_found' };

        const booking = snap.data();
        const status  = (booking.status || '').toLowerCase();

        // Guard: only dispatch if pending (not accepted/cancelled/completed).
        // This used to let any booking whose dispatchStatus read 'searching'
        // through whatever its status, so a re-delivered creation event — which
        // reset an ACCEPTED booking to 'searching' — dispatched it again and
        // nulled its artisanId.
        if (!['pending', 'searching'].includes(status)) {
            return { skipped: `status_${status}` };
        }
        // Guard: prevent double-dispatch while a round is in flight
        if (booking.dispatchStatus === 'dispatched') {
            return { skipped: 'already_dispatched' };
        }
        // Guard: a round starts only from a claimed search, or on a booking no
        // round has touched. A customer-chosen request is never open-dispatched:
        // that would hand their chosen job to someone else.
        if (booking.dispatchStatus !== 'searching'
            && !(isUnstarted(booking) && !requestedArtisanOf(booking))) {
            return { skipped: `dispatch_${booking.dispatchStatus || 'prematched'}` };
        }
        // Guard: a search past its deadline is over. A decline or a lapsed
        // offer re-enters here, and a new offer would reach an artisan only to
        // be withdrawn by expireStaleSearches on the next sweep, which closes
        // the request, refunds and tells the customer.
        const searchEnds = bookingSchedule.searchDeadlineMs(booking);
        if (searchEnds !== null && Date.now() >= searchEnds) {
            return { skipped: 'search_deadline' };
        }

        isEmergency  = booking.bookingType === 'emergency' || booking.type === 'emergency';
        customerId   = booking.customerId;
        serviceType  = booking.serviceType || booking.service || 'Service';
        customerFirstName = booking.customerFirstName || null;

        // THREE urgency tiers, not two. Emergency and immediate-standard are
        // both "someone is waiting"; a booked appointment is not, and holding it
        // to the same clock was the mechanism by which a scheduled request
        // behaved like an emergency one.
        appointment = bookingSchedule.resolveSchedule(booking);
        const timeout = isEmergency          ? EMERGENCY_TIMEOUT_S
                      : appointment.scheduled ? SCHEDULED_TIMEOUT_S
                      :                         STANDARD_TIMEOUT_S;

        const alreadyTried = booking.artisanCandidates || [];
        round = (booking.currentDispatchRound || 0) + 1;

        // Hard cap on dispatch rounds — prevents infinite loops when artisans
        // continuously become available and get rejected indefinitely.
        if (round > MAX_DISPATCH_ROUNDS) {
            txn.update(bookingRef, {
                status:               'unfulfilled',
                dispatchStatus:       'unfulfilled',
                currentDispatchRound: round,
                currentArtisanId:     null,
                updatedAt:            new Date().toISOString(),
                unfulfillReason:      'max_rounds_exceeded',
            });
            return { unfulfilled: true, reason: 'max_rounds_exceeded' };
        }

        // Find candidates — done outside transaction to avoid contention,
        // but we re-check eligibility inside via the excludeIds guard.
        const candidates = await findEligibleArtisans(booking, alreadyTried);

        if (candidates.length === 0) {
            txn.update(bookingRef, {
                status:               'unfulfilled',
                dispatchStatus:       'unfulfilled',
                currentDispatchRound: round,
                currentArtisanId:     null,
                updatedAt:            new Date().toISOString(),
                unfulfillReason:      'no_candidates',
            });
            return { unfulfilled: true, reason: 'no_candidates' };
        }

        chosen = candidates[0];
        offerExpiresAtMs = Date.now() + timeout * 1000;
        const deadline = Timestamp.fromMillis(offerExpiresAtMs);

        // The offer. booking.artisanId is NOT set here: holding artisanId is what
        // lets an artisan read the booking (exact address, position, notes), and
        // an artisan who has only been OFFERED the job reads job_offers/{id} — the
        // summary needed to decide (functions/jobOffers.js). artisanId is set by
        // respondToJobOffer when they accept.
        txn.set(jobOffers.offerRef(bookingId), jobOffers.buildOfferDoc(booking, {
            bookingId,
            artisanId:   chosen.id,
            expiresAtMs: offerExpiresAtMs,
            round,
            distanceKm:  chosen._distKm ?? null,
        }));
        txn.update(bookingRef, {
            dispatchStatus:         'dispatched',
            artisanId:              null,
            currentArtisanId:       chosen.id,
            currentArtisanName:     chosen.name           || 'Professional',
            currentArtisanPhoto:    chosen.profileImage   || null,
            currentArtisanRating:   chosen.rating         || null,
            currentArtisanCategory: chosen.specialty      || chosen.category || null,
            responseDeadline:       deadline,
            currentDispatchRound:   round,
            lastDispatchAt:         new Date().toISOString(),
            artisanCandidates:      FieldValue.arrayUnion(chosen.id),
            updatedAt:              new Date().toISOString(),
        });

        return { dispatched: true };
    });

    // Post-transaction: send notification (outside txn to keep txn small)
    if (result.dispatched && chosen) {
        // Distance wording. A real sub-100 m match is described rather than
        // printed as "0.0 km", which reads as "unknown" even when it is true.
        // A null distance is omitted — proximity is never fabricated.
        const distText = chosen._distKm == null ? ''
            : chosen._distKm < 0.1 ? ' · under 100 m away'
            : ` · ${chosen._distKm.toFixed(1)} km away`;

        // The response deadline, stated truthfully. This read "3 hours" for
        // every non-emergency booking long after STANDARD_TIMEOUT_S was cut to
        // three minutes — an artisan who believed it lost the job while they
        // finished what they were doing.
        // Quoted from the constants that decide it, so the two cannot drift.
        const mins = (s) => `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? '' : 's'}`;
        const timeoutTxt = isEmergency             ? `about ${mins(EMERGENCY_TIMEOUT_S)}`
                         : appointment.scheduled   ? mins(SCHEDULED_TIMEOUT_S)
                         :                           mins(STANDARD_TIMEOUT_S);

        // Name the customer so the artisan can tell one simultaneous request
        // from another. First name only — the same field the job card shows.
        const who = customerFirstName ? ` from ${String(customerFirstName).slice(0, 40)}` : '';

        // WHEN the job is, stated before anything else. This is the difference
        // between a request an artisan can answer and one they cannot: "accept
        // to hold Saturday afternoon" is a decision; "new booking request" on the
        // same job is a summons they have no way to evaluate.
        const whenText = appointment.scheduled ? ` for ${appointment.label}` : '';

        await sendArtisanNotification(chosen.id, {
            type:      'Bookings',
            title:     isEmergency           ? 'Emergency Job Request'
                     : appointment.scheduled ? 'New Scheduled Booking'
                     :                         'New Booking Request',
            message:   appointment.scheduled
                ? `${serviceType} visit${who}${whenText}${distText}. Accept within ${timeoutTxt} to hold the slot.`
                : `${serviceType} request${who}${distText}. You have ${timeoutTxt} to respond.`,
            actionUrl: 'dashboard.html',
            metadata:  {
                bookingId,
                serviceType,
                isEmergency,
                scheduled:   appointment.scheduled,
                scheduledFor: appointment.iso,
                round,
                // The push lives exactly as long as the offer: notifications.js
                // sets its TTL from this and drops it once the offer has lapsed.
                expiresAtMs: offerExpiresAtMs,
            },
        }).catch(e => console.warn('[dispatch] artisan notif error:', e.message));

        console.log(`[dispatch] Round ${round}: booking ${bookingId} → artisan ${chosen.id}`);

    } else if (result.unfulfilled) {
        await sendNotification(customerId, {
            type:      'Bookings',
            title:     'No Professionals Available',
            message:   `We couldn't find an available professional for your ${serviceType} request. Please try again later.`,
            actionUrl: 'booking.html',
            metadata:  { bookingId },
        }).catch(e => console.warn('[dispatch] unfulfilled notif error:', e.message));

        console.log(`[dispatch] Booking ${bookingId} marked unfulfilled after ${round} round(s).`);
    } else {
        console.log(`[dispatch] Booking ${bookingId} skipped: ${JSON.stringify(result)}`);
    }

    return result;
}

// ── Trigger: booking CREATED → initialise + first dispatch ───────────────────
// Dispatch latency matters and bookings arrive in bursts: a full vCPU (BURST_CPU).
const onBookingCreated = onDocumentCreated(
    { document: 'bookings/{bookingId}', database: FIRESTORE_DB_ID, region: FUNCTIONS_REGION, ...BURST_CPU },
    (event) => processNewBooking(event.params.bookingId, event.data.data())
);

/**
 * Everything the server does for a new booking: stamp its track, price an
 * emergency, then open the customer-chosen artisan's offer or start dispatch.
 *
 * Every step is guarded so it can run twice. Firestore delivers an event at
 * least once, and the sweep in checkExpiredDispatches replays this for a
 * booking the trigger never reached. The dispatch start is a transactional
 * claim (claimForDispatch), so two runs can never both dispatch.
 */
async function processNewBooking(bookingId, data) {

    // ── Make `track` explicit, server-side, on every booking ──────────────
    //
    // The lifecycle resolver keys off `track`, and when it is absent a
    // booking falls through to the WORK phase — telling a customer the job
    // is underway before anyone has visited. Downstream code was inferring
    // the track from symptoms (which statuses had appeared) to paper over it.
    //
    // The client CANNOT write this field: bookingHasNoSystemFields() in
    // firestore.rules rejects `track` on any client create, which is what
    // stops a fabricated inspection booking. So the stamp belongs here, on
    // the trigger that already runs for every new booking.
    //
    // 'emergency' is NOT a separate commercial lifecycle. It holds escrow
    // through the same holdBookingFunds path as everything else; it simply
    // skips the inspection/callout/quote sub-cycle because the customer has
    // already chosen an artisan and an amount. It is the work track without
    // a preceding inspection — and naming it explicitly is what keeps the
    // resolver from having to guess.
    const isEmergency = data.type === 'emergency' || data.bookingType === 'emergency'
                     || data.isEmergency === true;

    if (!data.track) {
        try {
            await db().collection('bookings').doc(bookingId).update({
                track:     isEmergency ? 'emergency' : 'standard',
                updatedAt: new Date().toISOString(),
            });
        } catch (err) {
            console.error(`[dispatch] Could not stamp track on ${bookingId}: ${err?.message}`);
        }
    }

    // ── Emergency callout fee — SERVER-COMPUTED, stamped here ─────────────
    //
    // The emergency page used to read a fee off the ARTISAN document
    // (`d.callOutFee`). No such field exists on artisans — they carry
    // baseRate — so the amount was always undefined, the escrow branch was
    // never entered, and no emergency booking ever charged anyone.
    //
    // Correcting the spelling would not have helped. The fee has to come
    // from the pricing engine, and it belongs on the BOOKING, where
    // firestore.rules already forbids client writes (bookingSystemFields).
    // payEmergencyCallout then escrows exactly this number, so the client
    // never names an amount.
    //
    // Guarded on a missing/zero fee so a re-run cannot re-price a booking
    // whose fee is already set — including one already paid.
    if (isEmergency && !(Number(data.calloutFee) > 0)) {
        try {
            // Lazily required: keeps the module graph flat in the Functions
            // runtime, matching the existing lazy require below.
            const pricingModule = require('./pricing');
            const price = await pricingModule.computeEmergencyCallout({
                category:  data.serviceType || data.category || '',
                lat:       data.lat,
                lng:       data.lng,
                artisanId: data.requestedArtisanId || data.artisanId || null,
            });
            await db().collection('bookings').doc(bookingId).update({
                priceType:       'emergency',
                calloutFee:      price.calloutFee,
                travelFee:       price.travelFee,
                travelEstimated: price.travelEstimated,
                updatedAt:       new Date().toISOString(),
            });
            console.log(`[dispatch] Emergency priced ${bookingId}: callout=GHS${price.calloutFee} travel=GHS${price.travelFee}`);
        } catch (err) {
            // Leave calloutFee unset rather than writing a guessed number.
            // payEmergencyCallout refuses to charge without it, so the
            // failure surfaces as "not ready yet" instead of a wrong charge.
            console.error(`[dispatch] Could not price emergency booking ${bookingId}: ${err?.message}`);
        }
    }

    if ((data.status || '').toLowerCase() !== 'pending') return;

    // Standard bookings (type:'standard') and pre-matched emergency bookings
    // (artisanId already set by the customer choosing an artisan or the emergency
    // page doing a frontend query) are NOT re-dispatched here. The artisan was
    // already chosen; bookingConfirmNotify.js sent their notification. Dispatch
    // would reassign them and send a duplicate/conflicting notification.
    // The chosen artisan gets the same offer summary as a dispatched one —
    // never the booking itself — with no deadline (a customer-chosen request
    // waits for that artisan; declining tells the customer, as before).
    //
    // A booking that arrives with artisanId already set is a LEGACY write (a
    // client cached from before AR-06, or one created while rules and
    // functions were deployed apart). Re-dispatching it would hand the
    // customer's chosen job to someone else, so it is converted instead: the
    // artisan becomes the request, artisanId is cleared (closing the booking
    // to them until they accept), and the same offer opens. The transaction
    // re-reads the booking so a booking already answered is left alone.
    const requested = data.requestedArtisanId || data.artisanId || null;
    if (requested) {
        let opened = false;
        try {
            await db().runTransaction(async (txn) => {
                const ref  = db().collection('bookings').doc(bookingId);
                const snap = await txn.get(ref);
                const b    = snap.exists ? snap.data() : null;
                if (!b || (b.status || '').toLowerCase() !== 'pending') return;
                if (!isUnstarted(b)) return;                 // offer already open
                opened = true;
                txn.set(jobOffers.offerRef(bookingId), jobOffers.buildOfferDoc(b, {
                    bookingId, artisanId: requested, prematched: true,
                }));
                txn.update(ref, {
                    requestedArtisanId: requested,
                    artisanId:          null,
                    currentArtisanId:   requested,
                    updatedAt:          new Date().toISOString(),
                });
            });
        } catch (err) {
            console.error(`[dispatch] Could not open the offer for pre-matched booking ${bookingId}: ${err?.message}`);
        }
        console.log(opened
            ? `[dispatch] Booking ${bookingId} pre-matched to ${requested} — offer opened, no dispatch.`
            : `[dispatch] Booking ${bookingId} pre-matched — offer already open or booking answered.`);
        return;
    }

    try {
        if (!(await claimForDispatch(bookingId))) {
            console.log(`[dispatch] Booking ${bookingId} already claimed for dispatch — skipped.`);
            return;
        }
        await dispatchRound(bookingId);
    } catch (err) {
        console.error(`[dispatch] processNewBooking error (${bookingId}):`, err.message);
    }
}

/**
 * Claim a booking for its first dispatch round. Succeeds only for a pending,
 * unstarted booking with no customer-chosen artisan, and moves it to
 * 'searching' in the same transaction — so of two callers racing (the trigger
 * and the sweep, or a re-delivered event) exactly one gets true.
 */
async function claimForDispatch(bookingId) {
    const ref = db().collection('bookings').doc(bookingId);
    return db().runTransaction(async (txn) => {
        const snap = await txn.get(ref);
        if (!snap.exists) return false;
        const b = snap.data();
        if ((b.status || '').toLowerCase() !== 'pending') return false;
        if (!isUnstarted(b) || requestedArtisanOf(b)) return false;
        const n = new Date().toISOString();
        txn.update(ref, {
            dispatchStatus:       'searching',
            currentDispatchRound: 0,
            artisanCandidates:    [],
            dispatchHistory:      [],
            searchStartedAt:      n,
            updatedAt:            n,
        });
        return true;
    });
}

// ── Dispatch event handler (called from bookings.js onBookingStatusChanged) ───
//
// Merged here from a separate onDocumentUpdated trigger to eliminate double
// Cloud Function invocations per booking write. bookings.js owns the single
// trigger; this function handles the dispatch-specific side effects.
async function handleDispatchEvent(before, after, bookingId) {
    const prevStatus = (before.status || '').toLowerCase();
    const nextStatus = (after.status  || '').toLowerCase();

    // ── Artisan rejected ──────────────────────────────────────────────────
    if (prevStatus === 'pending' && nextStatus === 'rejected') {
        const wasDispatched = before.dispatchStatus === 'dispatched';

        if (wasDispatched) {
            try {
                await db().collection('bookings').doc(bookingId).update({
                    status:           'pending',   // reset — customer never sees "rejected"
                    dispatchStatus:   'searching',
                    artisanId:        null,
                    currentArtisanId: null,
                    responseDeadline: null,
                    dispatchHistory:  FieldValue.arrayUnion({
                        artisanId:   after.artisanId || before.currentArtisanId || null,
                        response:    'rejected',
                        respondedAt: new Date().toISOString(),
                        round:       after.currentDispatchRound || 1,
                    }),
                    updatedAt: new Date().toISOString(),
                });

                if (after.customerId) {
                    await sendNotification(after.customerId, {
                        type:      'Bookings',
                        title:     'Searching for another professional…',
                        message:   'The previous professional couldn\'t take your booking. We\'re finding another one.',
                        actionUrl: 'booking.html',
                        metadata:  { bookingId },
                    }).catch(e => console.warn('[dispatch] searching notif error:', e.message));
                }

                await dispatchRound(bookingId);
            } catch (err) {
                console.error(`[dispatch] re-dispatch after rejection error (${bookingId}):`, err.message);
            }
        } else {
            console.log(`[dispatch] Booking ${bookingId} rejected (pre-matched, no re-dispatch).`);
        }
    }

    // ── Customer cancelled while the request was on offer → withdraw it ──
    if (prevStatus === 'pending' && nextStatus === 'cancelled') {
        await jobOffers.closeOffer(null, bookingId, 'withdrawn');
    }

    // ── Artisan accepted → clear dispatch timer ───────────────────────────
    if (prevStatus === 'pending' && nextStatus === 'accepted') {
        try {
            await db().collection('bookings').doc(bookingId).update({
                dispatchStatus:   'accepted',
                responseDeadline: null,
                dispatchHistory:  FieldValue.arrayUnion({
                    artisanId:   after.artisanId || null,
                    response:    'accepted',
                    respondedAt: new Date().toISOString(),
                    round:       after.currentDispatchRound || 1,
                }),
                updatedAt: new Date().toISOString(),
            });
        } catch (err) {
            console.error(`[dispatch] accept cleanup error (${bookingId}):`, err.message);
        }
    }
}

// ── Scheduler: the dispatch sweep ────────────────────────────────────────────
// Runs every minute, two passes, each isolated so one failing cannot stop the
// other:
//   1. expire offers whose responseDeadline has passed → next round;
//   2. rescue bookings that dispatch never started, or that stalled between
//      rounds (rescueStalledBookings);
//   3. close requests whose search deadline has passed (expireStaleSearches).
// No new function: the region's CPU quota is spent (CLAUDE.md §4).
const checkExpiredDispatches = onSchedule(
    { schedule: 'every 1 minutes', region: FUNCTIONS_REGION },
    async () => {
        try { await expireTimedOutDispatches(); }
        catch (err) { console.error('[dispatch] expiry pass failed:', err.message); }
        try { await rescueStalledBookings(); }
        catch (err) { console.error('[dispatch] rescue pass failed:', err.message); }
        try { await expireStaleSearches(); }
        catch (err) { console.error('[dispatch] search-deadline pass failed:', err.message); }
    }
);

// Finds bookings where responseDeadline has passed.
async function expireTimedOutDispatches() {
    const now  = Timestamp.now();

    const snap = await db().collection('bookings')
        .where('dispatchStatus',   '==', 'dispatched')
        .where('responseDeadline', '<=', now)
        .get();

    if (snap.empty) return;
    console.log(`[dispatch] Expiring ${snap.size} timed-out dispatch(es)`);

    await Promise.all(snap.docs.map(async (doc) => {
        const bookingId = doc.id;
        const booking   = doc.data();
        try {
            // ── Re-check the timeout inside a transaction (F4) ────────────
            // The query snapshot is stale by the time we act on it. If the
            // artisan ACCEPTED (or the booking was cancelled/re-dispatched)
            // in the gap, blindly nulling artisanId here would strip the
            // professional off an accepted booking. Claim the timeout only
            // if the booking is still dispatched to the same round.
            let expiredFor = null;
            const claimed = await db().runTransaction(async (txn) => {
                const live = await txn.get(doc.ref);
                const offerSnap = await txn.get(jobOffers.offerRef(bookingId));
                if (!live.exists) return false;
                const d = live.data();
                if (d.dispatchStatus !== 'dispatched') return false;      // already accepted/re-dispatched
                if ((d.status || '').toLowerCase() !== 'pending') return false; // no longer pending
                // The offer as it stands, so the close records an 'expired'
                // event for the artisan who let it lapse (AR-12).
                const offer = offerSnap.exists ? offerSnap.data() : null;
                jobOffers.closeOffer(txn, bookingId, 'expired',
                    offer && offer.artisanId === d.currentArtisanId ? offer : null);
                expiredFor = d.currentArtisanId || null;
                txn.update(doc.ref, {
                    dispatchStatus:   'searching',
                    artisanId:        null,
                    currentArtisanId: null,
                    responseDeadline: null,
                    dispatchHistory:  FieldValue.arrayUnion({
                        artisanId:  d.currentArtisanId || null,
                        response:   'timeout',
                        expiredAt:  new Date().toISOString(),
                        round:      d.currentDispatchRound || 1,
                    }),
                    updatedAt: new Date().toISOString(),
                });
                return true;
            });

            if (!claimed) {
                console.log(`[dispatch] Expiry skipped — booking ${bookingId} advanced before timeout claim.`);
                return;
            }
            await jobOffers.refreshResponseStats(expiredFor);

            // Notify customer
            if (booking.customerId) {
                await sendNotification(booking.customerId, {
                    type:      'Bookings',
                    title:     'Searching for another professional…',
                    message:   'The previous professional didn\'t respond in time. Finding another one for you.',
                    actionUrl: 'booking.html',
                    metadata:  { bookingId },
                }).catch(e => console.warn('[dispatch] timeout notif error:', e.message));
            }

            await dispatchRound(bookingId);
        } catch (err) {
            console.error(`[dispatch] expire error (${bookingId}):`, err.message);
        }
    }));
}

/**
 * Pending bookings dispatch has dropped. Two ways that happens:
 *
 *   • never started — onBookingCreated did not run or failed before its claim
 *     (a deploy gap, an outage, a crash). Nothing else ever looked at these:
 *     the expiry pass only sees dispatchStatus 'dispatched', so the booking
 *     sat at "finding a professional" forever. processNewBooking is replayed.
 *   • stalled — 'searching' with no round in flight: a round between a
 *     rejection or a timeout and the next offer threw. dispatchRound is rerun.
 *
 * Both paths go through the same guards as the trigger (claimForDispatch, and
 * dispatchRound's own transaction), so a booking the trigger or another tick
 * reaches first is skipped, never dispatched twice.
 */
async function rescueStalledBookings(nowMs = Date.now()) {
    // Newest first, over a day: covers the immediate window and booked
    // appointments made within the last 24 hours (bookings.status +
    // createdAt DESC index).
    const snap = await db().collection('bookings')
        .where('status', '==', 'pending')
        .where('createdAt', '>=', new Date(nowMs - 24 * 60 * 60 * 1000).toISOString())
        .orderBy('createdAt', 'desc')
        .limit(RESCUE_SCAN_LIMIT)
        .get();

    const due = [];
    for (const doc of snap.docs) {
        const b = doc.data();
        const created = toMs(b.createdAt);
        if (created === null || nowMs - created < RESCUE_AFTER_MS) continue;

        const kind = isUnstarted(b) ? 'unstarted'
                   : b.dispatchStatus === 'searching'
                     && nowMs - (toMs(b.updatedAt) ?? created) >= RESCUE_AFTER_MS ? 'stalled'
                   : null;
        if (!kind) continue;

        const deadline = bookingSchedule.searchDeadlineMs(b, nowMs);
        if (deadline === null || nowMs >= deadline) continue;      // expireStaleSearches' job

        due.push({ id: doc.id, data: b, kind });
        if (due.length >= RESCUE_BATCH) break;
    }
    if (due.length === 0) return { rescued: 0 };
    console.log(`[dispatch] Rescuing ${due.length} booking(s): ${due.map((d) => `${d.id}=${d.kind}`).join(', ')}`);

    await Promise.all(due.map(async ({ id, data, kind }) => {
        try {
            if (kind === 'unstarted') await processNewBooking(id, data);
            else await dispatchRound(id);
        } catch (err) {
            console.error(`[dispatch] rescue error (${id}):`, err.message);
        }
    }));
    return { rescued: due.length };
}

/**
 * End every search that has outlived its deadline (bookingSchedule
 * searchDeadlineMs). Without this a request nobody accepted waited forever —
 * one read "we've been searching for 1879 minutes" (2026-10-23) because it was
 * never dispatched and nothing else ever looked at it.
 *
 * For each pending request past its deadline, in one transaction: re-check it
 * is still pending and still past the deadline (an artisan may have accepted a
 * moment ago — then nothing happens), withdraw an open offer (neutral for the
 * artisan's response rate: the platform ended it, not them), and mark it
 * unfulfilled with unfulfillReason 'search_timeout'. Then refund anything
 * already held for it (an emergency callout can be paid while still waiting)
 * and tell the customer.
 */
async function expireStaleSearches(nowMs = Date.now()) {
    const snap = await db().collection('bookings').where('status', '==', 'pending').limit(EXPIRE_SCAN_LIMIT).get();
    const due = snap.docs.filter((d) => {
        const dl = bookingSchedule.searchDeadlineMs(d.data(), nowMs);
        return dl !== null && nowMs >= dl;
    }).slice(0, RESCUE_BATCH);
    if (due.length === 0) return { expired: 0 };

    let expired = 0;
    await Promise.all(due.map(async (doc) => {
        const bookingId = doc.id;
        try {
            const closed = await db().runTransaction(async (txn) => {
                const [live, offerSnap] = await Promise.all([txn.get(doc.ref), txn.get(jobOffers.offerRef(bookingId))]);
                if (!live.exists) return null;
                const b = live.data();
                if ((b.status || '').toLowerCase() !== 'pending') return null;
                const dl = bookingSchedule.searchDeadlineMs(b, nowMs);
                if (dl === null || nowMs < dl) return null;
                const offer = offerSnap.exists ? offerSnap.data() : null;
                // Only an OPEN offer is closed — closeOffer would otherwise
                // create an offer document for a request that never had one.
                if (offer && offer.offerStatus === 'open') jobOffers.closeOffer(txn, bookingId, 'withdrawn', offer);
                const n = new Date(nowMs).toISOString();
                txn.update(doc.ref, {
                    status:           'unfulfilled',
                    dispatchStatus:   'unfulfilled',
                    unfulfillReason:  'search_timeout',
                    currentArtisanId: null,
                    responseDeadline: null,
                    searchEndedAt:    n,
                    updatedAt:        n,
                });
                return { customerId: b.customerId || null, serviceType: b.serviceType || b.service || 'service',
                         scheduled: bookingSchedule.resolveSchedule(b, nowMs).scheduled };
            });
            if (!closed) return;
            expired++;

            // Money already held for this request goes back — refundEscrow is
            // idempotent (it re-reads the escrow's status in its transaction)
            // and tells the customer itself.
            let refunded = false;
            const held = await db().collection('escrow').where('bookingId', '==', bookingId).get();
            for (const e of held.docs) {
                if (e.data().status !== 'held') continue;      // disputed money is the admin's to decide
                try {
                    await require('./financial/escrow').refundEscrow(e.id, {
                        reason: 'No professional accepted your request in time', refundedBy: 'system:search_timeout',
                    });
                    refunded = true;
                    // The booking says so too: calloutSettled is what the
                    // customer's screens read for "was I charged?".
                    if (e.data().kind === 'callout') {
                        await doc.ref.update({
                            calloutSettled: 'refunded', calloutSettledAt: new Date().toISOString(),
                            calloutSettleReason: 'search_timeout',
                        }).catch((x) => console.warn(`[dispatch] could not mark callout refunded on ${bookingId}: ${x.message}`));
                    }
                } catch (err) {
                    console.error(`[dispatch] search-timeout refund failed (${bookingId}, ${e.id}): ${err.message}`);
                }
            }

            if (closed.customerId) {
                await sendNotification(closed.customerId, {
                    type:      'Bookings',
                    title:     'No Professionals Available',
                    message:   closed.scheduled
                        ? `Nobody accepted your ${closed.serviceType} appointment before it was due to start.${refunded ? ' Your payment has been refunded.' : ' Nothing was charged.'} Please book another time.`
                        : `Nobody accepted your ${closed.serviceType} request within an hour.${refunded ? ' Your payment has been refunded.' : ' Nothing was charged.'} Please try again.`,
                    actionUrl: 'booking.html',
                    metadata:  { bookingId },
                }).catch((e) => console.warn('[dispatch] search-timeout notif error:', e.message));
            }
            console.log(`[dispatch] Search ended for ${bookingId}: deadline passed (refunded: ${refunded}).`);
        } catch (err) {
            console.error(`[dispatch] search-timeout error (${bookingId}):`, err.message);
        }
    }));
    return { expired };
}

module.exports = {
    onBookingCreated,
    checkExpiredDispatches,
    handleDispatchEvent,
    dispatchRound,
    // For tests: the pieces the trigger and the sweep share.
    processNewBooking,
    claimForDispatch,
    rescueStalledBookings,
    expireStaleSearches,
    RESCUE_AFTER_MS,
    RESCUE_WINDOW_MS,
};
