import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Megaphone, Send, Users, Wrench, X, CheckCircle, AlertTriangle, Bell, Info } from 'lucide-react';
import { collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { cn } from '../utils';

export function BroadcastCenter() {
  const [isOpen, setIsOpen] = useState(false);
  const [target, setTarget] = useState<'all' | 'artisans' | 'customers'>('all');
  const [type, setType] = useState<'info' | 'success' | 'warning' | 'error'>('info');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title || !message) return;

    setIsSending(true);
    try {
      await addDoc(collection(db, 'broadcasts'), {
        title,
        message,
        type,
        target,
        senderId: auth.currentUser?.uid,
        senderName: auth.currentUser?.displayName || 'Admin',
        timestamp: new Date().toISOString(),
        status: 'sent'
      });

      // Log the action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: auth.currentUser?.displayName || 'Admin',
        action: 'BROADCAST_SENT',
        target: target.toUpperCase(),
        details: `Broadcast sent to ${target}: ${title}`,
        timestamp: new Date().toISOString(),
        ip: 'Internal'
      });

      setSent(true);
      setTimeout(() => {
        setSent(false);
        setIsOpen(false);
        setTitle('');
        setMessage('');
      }, 2000);
    } catch (error) {
      console.error("Failed to send broadcast", error);
    } finally {
      setIsSending(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-8 right-8 w-14 h-14 bg-accent-blue text-white rounded-2xl flex items-center justify-center shadow-lg shadow-blue-500/20 hover:scale-110 transition-all z-[5000] group"
      >
        <Megaphone size={24} className="group-hover:rotate-12 transition-transform" />
        <div className="absolute right-full mr-4 px-3 py-1.5 bg-bg-panel border border-white/10 rounded-lg text-[10px] font-bold text-white uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
          Send Broadcast
        </div>
      </button>

      <AnimatePresence>
        {isOpen && (
          <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsOpen(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            
            <motion.div
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.9, opacity: 0, y: 20 }}
              className="w-full max-w-lg bg-bg-panel border border-white/10 rounded-3xl shadow-2xl overflow-hidden relative z-10"
            >
              <div className="p-8 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-accent-blue/10 rounded-2xl flex items-center justify-center text-accent-blue border border-accent-blue/20">
                    <Megaphone size={24} />
                  </div>
                  <div>
                    <h3 className="text-xl font-display font-black text-white tracking-tight">Broadcast Center</h3>
                    <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mt-0.5">Send platform-wide notifications</p>
                  </div>
                </div>
                <button onClick={() => setIsOpen(false)} className="text-white/20 hover:text-white transition-colors">
                  <X size={24} />
                </button>
              </div>

              <form onSubmit={handleSend} className="p-8 space-y-6">
                {sent ? (
                  <motion.div 
                    initial={{ scale: 0.9, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    className="py-12 text-center"
                  >
                    <div className="w-20 h-20 bg-accent-green/10 rounded-3xl flex items-center justify-center text-accent-green mx-auto mb-6 border border-accent-green/20">
                      <CheckCircle size={40} />
                    </div>
                    <h4 className="text-2xl font-bold text-white mb-2">Broadcast Sent!</h4>
                    <p className="text-white/40 text-sm">Your message is being delivered to {target}.</p>
                  </motion.div>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-3">
                      {[
                        { id: 'all', label: 'Everyone', icon: Bell },
                        { id: 'artisans', label: 'Artisans', icon: Wrench },
                        { id: 'customers', label: 'Customers', icon: Users },
                      ].map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setTarget(t.id as any)}
                          className={cn(
                            "p-4 rounded-2xl border transition-all flex flex-col items-center gap-2",
                            target === t.id ? "bg-accent-blue/10 border-accent-blue/40 text-accent-blue" : "bg-white/5 border-white/5 text-white/20 hover:border-white/10"
                          )}
                        >
                          <t.icon size={20} />
                          <span className="text-[10px] font-bold uppercase tracking-widest">{t.label}</span>
                        </button>
                      ))}
                    </div>

                    <div className="space-y-4">
                      <div className="flex gap-2">
                        {['info', 'success', 'warning', 'error'].map((t) => (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setType(t as any)}
                            className={cn(
                              "px-3 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-widest border transition-all",
                              type === t ? (
                                t === 'info' ? "bg-accent-blue/10 text-accent-blue border-accent-blue/20" :
                                t === 'success' ? "bg-accent-green/10 text-accent-green border-accent-green/20" :
                                t === 'warning' ? "bg-accent-orange/10 text-accent-orange border-accent-orange/20" :
                                "bg-red-500/10 text-red-500 border-red-500/20"
                              ) : "bg-white/5 text-white/20 border-white/5 hover:border-white/10"
                            )}
                          >
                            {t}
                          </button>
                        ))}
                      </div>

                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Notification Title</label>
                        <input
                          value={title}
                          onChange={(e) => setTitle(e.target.value)}
                          placeholder="e.g. System Maintenance Scheduled"
                          className="w-full px-5 py-4 bg-white/5 border border-white/5 rounded-2xl text-white text-sm outline-none focus:border-accent-blue/40 transition-all"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Message Content</label>
                        <textarea
                          value={message}
                          onChange={(e) => setMessage(e.target.value)}
                          placeholder="Type your message here..."
                          rows={4}
                          className="w-full px-5 py-4 bg-white/5 border border-white/5 rounded-2xl text-white text-sm outline-none focus:border-accent-blue/40 transition-all resize-none"
                        />
                      </div>
                    </div>

                    <button
                      type="submit"
                      disabled={isSending || !title || !message}
                      className="w-full py-5 bg-accent-blue text-white text-[11px] font-bold rounded-2xl hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20 uppercase tracking-widest flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {isSending ? (
                        <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                      ) : (
                        <Send size={18} />
                      )}
                      Send Broadcast
                    </button>
                  </>
                )}
              </form>

              <div className="p-6 bg-bg-dark/50 border-t border-white/5 flex items-center gap-3">
                <AlertTriangle size={16} className="text-accent-orange" />
                <p className="text-[9px] font-bold text-white/20 uppercase tracking-widest leading-relaxed">
                  Broadcasts are delivered instantly to all connected mobile apps and web portals.
                </p>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
