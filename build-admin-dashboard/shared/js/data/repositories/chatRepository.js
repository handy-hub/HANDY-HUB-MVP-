/**
 * chatRepository.js
 *
 * Collection:    "chats"
 * Document ID:   deterministic — sorted("uidA_uidB") for 1:1 chats, so two
 *                users always land on the same thread with no race between
 *                concurrent createChat() calls and no linear scan needed to
 *                find an existing conversation.
 * Sub-collection: "chats/{chatId}/messages"
 *
 * chats schema
 * ────────────
 * participants    string[]    Auth UIDs of both users
 * bookingId       string|null Optional — links this thread to a specific booking
 * lastMessage     string      text preview of the most recent message
 * lastSenderId    string      UID who sent the last message
 * lastMessageAt   string      ISO timestamp of the last message
 * unreadCount     map         { [uid]: number } — per-participant unread count,
 *                             incremented atomically on send, zeroed on read
 * createdAt       string      ISO timestamp
 *
 * messages sub-collection schema
 * ───────────────────────────────
 * senderId    string      Auth UID
 * text        string      may be '' when the message is attachment-only
 * attachment  map|null    { url, type, name, size } — Cloudinary-hosted file
 * isRead      boolean
 * createdAt   string      ISO timestamp
 *
 * Required Firestore composite indexes
 * ─────────────────────────────────────
 * 1. participants array-contains ASC + lastMessageAt DESC
 * 2. bookingId ASC  (single field, auto-created — getChatByBookingId)
 * 3. messages/createdAt ASC  (sub-collection — single field, auto-created)
 */

import { writeBatch, doc, collection, addDoc, increment, getDocs, query, where, limit as fsLimit }
    from 'https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js';
import { firebaseDb }
    from '../../backend/providers/firebase/firebaseConfig.js';

const CHATS_COLLECTION    = "chats";
const MESSAGES_SUBCOLLECTION = "messages";

function now() {
    return new Date().toISOString();
}

/** Deterministic 1:1 chat ID — same two UIDs always resolve to the same document. */
function directChatId(uidA, uidB) {
    return [uidA, uidB].sort().join('_');
}

export function createChatRepository({
    databaseService,
    collectionName = CHATS_COLLECTION
}) {
    if (!databaseService) {
        throw new Error("ChatRepository requires a DatabaseService.");
    }

    return {
        collectionName,

        // ── Chats ─────────────────────────────────────────────────────────────

        /**
         * All chats where the user is a participant, sorted by most recent message.
         * Requires index: participants array-contains + lastMessageAt DESC.
         */
        async getChatsByUser(userId) {
            return databaseService.queryWithOptions(
                collectionName,
                [{ field: "participants", op: "array-contains", value: userId }],
                { orderBy: { field: "lastMessageAt", direction: "desc" } }
            );
        },

        async getById(chatId) {
            return databaseService.getDocument(collectionName, chatId);
        },

        /**
         * Find (or determine the ID of) the 1:1 chat between two users.
         * With deterministic IDs this never needs to query — the ID IS the answer.
         */
        directChatId,

        /**
         * Get or create the 1:1 chat between two users. Idempotent: calling this
         * twice concurrently for the same pair converges on the same document
         * (deterministic ID + setDoc-with-merge semantics via getOrCreate below).
         *
         * @param {string} uidA
         * @param {string} uidB
         * @param {{ bookingId?: string }} [opts]
         * @returns {Promise<string>} chatId
         */
        async getOrCreateDirectChat(uidA, uidB, opts = {}) {
            const chatId = directChatId(uidA, uidB);
            const existing = await databaseService.getDocument(collectionName, chatId);
            if (existing.exists) {
                // Attach a bookingId to an existing thread if one wasn't set yet
                // (e.g. the same two people book again later).
                if (opts.bookingId && !existing.data.bookingId) {
                    await databaseService.updateDocument(collectionName, chatId, {
                        bookingId: opts.bookingId,
                    });
                }
                return chatId;
            }
            await databaseService.setDocument(collectionName, chatId, {
                participants:  [uidA, uidB],
                bookingId:     opts.bookingId || null,
                lastMessage:   "",
                lastSenderId:  null,
                lastMessageAt: now(),
                unreadCount:   { [uidA]: 0, [uidB]: 0 },
                createdAt:     now(),
            });
            return chatId;
        },

        /**
         * Find the chat thread linked to a specific booking, if any.
         * Requires a single-field index on bookingId (auto-created by Firestore).
         */
        async getChatByBookingId(bookingId) {
            const q = query(
                collection(firebaseDb, collectionName),
                where('bookingId', '==', bookingId),
                fsLimit(1)
            );
            const snap = await getDocs(q);
            if (snap.empty) return null;
            const d = snap.docs[0];
            return { id: d.id, data: d.data() };
        },

        /** Subscribe to the live chat list for a user. Returns unsubscribe fn. */
        subscribeByUser(userId, onChange, onError) {
            return databaseService.subscribeToCollection(
                collectionName,
                [{ field: "participants", op: "array-contains", value: userId }],
                { orderBy: { field: "lastMessageAt", direction: "desc" }, limit: 50 },
                onChange,
                onError
            );
        },

        // ── Messages sub-collection ───────────────────────────────────────────

        /**
         * Send a message into a chat thread.
         * Automatically updates the parent chat's lastMessage preview,
         * increments the recipient's unreadCount, and creates a notification.
         *
         * @param {string} chatId
         * @param {{ senderId: string, text?: string, senderName?: string,
         *           attachment?: { url: string, type: string, name?: string, size?: number } }} options
         * @returns {Promise<string>} new message ID
         */
        async sendMessage(chatId, { senderId, text, senderName, attachment = null }) {
            if (!chatId)   throw new Error("sendMessage: chatId is required.");
            if (!senderId) throw new Error("sendMessage: senderId is required.");
            const trimmedText = (text || "").trim();
            if (!trimmedText && !attachment) {
                throw new Error("sendMessage: message must have text or an attachment.");
            }

            const payload = {
                senderId,
                text:       trimmedText,
                attachment: attachment || null,
                isRead:     false,
                createdAt:  now(),
            };

            const chatSnap = await databaseService.getDocument(collectionName, chatId);
            if (!chatSnap.exists) throw new Error(`sendMessage: chat not found: ${chatId}`);
            const participants = chatSnap.data.participants || [];
            const receiverId   = participants.find(uid => uid !== senderId);

            // Atomic batch write: the message doc, the parent chat preview update,
            // and the recipient's unread-count increment succeed or fail together.
            const msgRef  = doc(collection(firebaseDb, collectionName, chatId, MESSAGES_SUBCOLLECTION));
            const chatRef = doc(firebaseDb, collectionName, chatId);

            const batch = writeBatch(firebaseDb);
            batch.set(msgRef, payload);
            const chatUpdate = {
                lastMessage:   trimmedText || (attachment ? '📎 Attachment' : ''),
                lastSenderId:  senderId,
                lastMessageAt: payload.createdAt,
            };
            if (receiverId) {
                chatUpdate[`unreadCount.${receiverId}`] = increment(1);
            }
            batch.update(chatRef, chatUpdate);
            await batch.commit();

            // Notify the other participant (fire-and-forget)
            if (receiverId) {
                _notifyMessageRecipient(
                    databaseService, chatId, senderId, receiverId, senderName, trimmedText, !!attachment
                ).catch(() => {});
            }

            return msgRef.id;
        },

        /**
         * One-shot fetch of messages in a chat, newest first, with pagination.
         *
         * @param {string} chatId
         * @param {{ pageSize?: number, before?: import('firebase/firestore').DocumentSnapshot }} [opts]
         */
        async getMessages(chatId, limitCount = 50) {
            return databaseService.querySubCollection(
                collectionName,
                chatId,
                MESSAGES_SUBCOLLECTION,
                [],
                { orderBy: { field: "createdAt", direction: "asc" }, limit: limitCount }
            );
        },

        /**
         * Real-time listener for messages in a chat thread.
         * Returns an unsubscribe function.
         */
        subscribeToMessages(chatId, onChange, onError) {
            return databaseService.subscribeToSubCollection(
                collectionName,
                chatId,
                MESSAGES_SUBCOLLECTION,
                [],
                { orderBy: { field: "createdAt", direction: "asc" } },
                onChange,
                onError
            );
        },

        /**
         * Mark a specific message as read.
         */
        async markMessageRead(chatId, messageId) {
            await databaseService.updateSubDocument(
                collectionName,
                chatId,
                MESSAGES_SUBCOLLECTION,
                messageId,
                { isRead: true }
            );
        },

        /**
         * Mark every unread message from the OTHER participant as read, and zero
         * out this user's unreadCount on the parent chat doc. Call when a user
         * opens a conversation.
         */
        async markChatRead(chatId, userId) {
            const unread = await databaseService.querySubCollection(
                collectionName, chatId, MESSAGES_SUBCOLLECTION,
                [{ field: 'isRead', op: '==', value: false }], {}
            );
            const toMark = unread.filter(m => m.data.senderId !== userId);
            await Promise.all(toMark.map(m =>
                databaseService.updateSubDocument(collectionName, chatId, MESSAGES_SUBCOLLECTION, m.id, { isRead: true })
            ));
            await databaseService.updateDocument(collectionName, chatId, {
                [`unreadCount.${userId}`]: 0,
            });
        },

        /**
         * Total unread count across all of a user's chats — for a badge counter.
         * One-shot; for a live badge, combine with subscribeByUser() and sum
         * chat.data.unreadCount[userId] client-side.
         */
        async getTotalUnreadCount(userId) {
            const chats = await this.getChatsByUser(userId);
            return chats.reduce((sum, c) => sum + (c.data.unreadCount?.[userId] || 0), 0);
        },
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helper — write a customer_notifications document for the recipient.
// ─────────────────────────────────────────────────────────────────────────────

async function _notifyMessageRecipient(db, chatId, senderId, receiverId, senderName, messageText, hasAttachment) {
    try {
        // Check receiver's notification preferences (Messages toggle)
        const userSnap = await db.getDocument('customers', receiverId);
        const prefs    = userSnap?.data?.notificationPreferences || {};
        if (prefs.messages === false) return; // user has disabled message notifications

        // Truncate message preview to 80 chars
        const preview = messageText && messageText.length > 80
            ? messageText.slice(0, 77) + '…'
            : (messageText || (hasAttachment ? '(attachment)' : ''));

        const fromName = senderName || 'Someone';

        await db.addDocument('customer_notifications', {
            receiverId,
            senderId,
            type:      'Messages',
            title:     `New message from ${fromName}`,
            message:   preview || '(attachment)',
            isRead:    false,
            actionUrl: `messages.html?chatId=${chatId}`,
            metadata:  { chatId, senderId },
            createdAt: new Date(),
        });
    } catch (err) {
        console.warn('[chatRepository] Could not send message notification:', err.message);
    }
}
