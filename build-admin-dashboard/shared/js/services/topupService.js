/**
 * shared/js/services/topupService.js — the ONE frontend wrapper for wallet top-ups.
 *
 * Replaces the client-side Paystack popup path. The browser no longer decides
 * the amount, the reference, or which wallet gets credited: it asks
 * initiateTopupCharge for a checkout handle and then watches the server's own
 * payment record for the outcome.
 *
 * AUTHORITY — read this before changing anything here
 *   Paystack's `onSuccess` callback is a HINT, not proof of payment. It fires in
 *   the customer's browser and can be missed (tab closed, network drop) or, in
 *   principle, forged. It must NEVER be used to tell the customer their wallet
 *   was credited.
 *
 *   The truth is topupIntents/{reference}.status, which only Cloud Functions can
 *   write, and which flips to 'successful' in the same Firestore transaction
 *   that moves the money. Subscribe to that and the flow stays correct even if
 *   the customer walks away mid-payment.
 */

import { getFunctions, httpsCallable }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-functions.js';
import { firebaseApp }
    from '../backend/providers/firebase/firebaseConfig.js';
import { FUNCTIONS_REGION, PAYSTACK_CONFIG } from '../config/appConfig.js';

let _functions = null;
function fn() {
    if (!_functions) _functions = getFunctions(firebaseApp, FUNCTIONS_REGION);
    return _functions;
}

// ── Paystack SDK loader (mirrors paystackService.js) ──────────────────────────
let sdkReady = null;
function loadSdk() {
    if (sdkReady) return sdkReady;
    sdkReady = new Promise((resolve, reject) => {
        if (window.PaystackPop) { resolve(); return; }
        const s   = document.createElement('script');
        s.src     = PAYSTACK_CONFIG.sdkUrl;
        s.onload  = resolve;
        s.onerror = () => reject(new Error('network'));
        document.head.appendChild(s);
    });
    return sdkReady;
}

/**
 * Idempotency key for a single logical top-up attempt.
 *
 * Generated once per attempt and reused across retries of the SAME attempt, so a
 * double-tap or a retried network call cannot open two charges.
 */
export function newIdempotencyKey() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Ask the server to start a top-up.
 *
 * The PIN is sent once, over HTTPS, to a callable that verifies it server-side
 * and immediately discards it. It is never stored or logged anywhere on the
 * client.
 *
 * @returns {Promise<{reference, accessCode, authorizationUrl, amountPesewas, currency}>}
 */
export async function initiateTopupCharge({ amount, pin, paymentMethodId = null, idempotencyKey = null }) {
    const call = httpsCallable(fn(), 'initiateTopupCharge');
    const { data } = await call({ amount, pin, paymentMethodId, idempotencyKey });
    return data;
}

/**
 * Ask the server to check Paystack for this charge right now.
 *
 * This is NOT the client asserting that a payment succeeded — it hands over a
 * reference and nothing more. The server checks that the reference belongs to
 * the caller, reads the real status from Paystack's API, and credits through the
 * same idempotent path the webhook uses.
 *
 * Exists because Paystack's mobile-money webhook commonly lags 30s–2min behind
 * the customer approving on their handset. Polling this closes that gap without
 * weakening the trust model.
 *
 * @returns {Promise<{status, credited, chargeStatus, amountPesewas?, transient?}>}
 */
export async function verifyTopupNow(reference) {
    const call = httpsCallable(fn(), 'verifyTopupNow');
    const { data } = await call({ reference });
    return data;
}

/**
 * Submit an OTP for a charge that came back as 'send_otp'.
 * @returns {Promise<{chargeStatus, displayText}>}
 */
export async function submitTopupOtp({ reference, otp }) {
    const call = httpsCallable(fn(), 'submitTopupOtp');
    const { data } = await call({ reference, otp });
    return data;
}

/**
 * Open Paystack checkout for a server-initialised transaction.
 *
 * Prefers resuming in-page via the access code so the customer never leaves the
 * app. Falls back to the hosted authorization URL when the inline SDK cannot
 * resume — the payment still completes and the webhook still credits, because
 * neither depends on this page staying open.
 *
 * @returns {Promise<{opened: 'inline'|'redirect'}>}
 */
export async function openPaystackCheckout({ accessCode, authorizationUrl, onClose }) {
    try {
        await loadSdk();
    } catch {
        if (authorizationUrl) { window.location.href = authorizationUrl; return { opened: 'redirect' }; }
        throw new Error('network');
    }

    const pop = window.PaystackPop;
    if (accessCode && pop && typeof pop.resumeTransaction === 'function') {
        // v1 inline accepts an optional callback bag; when it is ignored the
        // intent subscription still settles the UI, so nothing is lost.
        pop.resumeTransaction(accessCode, {
            onCancel: () => { if (onClose) onClose(); },
            onClose:  () => { if (onClose) onClose(); },
        });
        return { opened: 'inline' };
    }

    if (authorizationUrl) { window.location.href = authorizationUrl; return { opened: 'redirect' }; }
    throw new Error('unavailable');
}

/**
 * Map a callable error to a message that is honest, specific and safe.
 *
 * Deliberately granular: the old code funnelled every failure into one
 * catch-all string, which is why a hard 403 was indistinguishable from a wrong
 * PIN. Nothing here exposes internals, stack traces or server state.
 */
export function topupErrorMessage(err) {
    const code = String(err?.code || '').toLowerCase();
    const msg  = err?.message || '';

    if (code.includes('unauthenticated'))
        return 'Your session has expired. Please sign in again.';
    if (code.includes('permission-denied'))
        return 'Incorrect PIN. Please try again.';
    if (code.includes('resource-exhausted'))
        return msg || 'Too many attempts. Please try again later.';
    if (code.includes('failed-precondition'))
        return msg || 'Set up your Security PIN before topping up.';
    if (code.includes('invalid-argument'))
        return msg || 'Please check the amount and try again.';
    if (code.includes('already-exists'))
        return 'This top-up has already been processed.';
    if (code.includes('unavailable'))
        return 'Unable to reach the payment service. Check your connection and try again.';
    if (code.includes('deadline'))
        return 'The payment service is taking too long. Please try again.';
    if (code.includes('internal'))
        return 'Something went wrong starting your top-up. Please try again.';
    return 'Unable to start your top-up right now. Please try again.';
}
