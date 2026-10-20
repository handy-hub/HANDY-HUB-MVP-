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
        let fcmPlatform = null;

        const snap = await db().collection('customers').doc(receiverId).get();
        if (snap.exists) {
            const d = snap.data();
            fcmToken = d.fcmToken || null;
            fcmPlatform = d.fcmPlatform || null;
            if (prefKey !== null && (d.notificationPreferences || {})[prefKey] === false) {
                console.log(`[notif] Skipped ${type} to customer=${receiverId} (pref off)`);
                return null;
            }
        }

        const notifId = await _write(receiverId, type, data);

        // FCM push. Awaited: on Cloud Functions (2nd gen) CPU is throttled once
        // the request returns, so an un-awaited send can stall and never leave.
        // _sendFcm never throws — a push failure cannot break the caller.
        if (fcmToken) {
            await _sendFcm(fcmToken, fcmPlatform, type, data, receiverId, 'customer');
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

        const snap     = await db().collection('artisans').doc(artisanId).get();
        const token    = snap.exists ? (snap.data().fcmToken || null) : null;
        const platform = snap.exists ? (snap.data().fcmPlatform || null) : null;

        const notifId = await _write(artisanId, type, data);

        // Awaited for the same reason as sendNotification. The in-app record
        // above is written first, so a job offer is on the artisan's dashboard
        // whatever happens to the push.
        if (token) {
            await _sendFcm(token, platform, type, data, artisanId, 'artisan');
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

// FCM push title limit (iOS restricts to ~65 chars before truncation)
const FCM_TITLE_MAX = 65;

async function _write(receiverId, type, data) {
    const ref = db().collection(NOTIF_COL).doc();
    await ref.set({
        receiverId,
        senderId:  data.senderId  ?? null,
        type,
        title:     String(data.title  || '').slice(0, FCM_TITLE_MAX),
        message:   String(data.message || '').slice(0, 200),
        isRead:    false,
        readAt:    null,
        actionUrl: data.actionUrl ?? null,
        metadata:  data.metadata  ?? {},
        createdAt: new Date().toISOString(),
    });
    return ref.id;
}

/**
 * The FCM message for one device, or null when there is nothing worth sending.
 *
 * WEB tokens get DATA-ONLY messages. The service worker
 * (shared/push/firebase-messaging-sw.js) draws them itself, so it can give the
 * link the app's folder (/artisan-app/…, /customer-app/…), mark an offer that
 * expired in transit, and avoid the duplicate a `notification` block would
 * cause (the browser SDK draws those itself, with a link FCM requires to be an
 * absolute HTTPS URL — '/jobs.html' was neither absolute nor inside the app).
 *
 * NATIVE tokens (the Capacitor app; fcmPlatform 'android' / 'ios') need the
 * `notification` block: the operating system draws it while the app is closed.
 *
 * A job offer carries metadata.expiresAtMs (dispatch.js). Its push lives no
 * longer than the offer: TTL is the time left, and a lapsed offer is not sent.
 */
function buildFcmMessage({ token, platform, type, data = {}, userType, nowMs = Date.now() }) {
    const title = String(data.title || '').slice(0, FCM_TITLE_MAX);
    const body  = String(data.message || '').slice(0, 200);
    const bookingId = String((data.metadata && data.metadata.bookingId) || data.bookingId || '');
    const expiresAtMs = Number(data.metadata && data.metadata.expiresAtMs);
    const hasExpiry = Number.isFinite(expiresAtMs) && expiresAtMs > 0;
    if (hasExpiry && expiresAtMs <= nowMs) return null;
    const ttlSeconds = hasExpiry ? Math.max(1, Math.ceil((expiresAtMs - nowMs) / 1000)) : null;
    const urgent = type === 'Bookings';

    const payload = {
        type:      String(type),
        actionUrl: String(data.actionUrl || ''),
        bookingId,
        ...(hasExpiry ? { expiresAtMs: String(expiresAtMs) } : {}),
    };

    if (platform === 'android' || platform === 'ios') {
        return {
            token,
            notification: { title, body },
            data: payload,
            android: {
                priority: urgent ? 'high' : 'normal',
                ...(ttlSeconds ? { ttl: ttlSeconds * 1000 } : {}),
            },
            apns: {
                headers: {
                    'apns-priority': urgent ? '10' : '5',
                    ...(hasExpiry ? { 'apns-expiration': String(Math.floor(expiresAtMs / 1000)) } : {}),
                },
            },
        };
    }

    // Web (also any token saved before fcmPlatform existed: before 2026-10-20 no
    // web token could be obtained at all, and native tokens record their platform).
    return {
        token,
        data: { ...payload, title, body, app: userType === 'artisan' ? 'artisan' : 'customer' },
        webpush: {
            headers: {
                Urgency: urgent ? 'high' : 'normal',
                ...(ttlSeconds ? { TTL: String(ttlSeconds) } : {}),
            },
        },
    };
}

// FCM's answer for a token that will never work again.
const DEAD_TOKEN_CODES = new Set([
    'messaging/registration-token-not-registered',
    'messaging/invalid-registration-token',
]);

async function _sendFcm(token, platform, type, data, userId, userType) {
    const message = buildFcmMessage({ token, platform, type, data, userType });
    if (!message) {
        console.log(`[notif] Push skipped for ${userType}=${userId}: the offer it announced has expired.`);
        return { sent: false, reason: 'expired' };
    }
    try {
        await messaging().send(message);
        console.log(`[notif] FCM push → ${userType}=${userId} type=${type} platform=${platform || 'web'}`);
        return { sent: true };
    } catch (err) {
        if (DEAD_TOKEN_CODES.has(err.code)) {
            // Clear the token only if it is STILL the one that failed: the device
            // may have saved a fresh token while this send was in flight, and
            // that one must survive.
            const col = userType === 'artisan' ? 'artisans' : 'customers';
            const ref = db().collection(col).doc(userId);
            await db().runTransaction(async (txn) => {
                const snap = await txn.get(ref);
                if (snap.exists && snap.data().fcmToken === token) {
                    txn.update(ref, { fcmToken: null, fcmPlatform: null });
                }
            }).catch(() => {});
            console.log(`[notif] Dead FCM token for ${userType}=${userId} (${err.code}) — cleared.`);
            return { sent: false, reason: 'dead_token' };
        }
        console.warn(`[notif] FCM push failed ${userType}=${userId}:`, err.code || '', err.message);
        return { sent: false, reason: 'error' };
    }
}

module.exports = {
    sendNotification,
    sendArtisanNotification,
    // Exported for tests: the per-platform message shape and expiry must be provable.
    buildFcmMessage,
};
