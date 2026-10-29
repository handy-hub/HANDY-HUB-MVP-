/**
 * safeAppUrl.js — the only links a notification may open (SEC-001).
 *
 * customer_notifications can be written by any signed-in user, so a
 * notification's actionUrl is untrusted input. The artisan inbox put it into an
 * onclick attribute and assigned it to location.href, so a forged notification
 * could run `javascript:` in the app, or send the user to another site under a
 * "Support replied" title.
 *
 * Every place that navigates from a notification goes through safeAppUrl().
 * firestore.rules (customer_notifications create) applies the same pattern, so
 * a forged link is refused on write and ignored on tap.
 *
 * Accepted: a page in the same app, with an optional plain query.
 *   'booking.html'   'messages.html?chatId=a_b'   'job.html?id=HHB-260820-0332-58F1'
 * Refused: schemes (javascript:, data:, https:), '//host', paths, backslashes,
 * quotes, spaces, fragments. Anything refused is treated as "no link".
 */

export const SAFE_APP_URL_MAX = 300;

// Mirrored in firestore.rules as a string; tests/notification-safety pins both.
export const SAFE_APP_URL_PATTERN = /^[A-Za-z0-9_-]+\.html(\?[A-Za-z0-9_.%=&-]*)?$/;

/** @returns {string|null} the URL when it is a same-app page, otherwise null */
export function safeAppUrl(url) {
    if (typeof url !== 'string' || !url || url.length > SAFE_APP_URL_MAX) return null;
    return SAFE_APP_URL_PATTERN.test(url) ? url : null;
}
