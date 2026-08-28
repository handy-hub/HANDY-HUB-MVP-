import { collection, addDoc, onSnapshot, query, where, orderBy, limit, doc, updateDoc, writeBatch } from 'firebase/firestore';
import { db } from '../firebase';
import { Notification } from '../types';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';

export const notificationService = {
  // Send a notification to a specific user
  async sendNotification(notification: Omit<Notification, 'id' | 'createdAt' | 'read'>) {
    try {
      await addDoc(collection(db, 'notifications'), {
        ...notification,
        read: false,
        createdAt: new Date().toISOString()
      });
    } catch (error) {
      console.error('Failed to send notification:', error);
    }
  },

  // Send a global notification to all admins
  async sendGlobalNotification(title: string, message: string, type: Notification['type'] = 'info', category: Notification['category'] = 'system') {
    await this.sendNotification({
      userId: 'all',
      title,
      message,
      type,
      category
    });
  },

  // Listen for notifications for a specific user
  subscribeToNotifications(userId: string, callback: (notifications: Notification[]) => void) {
    if (!userId) {
      callback([]);
      return () => {};
    }

    const q = query(
      collection(db, 'notifications'),
      where('userId', 'in', [userId, 'all']),
      orderBy('createdAt', 'desc'),
      limit(50)
    );

    return onSnapshot(q, (snapshot) => {
      const notifications = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      } as Notification));
      callback(notifications);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'notifications');
    });
  },

  // Mark a notification as read
  async markAsRead(notificationId: string) {
    try {
      await updateDoc(doc(db, 'notifications', notificationId), {
        read: true
      });
    } catch (error) {
      console.error('Failed to mark notification as read:', error);
    }
  },

  // Mark all as read
  async markAllAsRead(userId: string, notifications: Notification[]) {
    try {
      const batch = writeBatch(db);
      notifications.filter(n => !n.read).forEach(n => {
        batch.update(doc(db, 'notifications', n.id), { read: true });
      });
      await batch.commit();
    } catch (error) {
      console.error('Failed to mark all as read:', error);
    }
  },

  // Delete a specific notification
  async deleteNotification(notificationId: string) {
    try {
      const { deleteDoc } = await import('firebase/firestore');
      await deleteDoc(doc(db, 'notifications', notificationId));
    } catch (error) {
      console.error('Failed to delete notification:', error);
    }
  },

  // Clear all notifications for a user
  async clearAll(notifications: Notification[]) {
    try {
      const batch = writeBatch(db);
      notifications.forEach(n => {
        batch.delete(doc(db, 'notifications', n.id));
      });
      await batch.commit();
    } catch (error) {
      console.error('Failed to clear notifications:', error);
    }
  }
};
