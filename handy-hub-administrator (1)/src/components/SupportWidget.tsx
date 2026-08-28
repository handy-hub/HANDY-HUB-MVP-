import React, { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  MessageSquare, 
  Send, 
  Phone, 
  X, 
  Loader2, 
  User, 
  Check, 
  CheckCheck, 
  Maximize2, 
  Minimize2, 
  HelpCircle,
  Clock,
  ExternalLink
} from 'lucide-react';
import { auth, db } from '../firebase';
import { 
  doc, 
  onSnapshot, 
  setDoc, 
  addDoc, 
  updateDoc, 
  collection, 
  query, 
  orderBy, 
  limit,
  getDoc
} from 'firebase/firestore';
import { SupportChat, SupportMessage } from '../types';

interface SupportWidgetProps {
  userType: 'customer' | 'artisan';
}

export function SupportWidget({ userType }: SupportWidgetProps) {
  const [chat, setChat] = useState<SupportChat | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [userName, setUserName] = useState('Valued Partner');
  const [userEmail, setUserEmail] = useState('');
  const [isExpanded, setIsExpanded] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const currentUser = auth.currentUser;

  // 1. Fetch user custom details and listen to active support chat
  useEffect(() => {
    if (!currentUser) {
      setLoading(false);
      return;
    }

    setUserEmail(currentUser.email || '');

    // Resolve name from proper collection
    const profileRef = doc(db, userType === 'customer' ? 'customers' : 'artisans', currentUser.uid);
    getDoc(profileRef).then((snap) => {
      if (snap.exists()) {
        const data = snap.data();
        setUserName(data.name || currentUser.displayName || 'Valued Partner');
      } else {
        setUserName(currentUser.displayName || 'Valued Partner');
      }
    });

    // Listen to the unique support chat doc for this user (keyed by UID)
    const chatRef = doc(db, 'support_chats', currentUser.uid);
    const unsubChat = onSnapshot(chatRef, (snap) => {
      if (snap.exists()) {
        setChat({ id: snap.id, ...snap.data() } as SupportChat);
      } else {
        setChat(null);
      }
      setLoading(false);
    }, (error) => {
      console.warn("Error subscribing to support chat status:", error.message);
      setLoading(false);
    });

    return () => unsubChat();
  }, [currentUser, userType]);

  // 2. Listen to messages for the active chat
  useEffect(() => {
    if (!currentUser || !chat) {
      setMessages([]);
      return;
    }

    const messagesQuery = query(
      collection(db, 'support_chats', currentUser.uid, 'messages'),
      orderBy('timestamp', 'asc'),
      limit(100)
    );

    const unsubMessages = onSnapshot(messagesQuery, (snap) => {
      const list = snap.docs.map(doc => ({ id: doc.id, ...doc.data() } as SupportMessage));
      setMessages(list);

      // Automatically mark incoming messages from support as read
      snap.docs.forEach(async (msgDoc) => {
        const data = msgDoc.data();
        if (data.senderType === 'support' && !data.read) {
          await updateDoc(doc(db, 'support_chats', currentUser.uid, 'messages', msgDoc.id), {
            read: true
          });
        }
      });

      // Clear the unread marker on parent chat
      if (chat.unreadByUser) {
        updateDoc(doc(db, 'support_chats', currentUser.uid), {
          unreadByUser: false
        });
      }
    }, (error) => {
      console.warn("Error subscribing to support messages:", error.message);
    });

    return () => unsubMessages();
  }, [currentUser, chat?.id]);

  // Scroll to bottom on new message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isExpanded]);

  const handleStartSession = async () => {
    if (!currentUser) return;
    setLoading(true);

    try {
      const now = new Date().toISOString();
      const chatData: SupportChat = {
        id: currentUser.uid,
        userId: currentUser.uid,
        userName,
        userEmail: currentUser.email || '',
        userType,
        lastMessage: 'Support thread initialized',
        lastMessageAt: now,
        status: 'open',
        unreadByAdmin: true,
        unreadByUser: false,
        updatedAt: now
      };

      // Create primary support chat document
      await setDoc(doc(db, 'support_chats', currentUser.uid), chatData);

      // Create initial greeting message from support
      const greetingMsg = {
        chatId: currentUser.uid,
        senderId: 'system_agent',
        senderName: 'HandyHub Support Agent',
        senderType: 'support',
        text: `Hello ${userName}! 👋 Welcome to HandyHub Support. How can we help you today with your ${userType === 'customer' ? 'bookings or account' : 'services or earnings'}?`,
        timestamp: now,
        read: false
      };

      await addDoc(collection(db, 'support_chats', currentUser.uid, 'messages'), greetingMsg);
    } catch (err) {
      console.error('Error starting support session:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !currentUser) return;

    const text = newMessage.trim();
    setNewMessage('');
    setSending(true);

    try {
      const now = new Date().toISOString();

      // Write to messages subcollection
      const messageData = {
        chatId: currentUser.uid,
        senderId: currentUser.uid,
        senderName: userName,
        senderType: 'user',
        text,
        timestamp: now,
        read: false
      };

      await addDoc(collection(db, 'support_chats', currentUser.uid, 'messages'), messageData);

      // Update parent ticket metadata
      await updateDoc(doc(db, 'support_chats', currentUser.uid), {
        lastMessage: text,
        lastMessageAt: now,
        status: 'open',
        unreadByAdmin: true,
        updatedAt: now
      });
    } catch (err) {
      console.error('Error sending support message:', err);
    } finally {
      setSending(false);
    }
  };

  const formatMessageTime = (isoString: string) => {
    try {
      return new Date(isoString).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return '';
    }
  };

  if (loading) {
    return (
      <div className="bg-bg-panel p-8 rounded-[32px] border border-white/5 flex flex-col items-center justify-center py-16 gap-3">
        <Loader2 size={32} className="animate-spin text-accent-blue" />
        <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Warming Support Channel...</p>
      </div>
    );
  }

  return (
    <>
      {/* 1. Main Dashboard Card State (Mini Preview) */}
      <section className="bg-bg-panel p-8 rounded-[32px] border border-white/5 space-y-6 relative overflow-hidden group">
        <div className="absolute top-0 right-0 w-32 h-32 bg-accent-blue/5 rounded-full blur-3xl group-hover:bg-accent-blue/10 transition-all duration-500" />
        
        <div className="flex justify-between items-center relative z-10">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-accent-blue/10 flex items-center justify-center text-accent-blue">
              <MessageSquare size={20} />
            </div>
            <div>
              <h2 className="text-xl font-bold text-white tracking-tight">HandyHub Support</h2>
              <p className="text-white/40 text-[10px] font-bold uppercase tracking-wider mt-0.5">24/7 Concierge Support</p>
            </div>
          </div>
          {chat && (
            <button
              onClick={() => setIsExpanded(true)}
              className="p-2 hover:bg-white/5 rounded-lg border border-white/5 text-white/40 hover:text-white transition-all flex items-center gap-1.5 text-xs"
              title="Open full messenger"
            >
              <Maximize2 size={14} />
              <span>Full Chat</span>
            </button>
          )}
        </div>

        {!chat ? (
          <div className="space-y-4 pt-2 relative z-10">
            <p className="text-white/60 text-sm leading-relaxed">
              Have questions about payments, verified artisans, or need help with a dispute? Launch a direct support session with our staff.
            </p>
            <button
              onClick={handleStartSession}
              className="w-full py-4 bg-accent-blue/10 hover:bg-accent-blue text-accent-blue hover:text-white rounded-2xl border border-accent-blue/20 hover:border-transparent font-bold text-xs uppercase tracking-widest transition-all duration-300 flex items-center justify-center gap-2.5"
            >
              <HelpCircle size={16} />
              Start Support Session
            </button>
          </div>
        ) : (
          <div className="space-y-4 relative z-10">
            {/* Inline mini chat history */}
            <div className="bg-white/[0.02] border border-white/5 rounded-2xl p-4 flex items-center justify-between gap-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider text-accent-blue bg-accent-blue/10 px-2 py-0.5 rounded-md">
                    Ticket Open
                  </span>
                  {chat.lastMessageAt && (
                    <span className="text-[9px] font-mono text-white/20">
                      {new Date(chat.lastMessageAt).toLocaleDateString()}
                    </span>
                  )}
                </div>
                <p className="text-xs text-white/80 font-medium truncate">
                  {chat.lastMessage || 'Active session connected.'}
                </p>
              </div>
              <button
                onClick={() => setIsExpanded(true)}
                className="px-4 py-2 bg-accent-blue text-white rounded-xl font-bold text-xs shrink-0 hover:bg-accent-blue/80 transition-all"
              >
                Reply Now
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 2. Beautiful Expanded Full Modal Messenger */}
      <AnimatePresence>
        {isExpanded && chat && (
          <div className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
            <motion.div
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              transition={{ type: 'spring', damping: 25, stiffness: 350 }}
              className="w-full max-w-2xl h-[620px] bg-bg-panel border border-white/10 rounded-[32px] flex flex-col overflow-hidden shadow-2xl"
            >
              {/* Headings */}
              <div className="p-6 bg-white/[0.02] border-b border-white/5 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl bg-accent-blue/10 flex items-center justify-center text-accent-blue border border-accent-blue/10 relative">
                    <MessageSquare size={22} />
                    <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-bg-panel animate-pulse" />
                  </div>
                  <div>
                    <h3 className="font-bold text-white text-base flex items-center gap-2">
                       HandyHub Direct Service
                    </h3>
                    <p className="text-xs font-mono text-white/40 flex items-center gap-1.5">
                      <Clock size={12} className="text-accent-blue" />
                      Average reply time: Under 5 mins
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setIsExpanded(false)}
                    className="p-2 hover:bg-white/5 rounded-xl border border-white/5 text-white/40 hover:text-white transition-transform"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>

              {/* Chat Messages */}
              <div className="flex-1 overflow-y-auto p-6 space-y-4 bg-gradient-to-b from-transparent to-black/10 custom-scrollbar">
                {messages.length > 0 ? (
                  messages.map((msg, index) => {
                    const isMe = msg.senderType === 'user';
                    return (
                      <div
                        key={msg.id || index}
                        className={`flex flex-col ${isMe ? 'items-end' : 'items-start'}`}
                      >
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-[9px] font-bold text-white/30 truncate max-w-[120px]">
                            {isMe ? 'You' : msg.senderName}
                          </span>
                          <span className="text-[8px] font-mono text-white/15">
                            {formatMessageTime(msg.timestamp)}
                          </span>
                        </div>
                        <div className={`p-4 text-xs font-medium leading-relaxed shadow-sm ${
                          isMe 
                            ? 'bg-accent-blue text-white rounded-[20px] rounded-tr-none ml-12' 
                            : 'bg-white/5 border border-white/5 text-white/95 rounded-[20px] rounded-tl-none mr-12'
                        }`}>
                          {msg.text}
                        </div>
                        {isMe && (
                          <span className="text-[8px] mt-1 text-white/20 flex items-center gap-0.5 font-mono">
                            {msg.read ? (
                              <>
                                <CheckCheck size={10} className="text-emerald-500" />
                                <span>Seen by agent</span>
                              </>
                            ) : (
                              <>
                                <Check size={10} />
                                <span>Delivered</span>
                              </>
                            )}
                          </span>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-center p-8 opacity-40 py-24">
                    <Loader2 className="animate-spin text-white mb-4" size={24} />
                    <p className="text-sm font-medium">Fetching support history...</p>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>

              {/* Msg input */}
              <form 
                onSubmit={handleSendMessage}
                className="p-4 bg-white/[0.01] border-t border-white/5 flex gap-3 items-center shrink-0"
              >
                <input
                  type="text"
                  placeholder="Tell us what you need help with..."
                  value={newMessage}
                  onChange={(e) => setNewMessage(e.target.value)}
                  disabled={sending}
                  className="flex-1 bg-white/5 border border-white/5 rounded-2xl py-3.5 px-4 text-xs text-white outline-none focus:border-accent-blue/40 transition-all placeholder:text-white/20"
                />
                <button
                  type="submit"
                  disabled={!newMessage.trim() || sending}
                  className="w-12 h-12 rounded-2xl bg-accent-blue hover:bg-accent-blue/80 text-white flex items-center justify-center transition-all disabled:opacity-40 disabled:hover:bg-accent-blue shrink-0 shadow-lg shadow-accent-blue/10"
                >
                  {sending ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                </button>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}
