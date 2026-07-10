/**
 * errorCopy.js — turn raw errors into friendly, actionable user copy.
 *
 * The booking flow surfaced errors with `showToast(err.message)`, which at a
 * payment moment could display the literal word "internal" (a Firebase callable
 * error code) — a trust-destroying, non-actionable message. This module maps
 * error shapes to human copy so users never see a raw code.
 *
 * Strategy:
 *   1. If the app deliberately threw an Error with a human sentence (our Cloud
 *      Functions do — "This pricing quote has expired…"), pass it through: it is
 *      already the right message for the user.
 *   2. If it is a Firebase callable/SDK error (err.code like "functions/internal",
 *      "auth/…", "resource-exhausted"), map the code to friendly copy.
 *   3. Otherwise fall back to a safe generic message.
 *
 * No imports — evaluates in every browser context.
 */

// Friendly copy per Firebase error code (bare code or `functions/<code>` form).
const CODE_COPY = {
    'internal':            'Something went wrong on our end. Please try again in a moment.',
    'unavailable':         'We can’t reach the server right now. Check your connection and try again.',
    'deadline-exceeded':   'That took too long. Please try again.',
    'unauthenticated':     'Your session expired. Please sign in again.',
    'permission-denied':   'You don’t have permission to do that.',
    'resource-exhausted':  'You’re doing that a bit too often. Please wait a moment and try again.',
    'not-found':           'We couldn’t find that. It may have been removed.',
    'already-exists':      'That already exists.',
    'failed-precondition': 'This can’t be done right now. Please refresh and try again.',
    'invalid-argument':    'Some details look off. Please check and try again.',
    'cancelled':           'That was cancelled.',
    'unknown':             'Something went wrong. Please try again.',
    // Auth-specific
    'auth/network-request-failed': 'Network problem. Check your connection and try again.',
    'auth/too-many-requests':      'Too many attempts. Please wait a moment and try again.',
    'auth/user-not-found':         'No account found with those details.',
    'auth/wrong-password':         'Incorrect email or password.',
    'auth/invalid-email':          'That email address doesn’t look right.',
    // App-specific
    'rate-limited':        'You’re doing that a bit too often. Please wait a moment and try again.',
};

const GENERIC = 'Something went wrong. Please try again.';

// Bare Firebase error codes are short kebab tokens with no spaces/punctuation
// (e.g. "internal", "unavailable"). Our own thrown messages are full sentences.
// This distinguishes a leaked code from a human message.
function looksLikeRawCode(msg) {
    if (!msg) return true;
    const m = String(msg).trim();
    // A human sentence has a space or ends with punctuation; a raw code doesn't.
    return !/\s/.test(m) && m.length <= 24;
}

function normalizeCode(code) {
    if (!code) return null;
    const c = String(code).toLowerCase();
    return c.startsWith('functions/') ? c.slice('functions/'.length) : c;
}

/**
 * @param {unknown} err  the caught error
 * @param {string} [fallback]  message to use if nothing better is found
 * @returns {string} user-facing copy — never a bare code
 */
export function mapError(err, fallback = GENERIC) {
    if (!err) return fallback;

    // 1. Known code → friendly copy (checked first: "internal" must never leak).
    const code = normalizeCode(err.code);
    if (code && CODE_COPY[code]) return CODE_COPY[code];

    // 2. A deliberate, human-readable message from our own code → pass through.
    const msg = err.message || err.reason || (typeof err === 'string' ? err : '');
    if (msg && !looksLikeRawCode(msg)) {
        // Guard: some SDKs put the code in the message ("internal", "INTERNAL").
        const asCode = normalizeCode(msg);
        if (CODE_COPY[asCode]) return CODE_COPY[asCode];
        return msg;
    }

    // 3. Message was itself a bare code we recognise.
    const msgCode = normalizeCode(msg);
    if (msgCode && CODE_COPY[msgCode]) return CODE_COPY[msgCode];

    return fallback;
}
