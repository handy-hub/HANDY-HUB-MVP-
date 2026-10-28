/**
 * authErrorCopy.js — what a customer is told when sign-up or social sign-in
 * fails, by Firebase error code.
 *
 * The signup page used to show `error.message` first and fall back to its own
 * copy — but every FirebaseError HAS a message ("Firebase: Error
 * (auth/email-already-in-use)."), so the friendly copy was dead code and a
 * tester saw raw SDK text with nothing to do about it. Copy is now chosen by
 * code; anything unrecognised says what failed, names the code (so a report is
 * actionable) and where to get help.
 *
 * Pure: no DOM, no Firebase import. Shared by the signup and login pages.
 */

import { SUPPORT_CONTACTS } from '../config/supportConfig.js';

const help = () => (SUPPORT_CONTACTS.email ? ` If it keeps happening, email ${SUPPORT_CONTACTS.email}.` : '');
const codeOf = (error) => String((error && error.code) || '').replace(/^firestore\//, '');

/** Email/password sign-up. */
export function signupErrorCopy(error) {
    const code = codeOf(error);
    switch (code) {
        case 'auth/email-already-in-use':
            return 'This email already has a Fidus X account. Log in instead — if you signed up with Google, use Continue with Google.';
        case 'auth/invalid-email':
            return 'Please enter a valid email address.';
        case 'auth/weak-password':
            return 'Choose a stronger password (at least 8 characters).';
        case 'auth/network-request-failed':
            return 'No connection. Check your internet and try again — your account was not created.';
        // Firestore could not be reached while the profile was being saved
        // (a weak phone connection). The new account is rolled back; if even
        // that could not get through, a later sign-in completes the profile
        // (customerAuthService ensureCustomerProfile) — so say both.
        case 'unavailable':
        case 'deadline-exceeded':
            return 'We could not reach Fidus X to finish setting up your account. Check your connection and try again — if it then says the email is already registered, just log in and we will finish setting it up.';
        case 'auth/too-many-requests':
            return 'Too many attempts from this device. Wait a few minutes and try again.';
        case 'auth/operation-not-allowed':
        case 'auth/admin-restricted-operation':
            return 'New accounts cannot be created right now.' + help();
        case 'auth/wrong-app-role':
            return 'This is an artisan account. Please use the Fidus X Artisan app.';
        case 'permission-denied':
            return 'Your account could not be set up, so nothing was saved. Please try again.' + help();
        default:
            return `We could not create your account${code ? ` (${code})` : ''}. Please try again.` + help();
    }
}

/** Google / Apple / Facebook, on the signup and login pages. */
export function socialAuthErrorCopy(error, providerName = 'Google') {
    const code = codeOf(error);
    switch (code) {
        case 'auth/popup-closed-by-user':
        case 'auth/cancelled-popup-request':
        case 'auth/user-cancelled':
            return `${providerName} sign-in was cancelled.`;
        case 'auth/wrong-app-role':
            return 'This is an artisan account. Please sign in through the Fidus X Artisan app.';
        case 'auth/account-exists-with-different-credential':
            return 'This email already has an account with a password. Log in with your email and password.';
        case 'auth/network-request-failed':
            return 'No connection. Check your internet and try again.';
        case 'auth/too-many-requests':
            return 'Too many attempts. Wait a few minutes and try again.';
        case 'auth/popup-blocked':
            return 'Your browser blocked the sign-in window. Trying another way…';
        case 'auth/unauthorized-domain':
            return `${providerName} sign-in is not allowed on this address. Use the Fidus X app or lamax-4fd82.web.app.` + help();
        case 'auth/operation-not-allowed':
            return `${providerName} sign-in is switched off right now. Use email instead.` + help();
        case 'auth/unsupported-provider':
            return 'That sign-in method is not supported yet.';
        // ── Native app (firebaseAuthService signInWithGoogleNatively) ─────────
        case 'auth/no-google-account':
            return 'There is no Google account on this phone. Add one in Settings → Accounts, or sign up with email.';
        case 'auth/native-google-unavailable':
            return 'Google sign-in needs the latest version of the Fidus X app. Update the app, or use email for now.';
        case 'auth/native-google-not-configured':
            return 'Google sign-in is not available in this version of the app yet. Please use email for now.' + help();
        default:
            return `${providerName} sign-in did not complete${code ? ` (${code})` : ''}. Please try again or use email.` + help();
    }
}
