import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  User, Mail, Phone, Shield, Camera, Save, Lock, 
  Bell, LogOut, Trash2, AlertTriangle, CheckCircle2, 
  Settings, Clock, Loader2, ArrowRight
} from 'lucide-react';
import { doc, onSnapshot, updateDoc, deleteDoc, query, collection, where, orderBy, limit } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { AdminUser, AuditLog, Notification } from '../types';
import { cn } from '../utils';
import { usePressAnimation } from '../hooks/usePressAnimation';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { notificationService } from '../services/notificationService';

export function Profile() {
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [loadingAudits, setLoadingAudits] = useState(true);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loadingNotifications, setLoadingNotifications] = useState(true);

  // Form state
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [notifEmail, setNotifEmail] = useState(true);
  const [notifPush, setNotifPush] = useState(true);
  const [compactView, setCompactView] = useState(false);
  const [language, setLanguage] = useState('English');

  const savePress = usePressAnimation();

  useEffect(() => {
    if (!auth.currentUser) return;

    const unsub = onSnapshot(doc(db, 'admins', auth.currentUser.uid), (doc) => {
      if (doc.exists()) {
        const data = { id: doc.id, ...doc.data() } as AdminUser;
        setAdmin(data);
        setName(data.name);
        setPhone(data.phone || '');
        // Load preferences if they exist
        if (data.preferences) {
          setNotifEmail(data.preferences.emailNotifications ?? true);
          setNotifPush(data.preferences.pushNotifications ?? true);
          setCompactView(data.preferences.compactView ?? false);
          setLanguage(data.preferences.language ?? 'English');
        }
      }
      setLoading(false);
    });

    // Fetch personal audit logs
    const auditsQuery = query(
      collection(db, 'audit_logs'),
      where('adminId', '==', auth.currentUser.uid),
      orderBy('timestamp', 'desc'),
      limit(20)
    );

    const unsubAudits = onSnapshot(auditsQuery, (snapshot) => {
      const logs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AuditLog));
      setAuditLogs(logs);
      setLoadingAudits(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'audit_logs');
    });

    // Fetch personal notifications
    const notificationsQuery = query(
      collection(db, 'notifications'),
      where('userId', 'in', [auth.currentUser.uid, 'all']),
      orderBy('createdAt', 'desc'),
      limit(10)
    );

    const unsubNotifications = onSnapshot(notificationsQuery, (snapshot) => {
      const notifs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Notification));
      setNotifications(notifs);
      setLoadingNotifications(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'notifications');
    });

    return () => {
      unsub();
      unsubAudits();
      unsubNotifications();
    };
  }, []);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const handleUpdateProfile = async () => {
    if (!admin || !auth.currentUser) return;
    setUpdating(true);
    setError(null);

    try {
      await updateDoc(doc(db, 'admins', auth.currentUser.uid), {
        name,
        phone,
        preferences: {
          emailNotifications: notifEmail,
          pushNotifications: notifPush,
          compactView,
          language
        },
        updatedAt: new Date().toISOString()
      });
      showToast('Profile updated successfully');
    } catch (err) {
      console.error('Update failed:', err);
      setError('Failed to update profile. Please try again.');
      showToast('Update failed', 'error');
    } finally {
      setUpdating(false);
    }
  };

  const handleDeleteAccount = async () => {
    if (!admin || !auth.currentUser) return;
    setDeleting(true);
    setError(null);

    try {
      // In a real app, you'd also delete the Auth user and handle cleanup
      await deleteDoc(doc(db, 'admins', auth.currentUser.uid));
      await auth.signOut();
    } catch (err) {
      console.error('Deletion failed:', err);
      setError('Failed to delete account. Please contact support.');
      showToast('Deletion failed', 'error');
      setDeleting(false);
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-[calc(100vh-80px)] bg-bg-dark">
      <div className="w-12 h-12 border-4 border-white/10 border-t-accent-blue rounded-full animate-spin"></div>
    </div>
  );

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6 pb-8 max-w-[1600px] mx-auto bg-bg-dark min-h-screen p-4 lg:p-6"
    >
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-white/5 pb-6">
        <div className="space-y-2">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-accent-blue/10 flex items-center justify-center text-accent-blue border border-accent-blue/20">
              <User size={16} />
            </div>
            <p className="text-[11px] font-bold text-accent-blue uppercase tracking-[0.3em] opacity-80">Account Settings</p>
          </div>
          <h2 className="text-4xl lg:text-5xl font-display font-black text-white tracking-tighter">Admin Profile</h2>
          <p className="text-base text-white/40 font-medium max-w-2xl leading-relaxed">
            Manage your administrative identity and security preferences.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column - Profile Card */}
        <div className="lg:col-span-1 space-y-6">
          <div className="bg-bg-card p-6 rounded-[32px] border border-white/5 shadow-2xl text-center relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-accent-blue/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
            <div className="relative">
              <div className="relative w-32 h-32 mx-auto mb-6">
                <div className="w-full h-full rounded-[40px] bg-accent-blue/10 flex items-center justify-center text-accent-blue border border-accent-blue/20 shadow-inner group-hover:scale-105 transition-transform duration-500">
                  <User size={64} className="drop-shadow-[0_0_15px_rgba(59,130,246,0.3)]" />
                </div>
                <button className="absolute bottom-1 right-1 w-10 h-10 bg-white text-bg-dark rounded-xl flex items-center justify-center shadow-xl hover:scale-110 transition-transform border border-white/10">
                  <Camera size={18} />
                </button>
              </div>
              
              <h3 className="text-2xl font-display font-black text-white tracking-tight mb-1">{admin?.name}</h3>
              <p className="text-[10px] font-bold text-accent-blue uppercase tracking-[0.3em] mb-6 bg-accent-blue/5 py-1.5 rounded-full inline-block px-5 border border-accent-blue/10">
                {admin?.role.replace('_', ' ')}
              </p>
              
              <div className="space-y-3 text-left pt-6 border-t border-white/5">
                <div className="flex items-center gap-3 p-4 rounded-2xl bg-white/5 border border-white/5">
                  <Mail size={16} className="text-white/20" />
                  <div className="min-w-0">
                    <p className="text-[12px] font-bold text-white/20 uppercase tracking-widest mb-0.5">Email Address</p>
                    <p className="text-sm font-bold text-white truncate">{admin?.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3 p-4 rounded-2xl bg-white/5 border border-white/5">
                  <Shield size={16} className="text-white/20" />
                  <div className="min-w-0">
                    <p className="text-[12px] font-bold text-white/20 uppercase tracking-widest mb-0.5">Account Status</p>
                    <div className="text-sm font-bold text-accent-green flex items-center gap-2 uppercase tracking-widest">
                      <div className="w-1.5 h-1.5 rounded-full bg-accent-green animate-pulse shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                      Active
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-bg-card p-6 rounded-[32px] border border-white/5 shadow-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-1 h-6 bg-accent-blue rounded-full" />
              <h4 className="text-[18px] font-bold text-white tracking-tight">Security Status</h4>
            </div>
            <div className="space-y-3">
              <div className="flex items-center justify-between p-4 bg-emerald-500/5 rounded-2xl border border-emerald-500/10">
                <div className="flex items-center gap-3">
                  <CheckCircle2 size={16} className="text-emerald-500" />
                  <span className="text-xs font-bold text-emerald-400 uppercase tracking-widest">Verified Admin</span>
                </div>
              </div>
              <button 
                onClick={() => auth.signOut()}
                className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-white text-bg-dark rounded-2xl text-xs font-bold hover:bg-white/90 transition-all shadow-xl shadow-white/5 uppercase tracking-widest"
              >
                <LogOut size={16} />
                Sign Out
              </button>
            </div>
          </div>
        </div>

        {/* Right Column - Settings */}
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-bg-card p-6 rounded-[32px] border border-white/5 shadow-xl">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-1 h-6 bg-accent-blue rounded-full" />
                <h4 className="text-[22px] font-bold text-white tracking-tight">Profile Configuration</h4>
              </div>
              <motion.button 
                style={savePress.style}
                onMouseDown={savePress.onMouseDown}
                onMouseUp={savePress.onMouseUp}
                onMouseLeave={savePress.onMouseLeave}
                onClick={handleUpdateProfile}
                disabled={updating}
                className="px-6 py-3 bg-accent-blue text-white rounded-xl text-[11px] font-bold hover:bg-blue-600 transition-all uppercase tracking-widest shadow-lg shadow-blue-500/20 disabled:opacity-50 flex items-center gap-2"
              >
                {updating ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
                Save Changes
              </motion.button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="space-y-2">
                <label className="text-[14px] font-bold text-white/20 uppercase tracking-widest ml-4">Full Name</label>
                <input 
                  type="text" 
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-5 py-3.5 bg-white/5 border border-white/5 rounded-xl text-white outline-none focus:border-accent-blue/50 focus:bg-white/10 transition-all font-medium"
                  placeholder="Enter your name"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[14px] font-bold text-white/20 uppercase tracking-widest ml-4">Email Address</label>
                <input 
                  type="email" 
                  value={admin?.email}
                  disabled
                  className="w-full px-5 py-3.5 bg-white/5 border border-white/5 rounded-xl text-white/40 outline-none cursor-not-allowed font-medium"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[14px] font-bold text-white/20 uppercase tracking-widest ml-4">Phone Number</label>
                <input 
                  type="tel" 
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className="w-full px-5 py-3.5 bg-white/5 border border-white/5 rounded-xl text-white outline-none focus:border-accent-blue/50 focus:bg-white/10 transition-all font-medium"
                  placeholder="+233 XX XXX XXXX"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[14px] font-bold text-white/20 uppercase tracking-widest ml-4">Administrative Role</label>
                <div className="w-full px-5 py-3.5 bg-white/5 border border-white/5 rounded-xl text-white/40 font-medium flex items-center gap-3">
                  <Shield size={16} />
                  {admin?.role.replace('_', ' ')}
                </div>
              </div>
            </div>

            <div className="mt-8 pt-8 border-t border-white/5 grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="space-y-4">
                <div className="flex items-center gap-3 mb-1">
                  <Bell size={16} className="text-accent-blue" />
                  <h5 className="text-[17px] font-bold text-white uppercase tracking-widest">Notifications</h5>
                </div>
                <div className="space-y-3">
                  <label className="flex items-center justify-between p-3.5 bg-white/5 rounded-xl border border-white/5 cursor-pointer hover:bg-white/10 transition-all">
                    <span className="text-sm font-medium text-white/80">Email Notifications</span>
                    <input 
                      type="checkbox" 
                      checked={notifEmail}
                      onChange={(e) => setNotifEmail(e.target.checked)}
                      className="w-4 h-4 rounded border-white/10 bg-white/5 text-accent-blue focus:ring-accent-blue/20"
                    />
                  </label>
                  <label className="flex items-center justify-between p-3.5 bg-white/5 rounded-xl border border-white/5 cursor-pointer hover:bg-white/10 transition-all">
                    <span className="text-sm font-medium text-white/80">Push Notifications</span>
                    <input 
                      type="checkbox" 
                      checked={notifPush}
                      onChange={(e) => setNotifPush(e.target.checked)}
                      className="w-4 h-4 rounded border-white/10 bg-white/5 text-accent-blue focus:ring-accent-blue/20"
                    />
                  </label>
                </div>
              </div>

              <div className="space-y-4">
                <div className="flex items-center gap-3 mb-1">
                  <Settings size={16} className="text-accent-blue" />
                  <h5 className="text-[17px] font-bold text-white uppercase tracking-widest">Preferences</h5>
                </div>
                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <label className="text-[14px] font-bold text-white/20 uppercase tracking-widest ml-4">Language</label>
                    <select 
                      value={language}
                      onChange={(e) => setLanguage(e.target.value)}
                      className="w-full px-5 py-3.5 bg-white/5 border border-white/5 rounded-xl text-white outline-none focus:border-accent-blue/50 focus:bg-white/10 transition-all font-medium appearance-none"
                    >
                      <option value="English">English (US)</option>
                      <option value="French">French</option>
                      <option value="Spanish">Spanish</option>
                    </select>
                  </div>
                  <label className="flex items-center justify-between p-3.5 bg-white/5 rounded-xl border border-white/5 cursor-pointer hover:bg-white/10 transition-all">
                    <span className="text-sm font-medium text-white/80">Compact Dashboard View</span>
                    <input 
                      type="checkbox" 
                      checked={compactView}
                      onChange={(e) => setCompactView(e.target.checked)}
                      className="w-4 h-4 rounded border-white/10 bg-white/5 text-accent-blue focus:ring-accent-blue/20"
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-bg-card p-6 rounded-[32px] border border-white/5 shadow-xl">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center gap-3">
                <div className="w-1 h-6 bg-accent-blue rounded-full" />
                <h4 className="text-[22px] font-bold text-white tracking-tight">Recent Notifications</h4>
              </div>
              {notifications.length > 0 && (
                <button 
                  onClick={() => notificationService.clearAll(notifications)}
                  className="text-[10px] font-bold text-red-500 uppercase tracking-widest hover:text-red-400 transition-colors"
                >
                  Clear All
                </button>
              )}
            </div>
            
            <div className="space-y-4">
              {loadingNotifications ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="animate-spin text-accent-blue" />
                </div>
              ) : notifications.length > 0 ? (
                <div className="space-y-3">
                  {notifications.map((notif) => (
                    <div key={notif.id} className={cn(
                      "p-4 bg-white/5 border border-white/5 rounded-2xl group hover:bg-white/10 transition-all relative overflow-hidden",
                      !notif.read && "bg-white/[0.08]"
                    )}>
                      {!notif.read && <div className="absolute top-0 left-0 w-1 h-full bg-accent-blue" />}
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <h5 className="text-sm font-bold text-white">{notif.title}</h5>
                            <span className="text-[10px] font-mono text-white/20">
                              {new Date(notif.createdAt).toLocaleString()}
                            </span>
                          </div>
                          <p className="text-[12px] text-white/40 leading-relaxed">{notif.message}</p>
                        </div>
                        <div className="flex flex-col items-end gap-2">
                          <div className={cn(
                            "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                            notif.type === 'error' ? "bg-red-500/10 text-red-500" : 
                            notif.type === 'warning' ? "bg-orange-500/10 text-orange-500" : 
                            "bg-accent-blue/10 text-accent-blue"
                          )}>
                            <Bell size={14} />
                          </div>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              notificationService.deleteNotification(notif.id);
                            }}
                            className="opacity-0 group-hover:opacity-100 p-2 text-white/20 hover:text-red-500 transition-all"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-12 text-center bg-white/5 rounded-2xl border border-dashed border-white/10">
                  <Bell size={32} className="mx-auto text-white/10 mb-3" />
                  <p className="text-sm text-white/40">No notifications yet</p>
                </div>
              )}
            </div>
          </div>

          <div className="bg-bg-card p-6 rounded-[32px] border border-white/5 shadow-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-1 h-6 bg-accent-blue rounded-full" />
              <h4 className="text-[22px] font-bold text-white tracking-tight">Activity History</h4>
            </div>
            
            <div className="space-y-4">
              {loadingAudits ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 size={24} className="animate-spin text-accent-blue" />
                </div>
              ) : auditLogs.length > 0 ? (
                <div className="space-y-3">
                  {auditLogs.map((log) => (
                    <div key={log.id} className="p-4 bg-white/5 border border-white/5 rounded-2xl group hover:bg-white/10 transition-all">
                      <div className="flex items-start justify-between gap-4">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-[10px] font-bold text-accent-blue uppercase tracking-widest bg-accent-blue/10 px-2 py-0.5 rounded border border-accent-blue/10">
                              {log.action.replace(/_/g, ' ')}
                            </span>
                            <span className="text-[10px] font-mono text-white/20">
                              {new Date(log.timestamp).toLocaleString()}
                            </span>
                          </div>
                          <p className="text-sm font-medium text-white/80">{log.details}</p>
                          <p className="text-[10px] text-white/20 font-mono">Target: {log.target}</p>
                        </div>
                        <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-white/20 group-hover:text-white/40 transition-colors">
                          <Clock size={14} />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-12 text-center bg-white/5 rounded-2xl border border-dashed border-white/10">
                  <Clock size={32} className="mx-auto text-white/10 mb-3" />
                  <p className="text-sm text-white/40">No activity recorded yet</p>
                </div>
              )}
            </div>
          </div>

          <div className="bg-bg-card p-6 rounded-[32px] border border-white/5 shadow-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-1 h-6 bg-accent-orange rounded-full" />
              <h4 className="text-[22px] font-bold text-white tracking-tight">Account Management</h4>
            </div>
            
            <div className="p-6 rounded-[24px] bg-red-500/5 border border-red-500/10 space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <h5 className="font-bold text-white text-lg tracking-tight">Close Administrator Account</h5>
                  <p className="text-sm text-white/40 leading-relaxed max-w-md">
                    Permanently revoke your administrative privileges and remove your profile.
                  </p>
                </div>
                
                {!showDeleteConfirm ? (
                  <button 
                    onClick={() => setShowDeleteConfirm(true)}
                    className="px-6 py-3 bg-white/5 border border-white/10 text-red-500 rounded-xl text-[11px] font-bold hover:bg-red-500/10 transition-all flex items-center gap-2 shrink-0 uppercase tracking-widest"
                  >
                    <Trash2 size={16} /> Close Account
                  </button>
                ) : (
                  <div className="flex items-center gap-3 shrink-0">
                    <button 
                      onClick={() => setShowDeleteConfirm(false)}
                      disabled={deleting}
                      className="px-4 py-2 text-white/20 text-[10px] font-bold uppercase tracking-widest hover:text-white transition-all"
                    >
                      Cancel
                    </button>
                    <button 
                      onClick={handleDeleteAccount}
                      disabled={deleting}
                      className="px-6 py-3 bg-red-600 text-white rounded-xl text-[11px] font-bold hover:bg-red-700 transition-all flex items-center justify-center gap-2 shadow-xl shadow-red-600/20 uppercase tracking-widest"
                    >
                      {deleting ? <Loader2 size={16} className="animate-spin" /> : <Trash2 size={16} />}
                      Confirm
                    </button>
                  </div>
                )}
              </div>
              
              {error && (
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-center gap-3 text-red-400 text-xs font-bold uppercase tracking-widest">
                  <AlertTriangle size={16} />
                  <p>{error}</p>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className={cn(
              "fixed bottom-12 left-1/2 z-[100] px-8 py-4 rounded-[20px] shadow-2xl flex items-center gap-4 min-w-[320px] border backdrop-blur-xl",
              toast.type === 'success' ? "bg-bg-panel text-white border-white/10" : "bg-red-600 text-white border-red-500/20"
            )}
          >
            <div className={cn(
              "w-2 h-2 rounded-full animate-pulse",
              toast.type === 'success' ? "bg-accent-green" : "bg-white"
            )} />
            <span className="text-[11px] font-bold uppercase tracking-widest">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
