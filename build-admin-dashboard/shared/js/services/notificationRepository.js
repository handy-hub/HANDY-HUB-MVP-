/**
 * notificationRepository.js
 *
 * Collection: "customer_notifications"
 *
 * Handles all read/write operations for customer (and cross-role) notifications.
 * Artisan notifications also go to this collection using receiverId targeting.
 *
 * DESIGN NOTES
 * ────────────
 * • Real-time subscriptions are used for notification lists and badges — never
 *   one-shot reads — so the cache layer is bypassed automatically.
 * • createdAt is stored as an ISO string (not Firestore Timestamp) so it round-trips
 *   correctly through the cached database service and is safe to JSON-serialise.
 * • markNotificationRead records both isRead:true and readAt for audit purposes.
 * • subscribeToUnreadCount uses a limit to avoid unbounded reads on users with
 *   large notification histories.
 */

import { getAppContainer } from "../app/container.js";

function getDb()   { return getAppContainer().services.databaseService; }
function getAuth() { return getAppContainer().services.authService; }

const COLLECTION      = "customer_notifications";
const UNREAD_LIMIT    = 200;   // max unread docs fetched for badge — prevents runaway reads
const NOTIF_LIST_LIMIT = 50;   // max notifications shown in the notification page

// ── Notification types ─────────────────────────────────────────────────────────
export const NOTIF_TYPES = /** @type {const} */ ({
    BOOKINGS:  'Bookings',
    MESSAGES:  'Messages',
    OFFERS:    'Offers',
    PAYMENTS:  'Payments',
    REVIEWS:   'Reviews',
    SYSTEM:    'System',
    GENERAL:   'General',
});

// ── Helpers ────────────────────────────────────────────────────────────────────

function nowIso() { return new Date().toISOString(); }

/**
 * Normalise a raw Firestore notification record into a clean DTO.
 * Handles both ISO string createdAt (written by this service) and Firestore
 * Timestamps (written by Cloud Functions via Admin SDK).
 */
function normalise({ id, data: d }) {
    let createdAt;
    if (typeof d.createdAt === 'string') {
        createdAt = new Date(d.createdAt);
    } else if (d.createdAt?.toDate) {
        createdAt = d.createdAt.toDate();   // Firestore Timestamp
    } else {
        createdAt = new Date();
    }

    return {
        id,
        receiverId: d.receiverId ?? null,
        senderId:   d.senderId   ?? null,
        type:       d.type       ?? NOTIF_TYPES.GENERAL,
        title:      d.title      ?? '',
        message:    d.message    ?? '',
        isRead:     d.isRead     ?? false,
        readAt:     d.readAt     ?? null,
        actionUrl:  d.actionUrl  ?? null,
        metadata:   d.metadata   ?? {},
        createdAt,
    };
}

// ── Subscriptions ──────────────────────────────────────────────────────────────

/**
 * Real-time subscription to all notifications for a user, newest-first.
 * Limited to NOTIF_LIST_LIMIT documents to bound Firestore read costs.
 *
 * @param {string}   userId
 * @param {Function} onChange  called with Notification[] on every change
 * @param {Function} [onError] called with Error on snapshot failure
 * @returns {Function} unsubscribe
 */
export function subscribeToUserNotifications(userId, onChange, onError) {
    return getDb().subscribeToCollection(
        COLLECTION,
        [{ field: 'receiverId', op: '==', value: userId }],
        { orderBy: { field: 'createdAt', direction: 'desc' }, limit: NOTIF_LIST_LIMIT },
        (records) => onChange(records.map(normalise)),
        onError ?? (() => {})
    );
}

/**
 * Real-time subscription to the unread notification count (badge).
 * Bounded by UNREAD_LIMIT to avoid runaway reads on high-volume accounts.
 *
 * @param {string}   userId
 * @param {Function} onChange  called with number (count) on every snapshot
 * @returns {Function} unsubscribe
 */
export function subscribeToUnreadCount(userId, onChange) {
    return getDb().subscribeToCollection(
        COLLECTION,
        [
            { field: 'receiverId', op: '==', value: userId },
            { field: 'isRead',     op: '==', value: false  },
        ],
        { limit: UNREAD_LIMIT },
        (records) => onChange(records.length),
        () => { /* silently ignore badge subscription errors */ }
    );
}

// ── Writes ─────────────────────────────────────────────────────────────────────

/**
 * Mark a single notification as read.
 * Sets both isRead and readAt so audits know when it was acknowledged.
 *
 * @param {string} notificationId  Firestore document ID
 */
export async function markNotificationRead(notificationId) {
    await getDb().updateDocument(COLLECTION, notificationId, {
        isRead: true,
        readAt: nowIso(),
    });
}

/**
 * Mark all unread notifications for a user as read in a single batch.
 * Fetches the first UNREAD_LIMIT unread docs and updates them.
 *
 * @param {string} userId
 */
export async function markAllNotificationsRead(userId) {
    const db = getDb();
    const unread = await db.queryWithOptions(
        COLLECTION,
        [
            { field: 'receiverId', op: '==', value: userId },
            { field: 'isRead',     op: '==', value: false  },
        ],
        { limit: UNREAD_LIMIT }
    );

    if (!unread.length) return;

    // Fire all updates concurrently — no batched write needed at this scale
    const readAt = nowIso();
    await Promise.all(
        unread.map(({ id }) =>
            db.updateDocument(COLLECTION, id, { isRead: true, readAt })
              .catch(err => console.warn(`[notifRepo] Failed to mark ${id} read:`, err.message))
        )
    );
}

/**
 * Write a new notification document.
 *
 * Used by bookingConfirmNotify.js and any frontend code that needs to create
 * an in-app notification for a user.
 *
 * Financial and system notifications should be created by Cloud Functions
 * (they have admin-level write access and can bypass Firestore rules).
 * Frontend-created notifications go through the customer_notifications rules.
 *
 * @param {{
 *   receiverId:  string,
 *   senderId?:   string | null,
 *   type?:       keyof typeof NOTIF_TYPES,
 *   title:       string,
 *   message:     string,
 *   actionUrl?:  string | null,
 *   metadata?:   object,
 * }} data
 * @returns {Promise<string>} new document ID
 */
export async function createNotification(data) {
    if (!data.receiverId) throw new Error('createNotification: receiverId is required');
    if (!data.title)      throw new Error('createNotification: title is required');
    if (!data.message)    throw new Error('createNotification: message is required');

    // Firestore security rules require senderId == request.auth.uid for client writes.
    // Auto-resolve from the current session when the caller hasn't supplied it so
    // every call site doesn't need to pass senderId manually.
    // Cloud Functions write via Admin SDK and bypass rules entirely, so null is safe there.
    let senderId = data.senderId ?? null;
    if (senderId === null) {
        try {
            const user = await getAuth().waitForUser();
            senderId = user?.uid ?? null;
        } catch (_) { /* leave as null for Cloud Function / unauthenticated contexts */ }
    }

    return getDb().addDocument(COLLECTION, {
        receiverId: data.receiverId,
        senderId,
        type:       data.type      ?? NOTIF_TYPES.GENERAL,
        title:      data.title,
        message:    data.message,
        isRead:     false,
        readAt:     null,
        actionUrl:  data.actionUrl ?? null,
        metadata:   data.metadata  ?? {},
        createdAt:  nowIso(),   // ISO string — consistent with the cache service and JSON-safe
    });
}

/**
 * Delete a single notification document permanently.
 * Used by the swipe-to-delete gesture in the notification page.
 *
 * @param {string} notificationId  Firestore document ID
 */
export async function deleteNotification(notificationId) {
    await getDb().deleteDocument(COLLECTION, notificationId);
}

/**
 * Resolves once with the currently signed-in user (or null after 3 s timeout).
 * Convenience re-export so callers don't need to import the auth service directly.
 */
export function waitForCurrentUser() {
    return getAuth().waitForUser();
}
