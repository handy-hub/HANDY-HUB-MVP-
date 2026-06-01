'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// HandyHub Firebase Cloud Functions — Financial System
//
// Deploy:
//   firebase deploy --only functions
//
// Required secrets (set before deploying):
//   firebase functions:secrets:set PAYSTACK_SECRET_KEY
//
// Optional env vars (set in functions/.env for local dev):
//   PAYSTACK_SECRET_KEY=sk_test_...
//   COMMISSION_RATE=0.15
//   MIN_WITHDRAWAL=5
// ─────────────────────────────────────────────────────────────────────────────

const { initializeApp }    = require('firebase-admin/app');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated }            = require('firebase-functions/v2/firestore');
const { onSchedule }                   = require('firebase-functions/v2/scheduler');

initializeApp();

// ── Financial modules ─────────────────────────────────────────────────────────
const escrow    = require('./financial/escrow');
const transfers = require('./financial/transfers');
const webhooks  = require('./financial/webhooks');

// ── Artisan verification module ───────────────────────────────────────────────
const artisanVerif = require('./artisanVerification');

// ── Booking lifecycle module ──────────────────────────────────────────────────
const bookingsModule = require('./bookings');

// ── Dispatch engine module ────────────────────────────────────────────────────
const dispatchModule = require('./dispatch');

// ─────────────────────────────────────────────────────────────────────────────
// WEBHOOK  —  Paystack → Firebase (public HTTPS endpoint)
// Add this URL to your Paystack dashboard → Settings → API Keys & Webhooks
// URL: https://us-central1-lamax-4fd82.cloudfunctions.net/paystackWebhook
// ─────────────────────────────────────────────────────────────────────────────
exports.paystackWebhook = onRequest(
    { region: 'us-central1', invoker: 'public' },
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
exports.holdBookingFunds = onCall({ region: 'us-central1' }, async (request) => {
    _requireAuth(request);
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
exports.releaseEscrow = onCall({ region: 'us-central1' }, async (request) => {
    _requireAuth(request);
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
exports.refundBooking = onCall({ region: 'us-central1' }, async (request) => {
    _requireAuth(request);
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
exports.raiseDispute = onCall({ region: 'us-central1' }, async (request) => {
    _requireAuth(request);
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
exports.processWithdrawal = onCall({ region: 'us-central1' }, async (request) => {
    _requireAuth(request);
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
exports.processArtisanWithdrawal = onCall({ region: 'us-central1' }, async (request) => {
    _requireAuth(request);
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
// ARTISAN VERIFICATION — admin-driven KYC approval workflow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * approveArtisan — admin approves a submitted verification request.
 *   const fn = httpsCallable(functions, 'approveArtisan');
 *   await fn({ artisanId, notes });
 */
exports.approveArtisan = onCall({ region: 'us-central1' }, async (request) => {
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
exports.rejectArtisan = onCall({ region: 'us-central1' }, async (request) => {
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
exports.requestMoreInfo = onCall({ region: 'us-central1' }, async (request) => {
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
exports.suspendArtisan = onCall({ region: 'us-central1' }, async (request) => {
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
exports.reinstateArtisan = onCall({ region: 'us-central1' }, async (request) => {
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
    { document: 'verification_requests/{artisanId}', region: 'us-central1' },
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
// DISPATCH ENGINE — Uber/Bolt-style sequential artisan matching
//
// onBookingCreated       : fires when booking doc is created → first dispatch round
// onBookingDispatchEvent : fires on update → handles rejection (re-dispatch) + acceptance
// checkExpiredDispatches : scheduled every 1 min → re-dispatches timed-out rounds
// ─────────────────────────────────────────────────────────────────────────────
exports.onBookingCreated        = dispatchModule.onBookingCreated;
exports.onBookingDispatchEvent  = dispatchModule.onBookingDispatchEvent;
exports.checkExpiredDispatches  = dispatchModule.checkExpiredDispatches;

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
