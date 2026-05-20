import {
    collection,
    query,
    where,
    orderBy,
    onSnapshot,
    doc,
    updateDoc,
    addDoc,
    serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { firebaseDb, firebaseAuth } from "../backend/providers/firebase/firebaseConfig.js";

/**
 * Resolves once with the currently signed-in user (or null).
 * Unsubscribes the auth listener immediately after the first emission.
 */
export function waitForCurrentUser() {
    return new Promise((resolve) => {
        const stop = onAuthStateChanged(firebaseAuth, (user) => {
            stop();
            resolve(user);
        });
    });
}

/**
 * Real-time subscription to all notifications for a given user,
 * ordered newest-first.
 *
 * Firestore index required:
 *   Collection: notifications
 *   Fields:     receiverId ASC, createdAt DESC
 *
 * @param {string}   userId
 * @param {Function} onChange  called with Notification[] on every change
 * @param {Function} onError   called with Error on snapshot failure
 * @returns {Function} unsubscribe
 */
export function subscribeToUserNotifications(userId, onChange, onError) {
    const q = query(
        collection(firebaseDb, "notifications"),
        where("receiverId", "==", userId),
        orderBy("createdAt", "desc")
    );

    return onSnapshot(
        q,
        (snapshot) => {
            const items = snapshot.docs.map((d) => ({
                id: d.id,
                receiverId: d.data().receiverId ?? null,
                senderId:   d.data().senderId   ?? null,
                type:       d.data().type        ?? "General",
                title:      d.data().title       ?? "",
                message:    d.data().message     ?? "",
                isRead:     d.data().isRead      ?? false,
                actionUrl:  d.data().actionUrl   ?? null,
                metadata:   d.data().metadata    ?? {},
                createdAt:  d.data().createdAt?.toDate?.() ?? new Date()
            }));
            onChange(items);
        },
        (err) => {
            if (onError) onError(err);
        }
    );
}

/**
 * Real-time subscription to the unread notification count for a user.
 * Useful for keeping the nav badge in sync.
 *
 * Firestore index required:
 *   Collection: notifications
 *   Fields:     receiverId ASC, isRead ASC
 *
 * @param {string}   userId
 * @param {Function} onChange  called with number (count) on every change
 * @returns {Function} unsubscribe
 */
export function subscribeToUnreadCount(userId, onChange) {
    const q = query(
        collection(firebaseDb, "notifications"),
        where("receiverId", "==", userId),
        where("isRead", "==", false)
    );

    return onSnapshot(q, (snapshot) => {
        onChange(snapshot.size);
    }, () => {
        // Silently ignore errors on the badge — non-critical
    });
}

/**
 * Mark a single notification document as read in Firestore.
 */
export async function markNotificationRead(notificationId) {
    await updateDoc(doc(firebaseDb, "notifications", notificationId), {
        isRead: true
    });
}

/**
 * Write a new notification document to Firestore.
 * Use this from any service (booking, messaging, payments, etc.)
 * to push activity into a user's notification feed.
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
    return addDoc(collection(firebaseDb, "notifications"), {
        receiverId: data.receiverId,
        senderId:   data.senderId   ?? null,
        type:       data.type       ?? "General",
        title:      data.title,
        message:    data.message,
        isRead:     false,
        actionUrl:  data.actionUrl  ?? null,
        metadata:   data.metadata   ?? {},
        createdAt:  serverTimestamp()
    });
}
