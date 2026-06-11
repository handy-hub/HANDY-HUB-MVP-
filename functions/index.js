'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// HandyHub Firebase Cloud Functions — Financial System
//
// Deploy:
//   firebase deploy --only functions
//
// All secrets and env vars live in functions/.env (gitignored).
// Firebase Functions v2 reads this file at deploy time — no Blaze plan needed.
// ─────────────────────────────────────────────────────────────────────────────

const { initializeApp }    = require('firebase-admin/app');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated }            = require('firebase-functions/v2/firestore');
const { onSchedule }                   = require('firebase-functions/v2/scheduler');
const { FUNCTIONS_REGION }             = require('./config');

initializeApp();

// ── Financial modules ─────────────────────────────────────────────────────────
const escrow            = require('./financial/escrow');
const escrowAutoRelease = require('./financial/escrowAutoRelease');
const transfers         = require('./financial/transfers');
const webhooks          = require('./financial/webhooks');
const { checkRateLimit } = require('./middleware/rateLimiter');

// ── Artisan verification module ───────────────────────────────────────────────
const artisanVerif  = require('./artisanVerification');

// ── Artisan index module ──────────────────────────────────────────────────────
const artisanIndex = require('./artisanIndex');

// ── Booking lifecycle module ──────────────────────────────────────────────────
const bookingsModule = require('./bookings');

// ── Review lifecycle module ───────────────────────────────────────────────────
const reviewsModule  = require('./reviews');

// ── Dispatch engine module ────────────────────────────────────────────────────
const dispatchModule = require('./dispatch');

// ── Quote lifecycle module ────────────────────────────────────────────────────
const quotesModule = require('./quotes');

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK  —  Paystack → Firebase (public HTTPS endpoint)
// Add this URL to your Paystack dashboard → Settings → API Keys & Webhooks
// URL: https://{FUNCTIONS_REGION}-lamax-4fd82.cloudfunctions.net/paystackWebhook
// e.g. https://europe-west1-lamax-4fd82.cloudfunctions.net/paystackWebhook
// ─────────────────────────────────────────────────────────────────────────────
exports.paystackWebhook = onRequest(
    { region: FUNCTIONS_REGION, invoker: 'public' },
    (req, res) => webhooks.handlePaystackWebhook(req, res),
);

// ─────────────────────────────────────────────────────────────────────────────
// ESCROW — called from the booking flow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * holdBookingFunds — move customer funds into escrow when a booking is confirmed.
 *
 * Call from frontend (booking confirmation step):
 *   const hold = httpsCallable(functions, 'holdBookingFunds');
 *   await hold({ bookingId, artisanId, amount });
 */
exports.holdBookingFunds = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'holdBookingFunds');
    const { bookingId, artisanId, amount } = request.data;
    // artisanId may be null for dispatch-assigned bookings (artisan not yet selected).
    // escrow.holdFundsForBooking accepts null artisanId and the release will read the
    // artisanId from the escrow document when the booking is completed.
    _validate({ bookingId, amount }, ['bookingId', 'amount']);
    if (Number(amount) <= 0) throw new HttpsError('invalid-argument', 'Amount must be greater than 0.');

    try {
        return await escrow.holdFundsForBooking({
            bookingId,
            customerId:  request.auth.uid,
            artisanId:   artisanId || null,
            amount,
            callerAuth:  request.auth,
        });
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * releaseEscrow — release funds to artisan after booking completion.
 *
 * Call when BOTH parties confirm (or after auto-release timeout):
 *   const release = httpsCallable(functions, 'releaseEscrow');
 *   await release({ escrowId });
 */
exports.releaseEscrow = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'releaseEscrow');
    const { escrowId } = request.data;
    if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId is required.');

    try {
        await escrow.releaseEscrow(escrowId, {
            releasedBy: request.auth.uid,
            callerAuth: request.auth,   // Authorization: must be customer, artisan, or admin of this booking
        });
        return { released: true };
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * refundBooking — refund escrow back to customer.
 *
 * Call on cancellation or admin dispute resolution:
 *   const refund = httpsCallable(functions, 'refundBooking');
 *   await refund({ escrowId, reason });
 */
exports.refundBooking = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'refundBooking');
    const { escrowId, reason } = request.data;
    if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId is required.');

    try {
        await escrow.refundEscrow(escrowId, {
            reason:     reason || 'Booking cancelled',
            refundedBy: request.auth.uid,
            callerAuth: request.auth,   // Authorization: must be customer, artisan, or admin of this booking
        });
        return { refunded: true };
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * raiseDispute — freeze escrow while a dispute is under review.
 *
 *   const dispute = httpsCallable(functions, 'raiseDispute');
 *   await dispute({ escrowId, disputeId });
 */
exports.raiseDispute = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'raiseDispute');
    const { escrowId, disputeId } = request.data;
    if (!escrowId) throw new HttpsError('invalid-argument', 'escrowId is required.');

    try {
        await escrow.freezeEscrowForDispute(escrowId, {
            disputeId:  disputeId || null,
            raisedBy:   request.auth.uid,
            callerAuth: request.auth,   // Authorization: must be a party to this booking
        });
        return { frozen: true };
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// WITHDRAWALS — called from customer/artisan wallet pages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * processWithdrawal — customer withdraws available (non-escrowed) wallet balance.
 *
 *   const withdraw = httpsCallable(functions, 'processWithdrawal');
 *   const { data } = await withdraw({ amount, provider, phone });
 */
exports.processWithdrawal = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'processWithdrawal');
    const { amount, provider, phone } = request.data;
    _validate({ amount, provider, phone }, ['amount', 'provider', 'phone']);

    try {
        const result = await transfers.executeCustomerWithdrawal(request.auth.uid, {
            amountGHS:    Number(amount),
            provider,
            phone,
            customerName: request.data.customerName || null,
        });
        return result;
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * processArtisanWithdrawal — artisan withdraws their completed earnings.
 *
 *   const withdraw = httpsCallable(functions, 'processArtisanWithdrawal');
 *   const { data } = await withdraw({ amount, provider, phone });
 */
exports.processArtisanWithdrawal = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'processArtisanWithdrawal');
    const { amount, provider, phone } = request.data;
    _validate({ amount, provider, phone }, ['amount', 'provider', 'phone']);

    try {
        const result = await transfers.executeArtisanWithdrawal(request.auth.uid, {
            amountGHS:   Number(amount),
            provider,
            phone,
            artisanName: request.data.artisanName || null,
        });
        return result;
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ARTISAN INDEX — keeps artisan_index in sync with artisans collection
//
// syncArtisanIndex fires on every artisans/{artisanId} write.
// artisan_index is the search/dispatch layer — never queried by clients.
//
// backfillArtisanIndex — one-time admin migration.
// Run once after deploying this version to populate artisan_index for all
// artisans that have lat/lng. New artisans are indexed automatically by
// syncArtisanIndex from this point on.
//
//   const fn = httpsCallable(functions, 'backfillArtisanIndex');
//   const { data } = await fn({});
//   // { processed, skipped, errors, total }
// ─────────────────────────────────────────────────────────────────────────────
exports.syncArtisanIndex = artisanIndex.syncArtisanIndex;

exports.backfillArtisanIndex = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 540, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        const { ADMIN_EMAILS } = require('./config');
        if (!ADMIN_EMAILS.includes(request.auth.token?.email)) {
            throw new HttpsError('permission-denied', 'Super-admin access required.');
        }
        try {
            return await artisanIndex.runBackfill();
        } catch (err) {
            throw new HttpsError('internal', err.message);
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// ARTISAN VERIFICATION — admin-driven KYC approval workflow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * approveArtisan — admin approves a submitted verification request.
 *   const fn = httpsCallable(functions, 'approveArtisan');
 *   await fn({ artisanId, notes });
 */
exports.approveArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.approveArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * rejectArtisan — admin rejects with a mandatory reason.
 *   await fn({ artisanId, reason });
 */
exports.rejectArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.rejectArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * requestMoreInfo — request additional documents / info.
 *   await fn({ artisanId, notes });
 */
exports.requestMoreInfo = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.requestMoreInfo(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * suspendArtisan — suspend an approved artisan.
 *   await fn({ artisanId, reason });
 */
exports.suspendArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.suspendArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * reinstateArtisan — lift a suspension.
 *   await fn({ artisanId, notes });
 */
exports.reinstateArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.reinstateArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * onVerificationSubmitted — Firestore trigger fires when a new
 * verification_request document is created. Sends an admin alert and
 * acknowledges receipt to the artisan.
 */
exports.onVerificationSubmitted = onDocumentCreated(
    { document: 'verification_requests/{artisanId}', region: FUNCTIONS_REGION },
    (event) => artisanVerif.onVerificationSubmitted(event),
);

// ─────────────────────────────────────────────────────────────────────────────
// BOOKING LIFECYCLE — status-change notifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * onBookingStatusChanged — fires on any booking document update.
 * Sends notifications to the customer or artisan based on the new status:
 *   pending → accepted    : customer notified
 *   pending → rejected    : customer notified
 *   accepted → in_progress: customer notified
 *   * → completed         : both notified
 *   * → cancelled         : both notified
 */
exports.onBookingStatusChanged  = bookingsModule.onBookingStatusChanged;

// ─────────────────────────────────────────────────────────────────────────────
// REVIEW LIFECYCLE — atomic artisan rating update on new customer review
//
// onBookingReviewed
//   Fires when a customer writes their `rating` to a completed booking doc.
//   Uses a Firestore transaction to atomically update the artisan's rolling
//   average rating and reviewCount. Eliminates the client-side TOCTOU in the
//   deprecated artisanRepository.applyNewReview().
// ─────────────────────────────────────────────────────────────────────────────
exports.onBookingReviewed = reviewsModule.onBookingReviewed;

// ─────────────────────────────────────────────────────────────────────────────
// DISPATCH ENGINE — Uber/Bolt-style sequential artisan matching
//
// onBookingCreated       : fires when booking doc is created → first dispatch round
// checkExpiredDispatches : scheduled every 1 min → re-dispatches timed-out rounds
//
// Rejection + acceptance handling was previously a second onDocumentUpdated
// trigger (onBookingDispatchEvent). It is now called from within
// onBookingStatusChanged (bookings.js) so there is only one trigger per update.
// ─────────────────────────────────────────────────────────────────────────────
exports.onBookingCreated        = dispatchModule.onBookingCreated;
exports.checkExpiredDispatches  = dispatchModule.checkExpiredDispatches;

// ─────────────────────────────────────────────────────────────────────────────
// QUOTE LIFECYCLE — artisan submits quote, customer approves/rejects
//
// submitJobQuote  (artisan callable)
//   Artisan sends labour cost + optional materials list.
//   System calculates total and notifies customer.
//
// approveJobQuote  (customer callable)
//   Customer approves the quote → escrow holds full amount → artisan notified.
//
// rejectJobQuote  (customer callable)
//   Customer rejects → artisan notified, can resubmit revised quote.
// ─────────────────────────────────────────────────────────────────────────────

exports.submitJobQuote = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await quotesModule.submitJobQuote(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.approveJobQuote = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await quotesModule.approveJobQuote(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.rejectJobQuote = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await quotesModule.rejectJobQuote(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// ESCROW LIFECYCLE — automated release of expired escrow records
//
// autoReleaseEscrow
//   Scheduled: every 6 hours.
//   Queries escrow where status=='held' AND autoReleaseAt<=now, pages through
//   results in batches of 100, and calls releaseEscrow() or refundEscrow()
//   per document based on the associated booking's status.
//   Safe under repeated execution — idempotent by design.
//
// adminBackfillEscrowLocks (callable — admin only)
//   One-time migration: creates _escrow_locks documents for all pre-existing
//   "held" escrow records that were created before the C1 lock-document fix.
//   Call once after deploying the new escrow.js. Safe to re-run.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scheduled escrow auto-release.
 * Runs every 6 hours. Memory 512 MiB. Timeout 540 s.
 *
 * Writes observability docs to:
 *   _auto_release_runs/{runId}         — run summary (start, end, counts, status)
 *   _auto_release_failures/{escrowId}  — per-escrow failure details for admin review
 */
exports.autoReleaseEscrow = onSchedule(
    {
        schedule:        'every 6 hours',
        region:          FUNCTIONS_REGION,
        timeoutSeconds:  540,
        memory:          '512MiB',
    },
    async () => {
        await escrowAutoRelease.runAutoRelease();
    }
);

/**
 * Admin-callable one-time migration: backfill _escrow_locks for pre-existing escrows.
 * Only super-admins may call this — enforced inside backfillEscrowLocks().
 *
 *   const backfill = httpsCallable(functions, 'adminBackfillEscrowLocks');
 *   const { data } = await backfill({});
 *   // data → { processed, skipped, errors }
 */
exports.adminBackfillEscrowLocks = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 540, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        // Restrict to super-admins only — backfill touches all escrow records.
        const { ADMIN_EMAILS } = require('./config');
        const callerEmail = request.auth.token?.email;
        if (!ADMIN_EMAILS.includes(callerEmail)) {
            throw new HttpsError('permission-denied', 'Super-admin access required.');
        }
        try {
            return await escrow.backfillEscrowLocks();
        } catch (err) {
            throw new HttpsError('internal', err.message);
        }
    }
);

/**
 * backfillSearchKeywords — regenerate searchKeywords for all artisan documents.
 *
 * Run once after deploying the updated artisanRepository.js that auto-generates
 * keywords. Artisans registered with the old repository have searchKeywords: []
 * and are invisible in search. This function rebuilds their keyword arrays from
 * their current profile data (name, specialty, category, commonSearchPhrases).
 *
 * Safe to re-run — artisans with complete keyword sets are skipped.
 *
 *   const fn = httpsCallable(functions, 'backfillSearchKeywords');
 *   const { data } = await fn({});
 *   // data → { processed, skipped, errors, total }
 */
exports.backfillSearchKeywords = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 540, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        const { ADMIN_EMAILS } = require('./config');
        const callerEmail = request.auth.token?.email;
        if (!ADMIN_EMAILS.includes(callerEmail)) {
            throw new HttpsError('permission-denied', 'Super-admin access required.');
        }
        try {
            return await artisanVerif.backfillSearchKeywords(request.auth);
        } catch (err) {
            throw new HttpsError('internal', err.message);
        }
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// GEOHASH BACKFILL — one-time migration for existing artisans
//
// backfillGeohash
//   Iterates all artisan documents that have lat/lng but no geohash field,
//   computes the geohash, and writes it back. Safe to re-run.
//   Call once after deploying this version.
//
//   const fn = httpsCallable(functions, 'backfillGeohash');
//   const { data } = await fn({});
//   // data → { processed, skipped, errors, total }
// ─────────────────────────────────────────────────────────────────────────────
exports.backfillGeohash = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 540, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        const { ADMIN_EMAILS } = require('./config');
        if (!ADMIN_EMAILS.includes(request.auth.token?.email)) {
            throw new HttpsError('permission-denied', 'Super-admin access required.');
        }

        const { getFirestore } = require('firebase-admin/firestore');
        const { FIRESTORE_DB_ID } = require('./config');
        const db = getFirestore(FIRESTORE_DB_ID);

        // Same encoder as artisanRepository.js — no external dep needed in Node
        function geohashForPoint(lat, lng, precision = 6) {
            const B = '0123456789bcdefghjkmnpqrstuvwxyz';
            let minLat = -90, maxLat = 90, minLng = -180, maxLng = 180;
            let hash = '', bit = 0, even = true, ch = 0;
            while (hash.length < precision) {
                if (even) {
                    const mid = (minLng + maxLng) / 2;
                    if (lng >= mid) { ch = (ch << 1) | 1; minLng = mid; }
                    else            { ch <<= 1;            maxLng = mid; }
                } else {
                    const mid = (minLat + maxLat) / 2;
                    if (lat >= mid) { ch = (ch << 1) | 1; minLat = mid; }
                    else            { ch <<= 1;            maxLat = mid; }
                }
                even = !even;
                if (++bit === 5) { hash += B[ch]; bit = 0; ch = 0; }
            }
            return hash;
        }

        const snap = await db.collection('artisans').get();
        let processed = 0, skipped = 0, errors = 0;

        const BATCH_SIZE = 400;
        let batch = db.batch();
        let batchCount = 0;

        for (const doc of snap.docs) {
            const d = doc.data();
            const lat = d.lat ?? d.latitude ?? null;
            const lng = d.lng ?? d.longitude ?? null;

            if (typeof lat !== 'number' || typeof lng !== 'number') {
                skipped++;
                continue;
            }
            if (d.geohash) {
                skipped++;
                continue;
            }

            try {
                batch.update(doc.ref, { geohash: geohashForPoint(lat, lng) });
                batchCount++;
                processed++;

                if (batchCount >= BATCH_SIZE) {
                    await batch.commit();
                    batch = db.batch();
                    batchCount = 0;
                }
            } catch (e) {
                console.error(`[backfillGeohash] artisan=${doc.id}:`, e.message);
                errors++;
            }
        }

        if (batchCount > 0) await batch.commit();

        console.log(`[backfillGeohash] done — processed=${processed} skipped=${skipped} errors=${errors} total=${snap.size}`);
        return { processed, skipped, errors, total: snap.size };
    }
);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function _requireAuth(request) {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Authentication required.');
    }
}

function _validate(data, required) {
    for (const key of required) {
        if (data[key] === undefined || data[key] === null || data[key] === '') {
            throw new HttpsError('invalid-argument', `"${key}" is required.`);
        }
    }
}
