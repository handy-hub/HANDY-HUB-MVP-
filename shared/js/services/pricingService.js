// ─────────────────────────────────────────────────────────────────────────────
// pricingService — frontend wrapper for the inspection-track pricing Cloud
// Functions. The server is the ONLY authority on fees: this service never
// computes or writes a price, it only relays server-issued quotes and tokens.
//
// Import anywhere in the frontend:
//   import { pricingService } from '../../shared/js/services/pricingService.js';
//   const quote = await pricingService.getPricingQuote({ category, lat, lng });
//
// Flow:
//   getPricingQuote → createInspectionBooking → (artisan accepts)
//   → payCalloutFee → (artisan inspects) → quote modal handles approve/reject
// ─────────────────────────────────────────────────────────────────────────────

import { getFunctions, httpsCallable }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { getAuth }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js';
import { firebaseApp }
    from '../backend/providers/firebase/firebaseConfig.js';
import { FUNCTIONS_REGION }
    from '../config/appConfig.js';
import { checkAndRecord, showRateLimitToast }
    from './rateLimitService.js';

let _functions = null;

function fn() {
    if (!_functions) _functions = getFunctions(firebaseApp, FUNCTIONS_REGION);
    return _functions;
}

function call(name) {
    return httpsCallable(fn(), name);
}

function _currentUserId() {
    try { return getAuth(firebaseApp).currentUser?.uid ?? null; }
    catch { return null; }
}

function _enforceLimit(action, ctx = 'booking') {
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

export const pricingService = {

    /**
     * Server-computed callout fee for an inspection visit.
     * @param {{ category: string, lat: number, lng: number, artisanId?: string }} args
     * @returns {Promise<{ quoteToken, calloutFee, travelFee, inspectionFee,
     *                     distanceKm, travelEstimated, expiresAt, currency }>}
     */
    async getPricingQuote({ category, lat, lng, artisanId = null }) {
        const { data } = await call('getPricingQuote')({ category, lat, lng, artisanId });
        return data;
    },

    /**
     * Create the inspection booking server-side from a pricing token.
     * The client never writes a price field.
     * @returns {Promise<{ bookingId, calloutFee }>}
     */
    async createInspectionBooking({ quoteToken, address, description, notes = '', photos = [], serviceLabel = '', scheduledFor = null }) {
        _enforceLimit('BOOKING_CREATE', 'booking');
        const { data } = await call('createInspectionBooking')({
            quoteToken, address, description, notes, photos, serviceLabel, scheduledFor,
        });
        return data;
    },

    /**
     * Escrow the callout fee once an artisan has accepted.
     * Fails with a clear message when the wallet balance is too low.
     * @returns {Promise<{ escrowId, calloutFee }>}
     */
    async payCalloutFee(bookingId) {
        _enforceLimit('HOLD_BOOKING_FUNDS', 'payment');
        const { data } = await call('payCalloutFee')({ bookingId });
        return data;
    },

    /**
     * Cancel an inspection-track booking with fair callout settlement
     * (refund vs release decided server-side). Callable by either party.
     */
    async cancelInspectionBooking(bookingId, reason = '') {
        const { data } = await call('cancelInspectionBooking')({ bookingId, reason });
        return data;
    },

    /**
     * Artisan marks the on-site inspection as done (status-only — the callout
     * escrow settles on the customer's quote decision, never on this call).
     */
    async completeInspection(bookingId, findings = '') {
        const { data } = await call('completeInspection')({ bookingId, findings });
        return data;
    },
};

export default pricingService;
