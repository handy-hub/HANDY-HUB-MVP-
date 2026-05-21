import { getAppContainer } from "../app/container.js";

function getDb() {
    return getAppContainer().services.databaseService;
}

function getAuth() {
    return getAppContainer().services.authService;
}

const COLLECTION = "customer_notifications";

/**
 * Resolves once with the currently signed-in user (or null).
 */
export function waitForCurrentUser() {
    return getAuth().waitForUser();
}

/**
 * Real-time subscription to all notifications for a given user, newest-first.
 *
 * @param {string}   userId
 * @param {Function} onChange  called with Notification[] on every change
 * @param {Function} onError   called with Error on snapshot failure
 * @returns {Function} unsubscribe
 */
export function subscribeToUserNotifications(userId, onChange, onError) {
    return getDb().subscribeToCollection(
        COLLECTION,
        [{ field: "receiverId", op: "==", value: userId }],
        { orderBy: { field: "createdAt", direction: "desc" } },
        (records) => {
            const items = records.map(({ id, data: d }) => ({
                id,
                receiverId: d.receiverId ?? null,
                senderId:   d.senderId   ?? null,
                type:       d.type       ?? "General",
                title:      d.title      ?? "",
                message:    d.message    ?? "",
                isRead:     d.isRead     ?? false,
                actionUrl:  d.actionUrl  ?? null,
                metadata:   d.metadata   ?? {},
                createdAt:  d.createdAt?.toDate?.() ?? new Date()
            }));
            onChange(items);
        },
        onError
    );
}

/**
 * Real-time subscription to the unread notification count for a user.
 *
 * @param {string}   userId
 * @param {Function} onChange  called with number (count) on every change
 * @returns {Function} unsubscribe
 */
export function subscribeToUnreadCount(userId, onChange) {
    return getDb().subscribeToCollection(
        COLLECTION,
        [
            { field: "receiverId", op: "==", value: userId },
            { field: "isRead",     op: "==", value: false  }
        ],
        {},
        (records) => onChange(records.length),
        () => { /* silently ignore badge errors */ }
    );
}

/**
 * Mark a single notification as read.
 */
export async function markNotificationRead(notificationId) {
    await getDb().updateDocument(COLLECTION, notificationId, { isRead: true });
}

/**
 * Write a new notification document.
 *
 * @param {{
 *   receiverId: string,
 *   senderId?:  string,
 *   type?:      'Bookings'|'Messages'|'Offers'|'Payments'|'Reviews'|'System'|'General',
 *   title:      string,
 *   message:    string,
 *   actionUrl?: string,
 *   metadata?:  object
 * }} data
 */
export async function createNotification(data) {
    return getDb().addDocument(COLLECTION, {
        receiverId: data.receiverId,
        senderId:   data.senderId   ?? null,
        type:       data.type       ?? "General",
        title:      data.title,
        message:    data.message,
        isRead:     false,
        actionUrl:  data.actionUrl  ?? null,
        metadata:   data.metadata   ?? {},
        createdAt:  new Date()
    });
}
