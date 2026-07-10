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
const PRICING_DEFAULTS = Object.freeze({
    inspectionFeeGHS: 50,   // fixed component per category
    perKmGHS:         2.5,  // travel rate beyond the free radius
    freeRadiusKm:     3,    // no travel charge within this distance
    maxTravelGHS:     60,   // travel component cap
    flatTravelGHS:    10,   // used when artisan/coords unknown (dispatch track)
    maxCalloutGHS:    150,  // absolute callout ceiling
});

// Category ids — keep in sync with shared/js/data/serviceCatalog.js
const CATALOG_CATEGORY_IDS = Object.freeze([
    'electrical', 'plumbing', 'carpentry', 'ac-repair',
    'welding', 'cleaning', 'painting', 'gardening',
]);

// Per-category inspection fee seeds (admin-tunable after seeding)
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

    // ── Travel component ─────────────────────────────────────────────────────
    let travelFee       = cfg.flatTravelGHS;
    let distanceKm      = null;
    let travelEstimated = true;

    if (artisanId) {
        const idxSnap = await db().collection('artisan_index').doc(String(artisanId)).get();
        const idx = idxSnap.exists ? idxSnap.data() : null;
        if (idx && Number.isFinite(idx.lat) && Number.isFinite(idx.lng)) {
            distanceKm      = fmt(haversineKm(lat, lng, idx.lat, idx.lng));
            travelEstimated = false;
            travelFee = distanceKm <= cfg.freeRadiusKm
                ? 0
                : Math.min((distanceKm - cfg.freeRadiusKm) * cfg.perKmGHS, cfg.maxTravelGHS);
        }
    }
    travelFee = fmt(travelFee);

    // ── Additive, capped, rounded up to a whole cedi ─────────────────────────
    const inspectionFee = fmt(cfg.inspectionFeeGHS);
    const calloutFee    = Math.ceil(Math.min(inspectionFee + travelFee, cfg.maxCalloutGHS));

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
// Payload:  { quoteToken, address, description, notes?, photos?, serviceLabel?, scheduledFor? }
// The booking document is written server-side with the token's locked fee.
// If the token carries an artisanId the booking is pre-matched; otherwise the
// dispatch engine (onBookingCreated) takes over via radius matching.
// ─────────────────────────────────────────────────────────────────────────────
async function createInspectionBooking(auth, {
    quoteToken, address, description, notes = '', photos = [],
    serviceLabel = '', scheduledFor = null,
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

    if (scheduledFor !== null) {
        const t = Date.parse(scheduledFor);
        if (Number.isNaN(t)) throw new Error('scheduledFor must be a valid date.');
        scheduledFor = new Date(t).toISOString();
    }

    const tokenRef   = db().collection('pricing_quotes').doc(quoteToken);
    const bookingId  = generateBookingId();
    const bookingRef = db().collection('bookings').doc(bookingId);

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
        txn.set(bookingRef, {
            bookingId,
            customerId:   auth.uid,
            artisanId:    q.artisanId || null,
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
            scheduledFor,
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
    if (quote.artisanId) {
        await sendArtisanNotification(quote.artisanId, {
            type:      'Bookings',
            title:     'New Inspection Request',
            message:   `A customer has requested an inspection visit for a ${quote.category} issue. Accept to schedule it.`,
            actionUrl: 'dashboard.html',
            bookingId,
        }).catch(() => {});
    }

    console.log(`[pricing] Inspection booking created: ${bookingId} cat=${quote.category} callout=GHS${quote.calloutFee} artisan=${quote.artisanId || 'DISPATCH'}`);
    return { bookingId, calloutFee: quote.calloutFee };
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
// completeInspection
//
// Called by: artisan app, on site after assessing the problem.
// Payload:  { bookingId, findings? }
// Pure status transition — NO money moves here. The callout escrow settles on
// customer quote decisions or scheduled timeouts, never on artisan say-so.
// ─────────────────────────────────────────────────────────────────────────────
async function completeInspection(auth, { bookingId, findings = '' }) {
    if (!bookingId) throw new Error('bookingId is required.');

    const bookingRef  = db().collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) throw new Error('Booking not found.');
    const preBooking = bookingSnap.data();

    if (preBooking.artisanId !== auth.uid) throw new Error('Not authorised for this booking.');
    if (preBooking.track !== 'inspection') throw new Error('This booking does not use the inspection flow.');
    if (!preBooking.calloutPaid)           throw new Error('Callout fee has not been paid yet.');
    if (!['inspection_scheduled', 'en_route', 'in_progress'].includes(preBooking.status)) {
        throw new Error(`Cannot complete inspection — booking is ${preBooking.status}.`);
    }

    // Atomic claim: no money moves here, but this prevents a double-fire and a
    // race against a concurrent cancellation from both writing.
    const booking = await claimBookingTransition(bookingRef, {
        authUid: auth.uid,
        party:   'artisan',
        fromStatuses: ['inspection_scheduled', 'en_route', 'in_progress'],
        guard: (b) => b.track === 'inspection' && !!b.calloutPaid,
        guardMessage: 'This inspection can no longer be completed.',
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
            label: 'inspection_not_completed', settleTo: 'customer',
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
    getPricingQuote,
    createInspectionBooking,
    payCalloutFee,
    completeInspection,
    cancelInspectionBooking,
    checkBookingTimeouts,
    seedPricingConfig,
    settleCallout,
    claimBookingTransition,
};
