'use strict';

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// HandyHub Firebase Cloud Functions â€” Financial System
//
// Deploy:
//   firebase deploy --only functions
//
// All secrets and env vars live in functions/.env (gitignored).
// Firebase Functions v2 reads this file at deploy time â€” no Blaze plan needed.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const { initializeApp }    = require('firebase-admin/app');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated }            = require('firebase-functions/v2/firestore');
const { onSchedule }                   = require('firebase-functions/v2/scheduler');
const { FUNCTIONS_REGION }             = require('./config');

initializeApp();

// â”€â”€ Financial modules â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const escrow            = require('./financial/escrow');
const escrowAutoRelease = require('./financial/escrowAutoRelease');
const transfers         = require('./financial/transfers');
const webhooks          = require('./financial/webhooks');
const { checkRateLimit } = require('./middleware/rateLimiter');

const VALID_PROVIDERS = new Set(['mtn', 'telecel', 'airteltigo']);

// â”€â”€ Artisan verification module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const artisanVerif  = require('./artisanVerification');

// â”€â”€ Dispute resolution module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const disputesModule = require('./disputes');

// â”€â”€ Artisan index module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const artisanIndex = require('./artisanIndex');

// â”€â”€ Booking lifecycle module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const bookingsModule = require('./bookings');

// â”€â”€ Review lifecycle module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const reviewsModule  = require('./reviews');

// â”€â”€ Dispatch engine module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const dispatchModule = require('./dispatch');

// â”€â”€ Quote lifecycle module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const quotesModule = require('./quotes');

// ── Pricing & inspection lifecycle module ────────────────────────────────────
const pricingModule = require('./pricing');

// â”€â”€ AI search module â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const aiSearchModule = require('./aiSearch');

// ── Email OTP signup module ──────────────────────────────────────────────────
const emailOtpModule = require('./emailOtp');

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// WEBHOOK  â€”  Paystack â†’ Firebase (public HTTPS endpoint)
// Add this URL to your Paystack dashboard â†’ Settings â†’ API Keys & Webhooks
// URL: https://{FUNCTIONS_REGION}-lamax-4fd82.cloudfunctions.net/paystackWebhook
// e.g. https://europe-west1-lamax-4fd82.cloudfunctions.net/paystackWebhook
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
exports.paystackWebhook = onRequest(
    { region: FUNCTIONS_REGION, invoker: 'public' },
    (req, res) => webhooks.handlePaystackWebhook(req, res),
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ESCROW â€” called from the booking flow
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * holdBookingFunds â€” move customer funds into escrow when a booking is confirmed.
 *
 * Call from frontend (booking confirmation step):
 *   const hold = httpsCallable(functions, 'holdBookingFunds');
 *   await hold({ bookingId, artisanId, amount });
 */
exports.holdBookingFunds = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
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
 * releaseEscrow â€” release funds to artisan after booking completion.
 *
 * Call when BOTH parties confirm (or after auto-release timeout):
 *   const release = httpsCallable(functions, 'releaseEscrow');
 *   await release({ escrowId });
 */
exports.releaseEscrow = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
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
 * refundBooking â€” refund escrow back to customer.
 *
 * Call on cancellation or admin dispute resolution:
 *   const refund = httpsCallable(functions, 'refundBooking');
 *   await refund({ escrowId, reason });
 */
exports.refundBooking = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
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
 * raiseDispute â€” freeze escrow while a dispute is under review.
 *
 *   const dispute = httpsCallable(functions, 'raiseDispute');
 *   await dispute({ escrowId, disputeId });
 */
exports.raiseDispute = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
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

/**
 * resolveDispute â€” admin closes an open dispute (full refund, release to
 * artisan, or partial split). Server-authoritative: never trust a client-
 * computed wallet balance.
 *
 *   const resolve = httpsCallable(functions, 'resolveDispute');
 *   await resolve({ disputeId, resolution: 'full_refund', notes });
 *   await resolve({ disputeId, resolution: 'partial_refund', notes, customerAmount });
 */
exports.resolveDispute = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    try {
        return await disputesModule.resolveDispute(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// WITHDRAWALS â€” called from customer/artisan wallet pages
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * processWithdrawal â€” customer withdraws available (non-escrowed) wallet balance.
 *
 *   const withdraw = httpsCallable(functions, 'processWithdrawal');
 *   const { data } = await withdraw({ amount, provider, phone });
 */
exports.processWithdrawal = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'processWithdrawal');
    const { amount, provider, phone } = request.data;
    _validate({ amount, provider, phone }, ['amount', 'provider', 'phone']);
    if (!VALID_PROVIDERS.has(provider)) throw new HttpsError('invalid-argument', 'Invalid payment provider.');
    _validateGhanaPhone(phone);

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
 * processArtisanWithdrawal â€” artisan withdraws their completed earnings.
 *
 *   const withdraw = httpsCallable(functions, 'processArtisanWithdrawal');
 *   const { data } = await withdraw({ amount, provider, phone });
 */
exports.processArtisanWithdrawal = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'processArtisanWithdrawal');
    const { amount, provider, phone } = request.data;
    _validate({ amount, provider, phone }, ['amount', 'provider', 'phone']);
    if (!VALID_PROVIDERS.has(provider)) throw new HttpsError('invalid-argument', 'Invalid payment provider.');
    _validateGhanaPhone(phone);

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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ARTISAN INDEX â€” keeps artisan_index in sync with artisans collection
//
// syncArtisanIndex fires on every artisans/{artisanId} write.
// artisan_index is the search/dispatch layer â€” never queried by clients.
//
// backfillArtisanIndex â€” one-time admin migration.
// Run once after deploying this version to populate artisan_index for all
// artisans that have lat/lng. New artisans are indexed automatically by
// syncArtisanIndex from this point on.
//
//   const fn = httpsCallable(functions, 'backfillArtisanIndex');
//   const { data } = await fn({});
//   // { processed, skipped, errors, total }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ARTISAN VERIFICATION â€” admin-driven KYC approval workflow
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * approveArtisan â€” admin approves a submitted verification request.
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
 * rejectArtisan â€” admin rejects with a mandatory reason.
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
 * requestMoreInfo â€” request additional documents / info.
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
 * suspendArtisan â€” suspend an approved artisan.
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
 * reinstateArtisan â€” lift a suspension.
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
 * banArtisan â€” permanently ban an artisan (distinct from suspendArtisan).
 *   await fn({ artisanId, reason });
 */
exports.banArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.banArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * unbanArtisan â€” lift a permanent ban.
 *   await fn({ artisanId, notes });
 */
exports.unbanArtisan = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    try {
        return await artisanVerif.unbanArtisan(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

/**
 * onVerificationSubmitted â€” Firestore trigger fires when a new
 * verification_request document is created. Sends an admin alert and
 * acknowledges receipt to the artisan.
 */
exports.onVerificationSubmitted = onDocumentCreated(
    { document: 'verification_requests/{artisanId}', region: FUNCTIONS_REGION },
    (event) => artisanVerif.onVerificationSubmitted(event),
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// BOOKING LIFECYCLE â€” status-change notifications
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * onBookingStatusChanged â€” fires on any booking document update.
 * Sends notifications to the customer or artisan based on the new status:
 *   pending â†’ accepted    : customer notified
 *   pending â†’ rejected    : customer notified
 *   accepted â†’ in_progress: customer notified
 *   * â†’ completed         : both notified
 *   * â†’ cancelled         : both notified
 */
exports.onBookingStatusChanged  = bookingsModule.onBookingStatusChanged;

/**
 * cancelBookingAsAdmin â€” admin cancels a booking with a required reason.
 * Writes status: 'cancelled' only after validating the current state; the
 * onBookingStatusChanged trigger above then runs the existing, audited
 * refund path for any booking transitioning to 'cancelled'.
 *
 *   const cancel = httpsCallable(functions, 'cancelBookingAsAdmin');
 *   await cancel({ bookingId, reason });
 */
exports.cancelBookingAsAdmin = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    try {
        return await bookingsModule.cancelBookingAsAdmin(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// REVIEW LIFECYCLE â€” atomic artisan rating update on new customer review
//
// onBookingReviewed
//   Fires when a customer writes their `rating` to a completed booking doc.
//   Uses a Firestore transaction to atomically update the artisan's rolling
//   average rating and reviewCount. Eliminates the client-side TOCTOU in the
//   deprecated artisanRepository.applyNewReview().
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
exports.onBookingReviewed = reviewsModule.onBookingReviewed;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DISPATCH ENGINE â€” Uber/Bolt-style sequential artisan matching
//
// onBookingCreated       : fires when booking doc is created â†’ first dispatch round
// checkExpiredDispatches : scheduled every 1 min â†’ re-dispatches timed-out rounds
//
// Rejection + acceptance handling was previously a second onDocumentUpdated
// trigger (onBookingDispatchEvent). It is now called from within
// onBookingStatusChanged (bookings.js) so there is only one trigger per update.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
exports.onBookingCreated        = dispatchModule.onBookingCreated;
exports.checkExpiredDispatches  = dispatchModule.checkExpiredDispatches;

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// QUOTE LIFECYCLE â€” artisan submits quote, customer approves/rejects
//
// submitJobQuote  (artisan callable)
//   Artisan sends labour cost + optional materials list.
//   System calculates total and notifies customer.
//
// approveJobQuote  (customer callable)
//   Customer approves the quote â†’ escrow holds full amount â†’ artisan notified.
//
// rejectJobQuote  (customer callable)
//   Customer rejects â†’ artisan notified, can resubmit revised quote.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

exports.submitJobQuote = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    try {
        return await quotesModule.submitJobQuote(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.approveJobQuote = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    try {
        return await quotesModule.approveJobQuote(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.rejectJobQuote = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    try {
        return await quotesModule.rejectJobQuote(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// PRICING & INSPECTION LIFECYCLE — server-authoritative callout fees
//
// getPricingQuote          (customer) additive capped callout fee + quote token
// createInspectionBooking  (customer) booking written server-side from token
// payCalloutFee            (customer) escrows callout → inspection_scheduled
// completeInspection       (artisan)  status-only transition → inspection_done
// cancelInspectionBooking  (either)   fair callout settlement + cancel
// checkBookingTimeouts     (schedule) expires stale quotes/inspections hourly
// adminSeedPricingConfig   (admin)    seeds pricing_config defaults
// ─────────────────────────────────────────────────────────────────────────────

exports.getPricingQuote = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 60 }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'getPricingQuote');
    try {
        return await pricingModule.getPricingQuote(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.createInspectionBooking = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120 }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'createInspectionBooking');
    try {
        return await pricingModule.createInspectionBooking(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.payCalloutFee = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'holdBookingFunds');   // shares the financial-hold bucket
    try {
        return await pricingModule.payCalloutFee(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.completeInspection = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 60 }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'completeInspection');
    try {
        return await pricingModule.completeInspection(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.cancelInspectionBooking = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120, memory: '512MiB' }, async (request) => {
    _requireAuth(request);
    await checkRateLimit(request.auth.uid, 'cancelInspectionBooking');
    try {
        return await pricingModule.cancelInspectionBooking(request.auth, request.data);
    } catch (err) {
        throw new HttpsError('failed-precondition', err.message);
    }
});

exports.checkBookingTimeouts = onSchedule(
    { schedule: 'every 1 hours', region: FUNCTIONS_REGION, timeoutSeconds: 300, memory: '512MiB' },
    async () => {
        await pricingModule.checkBookingTimeouts();
    }
);

exports.adminSeedPricingConfig = onCall({ region: FUNCTIONS_REGION, timeoutSeconds: 120 }, async (request) => {
    _requireAuth(request);
    const { ADMIN_EMAILS } = require('./config');
    if (!ADMIN_EMAILS.includes(request.auth.token?.email)) {
        throw new HttpsError('permission-denied', 'Super-admin access required.');
    }
    try {
        return await pricingModule.seedPricingConfig();
    } catch (err) {
        throw new HttpsError('internal', err.message);
    }
});

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ESCROW LIFECYCLE â€” automated release of expired escrow records
//
// autoReleaseEscrow
//   Scheduled: every 6 hours.
//   Queries escrow where status=='held' AND autoReleaseAt<=now, pages through
//   results in batches of 100, and calls releaseEscrow() or refundEscrow()
//   per document based on the associated booking's status.
//   Safe under repeated execution â€” idempotent by design.
//
// adminBackfillEscrowLocks (callable â€” admin only)
//   One-time migration: creates _escrow_locks documents for all pre-existing
//   "held" escrow records that were created before the C1 lock-document fix.
//   Call once after deploying the new escrow.js. Safe to re-run.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * Scheduled escrow auto-release.
 * Runs every 6 hours. Memory 512 MiB. Timeout 540 s.
 *
 * Writes observability docs to:
 *   _auto_release_runs/{runId}         â€” run summary (start, end, counts, status)
 *   _auto_release_failures/{escrowId}  â€” per-escrow failure details for admin review
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
 * Only super-admins may call this â€” enforced inside backfillEscrowLocks().
 *
 *   const backfill = httpsCallable(functions, 'adminBackfillEscrowLocks');
 *   const { data } = await backfill({});
 *   // data â†’ { processed, skipped, errors }
 */
exports.adminBackfillEscrowLocks = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 540, memory: '512MiB' },
    async (request) => {
        _requireAuth(request);
        // Restrict to super-admins only â€” backfill touches all escrow records.
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
 * backfillSearchKeywords â€” regenerate searchKeywords for all artisan documents.
 *
 * Run once after deploying the updated artisanRepository.js that auto-generates
 * keywords. Artisans registered with the old repository have searchKeywords: []
 * and are invisible in search. This function rebuilds their keyword arrays from
 * their current profile data (name, specialty, category, commonSearchPhrases).
 *
 * Safe to re-run â€” artisans with complete keyword sets are skipped.
 *
 *   const fn = httpsCallable(functions, 'backfillSearchKeywords');
 *   const { data } = await fn({});
 *   // data â†’ { processed, skipped, errors, total }
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

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GEOHASH BACKFILL â€” one-time migration for existing artisans
//
// backfillGeohash
//   Iterates all artisan documents that have lat/lng but no geohash field,
//   computes the geohash, and writes it back. Safe to re-run.
//   Call once after deploying this version.
//
//   const fn = httpsCallable(functions, 'backfillGeohash');
//   const { data } = await fn({});
//   // data â†’ { processed, skipped, errors, total }
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        // Same encoder as artisanRepository.js â€” no external dep needed in Node
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

        console.log(`[backfillGeohash] done â€” processed=${processed} skipped=${skipped} errors=${errors} total=${snap.size}`);
        return { processed, skipped, errors, total: snap.size };
    }
);

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// AI SEARCH â€” natural-language query interpretation via Claude
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/**
 * aiSearch â€” convert a natural-language query to structured artisan search terms.
 *
 *   const fn = httpsCallable(functions, 'aiSearch');
 *   const { data } = await fn({ query: 'my ceiling is leaking' });
 *   // data â†’ { searchTerms: ['plumber', 'ceiling leak'], category: 'plumbing', interpretation: '...' }
 */
exports.aiSearch = onCall({ region: FUNCTIONS_REGION }, async (request) => {
    _requireAuth(request);
    const { query } = request.data;
    if (!query || typeof query !== 'string' || !query.trim()) {
        throw new HttpsError('invalid-argument', 'query is required.');
    }
    if (query.trim().length > 200) {
        throw new HttpsError('invalid-argument', 'Query is too long.');
    }
    try {
        return await aiSearchModule.interpretSearchQuery(query.trim());
    } catch (err) {
        console.warn('[aiSearch] interpretation failed:', err.message);
        throw new HttpsError('internal', 'AI search temporarily unavailable.');
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL OTP SIGNUP — server-authoritative email verification before account creation
//
// requestSignupOtp  (callable — public, unauthenticated)
//   Validates payload, checks email uniqueness in Firebase Auth, generates
//   a CSPRNG 6-digit OTP, hashes it (SHA-256 + random salt), stores in
//   _email_verifications with 5-minute TTL, and sends the code by email.
//   Returns { sessionId, email, expiresInSeconds, resendCooldownSeconds }.
//
// resendSignupOtp  (callable — public, unauthenticated)
//   Enforces 60-second cooldown + 5 resends/hour per session.
//   Generates a fresh OTP, invalidates the old hash in Firestore, resends.
//
// verifySignupOtp  (callable — public, unauthenticated)
//   Constant-time hash compare, max 5 attempts.
//   On success: atomically creates Firebase Auth user + Firestore profile.
//   Returns { success: true, uid }.
// ─────────────────────────────────────────────────────────────────────────────

exports.requestSignupOtp = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
    async (request) => {
        const ip        = request.rawRequest?.ip || request.rawRequest?.headers?.['x-forwarded-for'] || null;
        const userAgent = request.rawRequest?.headers?.['user-agent'] || null;
        try {
            return await emailOtpModule.requestSignupOtp({
                payload:   request.data.payload,
                appType:   request.data.appType,
                ip,
                userAgent,
            });
        } catch (err) {
            if (err instanceof HttpsError) throw err;
            console.error('[requestSignupOtp]', err.message);
            throw new HttpsError('internal', err.message || 'Failed to initiate verification.');
        }
    }
);

exports.resendSignupOtp = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
    async (request) => {
        const ip        = request.rawRequest?.ip || request.rawRequest?.headers?.['x-forwarded-for'] || null;
        const userAgent = request.rawRequest?.headers?.['user-agent'] || null;
        try {
            return await emailOtpModule.resendSignupOtp({
                sessionId: request.data.sessionId,
                email:     request.data.email,
                appType:   request.data.appType,
                ip,
                userAgent,
            });
        } catch (err) {
            if (err instanceof HttpsError) throw err;
            console.error('[resendSignupOtp]', err.message);
            throw new HttpsError('internal', err.message || 'Failed to resend OTP.');
        }
    }
);

exports.verifySignupOtp = onCall(
    { region: FUNCTIONS_REGION, timeoutSeconds: 60, memory: '256MiB', invoker: 'public' },
    async (request) => {
        const ip = request.rawRequest?.ip || request.rawRequest?.headers?.['x-forwarded-for'] || null;
        try {
            return await emailOtpModule.verifySignupOtp({
                sessionId: request.data.sessionId,
                otp:       request.data.otp,
                appType:   request.data.appType,
                ip,
            });
        } catch (err) {
            if (err instanceof HttpsError) throw err;
            console.error('[verifySignupOtp]', err.message);
            throw new HttpsError('internal', err.message || 'Verification failed.');
        }
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

function _validateGhanaPhone(phone) {
    const digits = String(phone).replace(/\D/g, '');
    // Accept: 0XXXXXXXXX (10 digits) or 233XXXXXXXXX (12 digits)
    if (!/^(0\d{9}|233\d{9})$/.test(digits)) {
        throw new HttpsError('invalid-argument', 'Invalid phone number. Must be a valid Ghana mobile number.');
    }
}
