import React from 'react';
import { Bell, Search, Briefcase, Wrench, User, X, Menu, AlertTriangle, Wallet, CheckCircle, Info, ChevronDown, Clock, Shield, Gavel, CreditCard, MessageSquare, Trash2 } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate, useLocation } from 'react-router-dom';
import { collection, query, getDocs, limit, where } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { Job, Artisan, Customer, Notification } from '../types';
import { cn } from '../utils';
import { SidePanel } from './SidePanel';
import { notificationService } from '../services/notificationService';

type SearchCategory = 'All' | 'Jobs' | 'Artisans' | 'Customers';

export function Topbar({ onMenuClick }: { onMenuClick: () => void }) {
  const [searchQuery, setSearchQuery] = React.useState('');
  const [isSearching, setIsSearching] = React.useState(false);
  const [searchCategory, setSearchCategory] = React.useState<SearchCategory>('All');
  const [results, setResults] = React.useState<{
    jobs: Job[];
    artisans: Artisan[];
    customers: Customer[];
  }>({ jobs: [], artisans: [], customers: [] });
  const [showResults, setShowResults] = React.useState(false);
  const [showNotifications, setShowNotifications] = React.useState(false);
  const [notifications, setNotifications] = React.useState<Notification[]>([]);
  const [toast, setToast] = React.useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const isSettingsPage = location.pathname.startsWith('/settings');

  React.useEffect(() => {
    if (auth.currentUser) {
      const unsub = notificationService.subscribeToNotifications(auth.currentUser.uid, (newNotifs) => {
        setNotifications(newNotifs);
      });
      return () => unsub();
    }
  }, []);

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
  };

  const handleSearch = async (queryStr: string) => {
    setSearchQuery(queryStr);
    if (queryStr.length < 2) {
      setResults({ jobs: [], artisans: [], customers: [] });
      setShowResults(false);
      return;
    }

    setIsSearching(true);
    try {
      // Check if user is an admin before searching all collections
      const adminDoc = await getDocs(query(collection(db, 'admins'), where('email', '==', auth.currentUser?.email), limit(1)));
      const isAdmin = !adminDoc.empty || 
                     auth.currentUser?.email === 'silas7korda@gmail.com' || 
                     auth.currentUser?.email === 'clasceth4traders@gmail.com';

      if (!isAdmin) {
        setResults({ jobs: [], artisans: [], customers: [] });
        return;
      }

      const [jobsSnap, artisansSnap, customersSnap] = await Promise.all([
        getDocs(query(collection(db, 'jobs'), limit(50))),
        getDocs(query(collection(db, 'artisans'), limit(50))),
        getDocs(query(collection(db, 'customers'), limit(50)))
      ]);

      const jobs = jobsSnap.docs.map(d => ({ id: d.id, ...d.data() } as Job));
      const artisans = artisansSnap.docs.map(d => ({ id: d.id, ...d.data() } as Artisan));
      const customers = customersSnap.docs.map(d => ({ id: d.id, ...d.data() } as Customer));

      const filteredJobs = jobs.filter(j => 
        j.id.toLowerCase().includes(queryStr.toLowerCase()) || 
        j.category.toLowerCase().includes(queryStr.toLowerCase())
      );
      const filteredArtisans = artisans.filter(a => 
        a.name.toLowerCase().includes(queryStr.toLowerCase()) ||
        a.category.toLowerCase().includes(queryStr.toLowerCase())
      );
      const filteredCustomers = customers.filter(c => 
        c.name.toLowerCase().includes(queryStr.toLowerCase()) ||
        c.phone.toLowerCase().includes(queryStr.toLowerCase())
      );

      setResults({
        jobs: filteredJobs,
        artisans: filteredArtisans,
        customers: filteredCustomers
      });
      setShowResults(true);
    } catch (error) {
      console.error("Search failed", error);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSelect = (path: string) => {
    navigate(path);
    setSearchQuery('');
    setShowResults(false);
  };

  const filteredResults = {
    jobs: searchCategory === 'All' || searchCategory === 'Jobs' ? results.jobs : [],
    artisans: searchCategory === 'All' || searchCategory === 'Artisans' ? results.artisans : [],
    customers: searchCategory === 'All' || searchCategory === 'Customers' ? results.customers : []
  };

  const hasResults = filteredResults.jobs.length > 0 || filteredResults.artisans.length > 0 || filteredResults.customers.length > 0;

  return (
    <header className={cn(
      "h-16 backdrop-blur-xl px-4 lg:px-6 flex items-center justify-between sticky top-0 z-30 border-b border-white/5",
      "bg-bg-dark/80"
    )}>
      <div className="flex items-center gap-3 flex-1 max-w-3xl mx-auto relative">
        <button 
          onClick={onMenuClick}
          className="lg:hidden p-1.5 text-white/60 hover:text-white transition-colors"
        >
          <Menu size={20} />
        </button>
        
        <div className="relative w-full group">
          <div className="absolute left-5 top-1/2 -translate-y-1/2 flex items-center gap-2.5">
            <Search className="text-white/20 group-focus-within:text-accent-blue transition-colors" size={18} />
            <div className="h-3.5 w-[1px] bg-white/10 hidden md:block" />
            <select
              value={searchCategory}
              onChange={(e) => setSearchCategory(e.target.value as SearchCategory)}
              className="hidden md:block bg-transparent text-[9px] font-bold text-white/40 uppercase tracking-widest outline-none cursor-pointer hover:text-white transition-colors"
            >
              <option value="All" className="bg-bg-dark">All</option>
              <option value="Jobs" className="bg-bg-dark">Jobs</option>
              <option value="Artisans" className="bg-bg-dark">Artisans</option>
              <option value="Customers" className="bg-bg-dark">Customers</option>
            </select>
          </div>
          
          <input 
            type="text" 
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            onFocus={() => searchQuery.length >= 2 && setShowResults(true)}
            placeholder={`Search ${searchCategory === 'All' ? 'anything' : searchCategory.toLowerCase()}...`}
            className="w-full pl-12 md:pl-36 pr-10 py-2.5 bg-white/5 border border-white/10 rounded-full text-[16px] font-medium transition-all outline-none text-white placeholder:text-white/20 focus:bg-white/10 focus:ring-4 focus:ring-accent-blue/10 focus:border-accent-blue/20 shadow-xl shadow-black/50"
          />
          
          {searchQuery && (
            <button 
              onClick={() => { setSearchQuery(''); setShowResults(false); }}
              className="absolute right-5 top-1/2 -translate-y-1/2 text-white/20 hover:text-white transition-colors"
            >
              <X size={16} />
            </button>
          )}
        </div>

        <AnimatePresence>
          {showResults && (
            <>
              <div 
                className="fixed inset-0 z-[-1]" 
                onClick={() => setShowResults(false)}
              />
              <motion.div
                initial={{ opacity: 0, y: 10, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 10, scale: 0.98 }}
                className="absolute top-full left-0 right-0 mt-4 bg-bg-panel border border-white/10 rounded-[32px] shadow-2xl overflow-hidden z-50 p-2"
              >
                {/* Search Filters */}
                <div className="flex items-center gap-2 p-2 border-b border-white/5 mb-2">
                  {(['All', 'Jobs', 'Artisans', 'Customers'] as SearchCategory[]).map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setSearchCategory(cat)}
                      className={cn(
                        "px-4 py-2 rounded-full text-[12px] font-bold transition-all",
                        searchCategory === cat 
                          ? "bg-accent-blue text-white shadow-lg shadow-blue-500/20" 
                          : "text-white/40 hover:text-white hover:bg-white/5"
                      )}
                    >
                      {cat}
                    </button>
                  ))}
                </div>

                <div className="max-h-[500px] overflow-y-auto custom-scrollbar p-2">
                  {filteredResults.jobs.length > 0 && (
                    <div className="mb-6">
                      <p className="px-4 py-2 text-[10px] font-bold text-white/20 uppercase tracking-[0.2em]">Jobs</p>
                      <div className="grid grid-cols-1 gap-1">
                        {filteredResults.jobs.slice(0, 5).map(job => (
                          <button
                            key={job.id}
                            onClick={() => handleSelect('/jobs')}
                            className="w-full flex items-center gap-4 px-4 py-3 hover:bg-white/5 rounded-2xl transition-all text-left group"
                          >
                            <div className="w-10 h-10 bg-accent-blue/10 text-accent-blue rounded-xl flex items-center justify-center shrink-0 border border-accent-blue/10">
                              <Briefcase size={18} />
                            </div>
                            <div className="min-w-0">
                              <p className="text-[14px] font-bold text-white truncate group-hover:text-accent-blue transition-colors">{job.id}</p>
                              <p className="text-[11px] text-white/40 truncate uppercase tracking-wider">{job.category}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {filteredResults.artisans.length > 0 && (
                    <div className="mb-6">
                      <p className="px-4 py-2 text-[10px] font-bold text-white/20 uppercase tracking-[0.2em]">Artisans</p>
                      <div className="grid grid-cols-1 gap-1">
                        {filteredResults.artisans.slice(0, 5).map(artisan => (
                          <button
                            key={artisan.id}
                            onClick={() => handleSelect('/artisans')}
                            className="w-full flex items-center gap-4 px-4 py-3 hover:bg-white/5 rounded-2xl transition-all text-left group"
                          >
                            <div className="w-10 h-10 rounded-xl bg-accent-purple/10 text-accent-purple border border-accent-purple/10 flex items-center justify-center font-bold text-sm shrink-0">
                              {artisan.name[0]}
                            </div>
                            <div className="min-w-0">
                              <p className="text-[14px] font-bold text-white truncate group-hover:text-accent-blue transition-colors">{artisan.name}</p>
                              <p className="text-[11px] text-white/40 truncate uppercase tracking-wider">{artisan.category} • {artisan.rating} ★</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {filteredResults.customers.length > 0 && (
                    <div className="mb-6">
                      <p className="px-4 py-2 text-[10px] font-bold text-white/20 uppercase tracking-[0.2em]">Customers</p>
                      <div className="grid grid-cols-1 gap-1">
                        {filteredResults.customers.slice(0, 5).map(customer => (
                          <button
                            key={customer.id}
                            onClick={() => handleSelect('/customers')}
                            className="w-full flex items-center gap-4 px-4 py-3 hover:bg-white/5 rounded-2xl transition-all text-left group"
                          >
                            <div className="w-10 h-10 bg-accent-green/10 text-accent-green rounded-xl flex items-center justify-center shrink-0 border border-accent-green/10">
                              <User size={18} />
                            </div>
                            <div className="min-w-0">
                              <p className="text-[14px] font-bold text-white truncate group-hover:text-accent-blue transition-colors">{customer.name}</p>
                              <p className="text-[11px] text-white/40 truncate uppercase tracking-wider">{customer.phone}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {!hasResults && (
                    <div className="p-12 text-center">
                      <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
                        <Search size={24} className="text-white/20" />
                      </div>
                      <p className="text-sm text-white/40">No results found for "{searchQuery}" in {searchCategory}</p>
                    </div>
                  )}
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      <div className="flex items-center gap-3">
        <button 
          onClick={() => setShowNotifications(true)}
          className="relative w-10 h-10 flex items-center justify-center bg-white/5 text-white/60 hover:text-white rounded-full transition-all border border-white/5 hover:bg-white/10"
        >
          <Bell size={20} />
          {notifications.some(n => !n.read) && (
            <span className="absolute top-2.5 right-2.5 w-2 h-2 bg-accent-orange rounded-full border-2 border-bg-dark"></span>
          )}
        </button>

        <button 
          onClick={() => navigate('/profile')}
          className={cn(
            "w-10 h-10 flex items-center justify-center bg-white/5 text-white/60 hover:text-white rounded-full transition-all border border-white/5 hover:bg-white/10 overflow-hidden",
            location.pathname === '/profile' && "border-accent-blue/50 bg-accent-blue/10 text-accent-blue"
          )}
        >
          {auth.currentUser?.photoURL ? (
            <img src={auth.currentUser.photoURL} alt="Profile" className="w-full h-full object-cover" />
          ) : (
            <User size={20} />
          )}
        </button>
      </div>

      <SidePanel
        isOpen={showNotifications}
        onClose={() => setShowNotifications(false)}
        title="Notifications"
        className="bg-bg-panel"
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between mb-4">
            <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest">{notifications.filter(n => !n.read).length} Unread</span>
            <div className="flex items-center gap-4">
              <button 
                onClick={() => auth.currentUser && notificationService.markAllAsRead(auth.currentUser.uid, notifications)}
                className="text-[10px] font-bold text-accent-blue uppercase tracking-widest hover:text-blue-400 transition-colors"
              >
                Mark all as read
              </button>
              <button 
                onClick={() => notificationService.clearAll(notifications)}
                className="text-[10px] font-bold text-red-500 uppercase tracking-widest hover:text-red-400 transition-colors"
              >
                Clear All
              </button>
            </div>
          </div>
          {notifications.length > 0 ? (
            notifications.map((notif) => {
              const { icon: Icon, color, bg } = getNotificationIcon(notif.category, notif.type);
              return (
                <div 
                  key={notif.id}
                  onClick={() => {
                    notificationService.markAsRead(notif.id);
                    if (notif.link) navigate(notif.link);
                  }}
                  className={cn(
                    "group p-5 bg-white/5 border border-white/5 rounded-3xl hover:bg-white/10 transition-all cursor-pointer relative overflow-hidden",
                    !notif.read && "bg-white/[0.08] border-white/10"
                  )}
                >
                  {!notif.read && (
                    <div className="absolute top-0 left-0 w-1 h-full bg-accent-blue" />
                  )}
                  <div className="flex gap-3">
                    <div className={cn(
                      "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 transition-transform group-hover:scale-110",
                      bg,
                      color
                    )}>
                      <Icon size={18} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <h5 className="text-[13px] font-bold text-white truncate">{notif.title}</h5>
                        <span className="text-[9px] font-bold text-white/20 uppercase tracking-widest shrink-0">{formatTime(notif.createdAt)}</span>
                      </div>
                      <p className="text-[12px] text-white/40 leading-relaxed">{notif.message}</p>
                    </div>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        notificationService.deleteNotification(notif.id);
                      }}
                      className="opacity-0 group-hover:opacity-100 p-2 text-white/20 hover:text-red-500 transition-all shrink-0"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })
          ) : (
            <div className="py-20 text-center">
              <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
                <Bell size={24} className="text-white/20" />
              </div>
              <p className="text-sm text-white/40">No notifications yet</p>
            </div>
          )}
          {notifications.length > 0 && (
            <button className="w-full py-5 text-[11px] font-bold text-white/20 uppercase tracking-[0.2em] hover:text-white transition-colors border-t border-white/5 mt-6">
              View All Notifications
            </button>
          )}
        </div>
      </SidePanel>
      
      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className={cn(
              "fixed bottom-8 left-1/2 z-50 px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-4 min-w-[320px] backdrop-blur-xl",
              toast.type === 'success' ? "bg-bg-panel text-white border border-white/10" : "bg-red-600 text-white"
            )}
          >
            <div className={cn(
              "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
              toast.type === 'success' ? "bg-accent-green/20 text-accent-green" : "bg-white/20 text-white"
            )}>
              {toast.type === 'success' ? <CheckCircle size={16} /> : <AlertTriangle size={16} />}
            </div>
            <span className="text-sm font-bold">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
