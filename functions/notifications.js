'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// notifications.js — server-side notification delivery
//
// Every notification does two things in parallel:
//   1. Writes to customer_notifications (in-app inbox, real-time badge).
//   2. Sends an FCM push (native browser/device notification when app is closed).
//
// FCM push failures are always non-fatal — they must never break booking or
// financial flows. Stale tokens are removed automatically.
// ─────────────────────────────────────────────────────────────────────────────

const { FIRESTORE_DB_ID } = require('./config');
const NOTIF_COL = 'customer_notifications';

const PREF_MAP = {
    Payments: 'payments',
    Bookings: 'bookings',
    Messages: 'messages',
    Offers:   'offers',
    Reviews:  'reviews',
    System:   'system',
    General:  null,
};

let _db;
function db() {
    if (!_db) {
        const { getFirestore } = require('firebase-admin/firestore');
        _db = getFirestore(FIRESTORE_DB_ID);
    }
    return _db;
}

let _messaging;
function messaging() {
    if (!_messaging) {
        const { getMessaging } = require('firebase-admin/messaging');
        _messaging = getMessaging();
    }
    return _messaging;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send notification to a CUSTOMER.
 * Respects notificationPreferences. Reads the customer doc once (shared with
 * pref check) to get the FCM token — no extra Firestore read.
 */
async function sendNotification(receiverId, data) {
    try {
        const type    = data.type || 'General';
        const prefKey = PREF_MAP[type] ?? null;

        let fcmToken = null;

        const snap = await db().collection('customers').doc(receiverId).get();
        if (snap.exists) {
            const d = snap.data();
            fcmToken = d.fcmToken || null;
            if (prefKey !== null && (d.notificationPreferences || {})[prefKey] === false) {
                console.log(`[notif] Skipped ${type} to customer=${receiverId} (pref off)`);
                return null;
            }
        }

        const notifId = await _write(receiverId, type, data);

        // FCM push — fire-and-forget; never blocks the caller
        if (fcmToken) {
            _sendFcm(fcmToken, type, data, receiverId, 'customer').catch(() => {});
        }

        return notifId;
    } catch (err) {
        console.error('[notif] sendNotification error:', err.message);
        return null;
    }
}

/**
 * Send notification to an ARTISAN.
 * No preference check — artisans always receive booking and payment events.
 * Fetches artisan doc for FCM token.
 */
async function sendArtisanNotification(artisanId, data) {
    try {
        const type = data.type || 'General';

        const snap   = await db().collection('artisans').doc(artisanId).get();
        const token  = snap.exists ? (snap.data().fcmToken || null) : null;

        const notifId = await _write(artisanId, type, data);

        if (token) {
            _sendFcm(token, type, data, artisanId, 'artisan').catch(() => {});
        }

        return notifId;
    } catch (err) {
        console.error('[notif] sendArtisanNotification error:', err.message);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal
// ─────────────────────────────────────────────────────────────────────────────

async function _write(receiverId, type, data) {
    const ref = db().collection(NOTIF_COL).doc();
    await ref.set({
        receiverId,
        senderId:  data.senderId  ?? null,
        type,
        title:     data.title,
        message:   data.message,
        isRead:    false,
        readAt:    null,
        actionUrl: data.actionUrl ?? null,
        metadata:  data.metadata  ?? {},
        createdAt: new Date().toISOString(),
    });
    return ref.id;
}

async function _sendFcm(token, type, data, userId, userType) {
    try {
        await messaging().send({
            token,
            notification: {
                title: data.title,
                body:  data.message,
            },
            webpush: {
                notification: {
                    icon:  '/icons/icon-192.png',
                    badge: '/icons/badge-72.png',
                    // Keep booking notifications on screen until the user acts —
                    // critical for artisans during the 30-second emergency window.
                    requireInteraction: type === 'Bookings',
                },
                fcmOptions: {
                    link: data.actionUrl ? `/${data.actionUrl}` : '/dashboard.html',
                },
            },
            // Structured data payload so the SW can deep-link on tap
            data: {
                type:      String(type),
                actionUrl: String(data.actionUrl || ''),
                bookingId: String(data.metadata?.bookingId || ''),
            },
        });

        console.log(`[notif] FCM push → ${userType}=${userId} type=${type}`);

    } catch (err) {
        // Stale or unregistered token — clean it up so we stop trying
        if (
            err.code === 'messaging/registration-token-not-registered' ||
            err.code === 'messaging/invalid-registration-token'
        ) {
            console.log(`[notif] Stale FCM token for ${userType}=${userId} — clearing`);
            const col = userType === 'artisan' ? 'artisans' : 'customers';
            await db().collection(col).doc(userId)
                .update({ fcmToken: null })
                .catch(() => {});
        } else {
            console.warn(`[notif] FCM push failed ${userType}=${userId}:`, err.message);
        }
    }
}

module.exports = { sendNotification, sendArtisanNotification };
