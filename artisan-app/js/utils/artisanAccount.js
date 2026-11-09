/**
 * artisanAccount.js — where a signed-in artisan goes, and how a first-time
 * Google artisan gets a profile (AR-09).
 *
 * login.html, signup.html and the auth guard all use this, so a new artisan is
 * never sent somewhere that then tells them "Access Denied". The profile itself
 * is created server-side (the artisanAccount callable, functions/artisanAccount.js):
 * once, whichever provider or however many attempts, and never for a customer
 * or administrator account.
 *
 * It is also how an approved artisan asks to change a VERIFIED claim — their
 * name or trade (AR-10). Those fields are fixed by firestore.rules once an
 * application is submitted; a change is reviewed by an administrator.
 */

import { httpsCallable }     from '../../../shared/vendor/firebase/firebase-functions.js';
import { firebaseFunctions } from '../../../shared/js/backend/providers/firebase/firebaseConfig.js';

/** The trades an artisan can register under: one list for the forms and the
 *  server (shared/js/domain/artisanTrades.js, mirrored to functions/shared). */
export { ARTISAN_TRADES } from '../../../shared/js/domain/artisanTrades.js';

/** Verification states in which name and trade are fixed (firestore.rules claimsLockedIn). */
export function claimsLocked(verificationStatus) {
    return ['submitted', 'pending_review', 'approved', 'suspended', 'banned']
        .includes(String(verificationStatus || '').toLowerCase());
}

/** The page an artisan with this verification status should land on (pure, in artisanRoutes.js). */
export { nextArtisanPage } from './artisanRoutes.js';

/**
 * Make sure the signed-in user has an artisan profile.
 * @returns {Promise<{ ok: boolean, result?: 'existing'|'created', verificationStatus?: string,
 *                     emailVerified?: boolean, reason?: string|null, message?: string }>}
 */
export async function ensureArtisanAccount() {
    return callAccount({ action: 'ensure' },
        'Could not set up your artisan account. Check your connection and try again.');
}

/**
 * Ask for a verified claim to change. `change` holds only the fields to change
 * ({ name?, category?, specialty? }) plus `reason`.
 */
export async function requestProfileChange(change) {
    return callAccount({ ...change, action: 'requestProfileChange' },
        'Your change request was not sent. Check your connection and try again.');
}

/** Withdraw a pending change request. */
export async function cancelProfileChange() {
    return callAccount({ action: 'cancelProfileChange' },
        'Could not withdraw the request. Check your connection and try again.');
}

async function callAccount(payload, fallbackMessage) {
    try {
        const { data } = await httpsCallable(firebaseFunctions, 'artisanAccount')(payload);
        return { ok: true, ...data };
    } catch (err) {
        return {
            ok: false,
            reason: (err && err.details && err.details.reason) || null,
            message: (err && err.message && !/^internal$/i.test(err.message)) ? err.message : fallbackMessage,
        };
    }
}
