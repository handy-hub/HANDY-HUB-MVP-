/**
 * artisan-app/js/utils/artisanRoutes.js — where a signed-in artisan belongs,
 * decided from the server's records. Pure: no DOM, no Firebase.
 *
 * Shared by the entry screens (sign in, sign up), the auth guard and
 * artisanAccount.js. An artisan is never sent to work because a form was
 * completed: only the verification status the server holds says where they go.
 */

/** Verification states that still need the onboarding form (draft, or sent back). */
export const NEEDS_ONBOARDING = Object.freeze(['', 'draft', 'rejected', 're_verification_required']);

/** The page an artisan with this verification status should land on. */
export function nextArtisanPage(verificationStatus) {
    const v = String(verificationStatus || '').toLowerCase();
    return NEEDS_ONBOARDING.includes(v) ? 'onboarding.html' : 'dashboard.html';
}

/**
 * The server's own answers about an account (functions/artisanAccount.js,
 * accountError → HttpsError details.reason) that end a session. A failure with
 * no reason — an outage, a timeout — is never evidence about the account
 * (LOGIN-001, FLOW-004) and never signs anyone out.
 */
export const ACCOUNT_REFUSALS = Object.freeze(['customer_account', 'admin_account', 'not_artisan', 'no_email', 'unauthenticated']);
