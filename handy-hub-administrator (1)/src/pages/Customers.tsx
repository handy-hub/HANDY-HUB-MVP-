import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Filter, MoreVertical, User, MapPin, Calendar, CreditCard, X, ShieldAlert, ShieldCheck, CheckCircle, Eye, Briefcase, History, Zap, Lock, UserX, UserCheck, Trash2, MessageSquare } from 'lucide-react';
import { collection, onSnapshot, doc, updateDoc, addDoc, query, where, orderBy, limit, getDoc, deleteDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Customer, Job, AdminUser } from '../types';
import { cn, formatDate, formatCurrency } from '../utils';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { ConfirmModal } from '../components/ConfirmModal';
import { notificationService } from '../services/notificationService';

import { usePermissions } from '../hooks/usePermissions';

export function Customers() {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const { admin, hasPermission, loading: permissionsLoading } = usePermissions();
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [recentJobs, setRecentJobs] = useState<Job[]>([]);
  const [customerAudits, setCustomerAudits] = useState<any[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [loadingAudits, setLoadingAudits] = useState(false);
  const [activeTab, setActiveTab] = useState<'details' | 'jobs' | 'audits'>('details');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [currentUserData, setCurrentUserData] = useState<AdminUser | null>(null);
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
    const unsub = onSnapshot(collection(db, 'customers'), (snap) => {
      setCustomers(snap.docs.map(d => ({ id: d.id, ...d.data() } as Customer)));
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'customers');
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
    if (!selectedCustomer) {
      setRecentJobs([]);
      setCustomerAudits([]);
      setActiveTab('details');
      return;
    }

    setLoadingJobs(true);
    const jobsQ = query(
      collection(db, 'jobs'),
      where('customerId', '==', selectedCustomer.id),
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
      where('targetId', '==', selectedCustomer.id),
      orderBy('timestamp', 'desc'),
      limit(20)
    );

    const unsubAudits = onSnapshot(auditsQ, (snap) => {
      setCustomerAudits(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      setLoadingAudits(false);
    }, (error) => {
      console.error("Failed to fetch audits", error);
      setLoadingAudits(false);
    });

    return () => {
      unsubJobs();
      unsubAudits();
    };
  }, [selectedCustomer]);

  const handleStatusUpdate = async (customerId: string, newStatus: string) => {
    const statusValue = newStatus.toLowerCase();
    
    if (statusValue === 'banned') {
      setConfirmModal({
        isOpen: true,
        title: 'Ban Customer',
        message: 'Are you sure you want to BAN this customer? This will block their access to the platform.',
        variant: 'danger',
        onConfirm: () => performStatusUpdate(customerId, statusValue)
      });
      return;
    }

    performStatusUpdate(customerId, statusValue);
  };

  const performStatusUpdate = async (customerId: string, statusValue: string) => {
    try {
      const customerRef = doc(db, 'customers', customerId);
      const customerDoc = await getDoc(customerRef);
      const oldStatus = customerDoc.exists() ? customerDoc.data().status : 'unknown';

      await updateDoc(customerRef, { 
        status: statusValue,
        updatedAt: new Date().toISOString()
      });
      
      // Log the action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: currentUserData?.name || 'Unknown Admin',
        action: 'CUSTOMER_STATUS_UPDATE',
        target: `Customer: ${customerId}`,
        targetId: customerId,
        targetType: 'customer',
        details: `Changed status from ${oldStatus} to ${statusValue}`,
        timestamp: new Date().toISOString(),
        ip: 'Internal'
      });

      showToast(`Customer status updated to ${statusValue}`, 'success');
      if (selectedCustomer?.id === customerId) {
        setSelectedCustomer(prev => prev ? { ...prev, status: statusValue as any } : null);
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `customers/${customerId}`);
      showToast("Failed to update status", "error");
    } finally {
      setConfirmModal(prev => ({ ...prev, isOpen: false }));
    }
  };

  const isSuperAdminUser = admin?.role === 'super_admin' || 
    (auth.currentUser?.email && [
      'silas7korda@gmail.com',
      'clasceth4traders@gmail.com',
      'paakumisam@gmail.com'
    ].includes(auth.currentUser.email.toLowerCase())) || false;

  const handleDeleteCustomer = async (customerId: string) => {
    setConfirmModal({
      isOpen: true,
      title: 'Delete Customer Permanently',
      message: `Are you sure you want to PERMANENTLY DELETE this customer's account? All profile details, bookings, and data will be permanently erased. This action is irreversible!`,
      variant: 'danger',
      onConfirm: async () => {
        try {
          await deleteDoc(doc(db, 'customers', customerId));
          
          await addDoc(collection(db, 'audit_logs'), {
            adminId: auth.currentUser?.uid,
            adminName: currentUserData?.name || admin?.name || 'Unknown Admin',
            action: 'CUSTOMER_ACCOUNT_DELETE',
            target: `Customer: ${customerId}`,
            targetId: customerId,
            targetType: 'customer',
            details: `Permanently deleted customer profile of ${selectedCustomer?.name || customerId}`,
            timestamp: new Date().toISOString(),
            ip: 'Internal'
          });
          
          showToast(`Customer permanently deleted successfully.`, 'success');
          setSelectedCustomer(null);
        } catch (error: any) {
          console.error("Deletion failed:", error);
          showToast(`Failed to delete customer: ${error.message}`, 'error');
        } finally {
          setConfirmModal(prev => ({ ...prev, isOpen: false }));
        }
      }
    });
  };

  const filteredCustomers = customers.filter(c => 
    c.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    c.phone.includes(searchTerm) ||
    c.location.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading || permissionsLoading) return (
    <div className="flex items-center justify-center h-[calc(100vh-80px)] bg-bg-dark">
      <div className="w-12 h-12 border-4 border-white/10 border-t-accent-blue rounded-full animate-spin"></div>
    </div>
  );

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-6 pb-8 max-w-[1600px] mx-auto p-6 bg-bg-dark min-h-screen"
    >
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-white/5 pb-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-accent-blue/10 flex items-center justify-center text-accent-blue border border-accent-blue/20">
              <User size={16} />
            </div>
            <p className="text-[10px] font-bold text-accent-blue uppercase tracking-[0.3em] opacity-80">User Management</p>
          </div>
          <h2 className="text-[17px] font-display font-black text-white tracking-tight">Customer Directory</h2>
          <p className="text-[13px] text-white/40 font-medium max-w-2xl leading-relaxed">
            Manage your user base of <span className="text-white">{customers.length}</span> active customers.
          </p>
        </div>
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-3 px-6 py-4 bg-bg-panel text-white/60 rounded-2xl text-[11px] font-bold border border-white/5 uppercase tracking-widest shadow-sm">
            <div className="w-2 h-2 bg-accent-green rounded-full animate-pulse shadow-[0_0_10px_rgba(34,197,94,0.5)]" />
            {customers.filter(c => c.status === 'active').length} Verified Users
          </div>
          <motion.button 
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={() => showToast('Customer database exported', 'success')}
            className="flex items-center gap-3 px-6 py-4 bg-white text-bg-dark rounded-2xl text-[11px] font-bold hover:bg-white/90 transition-all uppercase tracking-widest shadow-lg"
          >
            <CreditCard size={18} /> Export Directory
          </motion.button>
        </div>
      </div>

      <div className="bg-bg-panel rounded-3xl border border-white/5 shadow-xl overflow-hidden">
        <div className="p-6 border-b border-white/5 bg-white/[0.02] flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="flex items-center gap-4">
            <div className="w-1.5 h-6 bg-accent-blue rounded-full" />
            <h3 className="font-bold text-[15px] text-white tracking-tight">Active Users</h3>
          </div>
          <div className="relative w-full md:w-80 group">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/40 group-focus-within:text-accent-blue transition-colors" size={16} />
            <input 
              type="text"
              placeholder="Search by name, email or location..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-white/5 border border-white/10 text-white pl-12 pr-4 py-2.5 rounded-2xl text-sm focus:outline-none focus:border-accent-blue/50 transition-all placeholder:text-white/40 font-medium outline-none"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-white/[0.02]">
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Customer</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Contact Info</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Activity</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Status</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Joined</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filteredCustomers.map((customer) => (
                <tr key={customer.id} className="group hover:bg-white/[0.02] transition-colors">
                  <td className="px-6 py-5">
                    <div className="flex items-center gap-4">
                      <div className="relative">
                        <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center text-white/20 border border-white/10 font-bold text-lg shadow-sm overflow-hidden">
                          {customer.name[0]}
                        </div>
                        <div className={cn(
                          "absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-bg-panel shadow-sm",
                          customer.status === 'active' ? "bg-accent-green" : "bg-white/10"
                        )} />
                      </div>
                      <div className="flex flex-col">
                        <span className="text-sm font-bold text-white tracking-tight group-hover:text-accent-blue transition-colors">{customer.name}</span>
                        <span className="text-[10px] text-white/40 font-medium mt-0.5 flex items-center gap-1">
                          <MapPin size={10} className="text-white/20" /> {customer.location}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-5">
                    <div className="flex flex-col gap-0.5">
                      <p className="text-xs font-bold text-white/80 tracking-tight">{customer.email}</p>
                      <p className="text-[10px] text-white/40 font-medium">{customer.phone}</p>
                    </div>
                  </td>
                  <td className="px-6 py-5">
                    <div className="flex flex-col gap-0.5">
                      <p className="text-xs font-bold text-white tracking-tight">{customer.bookings} Bookings</p>
                      <p className="text-[10px] text-accent-green font-bold tracking-tight">{formatCurrency(customer.spent)} spent</p>
                    </div>
                  </td>
                  <td className="px-6 py-5">
                    <div className={cn(
                      "inline-flex items-center gap-2 px-3 py-1 text-[9px] font-bold rounded-lg border uppercase tracking-widest shadow-sm",
                      customer.status === 'active' ? "bg-accent-green/10 text-accent-green border-accent-green/20" :
                      customer.status === 'suspended' ? "bg-red-500/10 text-red-500 border-red-500/20" :
                      "bg-white/5 text-white/40 border-white/10"
                    )}>
                      <div className={cn(
                        "w-1 h-1 rounded-full",
                        customer.status === 'active' ? "bg-accent-green" :
                        customer.status === 'suspended' ? "bg-red-500" :
                        "bg-white/20"
                      )} />
                      {customer.status}
                    </div>
                  </td>
                  <td className="px-6 py-5">
                    <span className="text-xs font-medium text-white/40 tracking-tight">
                      {formatDate(customer.joined)}
                    </span>
                  </td>
                  <td className="px-6 py-5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button 
                        onClick={() => setSelectedCustomer(customer)}
                        className="p-2.5 bg-white/5 text-white/40 rounded-xl hover:text-accent-blue hover:bg-accent-blue/10 transition-all border border-white/10 hover:border-accent-blue/20 shadow-sm"
                      >
                        <Eye size={18} />
                      </button>
                      <button 
                        className="p-2.5 bg-white/5 text-white/40 rounded-xl hover:text-white hover:bg-white/10 transition-all border border-white/10 shadow-sm"
                      >
                        <MoreVertical size={18} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Customer Detail Modal */}
      <AnimatePresence>
        {selectedCustomer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              className="bg-bg-panel border border-white/10 rounded-[40px] w-full max-w-5xl max-h-[90vh] overflow-hidden shadow-2xl flex flex-col"
            >
              {/* Modal Header */}
              <div className="p-10 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
                <div className="flex items-center gap-8">
                  <div className="w-24 h-24 rounded-3xl bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center text-accent-blue shadow-lg">
                    <User size={48} />
                  </div>
                  <div>
                    <div className="flex items-center gap-4 mb-2">
                      <h3 className="text-3xl font-display font-black text-white tracking-tight">{selectedCustomer.name}</h3>
                      <span className={cn(
                        "px-3 py-1 text-[10px] font-bold rounded-full border uppercase tracking-widest",
                        selectedCustomer.status === 'active' ? "text-accent-green border-accent-green/20 bg-accent-green/10" : 
                        selectedCustomer.status === 'pending' ? "text-accent-blue border-accent-blue/20 bg-accent-blue/10" :
                        "text-red-500 border-red-500/20 bg-red-500/10"
                      )}>{selectedCustomer.status}</span>
                    </div>
                    <div className="flex items-center gap-6 text-white/40">
                      <div className="flex items-center gap-2">
                        <MapPin size={14} className="text-accent-blue" />
                        <span className="text-xs font-bold uppercase tracking-widest">{selectedCustomer.location}</span>
                      </div>
                      <div className="w-1 h-1 bg-white/10 rounded-full" />
                      <div className="flex items-center gap-2">
                        <Calendar size={14} className="text-accent-green" />
                        <span className="text-xs font-bold uppercase tracking-widest">Member since {formatDate(selectedCustomer.joinedAt)}</span>
                      </div>
                    </div>
                  </div>
                </div>
                <button 
                  onClick={() => setSelectedCustomer(null)}
                  className="w-12 h-12 flex items-center justify-center bg-white/5 text-white/20 hover:text-white hover:bg-white/10 rounded-2xl transition-all"
                >
                  <X size={24} />
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
                                {selectedCustomer.email}
                              </p>
                            </div>
                            <div className="p-8 bg-white/5 border border-white/5 rounded-3xl group hover:border-white/10 transition-colors shadow-inner">
                              <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-4">Phone Number</p>
                              <p className="text-sm font-bold text-white tracking-tight flex items-center gap-3">
                                <Zap size={16} className="text-accent-green" />
                                {selectedCustomer.phone}
                              </p>
                            </div>
                          </div>

                          <div className="p-8 bg-white/5 border border-white/5 rounded-3xl shadow-inner">
                            <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-4">Account Summary</p>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-8">
                              <div>
                                <p className="text-[9px] font-bold text-white/20 uppercase tracking-widest mb-2">Total Spent</p>
                                <p className="text-xl font-display font-black text-white">{formatCurrency(selectedCustomer.totalSpent || 0)}</p>
                              </div>
                              <div>
                                <p className="text-[9px] font-bold text-white/20 uppercase tracking-widest mb-2">Jobs Requested</p>
                                <p className="text-xl font-display font-black text-white">{selectedCustomer.jobsRequested || 0}</p>
                              </div>
                              <div>
                                <p className="text-[9px] font-bold text-white/20 uppercase tracking-widest mb-2">Last Active</p>
                                <p className="text-sm font-bold text-white">{formatDate(selectedCustomer.lastActive || selectedCustomer.joinedAt)}</p>
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="lg:col-span-4 space-y-8">
                          <div className="flex flex-col gap-4">
                            <button 
                              onClick={() => setIsNotificationModalOpen(true)}
                              className="w-full py-5 bg-accent-blue/10 hover:bg-accent-blue/20 text-accent-blue border border-accent-blue/20 text-[10px] font-bold rounded-2xl transition-all uppercase tracking-widest flex items-center justify-center gap-2 shadow-sm"
                            >
                              <MessageSquare size={16} /> Send Notification
                            </button>

                            {selectedCustomer.status === 'active' && (
                              <button 
                                onClick={() => handleStatusUpdate(selectedCustomer.id, 'suspended')}
                                className="w-full py-5 bg-accent-orange text-white text-[10px] font-bold rounded-2xl hover:bg-orange-600 transition-all shadow-lg shadow-orange-500/20 uppercase tracking-widest flex items-center justify-center gap-2"
                              >
                                <Lock size={16} /> Suspend Account
                              </button>
                            )}
                            {selectedCustomer.status === 'suspended' && (
                              <button 
                                onClick={() => handleStatusUpdate(selectedCustomer.id, 'active')}
                                className="w-full py-5 bg-accent-blue text-white text-[10px] font-bold rounded-2xl hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20 uppercase tracking-widest flex items-center justify-center gap-2"
                              >
                                <UserCheck size={16} /> Activate Account
                              </button>
                            )}
                            {selectedCustomer.status !== 'banned' ? (
                              <button 
                                onClick={() => handleStatusUpdate(selectedCustomer.id, 'banned')}
                                className="w-full py-5 bg-white/5 text-red-500 border border-red-500/20 text-[10px] font-bold rounded-2xl hover:bg-red-500/10 transition-all uppercase tracking-widest flex items-center justify-center gap-2"
                              >
                                <UserX size={16} /> Ban Account
                              </button>
                            ) : (
                              <button 
                                onClick={() => handleStatusUpdate(selectedCustomer.id, 'active')}
                                className="w-full py-5 bg-accent-blue text-white text-[10px] font-bold rounded-2xl hover:bg-blue-600 transition-all uppercase tracking-widest shadow-lg shadow-blue-500/20 flex items-center justify-center gap-2"
                              >
                                <ShieldCheck size={16} /> Unban & Activate
                              </button>
                            )}

                            {isSuperAdminUser && (
                              <button 
                                onClick={() => handleDeleteCustomer(selectedCustomer.id)}
                                className="w-full py-5 bg-red-600/10 hover:bg-red-600 text-red-500 hover:text-white border border-red-600/20 text-[10px] font-bold rounded-2xl transition-all uppercase tracking-widest flex items-center justify-center gap-2 shadow-inner hover:shadow-none"
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
                          ) : customerAudits.length > 0 ? (
                            <div className="divide-y divide-white/5">
                              {customerAudits.map((audit) => (
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

      {/* Send Notification Modal */}
      <AnimatePresence>
        {isNotificationModalOpen && selectedCustomer && (
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
                  <p className="text-xs text-white/40 mt-1">Direct message to {selectedCustomer.name}</p>
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
                    placeholder="e.g., Account status update"
                    className="w-full bg-white/5 border border-white/10 focus:border-accent-blue/50 text-white px-4 py-3 rounded-xl text-sm transition-all outline-none"
                  />
                </div>

                <div>
                  <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest block mb-1">Message</label>
                  <textarea 
                    value={notiMessage}
                    onChange={(e) => setNotiMessage(e.target.value)}
                    placeholder="Type your personal message to the customer here..."
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
                        userId: selectedCustomer.id,
                        title: notiTitle.trim(),
                        message: notiMessage.trim(),
                        type: notiType,
                        category: 'system'
                      });
                      
                      await addDoc(collection(db, 'audit_logs'), {
                        adminId: auth.currentUser?.uid,
                        adminName: currentUserData?.name || admin?.name || 'Unknown Admin',
                        action: 'CUSTOMER_NOTIFICATION_SEND',
                        target: `Customer: ${selectedCustomer.id}`,
                        targetId: selectedCustomer.id,
                        targetType: 'customer',
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
