'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// notifications.js — server-side helper for writing to customer_notifications.
//
// Usage (inside Cloud Functions):
//   const { sendNotification, sendArtisanNotification } = require('./notifications');
//   await sendNotification(uid, { type: 'Payments', title: '…', message: '…' });
//
// Errors are always swallowed — notification failures must never break the
// main financial / booking flows.
// ─────────────────────────────────────────────────────────────────────────────

const { FIRESTORE_DB_ID } = require('./config');
const NOTIF_COL = 'customer_notifications';

/**
 * Map notification type → the key in customers/{uid}.notificationPreferences
 * null  = always send (no gate)
 */
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

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write a notification to customer_notifications for a CUSTOMER, respecting
 * their stored notificationPreferences.
 *
 * @param {string} receiverId
 * @param {{
 *   type?:      'Payments'|'Bookings'|'Messages'|'Offers'|'Reviews'|'System'|'General',
 *   title:      string,
 *   message:    string,
 *   senderId?:  string | null,
 *   actionUrl?: string | null,
 *   metadata?:  object,
 * }} data
 * @returns {Promise<string|null>} notification document ID, or null on error/skip
 */
async function sendNotification(receiverId, data) {
    try {
        const firestore = db();
        const type      = data.type || 'General';
        const prefKey   = PREF_MAP[type] ?? null;

        // Check customer preference gate
        if (prefKey !== null) {
            const snap  = await firestore.collection('customers').doc(receiverId).get();
            const prefs = snap.exists ? (snap.data().notificationPreferences || {}) : {};
            if (prefs[prefKey] === false) {
                console.log(`[notif] Skipped ${type} to ${receiverId} (pref ${prefKey}=false).`);
                return null;
            }
        }

        return await _write(receiverId, type, data);

    } catch (err) {
        console.error('[notif] sendNotification error:', err.message);
        return null;
    }
}

/**
 * Write a notification for an ARTISAN.
 * Artisans use the same collection with their UID as receiverId.
 * No customer-preference check (artisans are always notified).
 */
async function sendArtisanNotification(artisanId, data) {
    try {
        return await _write(artisanId, data.type || 'General', data);
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
        // ISO string for consistency with client-side notificationRepository.js.
        // The client normalise() also handles Firestore Timestamps, but ISO keeps
        // the createdAt field JSON-safe and consistent whether written server or client side.
        createdAt: new Date().toISOString(),
    });
    return ref.id;
}

module.exports = { sendNotification, sendArtisanNotification };
