// ─────────────────────────────────────────────────────────────────────────────
// walletService — frontend service that calls Cloud Functions for all
// balance-mutating operations (escrow hold, release, refund, withdrawals).
//
// Import anywhere in the frontend:
//   import { walletService } from '../../shared/js/services/walletService.js';
//   await walletService.holdBookingFunds({ bookingId, artisanId, amount });
// ─────────────────────────────────────────────────────────────────────────────

import { getFunctions, httpsCallable }
    from '../../vendor/firebase/firebase-functions.js';
import { getAuth }
    from '../../vendor/firebase/firebase-auth.js';
import { firebaseApp, firebaseFunctions }
    from '../backend/providers/firebase/firebaseConfig.js';
import { FUNCTIONS_REGION }
    from '../config/appConfig.js';
import { checkAndRecord, showRateLimitToast }
    from './rateLimitService.js';

let _functions = null;

function fn() {
    if (!_functions) _functions = firebaseFunctions;
    return _functions;
}

function call(name) {
    return httpsCallable(fn(), name);
}

function _currentUserId() {
    try { return getAuth(firebaseApp).currentUser?.uid ?? null; }
    catch { return null; }
}

/**
 * Check the frontend rate limit for an action and throw a user-visible error
 * if the user has exceeded it.
 *
 * @param {string} action  Key from ACTIONS in rateLimitService
 * @param {string} ctx     Toast context ('payment'|'booking'|'general')
 */
function _enforceLimit(action, ctx = 'payment') {
    const userId = _currentUserId();
    const result = checkAndRecord(action, userId);
    if (!result.allowed) {
        showRateLimitToast(result.waitMs, ctx);
        throw Object.assign(
            new Error(`Rate limit: ${action}. Wait ${Math.ceil(result.waitMs / 1000)}s.`),
            { code: 'rate-limited', waitMs: result.waitMs },
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @deprecated Server-driven. bookings.js automatically holds funds when a booking
 * transitions pending → accepted. Client calls are idempotent (protected by
 * _escrow_locks) but redundant — remove from call sites.
 *
 * @param {{ bookingId: string, artisanId: string, amount: number }} opts
 * @returns {Promise<{ escrowId: string, commission: number, artisanShare: number }>}
 */
export async function holdBookingFunds({ bookingId, artisanId, amount }) {
    _enforceLimit('HOLD_BOOKING_FUNDS', 'booking');
    const result = await call('holdBookingFunds')({ bookingId, artisanId, amount });
    return result.data;
}

/**
 * Escrow the emergency callout fee for a booking.
 *
 * Takes ONLY a bookingId — there is deliberately no amount parameter. The fee
 * was computed by the server pricing engine and stamped onto the booking, and
 * payEmergencyCallout reads it from there, so nothing the browser holds can
 * change what the customer is charged.
 *
 * @param   {string} bookingId
 * @returns {Promise<{ escrowId: string, amount: number, alreadyPaid?: boolean }>}
 */
export async function payEmergencyCallout(bookingId) {
    _enforceLimit('HOLD_BOOKING_FUNDS', 'booking');
    const result = await call('payEmergencyCallout')({ bookingId });
    return result.data;
}

/**
 * @deprecated Server-driven. bookings.js automatically releases funds when a
 * booking transitions * → completed. Client calls are idempotent but redundant —
 * remove from call sites.
 *
 * @param {string} escrowId
 */
export async function releaseEscrow(escrowId) {
    _enforceLimit('RELEASE_ESCROW', 'payment');
    const result = await call('releaseEscrow')({ escrowId });
    return result.data;
}

/**
 * Refund escrow back to customer (cancellation or dispute resolved in their favour).
 *
 * @param {string} escrowId
 * @param {string} [reason]
 */
export async function refundBooking(escrowId, reason) {
    const result = await call('refundBooking')({ escrowId, reason });
    return result.data;
}

/**
 * Freeze escrow when a dispute is raised.
 *
 * @param {string} escrowId
 * @param {string} [disputeId]
 */
export async function raiseDispute(escrowId, disputeId) {
    const result = await call('raiseDispute')({ escrowId, disputeId });
    return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Withdrawals
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initiate a customer wallet withdrawal via Paystack Transfer.
 *
 * @param {{ amount: number, provider: string, phone: string, customerName?: string }} opts
 * @returns {Promise<{ ref: string, payoutId: string, transferCode: string }>}
 */
export async function withdrawCustomer({ amount, provider, phone, customerName }) {
    _enforceLimit('WITHDRAWAL', 'payment');
    const result = await call('processWithdrawal')({ amount, provider, phone, customerName });
    return result.data;
}

/**
 * Initiate an artisan earnings withdrawal via Paystack Transfer.
 *
 * @param {{ amount: number, provider: string, phone: string, artisanName?: string }} opts
 * @returns {Promise<{ ref: string, payoutId: string, transferCode: string }>}
 */
export async function withdrawArtisan({ amount, provider, phone, artisanName }) {
    _enforceLimit('ARTISAN_WITHDRAWAL', 'payment');
    const result = await call('processArtisanWithdrawal')({ amount, provider, phone, artisanName });
    return result.data;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience object export (optional — for callers that prefer one import)
// ─────────────────────────────────────────────────────────────────────────────
export const walletService = {
    holdBookingFunds,
    releaseEscrow,
    refundBooking,
    raiseDispute,
    withdrawCustomer,
    withdrawArtisan,
};
