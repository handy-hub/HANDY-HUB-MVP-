// ─────────────────────────────────────────────────────────────────────────────
// walletService — frontend service that calls Cloud Functions for all
// balance-mutating operations (escrow hold, release, refund, withdrawals).
//
// Import anywhere in the frontend:
//   import { walletService } from '../../shared/js/services/walletService.js';
//   await walletService.holdBookingFunds({ bookingId, artisanId, amount });
// ─────────────────────────────────────────────────────────────────────────────

import { getFunctions, httpsCallable }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { firebaseApp }
    from '../backend/providers/firebase/firebaseConfig.js';
import { FUNCTIONS_REGION }
    from '../config/appConfig.js';

let _functions = null;

function fn() {
    if (!_functions) _functions = getFunctions(firebaseApp, FUNCTIONS_REGION);
    return _functions;
}

function call(name) {
    return httpsCallable(fn(), name);
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrow
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hold customer funds in escrow when a booking is confirmed.
 * Call this immediately after the booking is accepted (not at payment time).
 *
 * @param {{ bookingId: string, artisanId: string, amount: number }} opts
 * @returns {Promise<{ escrowId: string, commission: number, artisanShare: number }>}
 */
export async function holdBookingFunds({ bookingId, artisanId, amount }) {
    const result = await call('holdBookingFunds')({ bookingId, artisanId, amount });
    return result.data;
}

/**
 * Release escrow to artisan after booking completion is confirmed.
 *
 * @param {string} escrowId
 */
export async function releaseEscrow(escrowId) {
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
