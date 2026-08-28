import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Filter, Download, Briefcase, Clock, MoreVertical, MapPin, User, Shield, X } from 'lucide-react';
import { collection, onSnapshot, query, orderBy, doc, updateDoc, addDoc, serverTimestamp } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Job, Artisan, Customer, AuditLog } from '../types';
import { cn, formatCurrency, formatDate } from '../utils';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { ConfirmModal } from '../components/ConfirmModal';

import { usePermissions } from '../hooks/usePermissions';

export function Jobs() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [artisans, setArtisans] = useState<Artisan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const { admin, hasPermission, loading: permissionsLoading } = usePermissions();
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('All');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
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
    const unsubJobs = onSnapshot(query(collection(db, 'jobs'), orderBy('createdAt', 'desc')), (snap) => {
      setJobs(snap.docs.map(d => ({ id: d.id, ...d.data() } as Job)));
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'jobs');
    });

    const unsubArtisans = onSnapshot(collection(db, 'artisans'), (snap) => {
      setArtisans(snap.docs.map(d => ({ id: d.id, ...d.data() } as Artisan)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'artisans');
    });

    const unsubCustomers = onSnapshot(collection(db, 'customers'), (snap) => {
      setCustomers(snap.docs.map(d => ({ id: d.id, ...d.data() } as Customer)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'customers');
    });

    return () => {
      unsubJobs();
      unsubArtisans();
      unsubCustomers();
    };
  }, []);

  const getArtisan = (id: string | null) => artisans.find(a => a.id === id);
  const getCustomer = (id: string) => customers.find(c => c.id === id);

  const handleCancelJob = async (jobId: string) => {
    setConfirmModal({
      isOpen: true,
      title: 'Cancel Job',
      message: 'Are you sure you want to cancel this job? This action is irreversible.',
      variant: 'danger',
      onConfirm: () => performCancelJob(jobId)
    });
  };

  const performCancelJob = async (jobId: string) => {
    try {
      await updateDoc(doc(db, 'jobs', jobId), {
        status: 'Cancelled',
        updatedAt: new Date().toISOString()
      });

      // Log action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid || 'system',
        adminName: auth.currentUser?.displayName || 'Admin',
        action: 'job_cancelled',
        targetId: jobId,
        targetType: 'job',
        details: `Job ${jobId} was cancelled by admin.`,
        timestamp: new Date().toISOString(),
        ipAddress: '127.0.0.1',
        severity: 'warning'
      });

      showToast('Job cancelled successfully');
      setSelectedJob(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `jobs/${jobId}`);
      showToast('Failed to cancel job', 'error');
    } finally {
      setConfirmModal(prev => ({ ...prev, isOpen: false }));
    }
  };

  const handleAssignArtisan = async (jobId: string, artisanId: string) => {
    try {
      const artisan = artisans.find(a => a.id === artisanId);
      if (!artisan) return;

      await updateDoc(doc(db, 'jobs', jobId), {
        artisanId,
        status: 'In Progress',
        updatedAt: new Date().toISOString()
      });

      // Log action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid || 'system',
        adminName: auth.currentUser?.displayName || 'Admin',
        action: 'job_assigned',
        targetId: jobId,
        targetType: 'job',
        details: `Job ${jobId} assigned to artisan ${artisan.name}.`,
        timestamp: new Date().toISOString(),
        ipAddress: '127.0.0.1',
        severity: 'info'
      });

      showToast(`Job assigned to ${artisan.name}`);
      setSelectedJob(null);
    } catch (error) {
      console.error('Error assigning artisan:', error);
      showToast('Failed to assign artisan', 'error');
    }
  };
  
  const filteredJobs = jobs.filter(j => {
    const matchesFilter = filter === 'All' || j.status.toLowerCase() === filter.toLowerCase();
    const customer = getCustomer(j.customerId);
    const artisan = getArtisan(j.artisanId);
    const matchesSearch = 
      j.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      j.category.toLowerCase().includes(searchQuery.toLowerCase()) ||
      customer?.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      artisan?.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesFilter && matchesSearch;
  });

  if (loading || permissionsLoading) return (
    <div className="flex items-center justify-center h-[calc(100vh-80px)] bg-bg-dark">
      <div className="w-12 h-12 border-4 border-white/10 border-t-accent-blue rounded-full animate-spin"></div>
    </div>
  );

  const canManageJobs = hasPermission('Jobs');

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-6 pb-8 screen-container p-6"
    >
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold text-accent-blue uppercase tracking-[0.3em] mb-1.5">Operations</p>
          <h2 className="text-[22px] font-display font-black text-white tracking-tight">Active Marketplace</h2>
          <p className="text-white/40 mt-0.5 text-[13px] font-medium">{jobs.length} total service requests in pipeline.</p>
        </div>
        <div className="flex gap-4">
          <button 
            onClick={() => showToast('Job ledger exported', 'success')}
            className="px-6 py-3 bg-white/5 border border-white/10 rounded-2xl text-xs font-bold text-white/60 hover:bg-white/10 transition-all flex items-center gap-2 shadow-sm"
          >
            <Download size={16} className="text-accent-blue" /> Export Ledger
          </button>
        </div>
      </div>

      <div className="bg-bg-panel rounded-3xl border border-white/5 shadow-xl overflow-hidden">
        <div className="p-6 border-b border-white/5 bg-white/[0.02] flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="flex items-center gap-2 overflow-x-auto pb-2 lg:pb-0 scrollbar-hide">
            {['All', 'Pending', 'In Progress', 'Completed', 'Disputed'].map((f) => (
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
              placeholder="Search ID, Customer, Artisan or Skill..." 
              className="pl-12 pr-4 py-2.5 bg-white/5 border border-white/10 focus:border-accent-blue/50 rounded-2xl text-sm transition-all outline-none w-full lg:w-80 text-white placeholder:text-white/40"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-white/[0.02]">
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Service Node</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Stakeholders</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Region</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Status</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest text-right">Escrow Value</th>
                <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest text-right">Audit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {filteredJobs.map((job) => {
                const customer = getCustomer(job.customerId);
                const artisan = getArtisan(job.artisanId);
                return (
                  <tr key={job.id} className="group hover:bg-white/[0.02] transition-colors">
                    <td className="px-6 py-5">
                      <div>
                        <p className="text-sm font-bold text-white group-hover:text-accent-blue transition-colors font-mono tracking-tighter">{job.id}</p>
                        <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest">{job.category}</span>
                      </div>
                    </td>
                    <td className="px-6 py-5">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <User size={12} className="text-white/40" />
                          <span className="text-xs font-bold text-white/60">{customer?.name || 'Unknown'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <Shield size={12} className="text-accent-blue" />
                          <span className="text-xs font-medium text-white/40">{artisan?.name || 'Unassigned'}</span>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-5">
                      <div className="flex items-center gap-2 text-white/40">
                        <MapPin size={14} />
                        <span className="text-xs font-medium">{job.region}</span>
                      </div>
                    </td>
                    <td className="px-6 py-5">
                      <span className={cn(
                        "px-3 py-1 text-[10px] font-bold rounded-lg border uppercase tracking-wider",
                        job.status === 'Completed' ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" :
                        job.status === 'In Progress' ? "bg-blue-500/10 text-blue-500 border-blue-500/20" :
                        job.status === 'Disputed' ? "bg-red-500/10 text-red-500 border-red-500/20" :
                        "bg-amber-500/10 text-amber-500 border-amber-500/20"
                      )}>
                        {job.status}
                      </span>
                    </td>
                    <td className="px-6 py-5 text-right">
                      <p className="text-sm font-bold text-white font-mono">{formatCurrency(job.amount)}</p>
                      <p className="text-[10px] text-white/40 font-bold uppercase tracking-widest">Locked</p>
                    </td>
                    <td className="px-6 py-5 text-right">
                      <button 
                        onClick={() => setSelectedJob(job)}
                        className="p-2.5 bg-white/5 text-white/40 hover:text-accent-blue hover:bg-accent-blue/10 rounded-xl transition-all border border-white/10 hover:border-accent-blue/20 shadow-sm"
                      >
                        <MoreVertical size={18} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Job Detail Modal */}
      <AnimatePresence>
        {selectedJob && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedJob(null)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="bg-bg-panel w-full max-w-2xl relative z-10 overflow-hidden rounded-[2.5rem] border border-white/10 shadow-2xl"
            >
              <div className="p-8 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
                <div>
                  <h3 className="text-2xl font-display font-bold text-white">Job Audit: <span className="text-accent-blue font-mono">{selectedJob.id}</span></h3>
                  <p className="text-xs font-bold text-white/40 uppercase tracking-widest mt-1">Transaction Lifecycle Management</p>
                </div>
                <button 
                  onClick={() => setSelectedJob(null)}
                  className="p-2 text-white/40 hover:text-white transition-colors bg-white/5 rounded-xl border border-white/10 shadow-sm"
                >
                  <X size={20} />
                </button>
              </div>

              <div className="p-8 space-y-8">
                <div className="grid grid-cols-2 gap-8">
                  <div className="space-y-4">
                    <h4 className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Service Details</h4>
                    <div className="space-y-4">
                      <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/10">
                        <span className="text-xs text-white/40">Category</span>
                        <span className="text-xs font-bold text-white">{selectedJob.category}</span>
                      </div>
                      <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/10">
                        <span className="text-xs text-white/40">Created</span>
                        <span className="text-xs font-bold text-white font-mono">{formatDate(selectedJob.createdAt)}</span>
                      </div>
                      <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/10">
                        <span className="text-xs text-white/40">Last Update</span>
                        <span className="text-xs font-bold text-white font-mono">{formatDate(selectedJob.updatedAt)}</span>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-4">
                    <h4 className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Financials</h4>
                    <div className="space-y-4">
                      <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/10">
                        <span className="text-xs text-white/40">Escrow Amount</span>
                        <span className="text-xs font-bold text-emerald-500 font-mono">{formatCurrency(selectedJob.amount)}</span>
                      </div>
                      <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/10">
                        <span className="text-xs text-white/40">Platform Fee (15%)</span>
                        <span className="text-xs font-bold text-white font-mono">{formatCurrency(selectedJob.amount * 0.15)}</span>
                      </div>
                      <div className="flex justify-between items-center bg-white/5 p-3 rounded-xl border border-white/10">
                        <span className="text-xs text-white/40">Artisan Payout</span>
                        <span className="text-xs font-bold text-white font-mono">{formatCurrency(selectedJob.amount * 0.85)}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-6 bg-white/5 rounded-3xl border border-white/10">
                  <h4 className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-4">Stakeholder Status</h4>
                  <div className="grid grid-cols-2 gap-6">
                    <div className="flex items-center gap-4 p-3 bg-bg-panel rounded-2xl border border-white/10 shadow-sm">
                      <div className="w-12 h-12 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-white/40 font-bold">
                        {getCustomer(selectedJob.customerId)?.name[0]}
                      </div>
                      <div>
                        <p className="text-xs font-bold text-white">{getCustomer(selectedJob.customerId)?.name}</p>
                        <p className="text-[10px] text-white/40 font-bold uppercase">Customer</p>
                      </div>
                    </div>
                    <div className="flex flex-col gap-3">
                      <div className="flex items-center gap-4 p-3 bg-bg-panel rounded-2xl border border-white/10 shadow-sm">
                        <div className="w-12 h-12 rounded-2xl bg-accent-blue/10 border border-accent-blue/20 flex items-center justify-center text-accent-blue font-bold">
                          {getArtisan(selectedJob.artisanId)?.name[0] || '?'}
                        </div>
                        <div>
                          <p className="text-xs font-bold text-white">{getArtisan(selectedJob.artisanId)?.name || 'Unassigned'}</p>
                          <p className="text-[10px] text-white/40 font-bold uppercase">Artisan</p>
                        </div>
                      </div>
                      {canManageJobs && !selectedJob.artisanId && selectedJob.status === 'Pending' && (
                        <select 
                          onChange={(e) => handleAssignArtisan(selectedJob.id, e.target.value)}
                          className="w-full p-2 text-[10px] font-bold uppercase tracking-widest bg-bg-panel text-white border border-white/10 rounded-xl outline-none focus:border-accent-blue transition-all"
                          defaultValue=""
                        >
                          <option value="" disabled>Assign Artisan...</option>
                          {artisans.filter(a => a.status === 'Active' && a.skills.includes(selectedJob.category)).map(a => (
                            <option key={a.id} value={a.id}>{a.name} ({a.rating}★)</option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex gap-4 pt-4">
                  {canManageJobs && selectedJob.status !== 'Cancelled' && selectedJob.status !== 'Completed' && (
                    <button 
                      onClick={() => handleCancelJob(selectedJob.id)}
                      className="flex-1 py-4 bg-red-500/10 text-red-500 text-xs font-bold rounded-2xl hover:bg-red-500/20 transition-all uppercase tracking-widest border border-red-500/20"
                    >
                      Cancel Job
                    </button>
                  )}
                  <button 
                    onClick={() => showToast('Viewing job timeline...', 'success')}
                    className="flex-1 py-4 bg-white/5 text-white/60 text-xs font-bold rounded-2xl hover:bg-white/10 transition-all uppercase tracking-widest border border-white/10"
                  >
                    View Timeline
                  </button>
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
              "fixed bottom-8 left-1/2 z-[100] px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-3 min-w-[320px] border bg-bg-panel border-white/10",
              toast.type === 'success' 
                ? "text-white" 
                : "bg-red-600 text-white border-red-500/20"
            )}
          >
            <div className={cn(
              "w-2 h-2 rounded-full animate-pulse",
              toast.type === 'success' ? "bg-emerald-500" : "bg-white"
            )} />
            <span className="text-sm font-bold tracking-tight">{toast.message}</span>
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
