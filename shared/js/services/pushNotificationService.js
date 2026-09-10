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
 *   - firebase-messaging-sw.js deployed at the root of the hosting domain
 *   - FCM_VAPID_KEY filled in appConfig.js
 *   - fcmToken field allowed in Firestore rules for both customers and artisans
 */

import { getToken, onMessage }   from '../../vendor/firebase/firebase-messaging.js';
import { doc, updateDoc }        from '../../vendor/firebase/firebase-firestore.js';
// Keep push optional during rolling deployments. An older cached config module
// may not expose firebaseMessaging yet; that must not stop the dashboard graph.
import * as firebaseConfig from '../backend/providers/firebase/firebaseConfig.js';
import { FCM_VAPID_KEY }         from '../config/appConfig.js';

const { firebaseDb } = firebaseConfig;
const firebaseMessaging = firebaseConfig.firebaseMessaging ?? null;

let _initialized = false;

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

/**
 * Persist the device token. Identical for web and native by design: Cloud
 * Functions look up ONE field, so both platforms must write the same one.
 */
async function saveDeviceToken(uid, userType, token) {
    if (!uid || !token) return;
    const collection = userType === 'artisan' ? 'artisans' : 'customers';
    await updateDoc(doc(firebaseDb, collection, uid), {
        fcmToken:  token,
        updatedAt: new Date().toISOString(),
    });
}

/** Foreground presentation, shared by both transports. */
function presentForeground(title, body, type) {
    const toastType = type === 'payments' ? 'success'
                    : type === 'bookings' ? 'info'
                    : 'info';
    if (typeof window.showToast === 'function') {
        window.showToast(`${title} — ${body}`, toastType);
    }
}

/**
 * Native registration (Android FCM / iOS APNs).
 *
 * @returns {Promise<boolean>} true when this ran, i.e. we are in a native shell
 *          and the caller should NOT fall through to the web path.
 */
async function initNativePush(uid, userType) {
    const PN = nativePushPlugin();
    if (!PN) return false;

    try {
        let perm = await PN.checkPermissions();
        if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
            perm = await PN.requestPermissions();
        }
        if (perm.receive !== 'granted') {
            // A declined prompt is a legitimate user choice, not an error. The
            // app keeps working; it simply will not receive pushes.
            console.info('[push] native permission not granted — push disabled');
            return true;
        }

        // The token arrives asynchronously on the 'registration' event, so the
        // listeners must be attached BEFORE register() is called.
        PN.addListener('registration', async (t) => {
            try {
                await saveDeviceToken(uid, userType, t && t.value);
                console.log('[push] native token registered for', userType, uid);
            } catch (err) {
                console.warn('[push] saving native token failed:', err && err.message);
            }
        });

        PN.addListener('registrationError', (err) => {
            // Almost always a missing google-services.json / APNs setup rather
            // than anything the user did. Loud, because silence here is what
            // made the web version so hard to notice.
            console.warn('[push] native registration FAILED:', err && (err.error || err.message));
        });

        // Delivered while the app is in the foreground; the OS shows nothing.
        PN.addListener('pushNotificationReceived', (notif) => {
            presentForeground(
                (notif && notif.title) || 'HandyHub',
                (notif && notif.body) || '',
                ((notif && notif.data && notif.data.type) || 'info').toLowerCase()
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

        await PN.register();
        _initialized = true;
        return true;

    } catch (err) {
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
 */
export async function initializePushNotifications(uid, userType = 'customer') {
    if (_initialized) return;

    // Native first. The web path below depends on a service worker and a VAPID
    // key, neither of which exists in a packaged app, and its guard clauses
    // would return silently rather than report that push is dead.
    if (await initNativePush(uid, userType)) return;

    if (!firebaseMessaging) return; // browser doesn't support FCM (e.g. Safari < 16)
    if (!FCM_VAPID_KEY)    return; // not yet configured — skip silently

    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;

    try {
        // Register the FCM service worker.
        // Must be at the root of the hosting scope — firebase.json serves customer-app/ as root.
        const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js', {
            scope: '/',
        });

        // Request permission — browser shows the native permission prompt once.
        // On subsequent calls, returns the already-granted state without prompting.
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;

        // Get the FCM registration token for this device+browser.
        const token = await getToken(firebaseMessaging, {
            vapidKey: FCM_VAPID_KEY,
            serviceWorkerRegistration: registration,
        });

        if (!token) return;

        // Persist the token in the user's Firestore document so Cloud Functions
        // can look it up when sending notifications.
        await saveDeviceToken(uid, userType, token);

        // Handle notifications that arrive while the app is open (foreground).
        // Firebase suppresses the system notification in this case, so we show
        // a toast instead to keep the UX consistent.
        onMessage(firebaseMessaging, (payload) => {
            const title = payload.notification?.title || 'HandyHub';
            const body  = payload.notification?.body  || '';
            const type  = payload.data?.type?.toLowerCase() || 'info';

            // Map FCM type → toast type
            const toastType = type === 'payments' ? 'success'
                            : type === 'bookings' ? 'info'
                            : 'info';

            if (typeof window.showToast === 'function') {
                window.showToast(`${title} — ${body}`, toastType);
            }

            // Also navigate on foreground notification tap via actionUrl
            const actionUrl = payload.data?.actionUrl;
            if (actionUrl && payload.data?._tapped) {
                window.location.href = `/${actionUrl}`;
            }
        });

        _initialized = true;
        console.log('[push] FCM initialized for', userType, uid);

    } catch (err) {
        // Never throw — push notification failures are always non-fatal
        console.warn('[push] initializePushNotifications failed:', err.message);
    }
}
