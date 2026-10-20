'use strict';

/**
 * pricing.js — Inspection-track booking lifecycle + server-authoritative callout fees
 *
 * Implements the HandyHub inspection-first pricing architecture:
 *
 *   1. getPricingQuote        customer asks "what does an inspection visit cost?"
 *                             → additive, capped fee computed from pricing_config
 *                             → single-use quote token stored server-side
 *
 *   2. createInspectionBooking booking created SERVER-SIDE from the token —
 *                             the client never writes a price field
 *
 *   3. payCalloutFee          customer escrows the callout fee after an artisan
 *                             accepts → status: accepted → inspection_scheduled
 *
 *   4. completeInspection     artisan marks the inspection done (NO money moves —
 *                             callout escrow settles only on customer decisions
 *                             or timeouts, so an artisan cannot self-pay)
 *                             → status: inspection_scheduled/en_route/in_progress
 *                                       → inspection_done
 *
 *   5. cancelInspectionBooking party-aware cancellation with fair callout
 *                             settlement (refund vs release)
 *
 *   6. checkBookingTimeouts   scheduled sweeper — expires stale quotes and
 *                             abandoned inspections with fair settlement
 *
 * Callout fee formula (ADDITIVE with caps — never multiplicative):
 *   travelFee  = 0                                   if distance ≤ freeRadiusKm
 *              = min((d − freeRadiusKm) × perKmGHS, maxTravelGHS)   otherwise
 *              = flatTravelGHS                        if artisan/coords unknown
 *   calloutFee = ceil(min(inspectionFeeGHS + travelFee, maxCalloutGHS))
 *
 * Callout settlement invariants:
 *   • Held via _escrow_locks/{bookingId}_callout — never collides with the job
 *     escrow lock (_escrow_locks/{bookingId}).
 *   • Released to artisan ONLY when the inspection was genuinely delivered:
 *     quote approved (credited), quote finally rejected, or customer ghosted
 *     a submitted quote past the expiry window.
 *   • Refunded to customer when the artisan fails: cancellation by artisan,
 *     no-show, or no quote submitted after inspection.
 */

const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto');
const { FIRESTORE_DB_ID } = require('./config');
const { sendNotification, sendArtisanNotification } = require('./notifications');
const escrow = require('./financial/escrow');
// Generated mirror of shared/js/domain/bookingSchedule.js — see
// scripts/build-functions-shared.cjs. The browser's picker, this validator and
// firestore.rules all decide appointments from the same numbers.
const bookingSchedule = require('./shared/bookingSchedule');

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

const fmt = (n) => parseFloat(Number(n).toFixed(2));
const nowIso = () => new Date().toISOString();

// ── Pricing defaults ──────────────────────────────────────────────────────────
// Used when a pricing_config/{category} doc is missing a field (or entirely).
// All values are GHS. Admin-editable per category in the pricing_config
// collection — these are only the safety floor.
// ╔══════════════════════════════════════════════════════════════════════════╗
// ║  TEMPORARY TEST PRICING — GHS 1 CALLOUT FEE                              ║
// ║                                                                          ║
// ║  Set deliberately so a real end-to-end booking can be paid for with one  ║
// ║  cedi instead of fifty. Every component is zeroed rather than just the   ║
// ║  inspection fee, because the formula is                                  ║
// ║      calloutFee = ceil(min(inspectionFeeGHS + travelFee, maxCalloutGHS)) ║
// ║  and any travel component would push the total above 1. maxCalloutGHS: 1 ║
// ║  is the backstop that holds even if a travel value is reintroduced.      ║
// ║                                                                          ║
// ║  ⚠ REVERT BEFORE REAL CUSTOMERS. Production values are preserved below  ║
// ║  in PRICING_PRODUCTION — swap the two assignments back.                  ║
// ╚══════════════════════════════════════════════════════════════════════════╝
const PRICING_PRODUCTION = Object.freeze({
    // ⚠ AWAITING BUSINESS APPROVAL — provisional.
    // The urgency base for an emergency callout, used in place of
    // inspectionFeeGHS. GHS 80 = the standard GHS 50 inspection fee plus a
    // GHS 30 urgency premium. Nobody has signed this off; it is isolated here
    // as a single tunable so approving a different number is a one-line change
    // (or a pricing_config write, with no deploy at all).
    emergencyCalloutGHS: 80,
    inspectionFeeGHS: 50,   // fixed component per category
    perKmGHS:         2.5,  // travel rate beyond the free radius
    freeRadiusKm:     3,    // no travel charge within this distance
    maxTravelGHS:     60,   // travel component cap
    flatTravelGHS:    10,   // used when artisan/coords unknown (dispatch track)
    maxCalloutGHS:    150,  // absolute callout ceiling
});

const PRICING_TEST_1_CEDI = Object.freeze({
    emergencyCalloutGHS: 1,
    inspectionFeeGHS: 1,
    perKmGHS:         0,
    freeRadiusKm:     3,
    maxTravelGHS:     0,
    flatTravelGHS:    0,
    maxCalloutGHS:    1,
});

// PRODUCTION PRICING ACTIVE (restored 2026-09-09).
//
// Was PRICING_TEST_1_CEDI, which charged every customer a one-cedi callout.
// pricing_config in Firestore was empty, so nothing overrode it and the test
// value reached real bookings. Swap to PRICING_TEST_1_CEDI again only for a
// deliberate end-to-end payment test, and revert immediately afterwards.
const PRICING_DEFAULTS = PRICING_PRODUCTION;

// Category ids — keep in sync with shared/js/data/serviceCatalog.js
const CATALOG_CATEGORY_IDS = Object.freeze([
    'electrical', 'plumbing', 'carpentry', 'ac-repair',
    'welding', 'cleaning', 'painting', 'gardening',
]);

// Per-category inspection fee seeds (admin-tunable after seeding).
//
// Real per-category seeds, restored 2026-09-09 alongside PRICING_DEFAULTS.
// These two must always agree: seeding pricing_config from one while the other
// says something different produces a half-state that is hard to diagnose.
const SEED_INSPECTION_FEES = Object.freeze({
    'electrical': 50, 'plumbing': 50, 'carpentry': 40, 'ac-repair': 60,
    'welding': 60, 'cleaning': 30, 'painting': 40, 'gardening': 30,
});

const QUOTE_TOKEN_TTL_MS   = 15 * 60_000;      // pricing quote valid for 15 min
const QUOTE_EXPIRY_HOURS   = 48;               // customer must decide on a job quote
const NO_QUOTE_HOURS       = 24;               // artisan must quote after inspection
const STALE_INSPECTION_HRS = 72;               // artisan must inspect after callout paid
const UNPAID_CALLOUT_HRS   = 24;               // customer must pay callout after accept (F6)
const MAX_PHOTOS           = 6;
const CLOUDINARY_PREFIX    = 'https://res.cloudinary.com/';

// ─────────────────────────────────────────────────────────────────────────────
// claimBookingTransition — the concurrency primitive for booking state changes.
//
// Every money-moving Cloud Function (approve/reject quote, pay callout, complete
// inspection, cancel) used to do: read booking → check status → move money →
// update booking, with NO transaction around the status check. Two concurrent
// callers (double-tap, two tabs, a client retry racing the scheduler) could both
// pass the status check and both move money — the F4 race class.
//
// This helper closes the whole class with a single atomic compare-and-set:
//   • re-read the booking INSIDE a transaction
//   • assert its status is still one of `fromStatuses` (fail otherwise — the
//     other caller already advanced it; this one aborts before any money moves)
//   • optionally assert a guard (e.g. calloutPaid === false)
//   • stamp `patch` (typically an intermediate/target status + a claim marker)
//
// Because escrow.holdFundsForBooking / releaseEscrow run their OWN transactions
// (and cannot be nested), the pattern is claim-first: this txn only claims the
// transition; the caller then performs the already-idempotent money movement
// outside. If money movement fails after a successful claim, the booking is left
// in the claimed (intermediate) state and the hourly sweeper reconciles it.
//
// @returns the booking data as it was at claim time (pre-patch), for the caller.
// @throws  if the booking is missing, unauthorised, or no longer in fromStatuses.
async function claimBookingTransition(bookingRef, {
    fromStatuses, patch, authUid, party = 'customer', guard = null, guardMessage = null,
}) {
    return db().runTransaction(async (txn) => {
        const snap = await txn.get(bookingRef);
        if (!snap.exists) throw new Error('Booking not found.');
        const booking = snap.data();

        const owner = party === 'artisan' ? booking.artisanId
                    : party === 'any'     ? (booking.customerId === authUid ? booking.customerId : booking.artisanId)
                    : booking.customerId;
        if (authUid != null && owner !== authUid) throw new Error('Not authorised for this booking.');

        if (!fromStatuses.includes(booking.status)) {
            throw new Error(`This action is no longer available — the booking is ${booking.status}.`);
        }
        if (typeof guard === 'function' && !guard(booking)) {
            throw new Error(guardMessage || 'This action is no longer available.');
        }

        txn.update(bookingRef, { ...patch, updatedAt: nowIso() });
        return booking;
    });
}

function haversineKm(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Loose Ghana-region sanity bounds — rejects junk coordinates, not visitors. */
function isPlausibleGhanaCoord(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) &&
           lat >= 4 && lat <= 12 && lng >= -4 && lng <= 2;
}

/**
 * Map a bare ISO instant back onto the wall clock + window it must have come
 * from, so the legacy `scheduledFor` parameter is validated by the same rules
 * as a picker selection instead of being trusted as an arbitrary instant.
 *
 * An instant that does not land exactly on the start of a real arrival window
 * is rejected by validateScheduleRequest (no windowId), which is the correct
 * answer: HandyHub sells windows, not minutes, and a caller asking for 14:37 is
 * asking for something the product cannot promise.
 *
 * Ghana is UTC+0, so the UTC hour IS the Accra wall-clock hour — see
 * ACCRA_UTC_OFFSET_MINUTES in the schedule module for why that is a constant.
 */
function isoToScheduleRequest(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) throw new Error('scheduledFor must be a valid date.');
    const d   = new Date(t);
    const win = bookingSchedule.TIME_WINDOWS.find(
        w => w.startHour === d.getUTCHours() && d.getUTCMinutes() === 0);
    return {
        dateStr:  bookingSchedule.accraDateString(t),
        windowId: win ? win.id : null,
    };
}

/** HHB-YYMMDD-HHMM-XXXX — same format as stateService.generateBookingId (Ghana = UTC). */
function generateBookingId() {
    const d = new Date().toISOString();               // 2026-07-02T14:30:00.000Z
    const stamp = d.slice(2, 10).replace(/-/g, '') ;  // 260702
    const time  = d.slice(11, 16).replace(':', '');   // 1430
    const rand  = crypto.randomBytes(2).toString('hex').toUpperCase();
    return `HHB-${stamp}-${time}-${rand}`;
}

async function loadPricingConfig(category) {
    const snap = await db().collection('pricing_config').doc(category).get();
    const cfg  = snap.exists ? snap.data() : {};
    const merged = { ...PRICING_DEFAULTS };
    for (const key of Object.keys(PRICING_DEFAULTS)) {
        const v = Number(cfg[key]);
        if (Number.isFinite(v) && v >= 0) merged[key] = v;
    }
    return merged;
}

/**
 * The travel component — ONE implementation, shared by standard and emergency.
 *
 * Falls back to cfg.flatTravelGHS (a configured value, never 0) when the
 * artisan is unknown or their indexed position is unusable. That mirrors the
 * dispatch track, where no artisan has been chosen yet.
 *
 * @returns {Promise<{travelFee:number, distanceKm:number|null, travelEstimated:boolean}>}
 */
async function computeTravelFee(cfg, lat, lng, artisanId) {
    let travelFee       = cfg.flatTravelGHS;
    let distanceKm      = null;
    let travelEstimated = true;

    if (artisanId && isPlausibleGhanaCoord(Number(lat), Number(lng))) {
        const idxSnap = await db().collection('artisan_index').doc(String(artisanId)).get();
        const idx = idxSnap.exists ? idxSnap.data() : null;
        if (idx && Number.isFinite(idx.lat) && Number.isFinite(idx.lng)) {
            distanceKm      = fmt(haversineKm(Number(lat), Number(lng), idx.lat, idx.lng));
            travelEstimated = false;
            travelFee = distanceKm <= cfg.freeRadiusKm
                ? 0
                : Math.min((distanceKm - cfg.freeRadiusKm) * cfg.perKmGHS, cfg.maxTravelGHS);
        }
    }
    return { travelFee: fmt(travelFee), distanceKm, travelEstimated };
}

/**
 * THE callout formula: additive, capped, rounded up to a whole cedi.
 *
 * Standard passes inspectionFeeGHS as the base; emergency passes
 * emergencyCalloutGHS. Keeping one implementation is what stops the two tracks
 * drifting apart — an emergency booking that priced itself would be exactly the
 * class of bug this phase exists to remove.
 */
function applyCalloutFormula(cfg, baseFeeGHS, travelFee) {
    return Math.ceil(Math.min(fmt(baseFeeGHS) + fmt(travelFee), cfg.maxCalloutGHS));
}

/**
 * Authoritative emergency callout price. Server-only — no client input.
 *
 * Throws rather than returning a fallback when the fee is not configured: a
 * silent 0 here is precisely how emergency bookings came to be free.
 *
 * @returns {Promise<{calloutFee:number, travelFee:number, emergencyFee:number,
 *                    distanceKm:number|null, travelEstimated:boolean}>}
 */
async function computeEmergencyCallout({ category, lat, lng, artisanId }) {
    const cfg  = await loadPricingConfig(String(category || '').toLowerCase());
    const base = Number(cfg.emergencyCalloutGHS);

    if (!Number.isFinite(base) || base <= 0) {
        throw new Error('Emergency callout fee is not configured for this category.');
    }

    const { travelFee, distanceKm, travelEstimated } =
        await computeTravelFee(cfg, lat, lng, artisanId);

    const calloutFee = applyCalloutFormula(cfg, base, travelFee);
    if (!Number.isFinite(calloutFee) || calloutFee <= 0) {
        throw new Error('Emergency callout fee resolved to an invalid amount.');
    }

    return { calloutFee, travelFee, emergencyFee: fmt(base), distanceKm, travelEstimated };
}

/**
 * payEmergencyCallout — escrow the emergency callout fee.
 *
 * Deliberately the same shape as payCalloutFee: the amount is read from the
 * BOOKING DOCUMENT, which firestore.rules lists in bookingSystemFields() so no
 * client can write it. The caller supplies a bookingId and nothing else — there
 * is no amount parameter to tamper with.
 *
 * Idempotent through escrow's _escrow_locks/{bookingId}_callout, so a retry or
 * a double-tap reaches the same escrowId instead of holding twice.
 */
async function payEmergencyCallout(auth, { bookingId }) {
    if (!bookingId) throw new Error('bookingId is required.');

    const bookingRef  = db().collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error('Booking not found.');
    const booking = bookingSnap.data();

    if (booking.customerId !== auth.uid) throw new Error('Not authorised for this booking.');
    if (booking.track !== 'emergency')   throw new Error('This booking is not an emergency booking.');

    // Already settled — return the existing escrow rather than holding again.
    if (booking.calloutPaid === true) {
        return { escrowId: booking.calloutEscrowId || null, amount: Number(booking.calloutFee || 0), alreadyPaid: true };
    }

    // Stamped by onBookingCreated. Absent means the trigger has not run yet;
    // say so instead of charging a guessed amount.
    const fee = Number(booking.calloutFee || 0);
    if (!Number.isFinite(fee) || fee <= 0) {
        throw new Error('Emergency callout fee is not ready yet. Please try again in a moment.');
    }

    const { escrowId } = await escrow.holdFundsForBooking({
        bookingId,
        customerId: booking.customerId,
        artisanId:  booking.artisanId || null,
        amount:     fee,
        callerAuth: auth,
        kind:       'callout',
    });

    // Recorded only AFTER the hold succeeds. Stamping first would mark a
    // booking paid whose money never actually moved.
    await bookingRef.update({
        calloutPaid:     true,
        calloutPaidAt:   nowIso(),
        calloutEscrowId: escrowId,
        updatedAt:       nowIso(),
    });

    console.log(`[pricing] Emergency callout escrowed: ${bookingId} GHS${fee} escrow=${escrowId}`);
    return { escrowId, amount: fee };
}

// ─────────────────────────────────────────────────────────────────────────────
// getPricingQuote
//
// Called by: customer app, before creating an inspection booking.
// Payload:  { category, lat, lng, artisanId? }
// Returns:  { quoteToken, calloutFee, travelFee, inspectionFee, distanceKm,
//             travelEstimated, expiresAt, currency }
// ─────────────────────────────────────────────────────────────────────────────
async function getPricingQuote(auth, { category, lat, lng, artisanId = null }) {
    category = String(category || '').trim().toLowerCase();
    if (!CATALOG_CATEGORY_IDS.includes(category)) {
        throw new Error(`Unknown service category "${category}".`);
    }
    lat = Number(lat); lng = Number(lng);
    if (!isPlausibleGhanaCoord(lat, lng)) {
        throw new Error('A valid service location is required to price the visit.');
    }

    const cfg = await loadPricingConfig(category);

    // ── Travel component (shared with emergency pricing) ─────────────────────
    const { travelFee, distanceKm, travelEstimated } =
        await computeTravelFee(cfg, lat, lng, artisanId);

    // ── Additive, capped, rounded up to a whole cedi ─────────────────────────
    const inspectionFee = fmt(cfg.inspectionFeeGHS);
    const calloutFee    = applyCalloutFormula(cfg, inspectionFee, travelFee);

    // ── Single-use server-side token — the client never writes a price ──────
    const quoteToken = crypto.randomBytes(16).toString('hex');
    const expiresAt  = new Date(Date.now() + QUOTE_TOKEN_TTL_MS).toISOString();

    await db().collection('pricing_quotes').doc(quoteToken).set({
        customerId: auth.uid,
        category,
        calloutFee,
        travelFee,
        inspectionFee,
        distanceKm,
        travelEstimated,
        artisanId:  artisanId ? String(artisanId) : null,
        lat, lng,
        used:       false,
        createdAt:  nowIso(),
        expiresAt,
        // Firestore TTL policy (see firestore.indexes.json) garbage-collects
        // tokens a day after issue — used or not.
        ttlAt:      Timestamp.fromMillis(Date.now() + 24 * 3_600_000),
    });

    console.log(`[pricing] Quote: cat=${category} callout=GHS${calloutFee} travel=GHS${travelFee} est=${travelEstimated} user=${auth.uid}`);
    return { quoteToken, calloutFee, travelFee, inspectionFee, distanceKm, travelEstimated, expiresAt, currency: 'GHS' };
}

// ─────────────────────────────────────────────────────────────────────────────
// createInspectionBooking
//
// Called by: customer app, after reviewing the callout fee.
// Payload:  { quoteToken, address, description, notes?, photos?, serviceLabel?,
//             schedule? }
// The booking document is written server-side with the token's locked fee.
// If the token carries an artisanId the booking is pre-matched; otherwise the
// dispatch engine (onBookingCreated) takes over via radius matching.
//
// ── WHEN, not just what and where ────────────────────────────────────────────
// `schedule` is { dateStr: 'YYYY-MM-DD', windowId } — a WALL CLOCK in Ghana, not
// an instant. The client sends what the customer picked; this function decides
// what that means, using the same bookingSchedule module the picker used, so a
// slot the browser offered is a slot the server accepts. Omit it (or send null)
// for the immediate flow — the default, and what every booking before
// scheduling existed effectively was.
//
// `scheduledFor` (a bare ISO string) is still accepted for backward
// compatibility with the parameter this function has always declared, but it is
// re-validated through the same rules rather than trusted as written.
// ─────────────────────────────────────────────────────────────────────────────
async function createInspectionBooking(auth, {
    quoteToken, address, description, notes = '', photos = [],
    serviceLabel = '', scheduledFor = null, schedule = null,
}) {
    if (!quoteToken || typeof quoteToken !== 'string') throw new Error('quoteToken is required.');
    address     = String(address || '').trim();
    description = String(description || '').trim();
    if (!address)     throw new Error('A service address is required.');
    if (description.length < 10) throw new Error('Please describe the problem (at least 10 characters).');

    // ── Photo validation — Cloudinary URLs only ──────────────────────────────
    if (!Array.isArray(photos)) photos = [];
    photos = photos.slice(0, MAX_PHOTOS).map(String);
    for (const url of photos) {
        if (!url.startsWith(CLOUDINARY_PREFIX)) {
            throw new Error('Photos must be uploaded through the app before booking.');
        }
    }

    // ── Appointment — validated here, never taken on trust ───────────────────
    //
    // This used to be `Date.parse(scheduledFor)` and nothing else: any parseable
    // string was accepted, including one in the past. It did not matter, because
    // no caller ever passed one. Now that the appointment gates when work may
    // begin (scheduleWindowOpen in firestore.rules), a client-chosen instant is
    // a client-chosen gate — so the wall clock the customer picked is re-derived
    // here through the shared rules rather than believed.
    //
    // Both fields are written together or not at all: scheduledForMs is what
    // Rules compare, the ISO string is what humans and logs read. A booking that
    // carried one without the other could pass a gate it should not.
    let scheduleStartMs  = null;
    let scheduleWindowMins = null;

    const scheduleReq = schedule && typeof schedule === 'object'
        ? { dateStr: schedule.dateStr, windowId: schedule.windowId }
        : (scheduledFor !== null ? isoToScheduleRequest(scheduledFor) : null);

    if (scheduleReq) {
        const v = bookingSchedule.validateScheduleRequest(scheduleReq, Date.now());
        if (!v.ok) throw new Error(v.reason);
        scheduleStartMs    = v.startMs;
        scheduleWindowMins = v.windowMins;
        scheduledFor       = v.iso;
    } else {
        scheduledFor = null;
    }

    const tokenRef   = db().collection('pricing_quotes').doc(quoteToken);
    const bookingId  = generateBookingId();
    const bookingRef = db().collection('bookings').doc(bookingId);

    // ── Customer identity for the artisan's decision surface ─────────────────
    //
    // The booking IS the information contract between the two parties, and it
    // carried no customer identity at all — which is why an artisan was asked to
    // accept a job from "Customer" and travel to a stranger's home.
    //
    // PRIVACY: first name only. A full name is not needed to decide or to greet
    // someone at a door, and the booking is readable by the dispatched artisan
    // before they have committed to anything. The phone number is stored because
    // an artisan who is en route genuinely cannot do the job without it — but NOT
    // on the booking: it goes to bookings/{id}/private/contact, which
    // firestore.rules (contactDisclosed) open to the assigned artisan only once the
    // job is accepted and the callout fee is secured, and close when it ends.
    let customerFirstName = null;
    let customerPhone     = null;
    try {
        const custSnap = await db().collection('customers').doc(auth.uid).get();
        if (custSnap.exists) {
            const c = custSnap.data();
            const full = String(c.fullName || c.name || '').trim();
            customerFirstName = full ? full.split(/\s+/)[0].slice(0, 40) : null;
            customerPhone     = String(c.phone || '').trim().slice(0, 20) || null;
        }
    } catch (err) {
        // Non-fatal: a booking without a resolved name still works, and the
        // artisan UI renders an honest "Name unavailable" rather than a
        // placeholder that reads like a real identity.
        console.warn(`[pricing] Could not resolve customer identity for ${auth.uid}: ${err.message}`);
    }

    // ── Atomically consume the token and create the booking ──────────────────
    const quote = await db().runTransaction(async (txn) => {
        const tokenSnap = await txn.get(tokenRef);
        if (!tokenSnap.exists)                     throw new Error('Pricing quote not found — please refresh the fee.');
        const q = tokenSnap.data();
        if (q.customerId !== auth.uid)             throw new Error('This pricing quote belongs to a different account.');
        if (q.used)                                throw new Error('This pricing quote was already used.');
        if (q.expiresAt <= nowIso())               throw new Error('This pricing quote has expired — please refresh the fee.');

        txn.update(tokenRef, { used: true, usedAt: nowIso(), bookingId });

        const n = nowIso();
        // The customer's phone, kept off the booking (see above).
        txn.set(bookingRef.collection('private').doc('contact'), {
            bookingId,
            customerId:    auth.uid,
            customerPhone,
            updatedAt:     n,
        });
        txn.set(bookingRef, {
            bookingId,
            customerId:   auth.uid,
            customerFirstName,
            // A customer-chosen artisan is OFFERED the job (job_offers, opened by
            // onBookingCreated) and becomes artisanId only on accepting it.
            artisanId:          null,
            requestedArtisanId: q.artisanId || null,
            track:        'inspection',
            priceType:    'callout_only',
            type:         'standard',
            status:       'pending',
            category:     q.category,
            serviceType:  String(serviceLabel || '').trim().slice(0, 80) || q.category,
            description:  description.slice(0, 2000),
            notes:        String(notes || '').trim().slice(0, 500),
            photos,
            address:      address.slice(0, 300),
            lat:          q.lat,
            lng:          q.lng,
            // ── The appointment ──────────────────────────────────────────────
            // null on both fields = the immediate flow. Written as an explicit
            // null rather than omitted so every booking document answers the
            // question "when?" rather than leaving readers to infer it from an
            // absent key — the same reason `track` is stamped on every booking.
            scheduledFor,
            scheduledForMs:     scheduleStartMs,
            scheduleWindowMins: scheduleWindowMins,
            // ── Server-locked pricing — the client never writes these ────────
            calloutFee:       q.calloutFee,
            travelFee:        q.travelFee,
            inspectionFee:    q.inspectionFee,
            travelEstimated:  q.travelEstimated,
            pricingQuoteToken: quoteToken,
            calloutPaid:      false,
            quoteRevisionCount: 0,
            createdAt:    n,
            updatedAt:    n,
        });
        return q;
    });

    // ── Notify pre-matched artisan (dispatch handles the rest otherwise) ─────
    //
    // The message names the appointment when there is one. An artisan deciding
    // whether to take a job needs to know WHEN before they can answer, and a
    // request that reads the same whether it is for this afternoon or for a week
    // on Tuesday is not a decidable request.
    if (quote.artisanId) {
        const when = scheduleStartMs === null
            ? 'as soon as you can take it'
            : bookingSchedule.formatAppointment(scheduleStartMs, scheduleWindowMins);
        await sendArtisanNotification(quote.artisanId, {
            type:      'Bookings',
            title:     scheduleStartMs === null ? 'New Inspection Request' : 'New Scheduled Inspection',
            message:   scheduleStartMs === null
                ? `A customer has requested an inspection visit for a ${quote.category} issue. Accept to schedule it.`
                : `A customer has booked a ${quote.category} inspection for ${when}. Accept to hold the slot.`,
            actionUrl: 'dashboard.html',
            bookingId,
        }).catch(() => {});
    }

    console.log(`[pricing] Inspection booking created: ${bookingId} cat=${quote.category} callout=GHS${quote.calloutFee} artisan=${quote.artisanId || 'DISPATCH'} when=${scheduledFor || 'ASAP'}`);
    return { bookingId, calloutFee: quote.calloutFee, scheduledFor };
}

// ─────────────────────────────────────────────────────────────────────────────
// payCalloutFee
//
// Called by: customer app, once an artisan has accepted the inspection request.
// Payload:  { bookingId }
// Escrows the locked callout fee (kind 'callout' — separate lock from the job
// escrow) and moves the booking to inspection_scheduled.
// ─────────────────────────────────────────────────────────────────────────────
async function payCalloutFee(auth, { bookingId }) {
    if (!bookingId) throw new Error('bookingId is required.');

    const bookingRef  = db().collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error('Booking not found.');
    const preBooking = bookingSnap.data();

    if (preBooking.customerId !== auth.uid) throw new Error('Not authorised for this booking.');
    if (preBooking.track !== 'inspection')  throw new Error('This booking does not use the inspection flow.');
    if (preBooking.status !== 'accepted')   throw new Error(`Callout fee is payable once an artisan accepts (booking is ${preBooking.status}).`);
    if (preBooking.calloutPaid)             throw new Error('Callout fee already paid.');

    const calloutFee = Number(preBooking.calloutFee || 0);
    if (calloutFee <= 0) throw new Error('This booking has no valid callout fee.');

    // ── Claim the transition atomically BEFORE moving money (F4) ──────────────
    // Stamps status:inspection_scheduled + calloutPaid:true in one compare-and-set
    // so a concurrent artisan-cancel / double-tap cannot both proceed. If someone
    // already advanced the booking (or paid), the claim throws and no funds move.
    // The escrow hold is idempotent, so re-stamping calloutPaid before the hold
    // is safe: a retry re-enters the idempotent hold and reaches the same escrowId.
    const booking = await claimBookingTransition(bookingRef, {
        authUid: auth.uid,
        party:   'customer',
        fromStatuses: ['accepted'],
        guard: (b) => b.track === 'inspection' && !b.calloutPaid,
        guardMessage: 'Callout fee already paid or booking no longer accepting payment.',
        patch: { status: 'inspection_scheduled', calloutPaid: true, calloutPaidAt: nowIso() },
    });

    // Escrow hold — idempotent via _escrow_locks/{bookingId}_callout
    let escrowId;
    try {
        ({ escrowId } = await escrow.holdFundsForBooking({
            bookingId,
            customerId: booking.customerId,
            artisanId:  booking.artisanId || null,
            amount:     calloutFee,
            callerAuth: auth,
            kind:       'callout',
        }));
    } catch (holdErr) {
        // Wallet couldn't cover it (or hold failed): roll the claim back so the
        // customer can top up and retry — the booking returns to 'accepted'.
        await bookingRef.update({
            status: 'accepted', calloutPaid: false,
            calloutPaidAt: FieldValue.delete(), updatedAt: nowIso(),
        }).catch(() => {});
        throw holdErr;
    }

    await bookingRef.update({
        calloutEscrowId: escrowId,
        updatedAt:       nowIso(),
    });

    await sendArtisanNotification(booking.artisanId, {
        type:      'Bookings',
        title:     'Inspection Confirmed',
        message:   `The callout fee of GHS ${calloutFee.toFixed(2)} is secured in escrow. Head over, inspect, and submit your quote in the app.`,
        actionUrl: 'dashboard.html',
        bookingId,
    }).catch(() => {});

    console.log(`[pricing] Callout paid: booking=${bookingId} amount=GHS${calloutFee} escrow=${escrowId}`);
    return { escrowId, calloutFee };
}

// ─────────────────────────────────────────────────────────────────────────────
// Arrival before assessment
//
// The callout fee pays for a VISIT, and completing the inspection is what lets
// that fee reach the artisan (quote approval, final rejection, quote expiry or a
// customer cancellation all release it once the inspection is done). So it is
// accepted only once the visit has demonstrably begun:
//   • the artisan set out — inspection_scheduled → en_route, which
//     firestore.rules (scheduleWindowOpen) refuse before the booked window;
//   • and recorded arrival — en_route → in_progress, which stamps arrivedAt.
// The window is checked again here, so a booking cannot be completed ahead of its
// slot whatever route brought it to in_progress. Arrival is the artisan's own
// record (there is no location proof in the product); the customer can still
// dispute an inspection that did not happen.
//
// Returns null when completion is allowed, otherwise the reason to show.
// ─────────────────────────────────────────────────────────────────────────────
function inspectionCompletionBlocker(booking, nowMs = Date.now()) {
    const b = booking || {};
    if (b.track !== 'inspection') return 'This booking does not use the inspection flow.';
    if (!b.calloutPaid)           return 'Callout fee has not been paid yet.';
    // in_progress after an approved quote is the WORK visit, not the inspection.
    if (b.quoteApproved)          return 'The inspection is already complete — this booking is in the work phase.';
    if (b.status === 'inspection_scheduled') {
        return 'Set out and mark yourself arrived at the customer before completing the inspection.';
    }
    if (b.status === 'en_route') {
        return 'Mark yourself arrived at the customer before completing the inspection.';
    }
    if (b.status !== 'in_progress') return `Cannot complete inspection — booking is ${b.status}.`;
    if (!b.arrivedAt) {
        return 'Your arrival was not recorded. Mark yourself arrived before completing the inspection.';
    }
    const gate = bookingSchedule.canStartWork(b, nowMs);
    if (!gate.allowed) return gate.reason || 'This visit is not due yet.';
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// completeInspection
//
// Called by: artisan app, on site after assessing the problem.
// Payload:  { bookingId, findings? }
// Pure status transition — NO money moves here. The callout escrow settles on
// customer quote decisions or scheduled timeouts, never on artisan say-so.
// Allowed only from in_progress, after a recorded arrival (see above).
// ─────────────────────────────────────────────────────────────────────────────
async function completeInspection(auth, { bookingId, findings = '' }) {
    if (!bookingId) throw new Error('bookingId is required.');

    const bookingRef  = db().collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error('Booking not found.');
    const preBooking = bookingSnap.data();

    if (preBooking.artisanId !== auth.uid) throw new Error('Not authorised for this booking.');
    const blocker = inspectionCompletionBlocker(preBooking);
    if (blocker) throw new Error(blocker);

    // Atomic claim: no money moves here, but this prevents a double-fire and a
    // race against a concurrent cancellation from both writing. The full
    // prerequisite check runs again on the transaction's own snapshot; throwing
    // from the guard aborts the transaction with the specific reason.
    const booking = await claimBookingTransition(bookingRef, {
        authUid: auth.uid,
        party:   'artisan',
        fromStatuses: ['in_progress'],
        guard: (b) => {
            const reason = inspectionCompletionBlocker(b);
            if (reason) throw new Error(reason);
            return true;
        },
        patch: {
            status:             'inspection_done',
            inspectionDoneAt:   nowIso(),
            inspectionFindings: String(findings || '').trim().slice(0, 1000),
        },
    });

    await sendNotification(booking.customerId, {
        type:      'Bookings',
        title:     'Inspection Complete',
        message:   `${booking.artisanName || 'Your artisan'} has finished assessing the problem. Your quote is on the way.`,
        actionUrl: 'booking.html',
        bookingId,
    }).catch(() => {});

    console.log(`[pricing] Inspection done: booking=${bookingId} artisan=${auth.uid}`);
    return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// calloutDecision — WHO a still-held callout fee belongs to. (AR-07)
//
// The lifecycle CFs that settle a callout carry their own verdict and keep it
// (quote approved/finally rejected → artisan; artisan cancelled, no-show, no
// quote → customer). Everything else — a booking COMPLETING, an out-of-band
// cancellation (admin, system), the stuck-escrow sweep, a resolved dispute —
// asks this one function, so the three hand-written copies of "was it
// delivered?" that used to disagree cannot drift again.
//
// The rule, for both tracks: the fee pays for the VISIT. It belongs to the
// artisan once the visit was genuinely delivered, and is the customer's
// otherwise.
//   inspection  delivered = the inspection was completed (inspectionDoneAt,
//               inspection_done / quoted, a quote approved, or completed)
//   emergency   delivered = the artisan ARRIVED (arrivedAt, or the booking
//               reached in_progress / awaiting / completed). A quote alone is
//               not a visit: an emergency quote is sent from 'accepted',
//               before travel, so cancelling after one refunds the customer.
//   disputed    held — resolveDispute decides, never a timer or a trigger.
//   resolved    the administrator's resolution (calloutResolution, else
//               full_refund → customer, release_artisan → artisan); a partial
//               resolution with no callout decision is held for an admin.
//
// Before this, an emergency fee was settled ONLY on cancellation: completion
// released the job escrow (kind 'job') and nothing else, so a delivered
// emergency fee sat held until autoReleaseEscrow found it seven days later.
//
// Returns { to: 'artisan'|'customer'|null, hold: boolean, why }.
// ─────────────────────────────────────────────────────────────────────────────
function calloutDecision(booking, { event = null, priorStatus = null } = {}) {
    const b = booking || {};
    if (!b.calloutPaid || !b.calloutEscrowId || b.calloutSettled) {
        return { to: null, hold: false, why: 'nothing_to_settle' };
    }
    const status = String(b.status || '').toLowerCase();
    const prior  = String(priorStatus || '').toLowerCase();

    if (status === 'disputed') return { to: null, hold: true, why: 'disputed' };
    if (status === 'resolved') {
        if (b.calloutResolution === 'artisan' || b.calloutResolution === 'customer') {
            return { to: b.calloutResolution, hold: false, why: 'dispute_resolution' };
        }
        if (b.resolution === 'full_refund')     return { to: 'customer', hold: false, why: 'dispute_full_refund' };
        if (b.resolution === 'release_artisan') return { to: 'artisan',  hold: false, why: 'dispute_release' };
        return { to: null, hold: true, why: 'dispute_needs_callout_decision' };
    }

    const reached = (list) => list.includes(status) || list.includes(prior);
    let delivered;
    if (b.track === 'emergency') {
        delivered = !!b.arrivedAt || reached(['in_progress', 'awaiting', 'completed']);
    } else {
        delivered = !!b.inspectionDoneAt || b.quoteApproved === true ||
                    reached(['inspection_done', 'quoted', 'completed']);
    }
    if (event === 'completed') {
        return { to: 'artisan', hold: false, why: 'job_completed' };
    }
    return delivered
        ? { to: 'artisan',  hold: false, why: 'visit_delivered' }
        : { to: 'customer', hold: false, why: 'visit_not_delivered' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Callout settlement helper — release to artisan or refund to customer.
// settleTo: 'artisan' | 'customer'
// Never throws — records failures on the booking for the sweeper to retry.
// ─────────────────────────────────────────────────────────────────────────────
async function settleCallout(booking, bookingId, settleTo, why) {
    if (!booking.calloutPaid || !booking.calloutEscrowId || booking.calloutSettled) return true;
    try {
        if (settleTo === 'artisan') {
            await escrow.releaseEscrow(booking.calloutEscrowId, { releasedBy: `system:${why}`, callerAuth: null });
        } else {
            await escrow.refundEscrow(booking.calloutEscrowId, { reason: why, refundedBy: 'system', callerAuth: null });
        }
        await db().collection('bookings').doc(bookingId).update({
            calloutSettled: settleTo === 'artisan' ? 'released' : 'refunded',
            calloutSettlePending: FieldValue.delete(),
            calloutSettleReason:  FieldValue.delete(),
            calloutSettledAt: nowIso(),
        });
        return true;
    } catch (err) {
        // ── Terminal-state reconciliation (F5) ────────────────────────────────
        // If the escrow was ALREADY moved out of 'held' — by a prior partial
        // success (money moved, booking update failed) or a competing settlement
        // path — releaseEscrow/refundEscrow throw "Cannot release/refund ...
        // status is <x>". That is NOT a retryable failure: the money is settled.
        // Record the terminal outcome and clear the pending flag so the hourly
        // sweeper stops retrying forever (the retry-poisoning bug). Without this,
        // calloutSettlePending never clears and checkBookingTimeouts loops on it.
        const msg = err.message || '';
        const alreadyMoved = /released|refunded|Cannot (release|refund)/i.test(msg);
        if (alreadyMoved) {
            const terminal = await _readEscrowStatus(booking.calloutEscrowId);
            if (terminal === 'released' || terminal === 'refunded') {
                console.warn(`[pricing] Callout escrow ${booking.calloutEscrowId} already ${terminal} — reconciling booking=${bookingId}.`);
                await db().collection('bookings').doc(bookingId).update({
                    calloutSettled:       terminal,
                    calloutSettledAt:     nowIso(),
                    calloutSettlePending: FieldValue.delete(),
                    calloutSettleReason:  FieldValue.delete(),
                }).catch(() => {});
                return true;   // terminal — do not retry
            }
        }
        console.error(`[pricing] Callout settlement failed (${settleTo}, ${why}) booking=${bookingId}:`, msg);
        await db().collection('bookings').doc(bookingId)
            .update({ calloutSettlePending: settleTo, calloutSettleReason: why })
            .catch(() => {});
        return false;
    }
}

// Read an escrow doc's status (for terminal-state reconciliation). Returns null
// on any error so the caller falls back to the retry path.
async function _readEscrowStatus(escrowId) {
    try {
        const snap = await db().collection('escrow').doc(escrowId).get();
        return snap.exists ? (snap.data().status || null) : null;
    } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// cancelInspectionBooking
//
// Called by: customer OR artisan app.
// Payload:  { bookingId, reason? }
// Fair settlement:
//   artisan cancels          → customer refunded (artisan abandoned the job)
//   customer cancels BEFORE  inspection_done → refund (nothing delivered)
//   customer cancels AFTER   inspection_done → release (inspection delivered)
// Blocked after quote approval — job escrow disputes/refunds own that path.
// ─────────────────────────────────────────────────────────────────────────────
async function cancelInspectionBooking(auth, { bookingId, reason = '' }) {
    if (!bookingId) throw new Error('bookingId is required.');

    const bookingRef  = db().collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error('Booking not found.');
    const preBooking = bookingSnap.data();

    const isCustomer = preBooking.customerId === auth.uid;
    const isArtisan  = preBooking.artisanId  === auth.uid;
    if (!isCustomer && !isArtisan)         throw new Error('Not authorised for this booking.');
    if (preBooking.track !== 'inspection') throw new Error('This booking does not use the inspection flow.');
    if (preBooking.quoteApproved)          throw new Error('The quote is already approved — use the dispute/refund flow instead.');

    const cancellable = ['pending', 'accepted', 'inspection_scheduled', 'en_route', 'in_progress', 'inspection_done', 'quoted'];
    if (!cancellable.includes(preBooking.status)) {
        throw new Error(`Cannot cancel — booking is ${preBooking.status}.`);
    }

    // ── Claim the cancellation atomically BEFORE settling the callout (F4) ────
    // Writes status:cancelled + who/why in one compare-and-set. This is the
    // serialization point that stops a concurrent approveJobQuote from holding a
    // job escrow on a booking this call is cancelling (and vice-versa): whichever
    // claims first wins; the loser re-reads a status outside its fromStatuses and
    // aborts. settleCallout below is itself idempotent (skips if already settled).
    const booking = await claimBookingTransition(bookingRef, {
        authUid: auth.uid,
        party:   'any',
        fromStatuses: cancellable,
        guard: (b) => b.track === 'inspection' && !b.quoteApproved,
        guardMessage: 'The quote is already approved — use the dispute/refund flow instead.',
        patch: {
            status:             'cancelled',
            cancellationReason: String(reason || '').trim().slice(0, 300) || (isArtisan ? 'Cancelled by artisan' : 'Cancelled by customer'),
            cancelledBy:        isArtisan ? 'artisan' : 'customer',
            cancelledAt:        nowIso(),
        },
    });

    const inspectionDelivered = ['inspection_done', 'quoted'].includes(booking.status);
    const settleTo = (isCustomer && inspectionDelivered) ? 'artisan' : 'customer';

    await settleCallout(booking, bookingId, settleTo, isArtisan ? 'artisan_cancelled' : 'customer_cancelled');

    const notifyOther = isArtisan
        ? sendNotification(booking.customerId, {
              type: 'Bookings', title: 'Booking Cancelled',
              message: 'The artisan cancelled your inspection. Any callout fee paid has been refunded to your wallet.',
              actionUrl: 'booking.html', bookingId,
          })
        : (booking.artisanId
            ? sendArtisanNotification(booking.artisanId, {
                  type: 'Bookings', title: 'Booking Cancelled',
                  message: inspectionDelivered
                      ? 'The customer cancelled after your inspection. The callout fee has been released to you.'
                      : 'The customer cancelled the inspection request.',
                  actionUrl: 'dashboard.html', bookingId,
              })
            : Promise.resolve());
    await notifyOther.catch(() => {});

    console.log(`[pricing] Inspection booking cancelled: ${bookingId} by=${isArtisan ? 'artisan' : 'customer'} settle=${settleTo}`);
    return { success: true, calloutSettledTo: booking.calloutPaid ? settleTo : null };
}

// ─────────────────────────────────────────────────────────────────────────────
// checkBookingTimeouts — scheduled sweeper (hourly)
//
//   quoted            > 48 h → customer ghosted a delivered quote
//                              → callout released to artisan, booking cancelled
//   inspection_done   > 24 h → artisan never submitted a quote
//                              → callout refunded to customer, booking cancelled
//   inspection_scheduled > 72 h → artisan never completed the inspection
//                              → callout refunded to customer, booking cancelled
//   calloutSettlePending     → previous settlement failed → retried
//
// It also carries the appointment reminder sweep (sendAppointmentReminders),
// which rides this scheduler rather than adding a second deployed function —
// the maxInstances:1 binding makes an extra Cloud Run service expensive, and
// the cadence is already right.
//
// NOTE on the two calloutPaidAt-based sweeps: their clock starts at the
// APPOINTMENT when the booking has one (afterAppointment). Measuring 72 hours
// from payment would auto-cancel and refund any visit booked more than three
// days out, before it ever happened.
//
// All timestamp fields compared are ISO-8601 strings (lexicographic-safe).
// Composite indexes required — see firestore.indexes.json.
// ─────────────────────────────────────────────────────────────────────────────
async function checkBookingTimeouts() {
    const cutoffIso = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();
    const bookings  = db().collection('bookings');

    const sweeps = [
        {
            label: 'quote_expired', settleTo: 'artisan',
            query: bookings.where('status', '==', 'quoted')
                           .where('quoteSubmittedAt', '<=', cutoffIso(QUOTE_EXPIRY_HOURS)).limit(50),
            customerMsg: 'Your quote expired without a response, so the booking was closed. The callout fee covers the completed inspection.',
            artisanMsg:  'The customer did not respond to your quote in time. The booking was closed and the callout fee released to you.',
        },
        {
            label: 'no_quote_submitted', settleTo: 'customer',
            query: bookings.where('status', '==', 'inspection_done')
                           .where('inspectionDoneAt', '<=', cutoffIso(NO_QUOTE_HOURS)).limit(50),
            customerMsg: 'The artisan did not submit a quote after the inspection. Your callout fee has been refunded.',
            artisanMsg:  'You did not submit a quote within 24 hours of the inspection. The booking was closed and the callout fee refunded to the customer.',
        },
        {
            label: 'inspection_not_completed', settleTo: 'customer', afterAppointment: true,
            query: bookings.where('status', '==', 'inspection_scheduled')
                           .where('calloutPaidAt', '<=', cutoffIso(STALE_INSPECTION_HRS)).limit(50),
            customerMsg: 'The inspection was not carried out in time. Your callout fee has been refunded.',
            artisanMsg:  'The inspection was not completed within 72 hours. The booking was closed and the callout fee refunded.',
        },
        // ── F6: two lifecycle gaps that previously had NO sweep ──────────────
        {
            // Artisan accepted but the customer never paid the callout fee (F2's
            // dead-end scenario). Nothing is escrowed, so there is no callout to
            // settle — just close the booking so it stops clogging the artisan's
            // active queue. onlyInspection: filtered in code because 'accepted' is
            // shared with the legacy track (which has no callout to wait on).
            label: 'callout_unpaid', settleTo: null, onlyInspection: true, requireUnpaid: true,
            query: bookings.where('status', '==', 'accepted')
                           .where('acceptedAt', '<=', cutoffIso(UNPAID_CALLOUT_HRS)).limit(50),
            customerMsg: 'Your inspection request expired because the callout fee was not paid. Nothing was charged — feel free to book again.',
            artisanMsg:  'A customer did not pay the callout fee in time, so the inspection request was closed.',
        },
        {
            // Artisan tapped "En Route"/started the inspection but never completed
            // it — the booking left 'inspection_scheduled' so the 72h stale-inspection
            // sweep above no longer catches it. Same fairness: refund the customer.
            label: 'inspection_started_stale', settleTo: 'customer', onlyInspection: true,
            afterAppointment: true,
            query: bookings.where('status', 'in', ['en_route', 'in_progress'])
                           .where('calloutPaidAt', '<=', cutoffIso(STALE_INSPECTION_HRS)).limit(50),
            customerMsg: 'The inspection was started but not completed in time. Your callout fee has been refunded.',
            artisanMsg:  'An inspection you started was not completed within 72 hours, so it was closed and the callout fee refunded.',
        },
    ];

    for (const sweep of sweeps) {
        const snap = await sweep.query.get().catch((err) => {
            console.error(`[pricing] Timeout sweep query failed (${sweep.label}):`, err.message);
            return null;
        });
        if (!snap || snap.empty) continue;

        console.log(`[pricing] Timeout sweep ${sweep.label}: ${snap.size} booking(s)`);
        for (const doc of snap.docs) {
            const booking = doc.data();
            try {
                // Some sweeps query statuses shared with the legacy track
                // ('accepted', 'en_route', 'in_progress'). Filter in code so a
                // legacy booking is never swept by an inspection-only rule, and
                // so callout_unpaid only fires while the callout is genuinely unpaid.
                if (sweep.onlyInspection && booking.track !== 'inspection') continue;
                if (sweep.requireUnpaid && booking.calloutPaid) continue;

                // ── An unpriceable quote was not "ghosted" (AR-08) ─────────────
                // A malformed legacy quote can never be approved, so letting it
                // expire into a cancellation would pay the callout fee to the
                // artisan for a decision the customer could not make. Withdraw
                // it for correction instead — no money moves, no revision used.
                if (sweep.label === 'quote_expired') {
                    const quotes = require('./quotes');
                    const stored = quotes.storedQuoteCheck(booking);
                    if (!stored.ok) {
                        try {
                            await claimBookingTransition(doc.ref, {
                                authUid: null, party: 'any', fromStatuses: ['quoted'],
                                patch: quotes.voidQuotePatch(booking, stored.problems),
                            });
                            await quotes.notifyQuoteVoided(booking, doc.id);
                            console.warn(`[pricing] Invalid expired quote voided, not settled: booking=${doc.id} problems=${stored.problems.join(',')}`);
                        } catch {
                            console.log(`[pricing] Quote void skipped booking=${doc.id} — status changed before claim.`);
                        }
                        continue;
                    }
                }
                // A withdrawn quote restarts the artisan's time to send a new one.
                if (sweep.label === 'no_quote_submitted' && booking.quoteVoidedAt &&
                    Date.parse(booking.quoteVoidedAt) > Date.now() - NO_QUOTE_HOURS * 3600000) {
                    continue;
                }

                // ── The stale clock starts at the APPOINTMENT, not at payment ─
                //
                // These two sweeps ask "has the artisan had long enough to do
                // this inspection?" and measured it from calloutPaidAt, because
                // before scheduling existed the visit always followed payment
                // immediately. It no longer does. A customer who books a slot
                // ten days out and secures it today would otherwise have their
                // booking auto-cancelled and refunded on day three — punishing
                // an artisan for honouring the appointment they were given, and
                // silently deleting the customer's booking before it happened.
                //
                // For a scheduled booking the artisan's clock starts when the
                // window closes. Unscheduled bookings are untouched: no
                // appointment means the old behaviour, exactly.
                if (sweep.afterAppointment) {
                    const appt = bookingSchedule.resolveSchedule(booking);
                    if (appt.scheduled &&
                        Date.now() < appt.endMs + STALE_INSPECTION_HRS * 3600000) {
                        continue;
                    }
                }

                // Claim the cancellation atomically (F4/F6): re-check the status
                // inside a transaction so we never cancel a booking a customer
                // paid / an artisan completed in the gap since the query snapshot.
                let claimed;
                try {
                    claimed = await claimBookingTransition(doc.ref, {
                        authUid: null,
                        party:   'any',
                        fromStatuses: [booking.status],
                        patch: {
                            status:             'cancelled',
                            cancellationReason: sweep.label,
                            cancelledBy:        'system',
                            cancelledAt:        nowIso(),
                        },
                    });
                } catch {
                    // Booking advanced before we could claim it — skip; a later
                    // sweep or the relevant CF now owns it.
                    console.log(`[pricing] Timeout skip ${sweep.label} booking=${doc.id} — status changed before claim.`);
                    continue;
                }

                // Settle the callout only when the sweep specifies a direction
                // AND funds are actually escrowed. callout_unpaid has settleTo=null.
                if (sweep.settleTo && claimed.track === 'inspection') {
                    await settleCallout(claimed, doc.id, sweep.settleTo, sweep.label);
                }
                await sendNotification(booking.customerId, {
                    type: 'Bookings', title: 'Booking Closed',
                    message: sweep.customerMsg, actionUrl: 'booking.html', bookingId: doc.id,
                }).catch(() => {});
                if (booking.artisanId) {
                    await sendArtisanNotification(booking.artisanId, {
                        type: 'Bookings', title: 'Booking Closed',
                        message: sweep.artisanMsg, actionUrl: 'dashboard.html', bookingId: doc.id,
                    }).catch(() => {});
                }
            } catch (err) {
                console.error(`[pricing] Timeout handling failed booking=${doc.id} (${sweep.label}):`, err.message);
            }
        }
    }

    // ── Appointment reminders ────────────────────────────────────────────────
    //
    // A scheduled booking that nobody is reminded about is a booking both sides
    // forget. This rides the existing scheduler rather than adding a second
    // deployed function: the sweep below already runs on the same cadence, and
    // one more indexed query is cheaper than another Cloud Run service against
    // the maxInstances:1 binding.
    //
    // Idempotency is scheduleReminderSentAt, set in the SAME update that would
    // let a second run fire — so a retry, an overlapping invocation or a
    // redeploy cannot double-notify. It is a server-only field
    // (bookingSystemFields in firestore.rules), so a client cannot clear it to
    // farm notifications.
    await sendAppointmentReminders(bookings).catch(err =>
        console.error('[pricing] Appointment reminder sweep failed:', err.message));

    // ── Retry previously failed callout settlements ──────────────────────────
    const retrySnap = await bookings.where('calloutSettlePending', 'in', ['artisan', 'customer'])
        .limit(25).get().catch(() => null);
    if (retrySnap && !retrySnap.empty) {
        for (const doc of retrySnap.docs) {
            const booking = doc.data();
            const ok = await settleCallout(booking, doc.id, booking.calloutSettlePending, booking.calloutSettleReason || 'retry');
            if (ok) {
                await doc.ref.update({
                    calloutSettlePending: FieldValue.delete(),
                    calloutSettleReason:  FieldValue.delete(),
                }).catch(() => {});
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// sendAppointmentReminders
//
// Notifies both parties ~2 hours before a booked arrival window (REMINDER_LEAD_MS
// in the schedule module). Only for bookings that are actually going to happen:
// a cancelled or completed booking is not an appointment, and a booking still
// waiting on an artisan or a callout fee has nothing to remind anyone about yet.
//
// No composite index needed: this is a range on ONE field, which Firestore
// serves from the automatic single-field index. Status is filtered in code
// deliberately — adding it to the query would force a composite index AND, more
// importantly, a booking whose scheduledForMs is null never matches the range at
// all, so immediate bookings are excluded by the data rather than by a filter.
// ─────────────────────────────────────────────────────────────────────────────
const REMINDABLE_STATUSES = ['accepted', 'inspection_scheduled', 'quoted'];

async function sendAppointmentReminders(bookings) {
    const now = Date.now();

    const snap = await bookings
        .where('scheduledForMs', '>',  now)
        .where('scheduledForMs', '<=', now + bookingSchedule.REMINDER_LEAD_MS)
        .limit(100)
        .get();

    if (snap.empty) return;

    for (const doc of snap.docs) {
        const b = doc.data();
        if (b.scheduleReminderSentAt) continue;
        if (!REMINDABLE_STATUSES.includes(String(b.status || '').toLowerCase())) continue;

        const when = bookingSchedule.formatAppointment(b.scheduledForMs, b.scheduleWindowMins, now);
        const svc  = b.serviceType || b.category || 'service';

        // Claim first. If this write loses a race the other invocation already
        // sent it, and the customer hears about their appointment once.
        let claimed = false;
        try {
            await db().runTransaction(async (txn) => {
                const live = await txn.get(doc.ref);
                if (!live.exists || live.data().scheduleReminderSentAt) return;
                txn.update(doc.ref, { scheduleReminderSentAt: nowIso() });
                claimed = true;
            });
        } catch (err) {
            console.error(`[pricing] Reminder claim failed booking=${doc.id}: ${err.message}`);
            continue;
        }
        if (!claimed) continue;

        if (b.customerId) {
            await sendNotification(b.customerId, {
                type:      'Bookings',
                title:     'Your visit is coming up',
                message:   `Your ${svc} visit is booked for ${when}. Please make sure someone can let the professional in.`,
                actionUrl: `book-request.html?resume=${doc.id}`,
                metadata:  { bookingId: doc.id },
            }).catch(() => {});
        }
        if (b.artisanId) {
            await sendArtisanNotification(b.artisanId, {
                type:      'Bookings',
                title:     'Appointment coming up',
                message:   `You committed to a ${svc} visit for ${when}. ${b.address ? `Address: ${String(b.address).slice(0, 120)}` : ''}`.trim(),
                actionUrl: `job.html?id=${doc.id}`,
                metadata:  { bookingId: doc.id },
            }).catch(() => {});
        }
        console.log(`[pricing] Appointment reminder sent: booking=${doc.id} when=${when}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// seedPricingConfig — admin utility. Creates missing pricing_config docs with
// sensible Ghana-market defaults. Never overwrites an existing category doc,
// so admin tuning survives re-runs. Admin gating happens in the index.js wrapper.
// ─────────────────────────────────────────────────────────────────────────────
async function seedPricingConfig() {
    let created = 0, skipped = 0;
    for (const category of CATALOG_CATEGORY_IDS) {
        const ref  = db().collection('pricing_config').doc(category);
        const snap = await ref.get();
        if (snap.exists) { skipped++; continue; }
        await ref.set({
            ...PRICING_DEFAULTS,
            inspectionFeeGHS: SEED_INSPECTION_FEES[category] ?? PRICING_DEFAULTS.inspectionFeeGHS,
            category,
            currency:  'GHS',
            active:    true,
            createdAt: nowIso(),
            updatedAt: nowIso(),
        });
        created++;
    }
    console.log(`[pricing] Seed complete: created=${created} skipped=${skipped}`);
    return { created, skipped };
}

module.exports = {
    computeEmergencyCallout,
    payEmergencyCallout,
    // Exported for tests: the formula must be provable in isolation.
    applyCalloutFormula,
    getPricingQuote,
    createInspectionBooking,
    payCalloutFee,
    completeInspection,
    // Exported for tests: the arrival/slot prerequisites must be provable alone.
    inspectionCompletionBlocker,
    cancelInspectionBooking,
    checkBookingTimeouts,
    seedPricingConfig,
    settleCallout,
    calloutDecision,
    claimBookingTransition,
    // Exported for tests: reminder idempotency has to be provable without
    // waiting two hours for a real appointment.
    sendAppointmentReminders,
    isoToScheduleRequest,
};
