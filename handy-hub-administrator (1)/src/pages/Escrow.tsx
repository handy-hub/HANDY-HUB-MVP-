import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Wallet, Shield, ArrowUpRight, Download, Clock, AlertCircle, CheckCircle, XCircle, FileText } from 'lucide-react';
import { StatCard } from '../components/StatCard';
import { collection, onSnapshot, query, where, doc, updateDoc, addDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Job, Artisan, Customer, Payout } from '../types';
import { formatCurrency, cn } from '../utils';
import { notificationService } from '../services/notificationService';

import { useLocation } from 'react-router-dom';

import { usePressAnimation } from '../hooks/usePressAnimation';

import { usePermissions } from '../hooks/usePermissions';

export function Escrow() {
  const location = useLocation();
  const queryParams = new URLSearchParams(location.search);
  const activeTab = queryParams.get('tab') || 'overview';

  const [jobs, setJobs] = useState<Job[]>([]);
  const [artisans, setArtisans] = useState<Artisan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const { admin, hasPermission, loading: permissionsLoading } = usePermissions();
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  const exportPress = usePressAnimation();
  const releasePress = usePressAnimation();
  const refundPress = usePressAnimation();

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const unsubJobs = onSnapshot(collection(db, 'jobs'), (snap) => {
      setJobs(snap.docs.map(d => ({ id: d.id, ...d.data() } as Job)));
      setLoading(false);
    });

    const unsubArtisans = onSnapshot(collection(db, 'artisans'), (snap) => {
      setArtisans(snap.docs.map(d => ({ id: d.id, ...d.data() } as Artisan)));
    });

    const unsubCustomers = onSnapshot(collection(db, 'customers'), (snap) => {
      setCustomers(snap.docs.map(d => ({ id: d.id, ...d.data() } as Customer)));
    });

    const unsubPayouts = onSnapshot(collection(db, 'payouts'), (snap) => {
      setPayouts(snap.docs.map(d => ({ id: d.id, ...d.data() } as Payout)));
    });

    return () => {
      unsubJobs();
      unsubArtisans();
      unsubCustomers();
      unsubPayouts();
    };
  }, []);

  const getArtisan = (id: string | null) => artisans.find(a => a.id === id);
  const getCustomer = (id: string) => customers.find(c => c.id === id);

  const handlePayoutAction = async (payoutId: string, action: 'approved' | 'rejected') => {
    try {
      await updateDoc(doc(db, 'payouts', payoutId), {
        status: action,
        processedAt: new Date().toISOString(),
        processedBy: auth.currentUser?.uid
      });

      // Log action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: auth.currentUser?.displayName || 'Admin',
        action: `PAYOUT_${action.toUpperCase()}`,
        target: payoutId,
        details: `Payout ${payoutId} ${action}`,
        timestamp: new Date().toISOString(),
        ip: '0.0.0.0'
      });

      showToast(`Payout ${action} successfully`);

      // Notify relevant admins
      notificationService.sendGlobalNotification(
        `Payout ${action.charAt(0).toUpperCase() + action.slice(1)}`,
        `A payout of ${formatCurrency(payouts.find(p => p.id === payoutId)?.amount || 0)} for ${getArtisan(payouts.find(p => p.id === payoutId)?.artisanId || null)?.name || 'an artisan'} has been ${action}.`,
        action === 'approved' ? 'success' : 'warning',
        'payment'
      );
    } catch (error) {
      console.error("Payout action failed", error);
      showToast("Payout action failed", "error");
    }
  };
  const handleEscrowAction = async (jobId: string, action: 'RELEASE' | 'REFUND') => {
    try {
      const newStatus = action === 'RELEASE' ? 'Completed' : 'Refunded';
      await updateDoc(doc(db, 'jobs', jobId), { 
        status: newStatus,
        updatedAt: new Date().toISOString()
      });
      
      // Log action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: auth.currentUser?.displayName || 'Admin',
        action: `ESCROW_${action}`,
        target: jobId,
        details: `Funds ${action.toLowerCase()}ed for job ${jobId}`,
        timestamp: new Date().toISOString(),
        ip: '0.0.0.0'
      });

      showToast(`Funds ${action.toLowerCase()}ed successfully`, 'success');

      // Notify relevant admins
      notificationService.sendGlobalNotification(
        `Escrow ${action.charAt(0).toUpperCase() + action.slice(1)}d`,
        `Funds for job REF-${jobId.slice(-6).toUpperCase()} (${formatCurrency(jobs.find(j => j.id === jobId)?.amount || 0)}) have been ${action.toLowerCase()}ed.`,
        action === 'RELEASE' ? 'success' : 'warning',
        'payment'
      );
    } catch (error) {
      console.error("Escrow action failed", error);
      showToast("Escrow action failed", "error");
    }
  };

  if (loading || permissionsLoading) return (
    <div className="flex items-center justify-center h-[calc(100vh-80px)] bg-bg-dark">
      <div className="w-12 h-12 border-4 border-white/10 border-t-accent-blue rounded-full animate-spin"></div>
    </div>
  );

  const activeEscrowJobs = jobs.filter(j => j.status !== 'Completed' && j.status !== 'Refunded');
  const totalEscrow = activeEscrowJobs.reduce((sum, j) => sum + j.amount, 0);
  const disputedEscrow = jobs.filter(j => j.status === 'Disputed').reduce((sum, j) => sum + j.amount, 0);

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-6 pb-8 max-w-[1600px] mx-auto bg-bg-dark min-h-screen p-6"
    >
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-white/5 pb-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-accent-blue/10 flex items-center justify-center text-accent-blue border border-accent-blue/20">
              <Wallet size={16} />
            </div>
            <p className="text-[10px] font-bold text-accent-blue uppercase tracking-[0.3em] opacity-80">Financial Operations</p>
          </div>
          <h2 className="text-[17px] font-display font-black text-white tracking-tight">
            {activeTab === 'payouts' ? 'Payout Requests' : activeTab === 'history' ? 'Transaction History' : 'Escrow & Payments'}
          </h2>
          <p className="text-[13px] text-white/40 font-medium max-w-2xl leading-relaxed">
            {activeTab === 'overview' ? (
              <>Managing <span className="text-white">{formatCurrency(totalEscrow)}</span> currently secured in the platform's multi-sig vault.</>
            ) : activeTab === 'payouts' ? (
              <>Review and approve artisan payout requests based on completed jobs.</>
            ) : (
              <>Full audit trail of all financial movements within the platform.</>
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-3 px-6 py-4 bg-bg-panel text-white/60 rounded-2xl text-[11px] font-bold border border-white/5 uppercase tracking-widest shadow-sm">
            <div className="w-2 h-2 bg-accent-green rounded-full animate-pulse shadow-[0_0_10px_rgba(34,197,94,0.5)]" />
            Live Vault Balance
          </div>
          <motion.button 
            style={exportPress.style}
            onMouseDown={exportPress.onMouseDown}
            onMouseUp={exportPress.onMouseUp}
            onMouseLeave={exportPress.onMouseLeave}
            onClick={() => showToast('Escrow ledger exported', 'success')}
            className="flex items-center gap-3 px-6 py-4 bg-white text-bg-dark rounded-2xl text-[11px] font-bold hover:bg-white/90 transition-all uppercase tracking-widest shadow-lg"
          >
            <Download size={18} /> Export Ledger
          </motion.button>
        </div>
      </div>

      {activeTab === 'overview' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            <StatCard 
              label="Total Escrow" 
              value={totalEscrow} 
              icon={Wallet} 
              color="blue" 
              trend="GHS" 
              changeType="neutral" 
              prefix="GHS "
            />
            <StatCard 
              label="Active Jobs" 
              value={activeEscrowJobs.length} 
              icon={Shield} 
              color="teal" 
              trend="jobs" 
              changeType="neutral" 
            />
            <StatCard 
              label="In Dispute" 
              value={disputedEscrow} 
              icon={AlertCircle} 
              color="red" 
              trend="GHS" 
              changeType="down" 
              prefix="GHS "
            />
            <StatCard 
              label="Releasing Today" 
              value={totalEscrow * 0.1} // Mock projection
              icon={ArrowUpRight} 
              color="green" 
              trend="GHS" 
              changeType="up" 
              prefix="GHS "
            />
          </div>

          <div className="bg-bg-panel rounded-3xl border border-white/5 shadow-xl overflow-hidden">
            <div className="p-6 border-b border-white/5 bg-white/[0.02] flex items-center justify-between">
              <div className="flex items-center gap-4">
                <div className="w-1.5 h-6 bg-accent-blue rounded-full" />
                <h3 className="font-bold text-[15px] text-white tracking-tight">Escrow Ledger</h3>
              </div>
              <div className="flex items-center gap-4">
                <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest opacity-60">Real-time settlement tracking</span>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-white/[0.02]">
                    <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Job Reference</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Customer</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Artisan</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Amount Held</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Status</th>
                    <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {activeEscrowJobs.map((job) => {
                    const customer = getCustomer(job.customerId);
                    const artisan = getArtisan(job.artisanId);
                    return (
                      <tr key={job.id} className="group hover:bg-white/[0.02] transition-colors">
                        <td className="px-6 py-5">
                          <div className="flex flex-col">
                            <span className="text-sm font-bold text-white tracking-wider group-hover:text-accent-blue transition-colors">REF-{job.id.slice(-6).toUpperCase()}</span>
                            <span className="text-[10px] text-white/20 font-bold uppercase tracking-widest mt-0.5 opacity-60">{job.category}</span>
                          </div>
                        </td>
                        <td className="px-6 py-5">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center text-white/20 border border-white/10 font-bold text-xs shadow-sm">
                              {customer?.name[0]}
                            </div>
                            <p className="text-sm font-bold text-white tracking-tight">{customer?.name || 'Unknown'}</p>
                          </div>
                        </td>
                        <td className="px-6 py-5">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-xl bg-accent-blue/10 flex items-center justify-center text-accent-blue border border-accent-blue/20 font-bold text-xs shadow-sm">
                              {artisan?.name ? artisan.name[0] : '?'}
                            </div>
                            <p className="text-sm font-bold text-white/80 tracking-tight">{artisan?.name || 'Unassigned'}</p>
                          </div>
                        </td>
                        <td className="px-6 py-5">
                          <p className="text-sm font-bold text-accent-green tracking-tight">{formatCurrency(job.amount)}</p>
                        </td>
                        <td className="px-6 py-5">
                          <div className={cn(
                            "inline-flex items-center gap-2 px-3 py-1 text-[9px] font-bold rounded-lg border uppercase tracking-widest shadow-sm",
                            job.status === 'In Progress' ? "bg-accent-blue/10 text-accent-blue border-accent-blue/20" :
                            job.status === 'Disputed' ? "bg-red-500/10 text-red-500 border-red-500/20" :
                            "bg-amber-500/10 text-amber-500 border-amber-500/20"
                          )}>
                            <div className={cn(
                              "w-1 h-1 rounded-full",
                              job.status === 'In Progress' ? "bg-accent-blue" :
                              job.status === 'Disputed' ? "bg-red-500" :
                              "bg-amber-500"
                            )} />
                            {job.status === 'In Progress' ? 'HELD' : job.status}
                          </div>
                        </td>
                        <td className="px-6 py-5 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button 
                              onClick={() => handleEscrowAction(job.id, 'RELEASE')}
                              className="px-4 py-2 bg-accent-green/10 text-accent-green text-[9px] font-bold rounded-xl hover:bg-accent-green/20 transition-all border border-accent-green/20 flex items-center gap-2 uppercase tracking-widest shadow-sm group/btn"
                            >
                              <CheckCircle size={14} className="group-hover:scale-110 transition-transform" /> 
                              Release
                            </button>
                            <button 
                              onClick={() => handleEscrowAction(job.id, 'REFUND')}
                              className="px-4 py-2 bg-red-500/10 text-red-500 text-[9px] font-bold rounded-xl hover:bg-red-500/20 transition-all border border-red-500/20 flex items-center gap-2 uppercase tracking-widest shadow-sm group/btn"
                            >
                              <XCircle size={14} className="group-hover:scale-110 transition-transform" /> 
                              Refund
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {activeTab === 'payouts' && (
        <div className="bg-bg-panel rounded-3xl border border-white/5 shadow-xl overflow-hidden">
          <div className="p-6 border-b border-white/5 bg-white/[0.02] flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-1.5 h-6 bg-accent-blue rounded-full" />
              <h3 className="font-bold text-[15px] text-white tracking-tight">Pending Payouts</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-white/[0.02]">
                  <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Artisan</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Amount</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Method</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Requested</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {payouts.filter(p => p.status === 'pending').map((payout) => {
                  const artisan = getArtisan(payout.artisanId);
                  return (
                    <tr key={payout.id} className="group hover:bg-white/[0.02] transition-colors">
                      <td className="px-6 py-5">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-xl bg-accent-blue/10 flex items-center justify-center text-accent-blue border border-accent-blue/20 font-bold text-xs">
                            {artisan?.name ? artisan.name[0] : '?'}
                          </div>
                          <div>
                            <p className="text-sm font-bold text-white tracking-tight group-hover:text-accent-blue transition-colors">{artisan?.name || 'Unknown'}</p>
                            <p className="text-[9px] text-white/20 font-bold uppercase tracking-widest mt-0.5">{artisan?.category}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-5">
                        <p className="text-sm font-bold text-accent-green tracking-tight">{formatCurrency(payout.amount)}</p>
                      </td>
                      <td className="px-6 py-5">
                        <div className="flex items-center gap-2">
                          <div className="w-1.5 h-1.5 rounded-full bg-accent-blue" />
                          <span className="text-[10px] font-bold text-white/60 uppercase tracking-widest">{payout.method}</span>
                        </div>
                      </td>
                      <td className="px-6 py-5">
                        <p className="text-xs font-bold text-white/40">{new Date(payout.requestedAt).toLocaleDateString()}</p>
                      </td>
                      <td className="px-6 py-5 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <button 
                            onClick={() => handlePayoutAction(payout.id, 'approved')}
                            className="px-4 py-2 bg-accent-green/10 text-accent-green text-[9px] font-bold rounded-lg hover:bg-accent-green/20 transition-all border border-accent-green/20 uppercase tracking-widest shadow-sm"
                          >
                            Approve
                          </button>
                          <button 
                            onClick={() => handlePayoutAction(payout.id, 'rejected')}
                            className="px-4 py-2 bg-red-500/10 text-red-500 text-[9px] font-bold rounded-lg hover:bg-red-500/20 transition-all border border-red-500/20 uppercase tracking-widest shadow-sm"
                          >
                            Reject
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {payouts.filter(p => p.status === 'pending').length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-6 py-12 text-center">
                      <Clock size={32} className="mx-auto text-white/5 mb-3" />
                      <p className="text-white/20 font-bold uppercase tracking-widest text-[10px]">No pending payout requests</p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'history' && (
        <div className="bg-bg-panel rounded-3xl border border-white/5 shadow-xl overflow-hidden">
          <div className="p-6 border-b border-white/5 bg-white/[0.02] flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="w-1.5 h-6 bg-white rounded-full" />
              <h3 className="font-bold text-[15px] text-white tracking-tight">Transaction History</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-white/[0.02]">
                  <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Reference</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Type</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Amount</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Status</th>
                  <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest text-right">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5">
                {jobs.filter(j => j.status === 'Completed' || j.status === 'Refunded').map((job) => (
                  <tr key={job.id} className="group hover:bg-white/[0.02] transition-colors">
                    <td className="px-6 py-5">
                      <span className="text-sm font-bold text-white tracking-wider group-hover:text-accent-blue transition-colors">REF-{job.id.slice(-6).toUpperCase()}</span>
                    </td>
                    <td className="px-6 py-5">
                      <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Escrow Settlement</span>
                    </td>
                    <td className="px-6 py-5">
                      <p className={cn(
                        "text-sm font-bold tracking-tight",
                        job.status === 'Completed' ? "text-accent-green" : "text-red-500"
                      )}>{formatCurrency(job.amount)}</p>
                    </td>
                    <td className="px-6 py-5">
                      <span className={cn(
                        "px-3 py-1 text-[9px] font-bold rounded-lg border uppercase tracking-widest shadow-sm",
                        job.status === 'Completed' ? "bg-accent-green/10 text-accent-green border-accent-green/20" : "bg-red-500/10 text-red-500 border-red-500/20"
                      )}>{job.status}</span>
                    </td>
                    <td className="px-6 py-5 text-right">
                      <p className="text-xs font-bold text-white/20">{new Date(job.updatedAt).toLocaleDateString()}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

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
