/**
 * pushNotificationService.js
 *
 * Handles browser push notification permission, FCM token registration,
 * and foreground message display.
 *
 * Call initializePushNotifications(uid, userType) once after the user
 * successfully authenticates. Safe to call multiple times — it's idempotent.
 *
 * Requires:
 *   - the push service worker at the SITE ROOT, /firebase-messaging-sw.js.
 *     Its source is shared/push/firebase-messaging-sw.js; scripts/stage-hosting.cjs
 *     copies it to the root of every build that uses push. (Until 2026-10-20 that
 *     path served login.html, registration failed, and no token was ever saved.)
 *   - FCM_VAPID_KEY filled in appConfig.js
 *   - fcmToken / fcmPlatform / fcmTokenUpdatedAt allowed in Firestore rules for
 *     both customers and artisans
 *
 * Status: getPushState() and the window event 'fx:push-state' report a
 * PUSH_STATE (./pushState.js). Only a token that was obtained AND saved is ON —
 * a registered worker alone is not push working.
 */

import { getToken, onMessage }   from '../../vendor/firebase/firebase-messaging.js';
import { doc, updateDoc }        from '../../vendor/firebase/firebase-firestore.js';
// Keep push optional during rolling deployments. An older cached config module
// may not expose firebaseMessaging yet; that must not stop the dashboard graph.
import * as firebaseConfig from '../backend/providers/firebase/firebaseConfig.js';
import { FCM_VAPID_KEY }         from '../config/appConfig.js';
import { PUSH_STATE, tokenNeedsSave, workerUrl, nativePushAction, NATIVE_PUSH_DEFER_MS } from './pushState.js';

const { firebaseDb } = firebaseConfig;
const firebaseMessaging = firebaseConfig.firebaseMessaging ?? null;

let _initialized = false;
let _foregroundWired = false;
let _state = PUSH_STATE.PENDING;

/** The current push state of this device (see ./pushState.js). */
export function getPushState() {
    return _state;
}

function setState(next) {
    if (_state === next) return;
    _state = next;
    try {
        window.dispatchEvent(new CustomEvent('fx:push-state', { detail: { state: next } }));
    } catch (_) { /* no window (tests) */ }
}

/**
 * The Capacitor PushNotifications plugin, or null on the web.
 *
 * Absence is the signal that we are in a browser — no user agent sniffing, no
 * hostname test (which would be wrong anyway: Capacitor serves from localhost).
 */
function nativePushPlugin() {
    try {
        return (window.Capacitor && window.Capacitor.Plugins &&
                window.Capacitor.Plugins.PushNotifications) || null;
    } catch (_) {
        return null;
    }
}

const savedTokenKey = (userType, uid) => `fx_push_token:${userType}:${uid}`;
// When the customer may next be asked (our "Not now"); Android's own state is
// always read fresh from the plugin, never from here.
const NATIVE_ASK_AFTER_KEY = 'fx_push_ask_after';
let _nativeListenersWired = false;
let _resumeRecheckArmed = false;

/**
 * The explanation shown BEFORE Android's notification dialog (Android 13+ asks
 * once or twice, then never again — so the one chance is spent on a customer
 * who knows what it is for). Resolves true for "Allow", false for "Not now".
 */
function explainNativePush() {
    return new Promise((resolve) => {
        const ov = document.createElement('div');
        ov.setAttribute('role', 'dialog');
        ov.setAttribute('aria-modal', 'true');
        ov.setAttribute('aria-labelledby', 'fx-push-ask-title');
        ov.style.cssText = 'position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);' +
            'display:flex;align-items:flex-end;justify-content:center;font-family:inherit';
        ov.innerHTML =
            '<div style="width:100%;max-width:480px;box-sizing:border-box;background:#fff;color:#111;' +
            'border-radius:20px 20px 0 0;padding:22px 20px calc(20px + env(safe-area-inset-bottom))">' +
            '<p id="fx-push-ask-title" style="margin:0 0 8px;font-size:18px;font-weight:800;line-height:1.3">Get booking updates</p>' +
            '<p style="margin:0 0 18px;font-size:14px;line-height:1.5;color:#555">Fidus X can tell you when an artisan accepts ' +
            'your request, is on the way or sends a quote, even when the app is closed. You can change this any time in your ' +
            'phone’s settings.</p>' +
            '<button type="button" data-fx="allow" style="width:100%;min-height:48px;border:0;border-radius:12px;' +
            'background:var(--ui-primary,#730201);color:#fff;font:700 15px/1 inherit;cursor:pointer">Allow notifications</button>' +
            '<button type="button" data-fx="later" style="width:100%;min-height:48px;margin-top:8px;border:0;border-radius:12px;' +
            'background:#f2f2f2;color:#111;font:700 15px/1 inherit;cursor:pointer">Not now</button></div>';
        const done = (yes) => { document.removeEventListener('keydown', onKey); ov.remove(); resolve(yes); };
        const onKey = (e) => { if (e.key === 'Escape') done(false); };
        ov.addEventListener('click', (e) => {
            const b = e.target.closest('[data-fx]');
            if (b) done(b.dataset.fx === 'allow');
            else if (e.target === ov) done(false);
        });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(ov);
        try { ov.querySelector('[data-fx="allow"]').focus(); } catch (_) {}
    });
}

/**
 * Customers change permissions in Android Settings while the app is in the
 * background. On return, re-read the real state — never prompting — so a
 * permission granted there starts working without another sign-in.
 */
function armNativeResumeRecheck(uid, userType) {
    if (_resumeRecheckArmed) return;
    _resumeRecheckArmed = true;
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || _initialized) return;
        initNativePush(uid, userType, { prompt: false }).catch(() => {});
    });
}

/**
 * Persist the device token. Identical for web and native by design: Cloud
 * Functions look up ONE field, so both platforms must write the same one, plus
 * the platform, which decides the message shape the server sends.
 *
 * Written only when it changed (remembered per browser): every write to an
 * artisan's profile re-runs the search-index trigger, and the token is fetched
 * on every page load.
 */
async function saveDeviceToken(uid, userType, token, platform) {
    if (!uid || !token) return;
    let saved = null;
    try { saved = localStorage.getItem(savedTokenKey(userType, uid)); } catch (_) { /* private mode */ }
    if (!tokenNeedsSave(saved, token)) return;

    const collection = userType === 'artisan' ? 'artisans' : 'customers';
    const now = new Date().toISOString();
    await updateDoc(doc(firebaseDb, collection, uid), {
        fcmToken:          token,
        fcmPlatform:       platform,
        fcmTokenUpdatedAt: now,
        updatedAt:         now,
    });
    try { localStorage.setItem(savedTokenKey(userType, uid), token); } catch (_) { /* best effort */ }
}

/**
 * Foreground presentation, shared by both transports. An open page hears it
 * first ('fx:push', cancelable) and may cancel the generic toast — the artisan
 * dashboard does, for an offer it has already announced itself.
 */
function presentForeground(title, body, type, data = {}) {
    let handledByPage = false;
    try {
        handledByPage = !window.dispatchEvent(new CustomEvent('fx:push', { detail: data, cancelable: true }));
    } catch (_) { /* no window (tests) */ }
    if (handledByPage) return;
    const toastType = type === 'payments' ? 'success'
                    : type === 'bookings' ? 'info'
                    : 'info';
    if (typeof window.showToast === 'function') {
        window.showToast(body ? `${title} — ${body}` : title, toastType);
    }
}

/**
 * Native registration (Android FCM / iOS APNs).
 *
 * @returns {Promise<boolean>} true when this ran, i.e. we are in a native shell
 *          and the caller should NOT fall through to the web path.
 */
async function initNativePush(uid, userType, { prompt = true, explicit = false } = {}) {
    const PN = nativePushPlugin();
    if (!PN) return false;

    let platform = 'android';
    try {
        const p = window.Capacitor.getPlatform && window.Capacitor.getPlatform();
        if (p === 'ios' || p === 'android') platform = p;
    } catch (_) { /* default android — the only native build that exists */ }

    try {
        armNativeResumeRecheck(uid, userType);
        let perm = await PN.checkPermissions();
        let askAfter = 0;
        try { askAfter = Number(localStorage.getItem(NATIVE_ASK_AFTER_KEY)) || 0; } catch (_) { /* storage blocked */ }
        // An explicit "Turn on" tap overrides an earlier "Not now" and needs no
        // explanation: the customer just asked for it.
        const action = nativePushAction(perm.receive, { prompt, deferredUntil: explicit ? 0 : askAfter, now: Date.now() });

        if (action === 'blocked') {
            // Declined in Android (or in its Settings) — a legitimate choice. The
            // app keeps working; it simply will not receive pushes, and is not
            // asked again.
            console.info('[push] native permission denied — push off, not re-asked');
            setState(PUSH_STATE.BLOCKED);
            return true;
        }
        if (action === 'wait') { setState(PUSH_STATE.OFF); return true; }
        if (action === 'explain') {
            if (!explicit && !(await explainNativePush())) {
                try { localStorage.setItem(NATIVE_ASK_AFTER_KEY, String(Date.now() + NATIVE_PUSH_DEFER_MS)); } catch (_) {}
                setState(PUSH_STATE.OFF);
                return true;
            }
            perm = await PN.requestPermissions();
            if (perm.receive !== 'granted') {
                console.info('[push] native permission not granted — push disabled');
                setState(PUSH_STATE.BLOCKED);
                return true;
            }
        }

        // The token arrives asynchronously on the 'registration' event, so the
        // listeners must be attached BEFORE register() is called — once.
        if (!_nativeListenersWired) {
        _nativeListenersWired = true;
        PN.addListener('registration', async (t) => {
            try {
                await saveDeviceToken(uid, userType, t && t.value, platform);
                setState(PUSH_STATE.ON);
                console.log('[push] native token registered for', userType, uid);
            } catch (err) {
                setState(PUSH_STATE.FAILED);
                console.warn('[push] saving native token failed:', err && err.message);
            }
        });

        PN.addListener('registrationError', (err) => {
            // Almost always a missing google-services.json / APNs setup rather
            // than anything the user did. Loud, because silence here is what
            // made the web version so hard to notice.
            setState(PUSH_STATE.FAILED);
            console.warn('[push] native registration FAILED:', err && (err.error || err.message));
        });

        // Delivered while the app is in the foreground; the OS shows nothing.
        PN.addListener('pushNotificationReceived', (notif) => {
            presentForeground(
                (notif && notif.title) || 'Fidus X',
                (notif && notif.body) || '',
                ((notif && notif.data && notif.data.type) || 'info').toLowerCase(),
                (notif && notif.data) || {}
            );
        });

        // The user tapped a notification — from background OR a cold start.
        PN.addListener('pushNotificationActionPerformed', (action) => {
            const data = (action && action.notification && action.notification.data) || {};
            const actionUrl = data.actionUrl;
            if (!actionUrl) return;
            // Relative on purpose: the bundle root is the app, and an absolute
            // '/...' would resolve against the WebView origin instead.
            try { window.location.href = String(actionUrl).replace(/^\/+/, ''); } catch (_) {}
        });
        }

        await PN.register();
        _initialized = true;
        return true;

    } catch (err) {
        setState(PUSH_STATE.FAILED);
        console.warn('[push] native init failed:', err && err.message);
        return true;   // native shell confirmed; do not fall back to the web path
    }
}

/**
 * Request notification permission, obtain the FCM token, save it to Firestore,
 * and wire up foreground message handling.
 *
 * @param {string} uid       — Firebase Auth UID of the current user
 * @param {'customer'|'artisan'} userType
 * @param {{ prompt?: boolean }} [opts] — prompt:false never shows the browser's
 *        permission prompt (used to refresh state without interrupting)
 */
export async function initializePushNotifications(uid, userType = 'customer', { prompt = true, explicit = false } = {}) {
    if (_initialized) return;

    // Native first. The web path below depends on a service worker and a VAPID
    // key, neither of which exists in a packaged app, and its guard clauses
    // would return silently rather than report that push is dead.
    if (await initNativePush(uid, userType, { prompt, explicit })) return;

    if (!firebaseMessaging || !FCM_VAPID_KEY ||
        !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        setState(PUSH_STATE.UNSUPPORTED);
        return;
    }
    if (Notification.permission === 'denied') {
        setState(PUSH_STATE.BLOCKED);
        return;
    }

    try {
        // The worker lives at the SITE ROOT so its scope covers every app page;
        // it is given this page's Firebase config and which app it serves.
        const options = (firebaseConfig.firebaseApp && firebaseConfig.firebaseApp.options) || {};
        const registration = await navigator.serviceWorker.register(workerUrl(userType, options), {
            scope: '/',
        });

        // Ask once (or not at all when prompt is false). A granted permission
        // returns at once without prompting.
        let permission = Notification.permission;
        if (permission === 'default' && prompt) permission = await Notification.requestPermission();
        if (permission === 'denied')  { setState(PUSH_STATE.BLOCKED); return; }
        if (permission !== 'granted') { setState(PUSH_STATE.OFF);     return; }

        // Get the FCM registration token for this device+browser. FCM may rotate
        // it; a changed token is saved, an unchanged one is not.
        const token = await getToken(firebaseMessaging, {
            vapidKey: FCM_VAPID_KEY,
            serviceWorkerRegistration: registration,
        });
        if (!token) { setState(PUSH_STATE.FAILED); return; }

        await saveDeviceToken(uid, userType, token, 'web');

        // Messages that arrive while a page of this site is in focus come here
        // instead of the worker. Web pushes are data-only (functions/
        // notifications.js), so the text is in payload.data.
        if (!_foregroundWired) {
            _foregroundWired = true;
            onMessage(firebaseMessaging, (payload) => {
                const data  = payload.data || {};
                const title = payload.notification?.title || data.title || 'Fidus X';
                const body  = payload.notification?.body  || data.body  || '';
                presentForeground(title, body, String(data.type || 'info').toLowerCase(), data);
            });
        }

        _initialized = true;
        setState(PUSH_STATE.ON);
        console.log('[push] FCM initialized for', userType, uid);

    } catch (err) {
        // Never throw — push notification failures are always non-fatal. But say
        // so: getPushState() turns the dashboard banner on.
        setState(PUSH_STATE.FAILED);
        console.warn('[push] initializePushNotifications failed:', err.message);
    }
}

/**
 * The banner's "Turn on alerts" button: runs from a user gesture, so the
 * browser will show its permission prompt.
 */
export async function enablePushNotifications(uid, userType = 'customer') {
    _initialized = false;
    await initializePushNotifications(uid, userType, { prompt: true, explicit: true });
    return _state;
}
