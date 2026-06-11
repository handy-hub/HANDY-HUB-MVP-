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

import { getToken, onMessage }   from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging.js';
import { doc, updateDoc }        from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { firebaseMessaging, firebaseDb } from '../backend/providers/firebase/firebaseConfig.js';
import { FCM_VAPID_KEY }         from '../config/appConfig.js';

let _initialized = false;

/**
 * Request notification permission, obtain the FCM token, save it to Firestore,
 * and wire up foreground message handling.
 *
 * @param {string} uid       — Firebase Auth UID of the current user
 * @param {'customer'|'artisan'} userType
 */
export async function initializePushNotifications(uid, userType = 'customer') {
    if (_initialized) return;
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
        const collection = userType === 'artisan' ? 'artisans' : 'customers';
        await updateDoc(doc(firebaseDb, collection, uid), {
            fcmToken:  token,
            updatedAt: new Date().toISOString(),
        });

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
