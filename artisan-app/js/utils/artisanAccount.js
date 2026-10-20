/**
 * artisanAccount.js — where a signed-in artisan goes, and how a first-time
 * Google artisan gets a profile (AR-09).
 *
 * login.html, signup.html and the auth guard all use this, so a new artisan is
 * never sent somewhere that then tells them "Access Denied". The profile itself
 * is created server-side (ensureArtisanProfile, functions/artisanAccount.js):
 * once, whichever provider or however many attempts, and never for a customer
 * or administrator account.
 */

import { httpsCallable }     from '../../../shared/vendor/firebase/firebase-functions.js';
import { firebaseFunctions } from '../../../shared/js/backend/providers/firebase/firebaseConfig.js';

/** The page an artisan with this verification status should land on. */
export function nextArtisanPage(verificationStatus) {
    const v = String(verificationStatus || '').toLowerCase();
    return ['', 'draft', 'rejected', 're_verification_required'].includes(v) ? 'onboarding.html' : 'dashboard.html';
}

/**
 * Make sure the signed-in user has an artisan profile.
 * @returns {Promise<{ ok: boolean, result?: 'existing'|'created', verificationStatus?: string,
 *                     emailVerified?: boolean, reason?: string|null, message?: string }>}
 */
export async function ensureArtisanAccount() {
    try {
        const { data } = await httpsCallable(firebaseFunctions, 'ensureArtisanProfile')({});
        return { ok: true, ...data };
    } catch (err) {
        return {
            ok: false,
            reason: (err && err.details && err.details.reason) || null,
            message: (err && err.message && !/^internal$/i.test(err.message))
                ? err.message
                : 'Could not set up your artisan account. Check your connection and try again.',
        };
    }
}
