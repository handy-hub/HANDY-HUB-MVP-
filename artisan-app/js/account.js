/**
 * artisan-app/js/account.js — what the Account tab decides and says (Phase 5).
 *
 * Pure: no DOM, no Firebase. settings.html carries these decisions out;
 * tests/artisan-account.test.cjs runs them.
 *
 *  · Every control writes only what the backend lets the artisan change:
 *    the work radius and the push preference on the profile, the phone in
 *    private/contact (CONTACT-001). The payout account and the verified claims
 *    are shown, never edited, here (firestore.rules freezes them once
 *    approved; changes go through a review).
 *  · Verification is the server's status in words; nothing here can make an
 *    account verified.
 *  · Messages are chosen by error code, never Firebase's own text.
 */
import { normalisePhone, MIN_PASSWORD } from './entry.js';
import { RADIUS_CHOICES } from './onboarding.js';

export { RADIUS_CHOICES };

// ── Verification: the server's status, in words ─────────────────────────────

/** The row for each status. `link`: whether there is something to do or check in the application. */
export const VERIFICATION = Object.freeze({
    approved:                 Object.freeze({ value: 'Verified',      tone: 'ok',   sub: 'Your documents are approved',               link: false }),
    pending_review:           Object.freeze({ value: 'Under review',  tone: 'warn', sub: 'Fidus X is checking your application',      link: true }),
    rejected:                 Object.freeze({ value: 'Action needed', tone: 'bad',  sub: 'Review the feedback and resubmit',          link: true }),
    re_verification_required: Object.freeze({ value: 'Action needed', tone: 'bad',  sub: 'We need you to verify your details again',  link: true }),
    draft:                    Object.freeze({ value: 'Not submitted', tone: 'warn', sub: 'Finish verification to receive paid jobs',  link: true }),
});

/** The same reading as onboarding's applicationPhase: no status or draft → draft; anything not listed → under review. */
export function verificationView(status) {
    const s = String(status || '').toLowerCase();
    if (s === '' || s === 'draft') return VERIFICATION.draft;
    return VERIFICATION[s] || VERIFICATION.pending_review;
}

// ── Job radius ───────────────────────────────────────────────────────────────
// Dispatch offers a job when it is within workRadius of the artisan
// (functions/dispatch.js `a.workRadius || 20`), searching at most 25 km around
// the job. What is shown is the distance that actually applies.

export const DISPATCH_MAX_KM = 25;
export const DISPATCH_DEFAULT_KM = 20;
export function effectiveRadius(profile) {
    const r = Number(profile && profile.workRadius);
    return Math.min(Number.isFinite(r) && r > 0 ? r : DISPATCH_DEFAULT_KM, DISPATCH_MAX_KM);
}
export const radiusPatch = (km, nowIso) => ({ workRadius: km, updatedAt: nowIso });

// ── Push notifications (AR-15, IX-01) ────────────────────────────────────────
// Two things, shown together: the PREFERENCE (saved on the profile, read by the
// server before every push: functions/notifications.js artisanPushAllowed) and
// THIS DEVICE's permission (the browser decides). The switch shows whether
// pushes reach this device; it never changes the saved preference by itself.

export const DEVICE_LINE = Object.freeze({
    on:          'On for this device.',
    off:         'Not yet allowed on this device. Turn it off and on again to be asked.',
    blocked:     'Blocked by this browser. Allow notifications for this site in your browser settings.',
    unsupported: "This browser can't receive push notifications. Everything still arrives in your inbox.",
    failed:      "This device couldn't be registered for push. Try again later.",
    pending:     'Checking this device…',
});
export const PUSH_OFF_LINE = 'Off. New job requests show only while the app is open. Payment notifications are still pushed.';
/** States in which this device receives no push whatever the preference says. */
export const DEVICE_CANNOT_RECEIVE = Object.freeze(['blocked', 'unsupported']);

export const savedPush = (profile) => !(profile && profile.notificationPreferences && profile.notificationPreferences.push === false);
export function pushView({ pref, device }) {
    if (!pref) return { checked: false, text: PUSH_OFF_LINE };
    return { checked: !DEVICE_CANNOT_RECEIVE.includes(device), text: DEVICE_LINE[device] || DEVICE_LINE.pending };
}
export const pushPatch = (want, nowIso) => ({ notificationPreferences: { push: !!want, updatedAt: nowIso }, updatedAt: nowIso });

// ── Phone (CONTACT-001: private/contact, never the public profile) ──────────

export function phoneProblem(raw) {
    if (!String(raw || '').trim()) return 'Enter your mobile number.';
    return normalisePhone(raw) ? null : 'Enter a Ghana mobile number, like 024 123 4567.';
}
/** The private/contact write: the owner's id and the number as the server stores it. */
export const contactPatch = (uid, raw, nowIso) => ({ artisanId: uid, phone: normalisePhone(raw), updatedAt: nowIso });

// ── Payout account: shown masked, changed only through verification ─────────

const NETWORK = { mtn: 'MTN', telecel: 'Telecel', vodafone: 'Telecel', airteltigo: 'AirtelTigo' };
export function payoutLine(kyc) {
    const acct = kyc && kyc.payoutAccount;
    const digits = String((acct && acct.phone) || '').replace(/\D/g, '');
    if (digits.length < 4) return 'Not added';
    return `${NETWORK[String(acct.provider || '').toLowerCase()] || 'MoMo'} •••${digits.slice(-4)}`;
}

// ── Password ────────────────────────────────────────────────────────────────

/** The first problem with a change-password form, as { field, message }, or null. */
export function passwordProblem({ current, next, confirm }) {
    if (!current) return { field: 'current', message: 'Enter your current password.' };
    if (String(next || '').length < MIN_PASSWORD) return { field: 'next', message: `Your new password needs at least ${MIN_PASSWORD} characters.` };
    if (next !== confirm) return { field: 'confirm', message: "The new passwords don't match." };
    if (next === current) return { field: 'next', message: 'Choose a password different from your current one.' };
    return null;
}
const codeOf = (e) => String((e && e.code) || '');
export function passwordError(e) {
    const code = codeOf(e);
    if (/wrong-password|invalid-credential/.test(code)) return 'Your current password is not right.';
    if (/weak-password/.test(code)) return 'That password is too easy to guess. Try a longer one.';
    if (/too-many-requests/.test(code)) return 'Too many attempts. Wait a few minutes and try again.';
    if (/network/.test(code)) return 'No connection. Your password was not changed.';
    return 'Your password was not changed. Try again.';
}
export function resetError(e) {
    return /too-many-requests/.test(codeOf(e)) ? 'Too many requests. Wait a few minutes and try again.' : 'Could not send the reset link. Try again.';
}

// ── Closing the account (AR-15) ─────────────────────────────────────────────

/** The server's own reasons (written for the artisan: functions/accountLifecycle.js), as plain strings. */
export function closeBlockers(source) {
    const list = Array.isArray(source) ? source : (source && source.details && Array.isArray(source.details.blockers) ? source.details.blockers : []);
    return list.map((b) => String((b && b.message) || '').trim()).filter(Boolean);
}
export function closeError(e) {
    const code = codeOf(e);
    if (/wrong-password|invalid-credential/.test(code)) return 'That password is not right.';
    if (/popup-closed|cancelled-popup/.test(code)) return 'Sign-in was cancelled. Your account is unchanged.';
    if (/too-many-requests|resource-exhausted/.test(code)) return 'Too many attempts. Wait a few minutes and try again.';
    if (/network|unavailable|deadline-exceeded/.test(code)) return "Can't reach the server. Your account was not closed.";
    if (/failed-precondition/.test(code)) return 'Your account was not closed. Confirm it is you and try again.';
    return 'Your account was not closed. Try again.';
}
export const CLOSE_WORD = 'CLOSE';
export const readyToClose = ({ typed, password, usesPassword }) =>
    String(typed || '').trim().toUpperCase() === CLOSE_WORD && (!usesPassword || String(password || '').length > 0);

// ── Who is signed in ────────────────────────────────────────────────────────

export function initials(name) {
    const s = String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('');
    return (s || '?').toUpperCase();
}

/* ── Appearance (Phase 6) ─────────────────────────────────────────────────
 * A preference of this DEVICE, not of the account: artisan-app/js/theme.js
 * keeps it in localStorage ('pref_theme') and applies it before first paint on
 * every page. The values are the ones that key has always held; 'System'
 * follows the phone's own light/dark setting. Nothing is written to the
 * profile, so it needs no backend and works signed out and offline. */
export const THEME_CHOICES = Object.freeze([
    Object.freeze({ value: 'Light',  label: 'Light' }),
    Object.freeze({ value: 'Dark',   label: 'Dark' }),
    Object.freeze({ value: 'System', label: 'Match this device' }),
]);
/** The stored value as a known choice; anything else is Light (the default). */
export const themeChoice = (stored) => (THEME_CHOICES.find((c) => c.value === stored) || THEME_CHOICES[0]).value;
/** The row's value: what is chosen, and for "match" what that means right now. */
export function themeLabel(stored, deviceIsDark) {
    const v = themeChoice(stored);
    if (v === 'System') return deviceIsDark ? 'Device (dark)' : 'Device (light)';
    return v;
}
