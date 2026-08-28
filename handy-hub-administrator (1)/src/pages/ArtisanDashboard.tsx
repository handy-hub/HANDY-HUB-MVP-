import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Hammer, History, Star, Wallet, CheckCircle, Clock, Bell, Trash2, Check, AlertTriangle, Info, Shield, MessageSquare, CreditCard, Briefcase } from 'lucide-react';
import { auth } from '../firebase';
import { useNavigate } from 'react-router-dom';
import { notificationService } from '../services/notificationService';
import { Notification } from '../types';
import { cn } from '../utils';
import { SupportWidget } from '../components/SupportWidget';

export function ArtisanDashboard() {
  const navigate = useNavigate();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [loadingNotifs, setLoadingNotifs] = useState(true);

  useEffect(() => {
    if (auth.currentUser) {
      const unsub = notificationService.subscribeToNotifications(auth.currentUser.uid, (newNotifs) => {
        setNotifications(newNotifs);
        setLoadingNotifs(false);
      });
      return () => unsub();
    } else {
      setLoadingNotifs(false);
    }
  }, []);

  const handleLogout = () => {
    auth.signOut();
    navigate('/login');
  };

  const getNotificationIcon = (category: Notification['category'], type: Notification['type']) => {
    switch (category) {
      case 'job': return { icon: Briefcase, color: 'text-amber-400', bg: 'bg-amber-500/10' };
      case 'payment': return { icon: CreditCard, color: 'text-blue-400', bg: 'bg-blue-500/10' };
      case 'security': return { icon: Shield, color: 'text-purple-400', bg: 'bg-purple-500/10' };
      case 'message': return { icon: MessageSquare, color: 'text-emerald-400', bg: 'bg-emerald-500/10' };
      case 'system':
      default:
        if (type === 'error') return { icon: AlertTriangle, color: 'text-red-400', bg: 'bg-red-500/10' };
        if (type === 'warning') return { icon: AlertTriangle, color: 'text-orange-400', bg: 'bg-orange-500/10' };
        return { icon: Info, color: 'text-blue-400', bg: 'bg-blue-500/10' };
    }
  };

  const formatTime = (dateStr: string) => {
    try {
      const date = new Date(dateStr);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMins / 60);
      const diffDays = Math.floor(diffHours / 24);

      if (diffMins < 1) return 'Just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      return `${diffDays}d ago`;
    } catch {
      return '';
    }
  };

  return (
    <div className="min-h-screen bg-bg-dark p-6">
      <div className="max-w-6xl mx-auto space-y-8">
        <header className="flex justify-between items-center bg-bg-panel p-8 rounded-[32px] border border-white/5">
          <div>
            <h1 className="text-3xl font-display font-black text-white tracking-tight">Artisan Portal</h1>
            <p className="text-white/40 text-sm mt-1">Manage your professional services and earnings.</p>
          </div>
          <button 
            onClick={handleLogout}
            className="px-6 py-3 bg-white text-bg-dark rounded-xl font-bold hover:bg-white/90 transition-all text-xs uppercase tracking-widest"
          >
            Sign Out
          </button>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-accent-blue/10 border border-accent-blue/20 p-6 rounded-[24px] space-y-2">
            <div className="w-10 h-10 bg-accent-blue rounded-xl flex items-center justify-center text-white mb-2">
              <Wallet size={20} />
            </div>
            <p className="text-[10px] font-bold text-accent-blue uppercase tracking-widest">Total Earnings</p>
            <p className="text-3xl font-bold text-white tracking-tight">GHS 1,240.00</p>
          </div>
          <div className="bg-accent-green/10 border border-accent-green/20 p-6 rounded-[24px] space-y-2">
            <div className="w-10 h-10 bg-accent-green rounded-xl flex items-center justify-center text-white mb-2">
              <CheckCircle size={20} />
            </div>
            <p className="text-[10px] font-bold text-accent-green uppercase tracking-widest">Jobs Completed</p>
            <p className="text-3xl font-bold text-white tracking-tight">24</p>
          </div>
          <div className="bg-accent-orange/10 border border-accent-orange/20 p-6 rounded-[24px] space-y-2">
            <div className="w-10 h-10 bg-accent-orange rounded-xl flex items-center justify-center text-white mb-2">
              <Star size={20} />
            </div>
            <p className="text-[10px] font-bold text-accent-orange uppercase tracking-widest">Average Rating</p>
            <p className="text-3xl font-bold text-white tracking-tight">4.9</p>
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <SupportWidget userType="artisan" />

          <section className="bg-bg-panel p-8 rounded-[32px] border border-white/5 space-y-6">
            <div className="flex items-center gap-3">
              <History size={20} className="text-accent-blue" />
              <h2 className="text-xl font-bold text-white tracking-tight">Recent Jobs</h2>
            </div>
            <div className="space-y-4">
               <p className="text-white/40 text-xs leading-relaxed italic">You are currently logged in as an Artisan. This dashboard is a placeholder for your future job management tools.</p>
            </div>
          </section>

          <section className="bg-bg-panel p-8 rounded-[32px] border border-white/5 space-y-6">
            <div className="flex justify-between items-center">
              <div className="flex items-center gap-3">
                <Bell size={20} className="text-accent-blue" />
                <h2 className="text-xl font-bold text-white tracking-tight">Inbox</h2>
              </div>
              {notifications.length > 0 && (
                <button 
                  onClick={() => notificationService.clearAll(notifications)}
                  className="text-[10px] font-bold text-white/40 hover:text-white uppercase tracking-widest transition-colors"
                >
                  Clear All
                </button>
              )}
            </div>

            {loadingNotifs ? (
              <div className="py-12 flex flex-col items-center gap-3">
                <div className="w-6 h-6 border-2 border-white/5 border-t-accent-blue rounded-full animate-spin" />
                <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Checking inbox...</p>
              </div>
            ) : notifications.length > 0 ? (
              <div className="space-y-4 max-h-[380px] overflow-y-auto pr-1">
                <AnimatePresence initial={false}>
                  {notifications.map((notif) => {
                    const iconDetails = getNotificationIcon(notif.category, notif.type);
                    const IconComponent = iconDetails.icon;

                    return (
                      <motion.div
                        key={notif.id}
                        initial={{ opacity: 0, scale: 0.95, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: -10 }}
                        className={cn(
                          "p-4 rounded-2xl border transition-all flex gap-3 relative group",
                          notif.read 
                            ? "bg-white/[0.02] border-white/5 opacity-70" 
                            : "bg-white/5 border-white/10 shadow-lg"
                        )}
                      >
                        {!notif.read && (
                          <span className="absolute top-4 right-4 w-2 h-2 rounded-full bg-accent-blue animate-pulse" />
                        )}

                        <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center mt-0.5 shrink-0", iconDetails.bg, iconDetails.color)}>
                          <IconComponent size={16} />
                        </div>

                        <div className="min-w-0 flex-1">
                          <h4 className="text-xs font-bold text-white truncate pr-4">{notif.title}</h4>
                          <p className="text-[11px] text-white/60 leading-relaxed mt-1 break-words">{notif.message}</p>
                          <span className="text-[9px] font-medium text-white/20 uppercase tracking-wider block mt-2">
                            {formatTime(notif.createdAt)}
                          </span>
                        </div>

                        <div className="absolute right-3 bottom-3 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
                          {!notif.read && (
                            <button
                              onClick={() => notificationService.markAsRead(notif.id)}
                              className="p-1.5 bg-white/5 hover:bg-accent-blue/20 hover:text-accent-blue rounded-lg border border-white/10 text-white/40 transition-colors"
                              title="Mark read"
                            >
                              <Check size={12} />
                            </button>
                          )}
                          <button
                            onClick={() => notificationService.deleteNotification(notif.id)}
                            className="p-1.5 bg-white/5 hover:bg-red-500/20 hover:text-red-500 rounded-lg border border-white/10 text-white/40 transition-colors"
                            title="Delete notification"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
            ) : (
              <div className="py-12 text-center text-white/10 border border-dashed border-white/5 rounded-2xl">
                <Bell size={32} className="mx-auto mb-3" />
                <p className="text-xs font-medium text-white/20">All caught up! No notifications.</p>
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
