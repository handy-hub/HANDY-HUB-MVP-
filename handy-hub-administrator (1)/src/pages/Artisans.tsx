import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Filter, Download, Star, MoreVertical, CheckCircle, XCircle, AlertCircle, ShieldCheck, FileText, Eye, Lock, Briefcase, ShieldAlert, Zap, X, History, UserX, UserCheck, User, MapPin, MessageSquare, Trash2 } from 'lucide-react';
import { collection, onSnapshot, query, where, doc, updateDoc, addDoc, serverTimestamp, orderBy, limit, getDoc, Timestamp, deleteDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { notificationService } from '../services/notificationService';
import { Artisan, Job, AuditLog, AdminUser } from '../types';
import { cn, formatCurrency, formatDate } from '../utils';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { TableSkeleton } from '../components/Skeleton';
import { ConfirmModal } from '../components/ConfirmModal';

export function Artisans() {
  const [artisans, setArtisans] = useState<Artisan[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedArtisan, setSelectedArtisan] = useState<Artisan | null>(null);
  const [recentJobs, setRecentJobs] = useState<Job[]>([]);
  const [artisanAudits, setArtisanAudits] = useState<any[]>([]);
  const [loadingAudits, setLoadingAudits] = useState(false);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [currentUserData, setCurrentUserData] = useState<AdminUser | null>(null);
  const [activeTab, setActiveTab] = useState<'details' | 'jobs' | 'audits'>('details');
  const [isNotificationModalOpen, setIsNotificationModalOpen] = useState(false);
  const [notiTitle, setNotiTitle] = useState('');
  const [notiMessage, setNotiMessage] = useState('');
  const [notiType, setNotiType] = useState<'info' | 'success' | 'warning' | 'error'>('info');
  const [sendingNoti, setSendingNoti] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{
    isOpen: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
    variant: 'danger' | 'warning' | 'info';
  }>({
    isOpen: false,
    title: '',
    message: '',
    onConfirm: () => {},
    variant: 'danger'
  });

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'artisans'), (snap) => {
      setArtisans(snap.docs.map(d => ({ id: d.id, ...d.data() } as Artisan)));
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'artisans');
    });

    // Fetch current admin data
    const fetchAdmin = async () => {
      if (auth.currentUser) {
        const adminDoc = await getDoc(doc(db, 'admins', auth.currentUser.uid));
        if (adminDoc.exists()) {
          setCurrentUserData({ id: auth.currentUser.uid, ...adminDoc.data() } as AdminUser);
        }
      }
    };
    fetchAdmin();

    return () => unsub();
  }, []);

  useEffect(() => {
    if (!selectedArtisan) {
      setRecentJobs([]);
      setArtisanAudits([]);
      setActiveTab('details');
      return;
    }

    setLoadingJobs(true);
    const jobsQ = query(
      collection(db, 'jobs'),
      where('artisanId', '==', selectedArtisan.id),
      orderBy('createdAt', 'desc'),
      limit(10)
    );

    const unsubJobs = onSnapshot(jobsQ, (snap) => {
      setRecentJobs(snap.docs.map(d => ({ id: d.id, ...d.data() } as Job)));
      setLoadingJobs(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'jobs');
      setLoadingJobs(false);
    });

    setLoadingAudits(true);
    const auditsQ = query(
      collection(db, 'audit_logs'),
      where('targetId', '==', selectedArtisan.id),
      orderBy('timestamp', 'desc'),
      limit(20)
    );

    const unsubAudits = onSnapshot(auditsQ, (snap) => {
      setArtisanAudits(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoadingAudits(false);
    }, (error) => {
      console.error("Failed to fetch audits", error);
      setLoadingAudits(false);
    });

    return () => {
      unsubJobs();
      unsubAudits();
    };
  }, [selectedArtisan]);

  const handleStatusUpdate = async (artisanId: string, newStatus: string) => {
    const statusValue = newStatus.toLowerCase();
    
    if (statusValue === 'banned') {
      setConfirmModal({
        isOpen: true,
        title: 'Ban Artisan',
        message: 'Are you sure you want to BAN this artisan? This will block their access to the platform.',
        variant: 'danger',
        onConfirm: () => performStatusUpdate(artisanId, statusValue)
      });
      return;
    }

    performStatusUpdate(artisanId, statusValue);
  };

  const performStatusUpdate = async (artisanId: string, statusValue: string) => {
    try {
      const artisanRef = doc(db, 'artisans', artisanId);
      const artisanDoc = await getDoc(artisanRef);
      const oldStatus = artisanDoc.exists() ? artisanDoc.data().status : 'unknown';

      await updateDoc(artisanRef, { 
        status: statusValue,
        updatedAt: new Date().toISOString()
      });
      
      // Log the action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: currentUserData?.name || 'Unknown Admin',
        action: 'ARTISAN_STATUS_UPDATE',
        target: `Artisan: ${artisanId}`,
        targetId: artisanId,
        targetType: 'artisan',
        details: `Changed status from ${oldStatus} to ${statusValue}`,
        timestamp: new Date().toISOString(),
        ip: 'Internal'
      });

      showToast(`Artisan status updated to ${statusValue}`, 'success');
      if (selectedArtisan?.id === artisanId) {
        setSelectedArtisan(prev => prev ? { ...prev, status: statusValue as any } : null);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `artisans/${artisanId}`);
      showToast("Failed to update status", "error");
    } finally {
      setConfirmModal(prev => ({ ...prev, isOpen: false }));
    }
  };

  const isSuperAdminUser = currentUserData?.role === 'super_admin' || 
    (auth.currentUser?.email && [
      'silas7korda@gmail.com',
      'clasceth4traders@gmail.com',
      'paakumisam@gmail.com'
    ].includes(auth.currentUser.email.toLowerCase())) || false;

  const handleDeleteArtisan = async (artisanId: string) => {
    setConfirmModal({
      isOpen: true,
      title: 'Delete Artisan Permanently',
      message: `Are you sure you want to PERMANENTLY DELETE this artisan's account? All profile details, settings, and documents will be permanently erased. This action is irreversible!`,
      variant: 'danger',
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, 'artisans', artisanId));
          
          await addDoc(collection(db, 'audit_logs'), {
            adminId: auth.currentUser?.uid,
            adminName: currentUserData?.name || 'Unknown Admin',
            action: 'ARTISAN_ACCOUNT_DELETE',
            target: `Artisan: ${artisanId}`,
            targetId: artisanId,
            targetType: 'artisan',
            details: `Permanently deleted artisan profile of ${selectedArtisan?.name || artisanId}`,
            timestamp: new Date().toISOString(),
            ip: 'Internal'
          });
          
          showToast(`Artisan permanently deleted successfully.`, 'success');
          setSelectedArtisan(null);
        } catch (error: any) {
          console.error("Deletion failed:", error);
          showToast(`Failed to delete artisan: ${error.message}`, 'error');
        } finally {
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      }
    });
  };

  if (loading) return <TableSkeleton />;

  const filteredArtisans = artisans.filter(a => {
    const matchesFilter = filter === 'All' || a.status.toLowerCase() === filter.toLowerCase();
    const matchesSearch = a.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
                         a.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
                         a.category.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  const pendingCount = artisans.filter(a => a.status === 'pending').length;

  if (loading) return (
    <div className="p-8 bg-bg-dark min-h-screen">
      <TableSkeleton />
    </div>
  );

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-6 pb-8 screen-container p-6 bg-bg-dark min-h-screen"
    >
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-white/5 pb-6">
        <div>
          <p className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] mb-1.5">Management // Registry</p>
          <h2 className="text-[17px] font-bold text-white tracking-tight">Artisan Network</h2>
          <p className="text-[13px] text-white/40 mt-0.5 font-medium">
            <span className="text-accent-blue font-bold">{artisans.length}</span> verified artisans active across the platform.
          </p>
        </div>
        <div className="flex gap-4">
          <button 
            onClick={() => showToast('Artisan registry exported', 'success')}
            className="px-6 py-2.5 bg-white/5 border border-white/10 rounded-xl text-[10px] font-bold text-white/60 hover:text-white hover:border-white/20 transition-all flex items-center gap-2 uppercase tracking-widest shadow-sm group"
          >
            <Download size={14} className="group-hover:translate-y-0.5 transition-transform" /> Export Data
          </button>
        </div>
      </div>

      {pendingCount > 0 && (
        <motion.div 
          initial={{ scale: 0.98, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="bg-accent-orange/10 border border-accent-orange/20 rounded-2xl p-8 flex flex-col md:flex-row items-center justify-between gap-8 relative overflow-hidden group"
        >
          <div className="absolute top-0 left-0 w-1.5 h-full bg-accent-orange" />
          <div className="flex items-center gap-8 relative z-10">
            <div className="w-16 h-16 bg-bg-panel text-accent-orange rounded-2xl flex items-center justify-center border border-accent-orange/20 shadow-xl group-hover:scale-105 transition-transform">
              <Zap size={32} className="animate-pulse" />
            </div>
            <div>
              <h3 className="font-bold text-white text-xl tracking-tight">{pendingCount} Verification Requests</h3>
              <p className="text-sm text-white/40 font-medium mt-1">New artisans awaiting profile verification.</p>
            </div>
          </div>
          <button 
            onClick={() => setFilter('Pending')}
            className="px-8 py-3.5 bg-accent-orange text-white text-[10px] font-bold rounded-xl hover:bg-orange-600 transition-all shadow-lg shadow-orange-500/20 uppercase tracking-widest relative z-10"
          >
            Review Applications
          </button>
        </motion.div>
      )}

      <div className="bg-bg-panel rounded-3xl border border-white/5 shadow-xl overflow-hidden">
        <div className="p-6 border-b border-white/5 bg-white/[0.02] flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-center gap-2 overflow-x-auto pb-2 lg:pb-0 scrollbar-hide">
            {['All', 'Active', 'Pending', 'Suspended', 'Banned'].map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "px-6 py-2 rounded-xl text-[10px] font-bold transition-all whitespace-nowrap uppercase tracking-widest border",
                  filter === f 
                    ? "bg-white text-black border-white shadow-lg shadow-white/10" 
                    : "bg-white/5 text-white/40 border-white/10 hover:bg-white/10 hover:text-white"
                )}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="relative group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40 group-focus-within:text-accent-blue transition-colors" size={16} />
            <input 
              type="text" 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by ID, name or category..." 
              className="pl-12 pr-4 py-2.5 bg-white/5 border border-white/10 focus:border-accent-blue/50 rounded-2xl text-sm transition-all outline-none w-full lg:w-80 text-white placeholder:text-white/40"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-white/[0.02]">
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Artisan Node</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Specialization</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest text-center">Trust Index</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest text-center">Output</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Net Value</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Status</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest text-right">Vault</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filteredArtisans.map((artisan) => (
                <tr key={artisan.id} className="group hover:bg-white/[0.02] transition-colors">
                  <td className="px-6 py-5">
                    <div className="flex items-center gap-4">
                      <div className="relative">
                        <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-white/20 font-bold text-lg border border-white/5 group-hover:border-accent-blue/30 transition-colors shadow-inner">
                          {artisan.name[0]}
                        </div>
                        {artisan.status === 'active' && (
                          <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-accent-green rounded-full border-2 border-bg-panel flex items-center justify-center text-white shadow-lg">
                            <ShieldCheck size={8} />
                          </div>
                        )}
                      </div>
                      <div>
                        <p className="text-sm font-bold text-white group-hover:text-accent-blue transition-colors tracking-tight">{artisan.name}</p>
                        <p className="text-[9px] text-white/20 font-bold uppercase tracking-widest mt-0.5 opacity-60">{artisan.id}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-5">
                    <span className="px-3 py-1 bg-white/5 text-white/60 text-[9px] font-bold rounded-lg border border-white/5 uppercase tracking-widest shadow-sm">
                      {artisan.category}
                    </span>
                  </td>
                  <td className="px-6 py-5">
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="flex items-center gap-1">
                        <Star size={10} className="fill-accent-orange text-accent-orange" />
                        <span className="text-xs font-bold text-white">{artisan.rating.toFixed(1)}</span>
                      </div>
                      <div className="w-16 h-1 bg-white/5 rounded-full overflow-hidden border border-white/5">
                        <div className="h-full bg-accent-orange shadow-[0_0_8px_rgba(245,158,11,0.5)]" style={{ width: `${(artisan.rating / 5) * 100}%` }}></div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-5 text-center">
                    <p className="text-sm font-bold text-white">{artisan.jobs_completed}</p>
                    <p className="text-[9px] text-white/20 font-bold uppercase tracking-widest mt-0.5 opacity-60">Units</p>
                  </td>
                  <td className="px-6 py-5">
                    <p className="text-sm font-bold text-accent-green">{formatCurrency(artisan.earnings)}</p>
                    <p className="text-[9px] text-white/20 font-bold uppercase tracking-widest mt-0.5 opacity-60">Cumulative</p>
                  </td>
                  <td className="px-6 py-5">
                    <span className={cn(
                      "px-3 py-1 text-[8px] font-bold rounded-lg inline-flex items-center gap-2 uppercase tracking-[0.15em] border shadow-sm",
                      artisan.status === 'active' ? "bg-accent-green/10 text-accent-green border-accent-green/20" :
                      artisan.status === 'pending' ? "bg-accent-orange/10 text-accent-orange border-accent-orange/20" :
                      "bg-red-500/10 text-red-500 border-red-500/20"
                    )}>
                      <span className={cn(
                        "w-1 h-1 rounded-full animate-pulse",
                        artisan.status === 'active' ? "bg-accent-green" :
                        artisan.status === 'pending' ? "bg-accent-orange" :
                        "bg-red-500"
                      )}></span>
                      {artisan.status}
                    </span>
                  </td>
                  <td className="px-6 py-5 text-right">
                    <button 
                      onClick={() => setSelectedArtisan(artisan)}
                      className="p-2.5 bg-white/5 text-white/40 hover:text-accent-blue hover:bg-accent-blue/10 rounded-xl transition-all border border-white/10 hover:border-accent-blue/20 shadow-sm"
                    >
                      <Eye size={18} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Artisan Profile Modal */}
      <AnimatePresence>
        {selectedArtisan && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedArtisan(null)}
              className="absolute inset-0 bg-bg-dark/80 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 30 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 30 }}
              className="bg-bg-panel w-full max-w-5xl relative z-10 overflow-hidden rounded-[40px] border border-white/10 shadow-2xl flex flex-col max-h-[90vh]"
            >
              <div className="p-10 border-b border-white/5 flex items-center justify-between bg-white/5 relative overflow-hidden">
                <div className="flex items-center gap-8">
                  <div className="relative">
                    <div className="w-24 h-24 rounded-[32px] bg-accent-blue/10 text-accent-blue flex items-center justify-center text-4xl font-black border border-accent-blue/20 shadow-2xl">
                      {selectedArtisan.name[0]}
                    </div>
                    <div className="absolute -bottom-1 -right-1 w-10 h-10 bg-bg-panel rounded-full border border-white/10 flex items-center justify-center text-accent-green shadow-xl">
                      <ShieldCheck size={24} />
                    </div>
                  </div>
                  <div>
                    <h3 className="text-4xl font-bold text-white tracking-tight">{selectedArtisan.name}</h3>
                    <p className="text-[10px] font-bold text-white/20 uppercase tracking-[0.3em] mt-3 flex items-center gap-3">
                      <span className="w-2 h-2 rounded-full bg-accent-blue shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
                      Artisan Profile // {selectedArtisan.id}
                    </p>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedArtisan(null)}
                  className="p-5 text-white/20 hover:text-white transition-all bg-white/5 rounded-[24px] border border-white/10 hover:border-white/20 group shadow-xl"
                >
                  <X size={24} className="group-hover:rotate-90 transition-transform duration-300" />
                </button>
              </div>

              <div className="flex-1 overflow-hidden flex flex-col">
                {/* Tabs Navigation */}
                <div className="px-10 pt-6 border-b border-white/5 flex gap-8">
                  {[
                    { id: 'details', label: 'Overview', icon: User },
                    { id: 'jobs', label: 'Job History', icon: Briefcase },
                    { id: 'audits', label: 'Activity Log', icon: History },
                  ].map((tab) => (
                    <button
                      key={tab.id}
                      onClick={() => setActiveTab(tab.id as any)}
                      className={cn(
                        "pb-4 text-[10px] font-bold uppercase tracking-widest flex items-center gap-2 transition-all relative",
                        activeTab === tab.id ? "text-white" : "text-white/20 hover:text-white/40"
                      )}
                    >
                      <tab.icon size={14} />
                      {tab.label}
                      {activeTab === tab.id && (
                        <motion.div layoutId="activeTab" className="absolute bottom-0 left-0 right-0 h-0.5 bg-accent-blue shadow-[0_0_10px_rgba(59,130,246,0.5)]" />
                      )}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-y-auto p-10 custom-scrollbar">
                  <AnimatePresence mode="wait">
                    {activeTab === 'details' && (
                      <motion.div
                        key="details"
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                        className="grid grid-cols-1 lg:grid-cols-12 gap-10"
                      >
                        <div className="lg:col-span-8 space-y-10">
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                            <div className="p-8 bg-white/5 border border-white/5 rounded-3xl group hover:border-white/10 transition-colors shadow-inner">
                              <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-4">Email Address</p>
                              <p className="text-sm font-bold text-white tracking-tight flex items-center gap-3">
                                <Zap size={16} className="text-accent-blue" />
                                {selectedArtisan.email}
                              </p>
                            </div>
                            <div className="p-8 bg-white/5 border border-white/5 rounded-3xl group hover:border-white/10 transition-colors shadow-inner">
                              <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-4">Phone Number</p>
                              <p className="text-sm font-bold text-white tracking-tight flex items-center gap-3">
                                <Zap size={16} className="text-accent-green" />
                                {selectedArtisan.phone}
                              </p>
                            </div>
                          </div>

                          <div className="space-y-6">
                            <div className="flex items-center justify-between">
                              <h4 className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Verification Documents</h4>
                              <span className="text-[9px] font-bold text-white/10">{selectedArtisan.documents?.length || 0} FILES</span>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                              {selectedArtisan.documents && selectedArtisan.documents.length > 0 ? (
                                selectedArtisan.documents.map((doc, i) => (
                                  <div 
                                    key={i} 
                                    onClick={() => window.open(doc.url, '_blank')}
                                    className="p-6 bg-white/5 border border-white/5 rounded-2xl flex items-center justify-between group hover:bg-white/10 transition-all cursor-pointer relative overflow-hidden shadow-inner"
                                  >
                                    <div className="flex items-center gap-5 relative z-10">
                                      <div className="w-12 h-12 bg-bg-dark rounded-xl flex items-center justify-center text-white/20 group-hover:text-accent-blue transition-colors border border-white/5">
                                        <FileText size={20} />
                                      </div>
                                      <div>
                                        <p className="text-xs font-bold text-white tracking-tight">{doc.type}</p>
                                        <p className="text-[9px] text-white/20 uppercase mt-1.5">{formatDate(doc.uploadedAt)}</p>
                                      </div>
                                    </div>
                                    <div className="flex flex-col items-end gap-2 relative z-10">
                                      <Eye size={16} className="text-white/10 group-hover:text-white/40 transition-colors" />
                                      <span className={cn(
                                        "text-[7px] font-bold px-2 py-0.5 rounded-md border",
                                        doc.status === 'verified' ? "text-accent-green border-accent-green/20 bg-accent-green/10" : 
                                        doc.status === 'pending' ? "text-accent-orange border-accent-orange/20 bg-accent-orange/10" :
                                        "text-red-500 border-red-500/20 bg-red-500/10"
                                      )}>{doc.status.toUpperCase()}</span>
                                    </div>
                                  </div>
                                ))
                              ) : (
                                <div className="col-span-2 p-12 bg-white/5 border border-dashed border-white/10 rounded-3xl text-center">
                                  <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">No documents uploaded</p>
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="p-8 bg-white/5 border border-white/5 rounded-3xl shadow-inner">
                            <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-4">Bio / Description</p>
                            <p className="text-sm text-white/60 leading-relaxed italic">
                              {selectedArtisan.bio || "No biography provided by this artisan."}
                            </p>
                          </div>
                        </div>

                        <div className="lg:col-span-4 space-y-8">
                          <div className="p-8 bg-white/5 border border-white/5 rounded-3xl relative overflow-hidden group shadow-inner">
                            <h4 className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-8">Performance Metrics</h4>
                            <div className="space-y-6">
                              {[
                                { label: 'RATING', status: selectedArtisan.rating.toFixed(1), color: 'text-accent-orange' },
                                { label: 'JOBS COMPLETED', status: selectedArtisan.jobs_completed, color: 'text-white' },
                                { label: 'TOTAL EARNINGS', status: formatCurrency(selectedArtisan.earnings), color: 'text-accent-green' },
                                { label: 'JOINED', status: formatDate(selectedArtisan.joined), color: 'text-white/40' },
                              ].map((metric, i) => (
                                <div key={i} className="flex items-center justify-between border-b border-white/5 pb-4">
                                  <span className="text-[10px] text-white/20 font-bold tracking-wider">{metric.label}</span>
                                  <span className={cn("text-[11px] font-bold uppercase", metric.color)}>{metric.status}</span>
                                </div>
                              ))}
                            </div>
                            <div className="mt-10">
                              <p className="text-[9px] font-bold text-white/20 uppercase tracking-widest mb-2">Primary Region</p>
                              <p className="text-sm text-white font-bold tracking-tight flex items-center gap-3">
                                <MapPin size={14} className="text-accent-green" />
                                {selectedArtisan.region}
                              </p>
                            </div>
                          </div>

                          <div className="flex flex-col gap-4">
                            <button 
                              onClick={() => setIsNotificationModalOpen(true)}
                              className="w-full py-5 bg-accent-blue/10 hover:bg-accent-blue/20 text-accent-blue border border-accent-blue/20 text-[10px] font-bold rounded-2xl transition-all uppercase tracking-widest flex items-center justify-center gap-2 shadow-sm"
                            >
                              <MessageSquare size={16} /> Send Notification
                            </button>

                            {selectedArtisan.status === 'pending' && (
                              <button 
                                onClick={() => handleStatusUpdate(selectedArtisan.id, 'active')}
                                className="w-full py-5 bg-accent-green text-white text-[10px] font-bold rounded-2xl hover:bg-emerald-600 transition-all shadow-lg shadow-emerald-500/20 uppercase tracking-widest flex items-center justify-center gap-2"
                              >
                                <CheckCircle size={16} /> Approve Artisan
                              </button>
                            )}
                            {selectedArtisan.status === 'active' && (
                              <button 
                                onClick={() => handleStatusUpdate(selectedArtisan.id, 'suspended')}
                                className="w-full py-5 bg-accent-orange text-white text-[10px] font-bold rounded-2xl hover:bg-orange-600 transition-all shadow-lg shadow-orange-500/20 uppercase tracking-widest flex items-center justify-center gap-2"
                              >
                                <Lock size={16} /> Suspend Account
                              </button>
                            )}
                            {selectedArtisan.status === 'suspended' && (
                              <button 
                                onClick={() => handleStatusUpdate(selectedArtisan.id, 'active')}
                                className="w-full py-5 bg-accent-blue text-white text-[10px] font-bold rounded-2xl hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20 uppercase tracking-widest flex items-center justify-center gap-2"
                              >
                                <UserCheck size={16} /> Activate Account
                              </button>
                            )}
                            {selectedArtisan.status !== 'banned' ? (
                              <button 
                                onClick={() => handleStatusUpdate(selectedArtisan.id, 'banned')}
                                className="w-full py-5 bg-white/5 text-red-500 border border-red-500/20 text-[10px] font-bold rounded-2xl hover:bg-red-500/10 transition-all uppercase tracking-widest flex items-center justify-center gap-2"
                              >
                                <UserX size={16} /> Ban Account
                              </button>
                            ) : (
                              <button 
                                onClick={() => handleStatusUpdate(selectedArtisan.id, 'active')}
                                className="w-full py-5 bg-accent-blue text-white text-[10px] font-bold rounded-2xl hover:bg-blue-600 transition-all uppercase tracking-widest shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2"
                              >
                                <ShieldCheck size={16} /> Unban & Activate
                              </button>
                            )}

                            {isSuperAdminUser && (
                              <button 
                                onClick={() => handleDeleteArtisan(selectedArtisan.id)}
                                className="w-full py-5 bg-red-600/10 hover:bg-red-600 text-red-500 hover:text-white border border-red-600/20 text-[10px] font-bold rounded-2xl transition-all uppercase tracking-widest flex items-center justify-center gap-2 shadow-inner"
                              >
                                <Trash2 size={16} /> Delete Account
                              </button>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    )}

                    {activeTab === 'jobs' && (
                      <motion.div
                        key="jobs"
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                        className="space-y-6"
                      >
                        <div className="bg-white/5 border border-white/5 rounded-3xl overflow-hidden shadow-inner">
                          {loadingJobs ? (
                            <div className="p-20 flex flex-col items-center gap-4">
                              <div className="w-10 h-10 border-2 border-white/5 border-t-accent-blue rounded-full animate-spin"></div>
                              <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Loading Job History...</p>
                            </div>
                          ) : recentJobs.length > 0 ? (
                            <div className="divide-y divide-white/5">
                              {recentJobs.map((job) => (
                                <div key={job.id} className="p-8 flex items-center justify-between hover:bg-white/5 transition-all group relative">
                                  <div className="flex items-center gap-6">
                                    <div className="w-14 h-14 bg-bg-dark rounded-2xl flex items-center justify-center text-white/20 border border-white/5 group-hover:text-accent-blue group-hover:border-accent-blue/20 transition-all shadow-inner">
                                      <Briefcase size={24} />
                                    </div>
                                    <div>
                                      <p className="text-sm font-bold text-white tracking-tight">{job.category}</p>
                                      <div className="flex items-center gap-3 mt-1.5">
                                        <p className="text-[9px] text-white/20 uppercase tracking-widest">{job.id}</p>
                                        <div className="w-1 h-1 bg-white/10 rounded-full" />
                                        <p className="text-[9px] text-white/20 uppercase tracking-widest">{formatDate(job.createdAt)}</p>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-right flex flex-col items-end gap-3">
                                    <span className={cn(
                                      "px-3 py-1 text-[8px] font-bold rounded-lg inline-flex items-center gap-2 uppercase tracking-wider border",
                                      job.status === 'Completed' ? "bg-accent-green/10 text-accent-green border-accent-green/20" :
                                      job.status === 'Cancelled' ? "bg-red-500/10 text-red-500 border-red-500/20" :
                                      "bg-accent-blue/10 text-accent-blue border-accent-blue/20"
                                    )}>
                                      {job.status}
                                    </span>
                                    <p className="text-sm font-bold text-white">{formatCurrency(job.amount)}</p>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="p-32 text-center">
                              <ShieldAlert size={64} className="mx-auto text-white/5 mb-6" />
                              <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">No Job History Found</p>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}

                    {activeTab === 'audits' && (
                      <motion.div
                        key="audits"
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: 20 }}
                        className="space-y-6"
                      >
                        <div className="bg-white/5 border border-white/5 rounded-3xl overflow-hidden shadow-inner">
                          {loadingAudits ? (
                            <div className="p-20 flex flex-col items-center gap-4">
                              <div className="w-10 h-10 border-2 border-white/5 border-t-accent-blue rounded-full animate-spin"></div>
                              <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Loading Activity Log...</p>
                            </div>
                          ) : artisanAudits.length > 0 ? (
                            <div className="divide-y divide-white/5">
                              {artisanAudits.map((audit) => (
                                <div key={audit.id} className="p-8 flex items-start justify-between hover:bg-white/5 transition-all group relative">
                                  <div className="flex items-start gap-6">
                                    <div className="w-12 h-12 bg-bg-dark rounded-xl flex items-center justify-center text-white/20 border border-white/5 group-hover:text-accent-blue group-hover:border-accent-blue/20 transition-all shadow-inner mt-1">
                                      <History size={20} />
                                    </div>
                                    <div>
                                      <p className="text-sm font-bold text-white tracking-tight">{audit.action.replace(/_/g, ' ')}</p>
                                      <p className="text-xs text-white/40 mt-1 leading-relaxed">{audit.details}</p>
                                      <div className="flex items-center gap-3 mt-3">
                                        <p className="text-[9px] text-white/20 uppercase tracking-widest">BY {audit.adminName}</p>
                                        <div className="w-1 h-1 bg-white/10 rounded-full" />
                                        <p className="text-[9px] text-white/20 uppercase tracking-widest">{formatDate(audit.timestamp)}</p>
                                      </div>
                                    </div>
                                  </div>
                                  <div className="text-right">
                                    <span className="px-2 py-0.5 bg-white/5 text-white/20 text-[7px] font-bold rounded border border-white/5 uppercase tracking-widest">
                                      {audit.ip}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="p-32 text-center">
                              <History size={64} className="mx-auto text-white/5 mb-6" />
                              <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">No Activity Recorded</p>
                            </div>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className={cn(
              "fixed bottom-10 left-1/2 z-[100] px-8 py-4 rounded-2xl shadow-2xl flex items-center gap-4 min-w-[320px] backdrop-blur-xl border border-white/10",
              toast.type === 'success' ? "bg-bg-panel text-white" : "bg-red-600 text-white"
            )}
          >
            <div className={cn(
              "w-2 h-2 rounded-full",
              toast.type === 'success' ? "bg-accent-green" : "bg-white"
            )} />
            <span className="text-xs font-bold uppercase tracking-widest">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Send Notification Modal */}
      <AnimatePresence>
        {isNotificationModalOpen && selectedArtisan && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setIsNotificationModalOpen(false)}
              className="absolute inset-0 bg-bg-dark/95 backdrop-blur-md"
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 30 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 30 }}
              className="bg-bg-panel w-full max-w-lg relative z-10 overflow-hidden rounded-[32px] border border-white/10 shadow-2xl flex flex-col p-8"
            >
              <div className="flex justify-between items-center pb-6 border-b border-white/5 mb-6">
                <div>
                  <h3 className="text-lg font-bold text-white tracking-tight">Send Notification</h3>
                  <p className="text-xs text-white/40 mt-1">Direct message to {selectedArtisan.name}</p>
                </div>
                <button 
                  onClick={() => setIsNotificationModalOpen(false)}
                  className="p-3 text-white/20 hover:text-white transition-all bg-white/5 rounded-xl border border-white/10"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="space-y-5">
                <div>
                  <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest block mb-1">Notification Title</label>
                  <input 
                    type="text"
                    value={notiTitle}
                    onChange={(e) => setNotiTitle(e.target.value)}
                    placeholder="e.g., Profile verified successfully"
                    className="w-full bg-white/5 border border-white/10 focus:border-accent-blue/50 text-white px-4 py-3 rounded-xl text-sm transition-all outline-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest block mb-1">Message</label>
                  <textarea 
                    value={notiMessage}
                    onChange={(e) => setNotiMessage(e.target.value)}
                    placeholder="Type your personal message to the artisan here..."
                    rows={4}
                    className="w-full bg-white/5 border border-white/10 focus:border-accent-blue/50 text-white px-4 py-3 rounded-xl text-sm transition-all outline-none resize-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest block mb-2">Notification Level / Type</label>
                  <div className="grid grid-cols-4 gap-2">
                    {[
                      { type: 'info', color: 'border-accent-blue text-accent-blue bg-accent-blue/10' },
                      { type: 'success', color: 'border-accent-green text-accent-green bg-accent-green/10' },
                      { type: 'warning', color: 'border-accent-orange text-accent-orange bg-accent-orange/10' },
                      { type: 'error', color: 'border-red-500 text-red-500 bg-red-500/10' }
                    ].map((item) => (
                      <button
                        key={item.type}
                        type="button"
                        onClick={() => setNotiType(item.type as any)}
                        className={cn(
                          "py-2 rounded-xl text-[10px] font-bold uppercase tracking-widest border transition-all",
                          notiType === item.type 
                            ? item.color
                            : "border-white/10 text-white/40 hover:bg-white/5"
                        )}
                      >
                        {item.type}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex gap-4 mt-8">
                <button
                  type="button"
                  onClick={() => setIsNotificationModalOpen(false)}
                  className="flex-1 py-4 bg-white/5 hover:bg-white/10 text-white/60 text-[10px] font-bold rounded-2xl border border-white/10 uppercase tracking-widest transition-all"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={sendingNoti || !notiTitle.trim() || !notiMessage.trim()}
                  onClick={async () => {
                    if (!notiTitle.trim() || !notiMessage.trim()) return;
                    setSendingNoti(true);
                    try {
                      await notificationService.sendNotification({
                        userId: selectedArtisan.id,
                        title: notiTitle.trim(),
                        message: notiMessage.trim(),
                        type: notiType,
                        category: 'system'
                      });
                      
                      await addDoc(collection(db, 'audit_logs'), {
                        adminId: auth.currentUser?.uid,
                        adminName: currentUserData?.name || 'Unknown Admin',
                        action: 'ARTISAN_NOTIFICATION_SEND',
                        target: `Artisan: ${selectedArtisan.id}`,
                        targetId: selectedArtisan.id,
                        targetType: 'artisan',
                        details: `Sent notification: "${notiTitle.trim()}"`,
                        timestamp: new Date().toISOString(),
                        ip: 'Internal'
                      });

                      showToast('Notification sent successfully', 'success');
                      setNotiTitle('');
                      setNotiMessage('');
                      setIsNotificationModalOpen(false);
                    } catch (error: any) {
                      console.error("Failed to send notification:", error);
                      showToast('Failed to send notification: ' + error.message, 'error');
                    } finally {
                      setSendingNoti(false);
                    }
                  }}
                  className="flex-1 py-4 bg-accent-blue text-white text-[10px] font-bold rounded-2xl hover:bg-blue-600 uppercase tracking-widest disabled:opacity-50 disabled:cursor-not-allowed transition-all"
                >
                  {sendingNoti ? 'Sending...' : 'Send'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      <ConfirmModal
        isOpen={confirmModal.isOpen}
        onClose={() => setConfirmModal(prev => ({ ...prev, isOpen: false }))}
        onConfirm={confirmModal.onConfirm}
        title={confirmModal.title}
        message={confirmModal.message}
        variant={confirmModal.variant}
      />
    </motion.div>
  );
}
