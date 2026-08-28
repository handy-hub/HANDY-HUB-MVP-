/**
 * securityPinService.js — frontend wrapper for the Security PIN Cloud Functions.
 *
 * The ONE place the customer app talks to the PIN backend. Top-up and Settings
 * both import from here — no page calls the raw callable or invents its own
 * error copy. The raw PIN is passed straight through to the authenticated
 * callable and never stored, logged, or echoed by this module.
 *
 * Backend contract (functions/securityPin.js):
 *   setSecurityPin({ pin }) → { configured: true }
 *     - creates the account-level Security PIN for the authenticated UID
 *     - server-side scrypt hash (salt + pepper); raw PIN never persisted
 *     - rejects if a PIN already exists ('already-exists' → use Change PIN)
 *   PIN *verification* has NO standalone endpoint by design (it would be a
 *   brute-force oracle) — it happens inside trusted operations such as the
 *   future initiateTopupCharge.
 */

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

/**
 * Create the authenticated user's Security PIN.
 * @param {string} pin  4-digit string — passed through, never stored here.
 * @returns {Promise<{ configured: boolean }>}
 */
export async function setSecurityPin(pin) {
    const call = httpsCallable(fn(), 'setSecurityPin');
    const { data } = await call({ pin });
    return data;
}

/**
 * Map a callable error to safe, user-facing copy. Never surfaces backend
 * internals, and never distinguishes states an attacker could enumerate.
 */
export function pinErrorMessage(err) {
    const code = String(err?.code || '');
    const msg  = String(err?.message || '');

    if (code.includes('already-exists'))
        return 'You already have a Security PIN. Use Change PIN in Settings.';
    if (code.includes('invalid-argument'))
        return msg || 'PIN must be exactly 4 digits.';
    if (code.includes('resource-exhausted'))
        return 'Too many attempts. Please try again later.';
    if (code.includes('unauthenticated'))
        return 'Your session has expired. Please sign in again.';
    if (code.includes('failed-precondition'))
        return msg || 'Security PIN setup required.';
    if (code.includes('unavailable') || code.includes('internal') || code.includes('deadline'))
        return 'Unable to set up your PIN right now. Please try again.';
    return 'Unable to set up your PIN right now. Please try again.';
}
