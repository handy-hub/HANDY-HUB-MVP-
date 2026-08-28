import React, { useState, useEffect, useRef } from 'react';
import { 
  Search, 
  Send, 
  User, 
  MessageSquare, 
  MoreVertical, 
  Phone, 
  Video, 
  Info,
  Loader2,
  Check,
  CheckCheck,
  Plus,
  ArrowLeft,
  LogOut,
  AlertTriangle,
  Lock,
  Shield,
  Key,
  Eye,
  EyeOff
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  collection, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  addDoc, 
  serverTimestamp, 
  doc, 
  updateDoc, 
  getDocs, 
  setDoc,
  limit,
  Timestamp,
  getDoc
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import { AdminUser, AdminChat, AdminMessage, SupportChat, SupportMessage } from '../types';
import { cn } from '../utils';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { notificationService } from '../services/notificationService';
import { CryptoService } from '../services/cryptoService';

export default function Connect() {
  const [admins, setAdmins] = useState<AdminUser[]>([]);
  const [chats, setChats] = useState<AdminChat[]>([]);
  const [activeChat, setActiveChat] = useState<AdminChat | null>(null);
  const [messages, setMessages] = useState<AdminMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [newMessage, setNewMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [showAdminList, setShowAdminList] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [editingNickname, setEditingNickname] = useState(false);
  const [nickname, setNickname] = useState('');
  const [callState, setCallState] = useState<{ type: 'audio' | 'video', active: boolean } | null>(null);
  const [currentUserData, setCurrentUserData] = useState<AdminUser | null>(null);
  const [userPrivateKey, setUserPrivateKey] = useState<CryptoKey | null>(null);
  const [showKeySetup, setShowKeySetup] = useState(false);
  const [showKeyUnlock, setShowKeyUnlock] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [showPassphrase, setShowPassphrase] = useState(false);
  const [cryptoError, setCryptoError] = useState<string | null>(null);
  const [sharedKeys, setSharedKeys] = useState<{ [chatId: string]: CryptoKey }>({});
  const [decryptedMessages, setDecryptedMessages] = useState<{ [messageId: string]: string }>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Live support states
  const [supportChats, setSupportChats] = useState<SupportChat[]>([]);
  const [activeSupportChat, setActiveSupportChat] = useState<SupportChat | null>(null);
  const [supportMessages, setSupportMessages] = useState<SupportMessage[]>([]);
  const [loadingSupportMessages, setLoadingSupportMessages] = useState(false);
  const [connectionMode, setConnectionMode] = useState<'admin_chat' | 'support_ticket'>('admin_chat');

  const currentUser = auth.currentUser;

  const handleInitializeSecurity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase.trim() || !currentUser) return;
    setLoading(true);

    try {
      const { publicKey, encryptedPrivateKey, salt } = await CryptoService.generateIdentityKeyPair(passphrase);
      
      await updateDoc(doc(db, 'admins', currentUser.uid), {
        publicKey,
        encryptedPrivateKey,
        encryptionSalt: salt,
        updatedAt: new Date().toISOString()
      });

      // Automatically unlock after setup
      const privateKey = await CryptoService.decryptPrivateKey(encryptedPrivateKey, salt, passphrase);
      setUserPrivateKey(privateKey);
      
      setShowKeySetup(false);
      setPassphrase('');
    } catch (err) {
      console.error('Security initialization failed:', err);
      setCryptoError('Failed to initialize security. Use a stronger passphrase.');
    } finally {
      setLoading(false);
    }
  };

  const handleUnlockSecurity = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passphrase.trim() || !currentUser || !currentUserData?.encryptedPrivateKey) return;
    setLoading(true);
    setCryptoError(null);

    try {
      const privateKey = await CryptoService.decryptPrivateKey(
        currentUserData.encryptedPrivateKey,
        currentUserData.encryptionSalt!,
        passphrase
      );
      setUserPrivateKey(privateKey);
      setShowKeyUnlock(false);
      setPassphrase('');
    } catch (err) {
      console.error('Security unlock failed:', err);
      setCryptoError('Invalid passphrase. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // Manage Security Modal States
  useEffect(() => {
    if (!currentUserData) return;

    if (!currentUserData.publicKey) {
      setShowKeySetup(true);
      setShowKeyUnlock(false);
    } else if (!userPrivateKey) {
      setShowKeySetup(false);
      setShowKeyUnlock(true);
    } else {
      setShowKeySetup(false);
      setShowKeyUnlock(false);
    }
  }, [currentUserData?.publicKey, userPrivateKey, currentUserData]);

  // Decrypt messages when messages or key changes
  useEffect(() => {
    const decryptAll = async () => {
      if (!activeChat || !userPrivateKey || messages.length === 0) return;

      const otherId = activeChat.participants.find(id => id !== currentUser?.uid);
      const otherAdmin = admins.find(a => a.id === otherId);
      
      if (!otherAdmin?.publicKey) return;

      try {
        // 1. Get or derive shared key
        let sharedKey = sharedKeys[activeChat.id];
        if (!sharedKey) {
          sharedKey = await CryptoService.deriveSharedSecret(userPrivateKey, otherAdmin.publicKey);
          setSharedKeys(prev => ({ ...prev, [activeChat.id]: sharedKey }));
        }

        // 2. Decrypt each message
        const newDecrypted: { [id: string]: string } = { ...decryptedMessages };
        let changed = false;

        for (const msg of messages) {
          if (msg.isEncrypted && msg.ciphertext && msg.iv && !newDecrypted[msg.id]) {
            try {
              const decrypted = await CryptoService.decrypt(msg.ciphertext, msg.iv, sharedKey);
              newDecrypted[msg.id] = decrypted;
              changed = true;
            } catch (err) {
              newDecrypted[msg.id] = '[Decryption Failed]';
              changed = true;
            }
          }
        }

        if (changed) {
          setDecryptedMessages(newDecrypted);
        }
      } catch (err) {
        console.error('Encryption error:', err);
      }
    };

    decryptAll();
  }, [messages, userPrivateKey, activeChat?.id, admins]);

  // Scroll to bottom of messages
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Fetch admins and chats
  useEffect(() => {
    if (!currentUser) return;

    // Fetch current user data
    const userUnsub = onSnapshot(doc(db, 'admins', currentUser.uid), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data() as AdminUser;
        setCurrentUserData(data);
      }
    }, (error) => {
      console.warn("Failed to fetch current admin data:", error.message);
    });

    // Fetch all admins
    const adminsUnsub = onSnapshot(collection(db, 'admins'), (snapshot) => {
      const adminList = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() } as AdminUser))
        .filter(a => a.id !== currentUser.uid);
      setAdmins(adminList);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'admins');
    });

    // Fetch chats for current user
    const chatsQuery = query(
      collection(db, 'admin_chats'),
      where('participants', 'array-contains', currentUser.uid),
      orderBy('updatedAt', 'desc')
    );

    const chatsUnsub = onSnapshot(chatsQuery, (snapshot) => {
      const chatList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AdminChat));
      setChats(chatList);
      setLoading(false);
      
      // Update active chat if it was updated in background
      if (activeChat) {
        const updated = chatList.find(c => c.id === activeChat.id);
        if (updated) setActiveChat(updated);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'admin_chats');
    });

    return () => {
      userUnsub();
      adminsUnsub();
      chatsUnsub();
    };
  }, [currentUser, activeChat?.id]);

  // Live support tickets listener
  useEffect(() => {
    if (!currentUser) return;

    const supportChatsQuery = query(
      collection(db, 'support_chats'),
      orderBy('updatedAt', 'desc')
    );

    const supportChatsUnsub = onSnapshot(supportChatsQuery, (snapshot) => {
      const chatsList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SupportChat));
      setSupportChats(chatsList);
      
      if (activeSupportChat) {
        const updated = chatsList.find(c => c.id === activeSupportChat.id);
        if (updated) setActiveSupportChat(updated);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'support_chats');
    });

    return () => supportChatsUnsub();
  }, [currentUser, activeSupportChat?.id]);

  // Live support ticket messages listener
  useEffect(() => {
    if (!activeSupportChat || !currentUser) {
      setSupportMessages([]);
      return;
    }

    setLoadingSupportMessages(true);
    const messagesQuery = query(
      collection(db, 'support_chats', activeSupportChat.id, 'messages'),
      orderBy('timestamp', 'asc'),
      limit(100)
    );

    const messagesUnsub = onSnapshot(messagesQuery, (snapshot) => {
      const msgList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SupportMessage));
      setSupportMessages(msgList);
      setLoadingSupportMessages(false);

      // Mark unread messages as read from user side
      snapshot.docs.forEach(async (messageDoc) => {
        const data = messageDoc.data();
        if (msgDocNotMe(data) && !data.read) {
          try {
            await updateDoc(doc(db, 'support_chats', activeSupportChat.id, 'messages', messageDoc.id), {
              read: true
            });
          } catch (err) {
            console.error('Error setting message read:', err);
          }
        }
      });

      // Reset tickets unreadByAdmin counter
      if (activeSupportChat.unreadByAdmin) {
        updateDoc(doc(db, 'support_chats', activeSupportChat.id), {
          unreadByAdmin: false
        }).catch(err => console.error('Error resetting unreadByAdmin state:', err));
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `support_chats/${activeSupportChat.id}/messages`);
    });

    // Helper logic to verify sender
    function msgDocNotMe(data: any) {
      return data.senderType === 'user';
    }

    return () => messagesUnsub();
  }, [activeSupportChat?.id, currentUser]);

  // Fetch messages for active chat
  useEffect(() => {
    if (!activeChat || !currentUser) {
      setMessages([]);
      return;
    }

    setLoadingMessages(true);
    const messagesQuery = query(
      collection(db, 'admin_chats', activeChat.id, 'messages'),
      orderBy('timestamp', 'asc'),
      limit(100)
    );

    const messagesUnsub = onSnapshot(messagesQuery, (snapshot) => {
      const messageList = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AdminMessage));
      setMessages(messageList);
      setLoadingMessages(false);

      // Mark unread messages as read
      snapshot.docs.forEach(async (messageDoc) => {
        const data = messageDoc.data();
        if (data.senderId !== currentUser.uid && !data.read) {
          await updateDoc(doc(db, 'admin_chats', activeChat.id, 'messages', messageDoc.id), {
            read: true
          });
        }
      });
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `admin_chats/${activeChat.id}/messages`);
    });

    return () => messagesUnsub();
  }, [activeChat?.id, currentUser]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !currentUser) return;

    if (connectionMode === 'support_ticket') {
      if (!activeSupportChat) return;
      const text = newMessage.trim();
      setNewMessage('');

      try {
        const senderName = currentUserData?.name || 'HandyHub Support';
        const payload: Omit<SupportMessage, 'id'> = {
          chatId: activeSupportChat.id,
          senderId: currentUser.uid,
          senderName,
          senderType: 'support',
          text,
          timestamp: new Date().toISOString(),
          read: false
        };

        await addDoc(collection(db, 'support_chats', activeSupportChat.id, 'messages'), payload);

        await updateDoc(doc(db, 'support_chats', activeSupportChat.id), {
          lastMessage: text,
          lastMessageAt: payload.timestamp,
          updatedAt: payload.timestamp,
          unreadByUser: true
        });

        // Send push-like in-app message notification back to the customer/artisan
        await notificationService.sendNotification({
          userId: activeSupportChat.id,
          title: `HandyHub Support Response`,
          message: text.length > 50 ? text.substring(0, 48) + '...' : text,
          type: 'success',
          category: 'message',
          link: activeSupportChat.userType === 'customer' ? '/customer-dashboard' : '/artisan-dashboard'
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, `support_chats/${activeSupportChat.id}/messages`);
      }
      return;
    }

    // Default admin E2EE chat flow:
    if (!activeChat) return;
    const text = newMessage.trim();
    setNewMessage('');

    try {
      const currentAdmin = await getDocs(query(collection(db, 'admins'), where('id', '==', currentUser.uid)));
      const senderName = currentAdmin.docs[0]?.data()?.name || 'Admin';

      // E2EE logic
      const otherId = activeChat.participants.find(id => id !== currentUser.uid);
      const otherAdmin = admins.find(a => a.id === otherId);
      
      const payload: any = {
        chatId: activeChat.id,
        senderId: currentUser.uid,
        senderName,
        text,
        timestamp: new Date().toISOString(),
        read: false
      };

      await addDoc(collection(db, 'admin_chats', activeChat.id, 'messages'), payload);

      await updateDoc(doc(db, 'admin_chats', activeChat.id), {
        lastMessage: payload.text,
        lastMessageAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      // Send notification to other participants
      const otherParticipants = activeChat.participants.filter(id => id !== currentUser.uid);
      for (const participantId of otherParticipants) {
        await notificationService.sendNotification({
          userId: participantId,
          title: `New Message from ${senderName}`,
          message: text.length > 50 ? text.substring(0, 47) + '...' : text,
          type: 'info',
          category: 'message',
          link: '/connect'
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `admin_chats/${activeChat.id}/messages`);
    }
  };

  const startChat = async (admin: AdminUser) => {
    if (!currentUser) return;

    // Check if chat already exists
    const existingChat = chats.find(c => c.participants.includes(admin.id));
    if (existingChat) {
      setActiveChat(existingChat);
      setShowAdminList(false);
      return;
    }

    // Create new chat
    try {
      const chatId = [currentUser.uid, admin.id].sort().join('_');
      const chatData: Omit<AdminChat, 'id'> = {
        participants: [currentUser.uid, admin.id],
        updatedAt: new Date().toISOString()
      };

      await setDoc(doc(db, 'admin_chats', chatId), chatData);
      setActiveChat({ id: chatId, ...chatData });
      setShowAdminList(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'admin_chats');
    }
  };

  const getOtherParticipant = (chat: AdminChat) => {
    const otherId = chat.participants.find(id => id !== currentUser?.uid);
    const admin = admins.find(a => a.id === otherId) || { 
      id: otherId || 'unknown',
      name: 'Unknown Admin', 
      email: '',
      role: 'support_admin',
      status: 'active',
      lastLogin: '',
      createdAt: ''
    } as AdminUser;

    // Apply nickname if exists
    if (chat.nicknames && otherId && chat.nicknames[otherId]) {
      return { ...admin, name: chat.nicknames[otherId] };
    }
    return admin;
  };

  const handleUpdateNickname = async () => {
    if (!activeChat || !currentUser) return;
    const otherId = activeChat.participants.find(id => id !== currentUser.uid);
    if (!otherId) return;

    try {
      await updateDoc(doc(db, 'admin_chats', activeChat.id), {
        [`nicknames.${otherId}`]: nickname.trim() || null,
        updatedAt: new Date().toISOString()
      });
      setEditingNickname(false);
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `admin_chats/${activeChat.id}`);
    }
  };

  const handleStartCall = (type: 'audio' | 'video') => {
    setCallState({ type, active: true });
  };

  const filteredAdmins = admins.filter(a => 
    a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    a.email.toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-80px)]">
        <Loader2 size={32} className="animate-spin text-accent-blue" />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-100px)] gap-6 p-6">
      {/* Sidebar - Chat List */}
      <div className={cn(
        "w-full lg:w-80 flex flex-col bg-bg-card rounded-[32px] border border-white/5 overflow-hidden shadow-xl",
        ((connectionMode === 'admin_chat' && activeChat) || (connectionMode === 'support_ticket' && activeSupportChat)) && "hidden lg:flex"
      )}>
        <div className="p-6 border-b border-white/5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-bold text-white tracking-tight">Connect</h2>
            {connectionMode === 'admin_chat' && (
              <button 
                onClick={() => setShowAdminList(true)}
                className="w-10 h-10 rounded-xl bg-accent-blue/10 text-accent-blue flex items-center justify-center hover:bg-accent-blue/20 transition-all"
              >
                <Plus size={20} />
              </button>
            )}
          </div>

          {/* Connection Mode Toggle */}
          <div className="grid grid-cols-2 bg-white/5 p-1 rounded-xl text-[10px] font-bold border border-white/5 select-none shrink-0">
            <button
              onClick={() => setConnectionMode('admin_chat')}
              className={cn(
                "py-2 rounded-lg transition-all text-center uppercase tracking-wider font-extrabold",
                connectionMode === 'admin_chat' 
                  ? "bg-accent-blue text-white shadow" 
                  : "text-white/40 hover:text-white"
              )}
            >
              Admin Core
            </button>
            <button
              onClick={() => setConnectionMode('support_ticket')}
              className={cn(
                "py-2 rounded-lg transition-all text-center uppercase tracking-wider font-extrabold flex items-center justify-center gap-1",
                connectionMode === 'support_ticket' 
                  ? "bg-accent-blue text-white shadow" 
                  : "text-white/40 hover:text-white"
              )}
            >
              Client Support
              {supportChats.some(c => c.unreadByAdmin) && (
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse shrink-0" />
              )}
            </button>
          </div>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" size={16} />
            <input 
              type="text"
              placeholder={connectionMode === 'support_ticket' ? "Search tickets..." : "Search chats..."}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-white/5 border border-white/5 rounded-xl py-2.5 pl-10 pr-4 text-sm text-white outline-none focus:border-accent-blue/50 transition-all"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-2">
          {connectionMode === 'support_ticket' ? (
            supportChats.filter(chat => 
              chat.userName.toLowerCase().includes(searchQuery.toLowerCase()) || 
              chat.userEmail.toLowerCase().includes(searchQuery.toLowerCase())
            ).length > 0 ? (
              <div className="space-y-1">
                {supportChats
                  .filter(chat => 
                    chat.userName.toLowerCase().includes(searchQuery.toLowerCase()) || 
                    chat.userEmail.toLowerCase().includes(searchQuery.toLowerCase())
                  )
                  .map((chat) => {
                    const isActive = activeSupportChat?.id === chat.id;
                    const hasUnread = chat.unreadByAdmin;
                    return (
                      <button
                        key={chat.id}
                        onClick={() => setActiveSupportChat(chat)}
                        className={cn(
                          "w-full flex items-center gap-3 p-3 rounded-2xl transition-all group relative",
                          isActive ? "bg-accent-blue text-white" : "hover:bg-white/5 text-white/60"
                        )}
                      >
                        {hasUnread && !isActive && (
                          <span className="absolute left-1.5 top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse border border-bg-card shadow" />
                        )}
                        <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center overflow-hidden shrink-0 border border-white/10 relative">
                          <User size={20} className={isActive ? "text-white" : "text-white/20"} />
                          <span className={cn(
                            "absolute bottom-0 right-0 px-1 text-[7px] font-black uppercase rounded tracking-widest leading-none py-0.5",
                            chat.userType === 'customer' ? "bg-accent-blue text-white" : "bg-accent-purple text-colored"
                          )}>
                            {chat.userType === 'customer' ? 'CLIENT' : 'ARTISAN'}
                          </span>
                        </div>
                        <div className="flex-1 text-left min-w-0">
                          <div className="flex items-center justify-between mb-0.5">
                            <span className={cn("font-bold truncate text-xs", isActive ? "text-white" : "text-white")}>
                              {chat.userName}
                            </span>
                            {chat.lastMessageAt && (
                              <span className={cn("text-[9px] font-mono", isActive ? "text-white/60" : "text-white/20")}>
                                {new Date(chat.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            )}
                          </div>
                          <p className={cn("text-[11px] truncate", isActive ? "text-white/80" : "text-white/40")}>
                            {chat.lastMessage || 'Active support thread'}
                          </p>
                        </div>
                      </button>
                    );
                  })}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center p-6 opacity-30">
                <div className="w-16 h-16 rounded-3xl bg-white/5 flex items-center justify-center mb-4">
                  <MessageSquare size={32} className="text-white" />
                </div>
                <p className="text-xs text-white">No active support tickets found</p>
              </div>
            )
          ) : (
            chats.length > 0 ? (
              <div className="space-y-1">
                {chats.map((chat) => {
                  const other = getOtherParticipant(chat);
                  const isActive = activeChat?.id === chat.id;
                  return (
                    <button
                      key={chat.id}
                      onClick={() => setActiveChat(chat)}
                      className={cn(
                        "w-full flex items-center gap-3 p-3 rounded-2xl transition-all group",
                        isActive ? "bg-accent-blue text-white" : "hover:bg-white/5 text-white/60"
                      )}
                    >
                      <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center overflow-hidden shrink-0 border border-white/10">
                        {other.photoURL ? (
                          <img src={other.photoURL} alt={other.name} className="w-full h-full object-cover" />
                        ) : (
                          <User size={20} className={isActive ? "text-white" : "text-white/20"} />
                        )}
                      </div>
                      <div className="flex-1 text-left min-w-0">
                        <div className="flex items-center justify-between mb-0.5">
                          <span className={cn("font-bold truncate", isActive ? "text-white" : "text-white")}>{other.name}</span>
                          {chat.lastMessageAt && (
                            <span className={cn("text-[10px] font-mono", isActive ? "text-white/60" : "text-white/20")}>
                              {new Date(chat.lastMessageAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                        </div>
                        <p className={cn("text-[12px] truncate", isActive ? "text-white/80" : "text-white/40")}>
                          {chat.lastMessage || 'Start a conversation'}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center p-6">
                <div className="w-16 h-16 rounded-3xl bg-white/5 flex items-center justify-center mb-4">
                  <MessageSquare size={32} className="text-white/10" />
                </div>
                <p className="text-sm text-white/40 mb-4">No conversations yet</p>
                <button 
                  onClick={() => setShowAdminList(true)}
                  className="px-6 py-2.5 bg-accent-blue text-white rounded-xl font-bold text-sm hover:bg-accent-blue/80 transition-all"
                >
                  Find Admins
                </button>
              </div>
            )
          )}
        </div>
      </div>

      {/* Main Chat Window */}
      <div className={cn(
        "flex-1 flex flex-col bg-bg-card rounded-[32px] border border-white/5 overflow-hidden shadow-xl relative",
        ((connectionMode === 'admin_chat' && !activeChat) || (connectionMode === 'support_ticket' && !activeSupportChat)) && "hidden lg:flex"
      )}>
        {connectionMode === 'support_ticket' ? (
          activeSupportChat ? (
            <div className="flex h-full">
              <div className="flex-1 flex flex-col min-w-0">
                {/* Support Chat Header */}
                <div className="p-4 lg:p-6 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={() => setActiveSupportChat(null)}
                      className="lg:hidden p-2 text-white/40 hover:text-white transition-colors"
                    >
                      <ArrowLeft size={20} />
                    </button>
                    <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-xl bg-accent-blue/10 text-accent-blue flex items-center justify-center overflow-hidden border border-accent-blue/20">
                      <User size={20} />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-white tracking-tight">{activeSupportChat.userName}</h3>
                        <span className={cn(
                          "px-2 py-0.5 text-[8px] font-black uppercase rounded tracking-widest",
                          activeSupportChat.userType === 'customer' ? "bg-accent-blue text-white" : "bg-accent-purple text-colored"
                        )}>
                          {activeSupportChat.userType}
                        </span>
                      </div>
                      <p className="text-[10px] text-white/40 font-semibold tracking-wide mt-0.5">
                        {activeSupportChat.userEmail}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Support Messages Area */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
                  {loadingSupportMessages ? (
                    <div className="flex items-center justify-center h-full">
                      <Loader2 size={24} className="animate-spin text-accent-blue" />
                    </div>
                  ) : supportMessages.length > 0 ? (
                    supportMessages.map((msg, idx) => {
                      const isMe = msg.senderType === 'support';
                      const showDate = idx === 0 || new Date(supportMessages[idx-1].timestamp).toDateString() !== new Date(msg.timestamp).toDateString();
                      
                      return (
                        <React.Fragment key={msg.id}>
                          {showDate && (
                            <div className="flex justify-center my-4">
                              <span className="px-3 py-1 rounded-full bg-white/5 text-[10px] font-bold text-white/20 uppercase tracking-widest">
                                {new Date(msg.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                              </span>
                            </div>
                          )}
                          <div className={cn(
                            "flex flex-col max-w-[80%] lg:max-w-[70%]",
                            isMe ? "ml-auto items-end" : "mr-auto items-start"
                          )}>
                            <div className={cn(
                              "px-4 py-3 rounded-2xl text-sm font-medium leading-relaxed",
                              isMe 
                                ? "bg-accent-blue/20 text-white rounded-tr-none border border-accent-blue/30" 
                                : "bg-white/5 text-white/80 border border-white/5 rounded-tl-none"
                            )}>
                              {msg.text}
                            </div>
                            <div className="flex items-center gap-1.5 mt-1.5 px-1">
                              <span className="text-[10px] font-mono text-white/20">
                                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                          </div>
                        </React.Fragment>
                      );
                    })
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-center opacity-20">
                      <MessageSquare size={48} className="mb-4" />
                      <p className="text-sm font-medium">No messages yet. Reply to start the conversation.</p>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Response Message Input */}
                <form onSubmit={handleSendMessage} className="p-4 lg:p-6 border-t border-white/5 bg-white/[0.02]">
                  <div className="flex items-center gap-3 bg-white/5 border border-white/5 rounded-2xl p-2 focus-within:border-accent-blue/50 transition-all">
                    <input 
                      type="text"
                      placeholder="Type your response to support ticket..."
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      className="flex-1 bg-transparent border-none outline-none px-3 text-sm text-white placeholder:text-white/20"
                    />
                    <button 
                      type="submit"
                      disabled={!newMessage.trim()}
                      className="w-10 h-10 rounded-xl bg-accent-blue text-white flex items-center justify-center hover:bg-accent-blue/80 disabled:opacity-50 disabled:hover:bg-accent-blue transition-all shadow-lg"
                    >
                      <Send size={18} />
                    </button>
                  </div>
                </form>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center p-6 text-white/20">
              <MessageSquare size={48} className="mb-4 animate-pulse text-accent-blue/40" />
              <h3 className="text-lg font-bold text-white/40">Support Operations Console</h3>
              <p className="text-xs max-w-sm mt-2 text-white/30 leading-relaxed">
                Select an open customer or artisan support ticket from the sidebar to engage on live support.
              </p>
            </div>
          )
        ) : (
          activeChat ? (
            <div className="flex h-full">
              <div className="flex-1 flex flex-col min-w-0">
                {/* Chat Header */}
                <div className="p-4 lg:p-6 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
                  <div className="flex items-center gap-4">
                    <button 
                      onClick={() => setActiveChat(null)}
                      className="lg:hidden p-2 text-white/40 hover:text-white transition-colors"
                    >
                      <ArrowLeft size={20} />
                    </button>
                    <div className="w-10 h-10 lg:w-12 lg:h-12 rounded-xl bg-white/10 flex items-center justify-center overflow-hidden shrink-0 border border-white/10">
                      {getOtherParticipant(activeChat).photoURL ? (
                        <img src={getOtherParticipant(activeChat).photoURL} alt={getOtherParticipant(activeChat).name} className="w-full h-full object-cover" />
                      ) : (
                        <User size={20} className="text-white/20" />
                      )}
                    </div>
                    <div>
                      <h3 className="font-bold text-white tracking-tight">{getOtherParticipant(activeChat).name}</h3>
                      <p className="text-[10px] font-bold text-accent-blue uppercase tracking-widest">
                        {getOtherParticipant(activeChat).role.replace('_', ' ')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 lg:gap-2">
                    <button 
                      onClick={() => handleStartCall('audio')}
                      className="p-2 text-white/20 hover:text-white hover:bg-white/5 rounded-lg transition-all"
                    >
                      <Phone size={18} />
                    </button>
                    <button 
                      onClick={() => setShowInfo(!showInfo)}
                      className={cn(
                        "p-2 rounded-lg transition-all",
                        showInfo ? "bg-accent-blue text-white" : "text-white/20 hover:text-white hover:bg-white/5"
                      )}
                    >
                      <Info size={18} />
                    </button>
                  </div>
                </div>

                {/* Messages Area */}
                <div className="flex-1 overflow-y-auto custom-scrollbar p-6 space-y-6">
                  {loadingMessages ? (
                    <div className="flex items-center justify-center h-full">
                      <Loader2 size={24} className="animate-spin text-accent-blue" />
                    </div>
                  ) : messages.length > 0 ? (
                    messages.map((msg, idx) => {
                      const isMe = msg.senderId === currentUser?.uid;
                      const showDate = idx === 0 || new Date(messages[idx-1].timestamp).toDateString() !== new Date(msg.timestamp).toDateString();
                      
                      return (
                        <React.Fragment key={msg.id}>
                          {showDate && (
                            <div className="flex justify-center my-4">
                              <span className="px-3 py-1 rounded-full bg-white/5 text-[10px] font-bold text-white/20 uppercase tracking-widest">
                                {new Date(msg.timestamp).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}
                              </span>
                            </div>
                          )}
                          <div className={cn(
                            "flex flex-col max-w-[80%] lg:max-w-[70%]",
                            isMe ? "ml-auto items-end" : "mr-auto items-start"
                          )}>
                            <div className={cn(
                              "px-4 py-3 rounded-2xl text-sm font-medium leading-relaxed relative group",
                              isMe 
                                ? "bg-accent-blue text-white rounded-tr-none shadow-lg shadow-accent-blue/10" 
                                : "bg-white/5 text-white/80 border border-white/5 rounded-tl-none"
                            )}>
                              {msg.text}
                            </div>
                            <div className="flex items-center gap-1.5 mt-1.5 px-1">
                              <span className="text-[10px] font-mono text-white/20">
                                {new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                              {isMe && (
                                msg.read ? <CheckCheck size={12} className="text-accent-blue" /> : <Check size={12} className="text-white/20" />
                              )}
                            </div>
                          </div>
                        </React.Fragment>
                      );
                    })
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-center opacity-20">
                      <MessageSquare size={48} className="mb-4" />
                      <p className="text-sm font-medium">No messages yet. Say hi!</p>
                    </div>
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* Message Input */}
                <form onSubmit={handleSendMessage} className="p-4 lg:p-6 border-t border-white/5 bg-white/[0.02]">
                  <div className="flex items-center gap-3 bg-white/5 border border-white/5 rounded-2xl p-2 focus-within:border-accent-blue/50 transition-all">
                    <input 
                      type="text"
                      placeholder="Type a message..."
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      className="flex-1 bg-transparent border-none outline-none px-3 text-sm text-white placeholder:text-white/20"
                    />
                    <button 
                      type="submit"
                      disabled={!newMessage.trim()}
                      className="w-10 h-10 rounded-xl bg-accent-blue text-white flex items-center justify-center hover:bg-accent-blue/80 disabled:opacity-50 disabled:hover:bg-accent-blue transition-all shadow-lg shadow-accent-blue/20"
                    >
                      <Send size={18} />
                    </button>
                  </div>
                </form>
              </div>

            {/* Info Panel */}
            <AnimatePresence>
              {showInfo && (
                <motion.div
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 320, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  className="border-l border-white/5 bg-white/[0.01] overflow-hidden hidden xl:block"
                >
                  <div className="p-8 flex flex-col items-center text-center">
                    <div className="w-24 h-24 rounded-[32px] bg-white/5 flex items-center justify-center overflow-hidden mb-6 border border-white/10">
                      {getOtherParticipant(activeChat).photoURL ? (
                        <img src={getOtherParticipant(activeChat).photoURL} alt={getOtherParticipant(activeChat).name} className="w-full h-full object-cover" />
                      ) : (
                        <User size={40} className="text-white/20" />
                      )}
                    </div>
                    
                    <div className="w-full space-y-1 mb-8">
                      {editingNickname ? (
                        <div className="flex items-center gap-2">
                          <input 
                            type="text"
                            value={nickname}
                            onChange={(e) => setNickname(e.target.value)}
                            placeholder="Set nickname..."
                            className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white outline-none focus:border-accent-blue/50"
                            autoFocus
                          />
                          <button 
                            onClick={handleUpdateNickname}
                            className="p-2 bg-accent-blue text-white rounded-lg hover:bg-accent-blue/80"
                          >
                            <Check size={16} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-2 group">
                          <h4 className="text-xl font-bold text-white tracking-tight">{getOtherParticipant(activeChat).name}</h4>
                          <button 
                            onClick={() => {
                              setNickname(activeChat.nicknames?.[activeChat.participants.find(id => id !== currentUser?.uid) || ''] || '');
                              setEditingNickname(true);
                            }}
                            className="p-1 text-white/20 hover:text-white opacity-0 group-hover:opacity-100 transition-all"
                          >
                            <Plus size={14} />
                          </button>
                        </div>
                      )}
                      <p className="text-[11px] font-bold text-accent-blue uppercase tracking-[0.2em]">
                        {getOtherParticipant(activeChat).role.replace('_', ' ')}
                      </p>
                    </div>

                    <div className="w-full space-y-4 text-left">
                      <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                        <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-1">Email Address</p>
                        <p className="text-sm text-white/80 truncate">{getOtherParticipant(activeChat).email}</p>
                      </div>
                      <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                        <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-1">Last Active</p>
                        <p className="text-sm text-white/80">{getOtherParticipant(activeChat).lastLogin || 'Unknown'}</p>
                      </div>
                      <div className="p-4 bg-white/5 rounded-2xl border border-white/5">
                        <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-1">Member Since</p>
                        <p className="text-sm text-white/80">{new Date(getOtherParticipant(activeChat).createdAt).toLocaleDateString()}</p>
                      </div>
                    </div>

                    <div className="mt-auto pt-8 w-full">
                      <button className="w-full py-3 px-4 bg-red-500/10 text-red-500 rounded-xl font-bold text-sm hover:bg-red-500/20 transition-all flex items-center justify-center gap-2">
                        <AlertTriangle size={16} />
                        Block Administrator
                      </button>
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center p-12">
            <div className="w-24 h-24 rounded-[40px] bg-white/5 flex items-center justify-center mb-8 animate-pulse">
              <MessageSquare size={48} className="text-white/10" />
            </div>
            <h3 className="text-2xl font-bold text-white mb-3 tracking-tight">Your Conversations</h3>
            <p className="text-white/40 max-w-md leading-relaxed">
              Select a chat from the sidebar or start a new one to connect with other administrators.
            </p>
          </div>
        )
      )}

        {/* New Chat Modal */}
        <AnimatePresence>
          {showAdminList && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 bg-bg-dark/95 backdrop-blur-md p-6 flex flex-col"
            >
              <div className="flex items-center justify-between mb-8">
                <h3 className="text-2xl font-bold text-white tracking-tight">New Conversation</h3>
                <button 
                  onClick={() => setShowAdminList(false)}
                  className="w-10 h-10 rounded-xl bg-white/5 text-white/40 flex items-center justify-center hover:bg-white/10 hover:text-white transition-all"
                >
                  <Plus size={24} className="rotate-45" />
                </button>
              </div>

              <div className="relative mb-6">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" size={20} />
                <input 
                  type="text"
                  placeholder="Search by name or email..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-2xl py-4 pl-12 pr-6 text-white outline-none focus:border-accent-blue/50 transition-all font-medium"
                />
              </div>

              <div className="flex-1 overflow-y-auto custom-scrollbar space-y-2">
                {filteredAdmins.length > 0 ? (
                  filteredAdmins.map((admin) => (
                    <button
                      key={admin.id}
                      onClick={() => startChat(admin)}
                      className="w-full flex items-center gap-4 p-4 rounded-2xl hover:bg-white/5 transition-all group border border-transparent hover:border-white/5"
                    >
                      <div className="w-12 h-12 rounded-xl bg-white/10 flex items-center justify-center overflow-hidden shrink-0 border border-white/10 group-hover:border-accent-blue/30 transition-colors">
                        {admin.photoURL ? (
                          <img src={admin.photoURL} alt={admin.name} className="w-full h-full object-cover" />
                        ) : (
                          <User size={24} className="text-white/20 group-hover:text-accent-blue transition-colors" />
                        )}
                      </div>
                      <div className="flex-1 text-left">
                        <h4 className="font-bold text-white group-hover:text-accent-blue transition-colors">{admin.name}</h4>
                        <p className="text-[11px] font-bold text-white/20 uppercase tracking-widest mt-0.5">{admin.role.replace('_', ' ')}</p>
                      </div>
                      <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-white/20 group-hover:bg-accent-blue group-hover:text-white transition-all">
                        <Plus size={20} />
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-center opacity-20">
                    <User size={48} className="mb-4" />
                    <p className="text-lg font-medium">No admins found</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Calling Modal */}
        <AnimatePresence>
          {callState?.active && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              className="fixed inset-0 z-[100] bg-bg-dark/95 backdrop-blur-xl flex items-center justify-center p-6"
            >
              <div className="max-w-md w-full flex flex-col items-center text-center">
                <div className="relative mb-8">
                  <div className="w-32 h-32 rounded-[48px] bg-white/5 flex items-center justify-center overflow-hidden border border-white/10 relative z-10">
                    {getOtherParticipant(activeChat!).photoURL ? (
                      <img src={getOtherParticipant(activeChat!).photoURL} alt={getOtherParticipant(activeChat!).name} className="w-full h-full object-cover" />
                    ) : (
                      <User size={48} className="text-white/20" />
                    )}
                  </div>
                  <div className="absolute inset-0 bg-accent-blue/20 rounded-[48px] animate-ping" />
                  <div className="absolute -bottom-2 -right-2 w-10 h-10 rounded-2xl bg-accent-blue flex items-center justify-center text-white shadow-lg shadow-accent-blue/20 z-20">
                    {callState.type === 'video' ? <Video size={20} /> : <Phone size={20} />}
                  </div>
                </div>

                <h3 className="text-3xl font-bold text-white mb-2 tracking-tight">
                  {getOtherParticipant(activeChat!).name}
                </h3>
                <p className="text-accent-blue font-bold uppercase tracking-[0.2em] text-[12px] mb-12 animate-pulse">
                  Calling...
                </p>

                <div className="flex items-center gap-6">
                  <button className="w-16 h-16 rounded-3xl bg-white/5 text-white/40 flex items-center justify-center hover:bg-white/10 transition-all">
                    <Info size={24} />
                  </button>
                  <button 
                    onClick={() => setCallState(null)}
                    className="w-20 h-20 rounded-[32px] bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-all shadow-xl shadow-red-500/20"
                  >
                    <LogOut size={32} className="rotate-180" />
                  </button>
                  <button className="w-16 h-16 rounded-3xl bg-white/5 text-white/40 flex items-center justify-center hover:bg-white/10 transition-all">
                    <MoreVertical size={24} />
                  </button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Setup Security Keys Modal */}
        <AnimatePresence>
          {showKeySetup && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[90] bg-bg-dark/95 backdrop-blur-md p-6 flex items-center justify-center p-4"
            >
              <div className="max-w-md w-full bg-bg-panel border border-white/10 rounded-3xl shadow-2xl p-8 relative overflow-hidden">
                <div className="w-16 h-16 bg-accent-blue/10 rounded-2xl flex items-center justify-center text-accent-blue mx-auto mb-6">
                  <Key size={32} />
                </div>
                <h3 className="text-2xl font-bold text-white text-center mb-2 tracking-tight">E2E Encryption Setup</h3>
                <p className="text-white/40 text-[13px] text-center mb-6 leading-relaxed">
                  Generate secure keys to protect your administrator communications. Choose a private passphrase to encrypt your identity key.
                </p>

                <form onSubmit={handleInitializeSecurity} className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-white/20 uppercase tracking-widest ml-1">Choose Passphrase</label>
                    <div className="relative">
                      <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" size={18} />
                      <input 
                        type={showPassphrase ? "text" : "password"}
                        required
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        className="w-full pl-12 pr-12 py-3.5 bg-black/40 border border-white/10 rounded-xl text-white focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all font-medium text-sm"
                        placeholder="Must be strong & memorable"
                      />
                      <button 
                        type="button"
                        onClick={() => setShowPassphrase(!showPassphrase)}
                        className="absolute right-4 top-1/2 -translate-y-1/2 text-white/20 hover:text-white transition-colors animate-fade-in"
                      >
                        {showPassphrase ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </div>

                  {cryptoError && (
                    <p className="text-red-400 text-xs px-1 font-medium">{cryptoError}</p>
                  )}

                  <button 
                    type="submit"
                    disabled={loading || !passphrase.trim()}
                    className="w-full py-4 bg-white text-bg-dark rounded-xl font-bold hover:bg-white/90 transition-all shadow-lg flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {loading ? <div className="w-5 h-5 border-2 border-bg-dark/30 border-t-bg-dark rounded-full animate-spin" /> : 'Generate Secure Keys'}
                  </button>
                </form>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Unlock Security Keys Modal */}
        <AnimatePresence>
          {showKeyUnlock && (
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[90] bg-bg-dark/95 backdrop-blur-md p-6 flex items-center justify-center p-4"
            >
              <div className="max-w-md w-full bg-bg-panel border border-white/10 rounded-3xl shadow-2xl p-8 relative overflow-hidden">
                <div className="w-16 h-16 bg-accent-blue/10 rounded-2xl flex items-center justify-center text-accent-blue mx-auto mb-6">
                  <Key size={32} />
                </div>
                <h3 className="text-2xl font-bold text-white text-center mb-2 tracking-tight">Unlock Secure Chats</h3>
                <p className="text-white/40 text-[13px] text-center mb-6 leading-relaxed">
                  Enter your security passphrase to decrypt your identity key. This is required to access your administrator communications.
                </p>

                <form onSubmit={handleUnlockSecurity} className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-[10px] font-bold text-white/20 uppercase tracking-widest ml-1">Your Passphrase</label>
                    <div className="relative">
                      <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" size={18} />
                      <input 
                        type={showPassphrase ? "text" : "password"}
                        required
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        className="w-full pl-12 pr-12 py-3.5 bg-black/40 border border-white/10 rounded-xl text-white focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all font-medium text-sm"
                        placeholder="Enter secure decryption passphrase"
                      />
                      <button 
                        type="button"
                        onClick={() => setShowPassphrase(!showPassphrase)}
                        className="absolute right-4 top-1/2 -translate-y-1/2 text-white/20 hover:text-white transition-colors animate-fade-in"
                      >
                        {showPassphrase ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                  </div>

                  {cryptoError && (
                    <p className="text-red-400 text-xs px-1 font-medium">{cryptoError}</p>
                  )}

                  <button 
                    type="submit"
                    disabled={loading || !passphrase.trim()}
                    className="w-full py-4 bg-white text-bg-dark rounded-xl font-bold hover:bg-white/90 transition-all shadow-lg flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    {loading ? <div className="w-5 h-5 border-2 border-bg-dark/30 border-t-bg-dark rounded-full animate-spin" /> : 'Unlock Identity Key'}
                  </button>
                </form>

                <div className="mt-6 border-t border-white/5 pt-4 text-center">
                  <p className="text-white/20 text-xs">
                    Forgot passphrase?{' '}
                    <button 
                      onClick={async () => {
                        if (window.confirm("Warning: Resetting your keys means you will not be able to decrypt past conversations. Do you want to continue?")) {
                          try {
                            setLoading(true);
                            setUserPrivateKey(null);
                            await updateDoc(doc(db, 'admins', currentUser!.uid), {
                              publicKey: "",
                              encryptedPrivateKey: "",
                              encryptionSalt: ""
                            });
                          } catch (err) {
                            console.error(err);
                          } finally {
                            setLoading(false);
                          }
                        }
                      }}
                      className="text-accent-blue font-bold hover:underline"
                    >
                      Reset Security Keys
                    </button>
                  </p>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </div>
    </div>
  );
}
