// firebase-messaging-sw.js — Fidus X web push, for the customer and artisan apps.
//
// WHERE IT LIVES
// Served at the SITE ROOT, /firebase-messaging-sw.js, so its scope is the whole
// origin. scripts/stage-hosting.cjs copies this file there for every app that
// uses push. Without that copy the path falls through to the `**` rewrite and
// the browser is handed login.html, which it refuses to run as a worker — the
// state from 2026-07-02 until this file existed: registration failed on both
// sites, no device ever stored a push token, and job offers expired unseen.
//
// HOW IT IS REGISTERED
// shared/js/services/pushNotificationService.js registers
//   /firebase-messaging-sw.js?app=<artisan|customer>&apiKey=…&projectId=…
//                            &messagingSenderId=…&appId=…
// so the Firebase config is the page's own (one source of truth, whatever the
// environment) and the worker knows which app's pages to open.
//
// WHAT IT DRAWS
// Pushes to web tokens are DATA-ONLY (functions/notifications.js). This worker
// draws every notification itself, so links get the right app prefix, an offer
// that has already expired says so instead of inviting a tap, and nothing is
// shown twice. A message that does carry a `notification` block is displayed by
// the Firebase SDK itself and left alone here.

'use strict';

const PARAMS   = new URL(self.location.href).searchParams;
const APP      = PARAMS.get('app') === 'artisan' ? 'artisan' : 'customer';
const APP_BASE = APP === 'artisan' ? '/artisan-app/' : '/customer-app/';
const HOME     = 'dashboard.html';
const ICON     = '/shared/assets/images/handyhub-logo.png';

/**
 * The page a notification opens, always inside this app on this origin.
 * actionUrl is app-relative ('jobs.html', 'booking.html?id=…'). Anything that
 * would leave the app — another origin, a protocol, a path escaping the app
 * folder — falls back to the app's dashboard rather than being followed.
 */
function resolveTarget(actionUrl) {
    const fallback = APP_BASE + HOME;
    const raw = typeof actionUrl === 'string' ? actionUrl.trim() : '';
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) return fallback;
    try {
        const url = new URL(APP_BASE + raw.replace(/^\/+/, ''), self.location.origin);
        if (url.origin !== self.location.origin || !url.pathname.startsWith(APP_BASE)) return fallback;
        return url.pathname + url.search + url.hash;
    } catch (_) {
        return fallback;
    }
}

/**
 * Title and options for one data-only push.
 * A job offer carries expiresAtMs; if it arrives after that (a phone that was
 * offline), it is still shown — a push must always produce a notification — but
 * as expired, without the "act now" emphasis.
 */
function buildNotification(data, nowMs) {
    const d = data || {};
    const type = String(d.type || '');
    const expiresAtMs = Number(d.expiresAtMs);
    const expired = Number.isFinite(expiresAtMs) && expiresAtMs > 0 && nowMs >= expiresAtMs;

    const title = expired ? 'Job request expired' : (String(d.title || '') || 'Fidus X');
    const body  = expired
        ? 'This request timed out before it was answered. New requests appear on your dashboard.'
        : String(d.body || '');

    return {
        title,
        options: {
            body,
            icon:  ICON,
            badge: ICON,
            // One notification per booking: a re-offer replaces the old one.
            tag:   d.bookingId ? `booking-${d.bookingId}` : 'fx-notification',
            renotify: !!d.bookingId && !expired,
            // A live job offer stays on screen until the artisan acts on it.
            requireInteraction: type === 'Bookings' && !expired,
            vibrate: expired ? undefined : [200, 100, 200],
            data: { url: resolveTarget(d.actionUrl), bookingId: String(d.bookingId || ''), type },
        },
    };
}

// ── Clicks — registered before the SDK loads, for notifications drawn here ────
self.addEventListener('notificationclick', (event) => {
    const data = (event.notification && event.notification.data) || {};
    // Notifications the Firebase SDK drew itself carry FCM_MSG; it opens those.
    if (data.FCM_MSG) return;
    event.notification.close();
    const target = data.url || (APP_BASE + HOME);

    event.waitUntil((async () => {
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const mine = windows.find((c) => {
            try { return new URL(c.url).pathname.startsWith(APP_BASE); } catch (_) { return false; }
        });
        if (mine) {
            await mine.focus();
            try { await mine.navigate(target); } catch (_) { /* cross-origin or gone */ }
            return;
        }
        if (self.clients.openWindow) await self.clients.openWindow(target);
    })());
});

// ── Firebase Messaging ────────────────────────────────────────────────────────
// The compat SDK is the only form a classic worker can load; the version matches
// the pinned web SDK (shared/vendor/firebase, 10.8.0).
const CONFIG = {
    apiKey:            PARAMS.get('apiKey'),
    projectId:         PARAMS.get('projectId'),
    messagingSenderId: PARAMS.get('messagingSenderId'),
    appId:             PARAMS.get('appId'),
};

if (CONFIG.apiKey && CONFIG.projectId && CONFIG.messagingSenderId && CONFIG.appId) {
    importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
    importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

    firebase.initializeApp(CONFIG);
    const messaging = firebase.messaging();

    // Called when a push arrives and no page of this origin is in focus.
    messaging.onBackgroundMessage((payload) => {
        // A `notification` block means the SDK has already displayed it.
        if (payload && payload.notification) return;
        const { title, options } = buildNotification(payload && payload.data, Date.now());
        return self.registration.showNotification(title, options);
    });
} else {
    // Registered without its config (an old page, or a hand-typed URL): stay
    // installed so a later registration can replace it, but receive nothing.
    console.warn('[fx-sw] registered without Firebase config — push disabled until re-registered');
}
