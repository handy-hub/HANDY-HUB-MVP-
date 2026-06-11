// firebase-messaging-sw.js — FCM background message handler
//
// Must use the Firebase compat (non-modular) SDK via importScripts.
// Must be served from the root of the hosting scope.
// firebase.json → "public": "customer-app" so this file IS the root.
//
// This worker handles push notifications when:
//   - The browser tab is closed
//   - The app is backgrounded / minimised
//   - The screen is locked
//
// When the app is in the foreground, messages are handled by onMessage() in
// pushNotificationService.js and shown as toasts instead.

importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
    apiKey:            'AIzaSyBF-B48cl2jHJwcKxocpClNTYlLwK1cLiw',
    authDomain:        'lamax-4fd82.firebaseapp.com',
    projectId:         'lamax-4fd82',
    storageBucket:     'lamax-4fd82.firebasestorage.app',
    messagingSenderId: '1034220501833',
    appId:             '1:1034220501833:web:bba9ad6f78881029a0f898',
});

const messaging = firebase.messaging();

// ── Background message handler ────────────────────────────────────────────────
// Called when a push arrives and the app is not in focus.
// We must call showNotification() ourselves — Firebase does not auto-display
// background messages for web (unlike Android/iOS native SDKs).
messaging.onBackgroundMessage((payload) => {
    const title = payload.notification?.title || 'HandyHub';
    const body  = payload.notification?.body  || '';
    const type  = payload.data?.type || '';

    self.registration.showNotification(title, {
        body,
        icon:  '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag:   payload.data?.bookingId || 'hh-notif', // collapses duplicate booking alerts
        data: {
            actionUrl: payload.data?.actionUrl || 'dashboard.html',
            bookingId: payload.data?.bookingId || '',
            type,
        },
        // Keep booking notifications on screen — artisans must see the 30s dispatch window
        requireInteraction: type === 'Bookings',
        vibrate: [200, 100, 200],
    });
});

// ── Notification click handler ────────────────────────────────────────────────
// Deep-links the user to the relevant page when they tap the notification.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const actionUrl = event.notification.data?.actionUrl || 'dashboard.html';
    const target    = `/${actionUrl}`;

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            // If the app is already open somewhere, focus that tab and navigate
            for (const client of windowClients) {
                if ('focus' in client) {
                    client.focus();
                    client.navigate(target).catch(() => {});
                    return;
                }
            }
            // App not open — open a new window
            if (clients.openWindow) {
                return clients.openWindow(target);
            }
        })
    );
});
