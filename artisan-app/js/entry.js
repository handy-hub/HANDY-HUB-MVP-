/**
 * artisan-app/js/entry.js — what the entry screens decide and say: sign in,
 * create an account, reset a password (Phase 5).
 *
 * Pure: no DOM, no Firebase. The pages carry these decisions out.
 *
 *  · Messages are chosen by error CODE, never shown as Firebase's own text
 *    ("Firebase: Error (auth/…)"); anything unrecognised says what failed and
 *    where to get help.
 *  · A password reset says the same thing whether or not the email has an
 *    account (AUTH-002): saying otherwise tells anyone which addresses are
 *    registered professionals.
 *  · Where a signed-in person goes comes from the server's records: the profile
 *    if it can be read, else the artisanAccount 'ensure' answer. A failure with
 *    no reason is an outage, not an answer about the account — it keeps the
 *    session (LOGIN-001).
 */
import { SUPPORT_CONTACTS } from '../../shared/js/config/supportConfig.js';
import { ARTISAN_TRADES, OTHER_TRADE } from '../../shared/js/domain/artisanTrades.js';
import { nextArtisanPage, ACCOUNT_REFUSALS } from './utils/artisanRoutes.js';

const help = () => (SUPPORT_CONTACTS.email ? ` If it keeps happening, email ${SUPPORT_CONTACTS.email}.` : '');
const codeOf = (e) => String((e && e.code) || '').replace(/^(functions|firestore)\//, '');

// ── Checks (the server re-checks every one: functions/emailOtp.js) ───────────

/** The server's address rule (functions/emailOtp.js EMAIL_RE). */
export const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const isEmail = (v) => EMAIL_RE.test(String(v || '').trim());

/** A Ghana mobile number as the server stores it: 0XXXXXXXXX or 233XXXXXXXXX, or '' if it is not one. */
export function normalisePhone(raw) {
    let d = String(raw || '').replace(/[\s()-]/g, '');
    if (d.startsWith('+')) d = d.slice(1);
    return /^(0[235][0-9]{8}|233[235][0-9]{8})$/.test(d) ? d : '';
}

export const MIN_PASSWORD = 8;
export function passwordProblem(pw) {
    if (!pw) return 'Enter a password.';
    return String(pw).length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : '';
}

// ── Signing in ───────────────────────────────────────────────────────────────

export function signInError(err) {
    switch (codeOf(err)) {
        case 'auth/invalid-credential':
        case 'auth/invalid-login-credentials':
        case 'auth/wrong-password':
        case 'auth/user-not-found':
            // One answer for both: never say whether the email has an account.
            return 'That email and password do not match a Fidus X account. Check them, or reset your password.';
        case 'auth/invalid-email':
            return 'Enter a valid email address.';
        case 'auth/user-disabled':
            return 'This account cannot sign in. Contact Fidus X support.' + help();
        case 'auth/too-many-requests':
            return 'Too many attempts. Wait a few minutes, or reset your password.';
        case 'auth/network-request-failed':
            return 'No connection. Check your internet and try again.';
        default:
            return `We could not sign you in${codeOf(err) ? ` (${codeOf(err)})` : ''}. Please try again.` + help();
    }
}

/** Google, on sign in and sign up. null means say nothing (the person closed the window). */
export function googleError(err) {
    switch (codeOf(err)) {
        case 'auth/popup-closed-by-user':
        case 'auth/cancelled-popup-request':
        case 'auth/user-cancelled':
            return null;
        case 'auth/popup-blocked':
            return 'Your browser blocked the Google window. Allow pop-ups for this site and try again, or use your email.';
        case 'auth/account-exists-with-different-credential':
            return 'This email already has a Fidus X account with a password. Sign in with your email and password.';
        case 'auth/network-request-failed':
            return 'No connection. Check your internet and try again.';
        case 'auth/too-many-requests':
            return 'Too many attempts. Wait a few minutes and try again.';
        case 'auth/unauthorized-domain':
        case 'auth/operation-not-allowed':
            return 'Google sign-in is not available here right now. Use your email instead.' + help();
        case 'auth/no-google-account':
            return 'There is no Google account on this device. Add one, or use your email.';
        default:
            return `Google sign-in did not complete${codeOf(err) ? ` (${codeOf(err)})` : ''}. Please try again, or use your email.` + help();
    }
}

// ── Password reset (AUTH-002: one answer, account or not) ────────────────────

export const resetMessage = (email) =>
    `If a Fidus X professional account uses ${email}, a reset link is on its way. Check your inbox and spam folder.`;

/** What a reset request led to. err is null when Firebase accepted it. */
export function resetOutcome(err, email) {
    const code = codeOf(err);
    if (!err || code === 'auth/user-not-found') return { success: resetMessage(email) };
    if (code === 'auth/invalid-email' || code === 'auth/missing-email') return { error: 'Enter a valid email address.' };
    if (code === 'auth/too-many-requests') return { error: 'Too many attempts. Please wait a few minutes and try again.' };
    if (code === 'auth/network-request-failed') return { error: 'No connection. Check your internet and try again.' };
    return { error: 'We could not send the reset email. Please try again in a moment.' + help() };
}

// ── Creating an account (functions/emailOtp.js signUpArtisanDirect) ──────────

/**
 * What is wrong with the sign-up form, field by field ({} when it can be sent).
 * The server's own rules (validateArtisanPayload), said before sending.
 * @param {{ name, email, phone, trade, otherDesc, otherBucket, password, terms }} v
 */
export function signupProblems(v) {
    const out = {};
    if (String(v.name || '').trim().length < 2) out.name = 'Enter your full name, as on your Ghana Card.';
    if (!isEmail(v.email)) out.email = 'Enter a valid email address.';
    if (String(v.phone || '').trim() && !normalisePhone(v.phone)) out.phone = 'Enter a Ghana mobile number, like 024 123 4567.';
    if (!ARTISAN_TRADES.includes(v.trade) && v.trade !== OTHER_TRADE) out.trade = 'Choose your trade.';
    if (v.trade === OTHER_TRADE) {
        if (String(v.otherDesc || '').trim().length < 2) out.otherDesc = 'Describe your trade.';
        if (!ARTISAN_TRADES.includes(v.otherBucket)) out.otherBucket = 'Choose the listed trade closest to yours.';
    }
    const pw = passwordProblem(v.password);
    if (pw) out.password = pw;
    if (!v.terms) out.terms = 'Agree to the Terms of Service and Privacy Policy to continue.';
    return out;
}

/** What is sent to the server: the checked values, the phone as the server stores it. */
export function signupPayload(v) {
    const other = v.trade === OTHER_TRADE;
    return {
        name: String(v.name || '').trim().replace(/\s+/g, ' '),
        email: String(v.email || '').trim(),
        password: v.password,
        phone: normalisePhone(v.phone),
        category: v.trade,
        otherBucket: other ? v.otherBucket : null,
        otherDesc: other ? String(v.otherDesc || '').trim() : null,
    };
}

export function signUpError(err) {
    const code = codeOf(err);
    const msg = String((err && err.message) || '').trim();
    switch (code) {
        case 'already-exists':
            return 'This email already has a Fidus X account. Sign in instead — if you used Google, choose Continue with Google.';
        case 'invalid-argument':
            // The server's own words, written for the person filling the form
            // ("Invalid Ghana phone number.", "Describe your trade.").
            return msg || 'Check the details and try again.';
        case 'resource-exhausted':
            return 'Too many sign-ups from this network. Wait a while and try again.';
        case 'unavailable':
        case 'deadline-exceeded':
        case 'auth/network-request-failed':
            return 'We could not reach Fidus X. Check your connection and try again — if it then says the email is registered, sign in instead.';
        default:
            return `We could not create your account${code ? ` (${code})` : ''}. Please try again.` + help();
    }
}

// ── After someone is signed in ───────────────────────────────────────────────

/** A profile that exists: suspended accounts see the guard's screen; otherwise the page the server's status implies. */
export function routeExisting(profile, returnUrl = null) {
    const status = String((profile && profile.status) || '').toLowerCase();
    if (status === 'suspended' || status === 'banned') return { go: 'dashboard.html' };
    if (returnUrl) return { go: returnUrl };
    return { go: nextArtisanPage(profile && profile.verificationStatus) };
}

/**
 * No profile could be read: the artisanAccount 'ensure' answer decides.
 * @returns {{ go: string }} | {{ signOut: true, message: string, go?: string }} | {{ offline: true }}
 */
export function routeEnsured(acct) {
    if (acct && acct.ok) return { go: nextArtisanPage(acct.verificationStatus) };
    const reason = acct && acct.reason;
    if (reason === 'customer_account') {
        // Role isolation (docs/SECURITY_ROLE_ISOLATION.md): the server says this is a customer.
        return { signOut: true, message: 'This is a customer account. Taking you to the Fidus X customer app…', go: '../customer-app/login.html' };
    }
    if (ACCOUNT_REFUSALS.includes(reason)) return { signOut: true, message: (acct && acct.message) || 'This account cannot use the professional app.' };
    return { offline: true };
}

// ── What the sign-in screen says on arrival ──────────────────────────────────

/**
 * @param {{ closed?: boolean, returnPending?: boolean }} state
 *   closed         arrived from closing the account (settings → login.html?closed=1)
 *   returnPending  the auth guard sent them here from a page they were using
 */
export function arrivalNotice({ closed = false, returnPending = false } = {}) {
    if (closed) return { tone: 'info', text: 'Your Fidus X account has been closed.' };
    if (returnPending) return { tone: 'info', text: 'Your session has ended. Sign in to carry on where you were.' };
    return null;
}

/** Show Back only after a page of this site, with somewhere to go back to (and never to sign-up). */
export function backAllowed({ referrer, origin, historyLength }) {
    try {
        const ref = referrer ? new URL(referrer) : null;
        return !!ref && ref.origin === origin && historyLength > 1;
    } catch (_) { return false; }
}
