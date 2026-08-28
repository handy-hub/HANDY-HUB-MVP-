import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, MessageSquare, User, Clock, CheckCircle, XCircle, MoreVertical, ShieldAlert, Scale, X } from 'lucide-react';
import { collection, onSnapshot, doc, updateDoc, addDoc, query, orderBy } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Dispute, Artisan, Customer } from '../types';
import { cn, formatCurrency, formatDate } from '../utils';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';

import { usePressAnimation } from '../hooks/usePressAnimation';

import { usePermissions } from '../hooks/usePermissions';

export function Disputes() {
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [artisans, setArtisans] = useState<Artisan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const { admin, hasPermission, loading: permissionsLoading } = usePermissions();
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [selectedDispute, setSelectedDispute] = useState<Dispute | null>(null);
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('all');
  const [internalNote, setInternalNote] = useState('');
  const [resolutionComment, setResolutionComment] = useState('');
  const [isResolving, setIsResolving] = useState(false);

  const mediatePress = usePressAnimation();
  const auditPress = usePressAnimation();
  const releasePress = usePressAnimation();
  const refundPress = usePressAnimation();

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  useEffect(() => {
    const unsubDisputes = onSnapshot(query(collection(db, 'disputes'), orderBy('createdAt', 'desc')), (snap) => {
      setDisputes(snap.docs.map(d => ({ id: d.id, ...d.data() } as Dispute)));
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'disputes');
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
      unsubDisputes();
      unsubArtisans();
      unsubCustomers();
    };
  }, []);

  const getArtisan = (id: string) => artisans.find(a => a.id === id);
  const getCustomer = (id: string) => customers.find(c => c.id === id);

  const handleResolve = async (disputeId: string, resolution: 'RELEASE' | 'REFUND') => {
    setIsResolving(true);
    try {
      await updateDoc(doc(db, 'disputes', disputeId), { 
        status: 'resolved',
        resolution,
        resolvedAt: new Date().toISOString(),
        resolvedBy: auth.currentUser?.uid,
        resolutionComment: resolutionComment || `Dispute resolved via ${resolution}`
      });
      
      // Log action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: auth.currentUser?.displayName || 'Admin',
        action: 'DISPUTE_RESOLUTION',
        target: disputeId,
        details: `Dispute resolved via ${resolution}. Comment: ${resolutionComment || 'No comment'}`,
        timestamp: new Date().toISOString(),
        ip: '0.0.0.0'
      });

      showToast(`Dispute resolved: ${resolution}`, 'success');
      setSelectedDispute(null);
      setResolutionComment('');
    } catch (error) {
      console.error("Failed to resolve dispute", error);
      showToast("Failed to resolve dispute", "error");
    } finally {
      setIsResolving(false);
    }
  };

  const handleSaveNote = async (disputeId: string) => {
    try {
      await updateDoc(doc(db, 'disputes', disputeId), {
        internalNotes: internalNote
      });
      showToast('Internal note saved', 'success');
    } catch (error) {
      console.error("Failed to save note", error);
      showToast("Failed to save note", "error");
    }
  };

  if (loading || permissionsLoading) return (
    <div className="flex items-center justify-center h-[calc(100vh-80px)] bg-bg-dark">
      <div className="w-12 h-12 border-4 border-white/10 border-t-accent-blue rounded-full animate-spin"></div>
    </div>
  );

  const filteredDisputes = disputes.filter(d => {
    if (filter === 'all') return true;
    return d.status === filter;
  });

  const openDisputes = disputes.filter(d => d.status === 'open');

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="space-y-6 pb-8 max-w-[1600px] mx-auto bg-bg-dark min-h-screen p-6"
    >
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-white/5 pb-6">
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-500 border border-rose-500/20">
              <Scale size={16} />
            </div>
            <p className="text-[10px] font-bold text-rose-500 uppercase tracking-[0.3em]">Arbitration Center</p>
          </div>
          <h2 className="text-[22px] font-display font-black text-white tracking-tight">Dispute Resolution</h2>
          <p className="text-[13px] text-white/40 font-medium max-w-2xl leading-relaxed">
            Mediating <span className="text-white">{openDisputes.length} active conflicts</span> across the platform.
          </p>
        </div>
        <div className="flex flex-col gap-4 items-end">
          <div className="flex flex-wrap gap-4">
            <div className="flex items-center gap-3 px-6 py-4 bg-bg-panel text-white/60 rounded-2xl text-[11px] font-bold border border-white/5 uppercase tracking-widest shadow-sm">
              <ShieldAlert size={18} className="text-rose-500" />
              SLA: 24h Response Required
            </div>
            <div className="flex items-center gap-3 px-6 py-4 bg-bg-panel text-white/60 rounded-2xl text-[11px] font-bold border border-white/5 uppercase tracking-widest shadow-sm">
              <AlertTriangle size={18} className="text-orange-500" />
              High Priority Cases: {disputes.filter(d => d.amount > 50000).length}
            </div>
          </div>
          
          <div className="flex bg-bg-panel p-1 rounded-xl border border-white/5 shadow-sm">
            {(['all', 'open', 'resolved'] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "px-6 py-2 text-[10px] font-bold uppercase tracking-widest rounded-lg transition-all",
                  filter === f ? "bg-white text-bg-dark shadow-md" : "text-white/20 hover:text-white/40"
                )}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-10">
        {filteredDisputes.map((dispute) => {
          const customer = getCustomer(dispute.customerId);
          const artisan = getArtisan(dispute.artisanId);
          const isResolved = dispute.status === 'resolved';

          return (
            <motion.div 
              key={dispute.id}
              layout
              className="bg-bg-panel rounded-[32px] border border-white/5 shadow-sm overflow-hidden hover:border-white/10 transition-all duration-500 group relative"
            >
              {/* Status Indicator */}
              <div className={cn(
                "absolute top-0 left-0 w-full h-1",
                !isResolved ? "bg-rose-500" : "bg-emerald-500"
              )} />

              <div className="p-12">
                <div className="flex flex-col xl:flex-row justify-between gap-16">
                  <div className="space-y-10 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-6">
                      <div className="flex items-center gap-6">
                        <div className="flex flex-col">
                          <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-1">Case ID</span>
                          <span className="text-sm font-bold text-white bg-black/40 px-4 py-2 rounded-xl border border-white/5 tracking-wider">#{dispute.id.slice(-8).toUpperCase()}</span>
                        </div>
                        <div className="flex flex-col">
                          <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-1">Job Reference</span>
                          <span className="text-sm font-bold text-white/40 tracking-wider">REF-{dispute.jobId.slice(-6).toUpperCase()}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className={cn(
                          "px-6 py-2.5 text-[10px] font-bold rounded-full border uppercase tracking-[0.2em] shadow-sm",
                          !isResolved 
                            ? "bg-rose-500/10 text-rose-500 border-rose-500/20" 
                            : "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                        )}>
                          {dispute.status}
                        </div>
                      </div>
                    </div>

                    <div className="space-y-6">
                      <div className="flex flex-wrap items-center gap-6">
                        <h4 className="text-3xl font-bold text-white tracking-tight leading-tight">
                          {dispute.reason}
                        </h4>
                        <div className="flex items-center gap-3 bg-emerald-500/10 px-5 py-2.5 rounded-2xl border border-emerald-500/20">
                          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                          <span className="text-sm font-bold text-emerald-500 tracking-wide">{formatCurrency(dispute.amount)} in Escrow</span>
                        </div>
                      </div>
                      <p className="text-lg text-white/40 leading-relaxed font-medium max-w-3xl">
                        {dispute.description || "No additional description provided by the claimant."}
                      </p>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                      {/* Claimant */}
                      <div className="relative group/card">
                        <div className="relative flex items-center gap-6 p-6 bg-black/20 rounded-[24px] border border-white/5 shadow-sm">
                          <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center text-white/20 border border-white/10 font-bold text-2xl shadow-sm overflow-hidden">
                            {customer?.photoURL ? (
                              <img src={customer.photoURL} alt="" className="w-full h-full object-cover" />
                            ) : (
                              customer?.name[0]
                            )}
                          </div>
                          <div>
                            <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-1.5">Claimant (Customer)</p>
                            <p className="text-lg font-bold text-white tracking-tight">{customer?.name || 'Unknown'}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <div className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                              <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Verified Account</span>
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* Respondent */}
                      <div className="relative group/card">
                        <div className="relative flex items-center gap-6 p-6 bg-black/20 rounded-[24px] border border-white/5 shadow-sm">
                          <div className="w-16 h-16 rounded-2xl bg-accent-blue/10 flex items-center justify-center text-accent-blue border border-accent-blue/20 font-bold text-2xl shadow-sm overflow-hidden">
                            {artisan?.photoURL ? (
                              <img src={artisan.photoURL} alt="" className="w-full h-full object-cover" />
                            ) : (
                              artisan?.name[0]
                            )}
                          </div>
                          <div>
                            <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-1.5">Respondent (Artisan)</p>
                            <p className="text-lg font-bold text-white tracking-tight">{artisan?.name || 'Unknown'}</p>
                            <div className="flex items-center gap-2 mt-1">
                              <div className="w-1.5 h-1.5 rounded-full bg-accent-blue" />
                              <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Service Provider</span>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="xl:w-[380px] flex flex-col justify-between gap-10 border-t xl:border-t-0 xl:border-l border-white/5 xl:pl-16 pt-12 xl:pt-0">
                    <div className="space-y-6">
                      <div className="p-8 bg-black/20 rounded-[24px] border border-white/5 space-y-6 shadow-sm">
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Created</span>
                          <span className="text-xs font-bold text-white">{formatDate(dispute.createdAt)}</span>
                        </div>
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Deadline</span>
                          <span className="text-xs font-bold text-rose-500">24h Mediation</span>
                        </div>
                        <div className="h-px bg-white/5" />
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Escrow Status</span>
                          <span className="text-xs font-bold text-emerald-500">Secured</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-4">
                        <motion.button 
                          style={mediatePress.style}
                          onMouseDown={mediatePress.onMouseDown}
                          onMouseUp={mediatePress.onMouseUp}
                          onMouseLeave={mediatePress.onMouseLeave}
                          onClick={() => {
                            setSelectedDispute(dispute);
                            setInternalNote(dispute.internalNotes || '');
                          }}
                          className="w-full flex items-center justify-center gap-4 py-5 bg-white text-bg-dark text-[11px] font-bold rounded-2xl hover:bg-white/90 transition-all shadow-lg uppercase tracking-[0.2em]"
                        >
                          <Scale size={20} />
                          Mediate Case
                        </motion.button>
                        <motion.button 
                          style={auditPress.style}
                          onMouseDown={auditPress.onMouseDown}
                          onMouseUp={auditPress.onMouseUp}
                          onMouseLeave={auditPress.onMouseLeave}
                          onClick={() => showToast('Opening evidence vault...', 'success')}
                          className="w-full flex items-center justify-center gap-4 py-5 bg-white/5 border border-white/10 text-white/60 text-[11px] font-bold rounded-2xl hover:bg-white/10 transition-all uppercase tracking-[0.2em] shadow-sm"
                        >
                          <Clock size={20} />
                          Audit Timeline
                        </motion.button>
                      </div>
                    </div>
                    
                    {!isResolved ? (
                      <div className="flex gap-4">
                        <motion.button 
                          style={releasePress.style}
                          onMouseDown={releasePress.onMouseDown}
                          onMouseUp={releasePress.onMouseUp}
                          onMouseLeave={releasePress.onMouseLeave}
                          onClick={() => handleResolve(dispute.id, 'RELEASE')}
                          className="flex-1 flex flex-col items-center justify-center gap-2 py-6 bg-emerald-500/10 text-emerald-500 text-[10px] font-bold rounded-[24px] hover:bg-emerald-500/20 transition-all border border-emerald-500/20 uppercase tracking-widest shadow-sm group/btn"
                        >
                          <CheckCircle size={24} className="mb-1 group-hover/btn:scale-110 transition-transform" />
                          Release
                        </motion.button>
                        <motion.button 
                          style={refundPress.style}
                          onMouseDown={refundPress.onMouseDown}
                          onMouseUp={refundPress.onMouseUp}
                          onMouseLeave={refundPress.onMouseLeave}
                          onClick={() => handleResolve(dispute.id, 'REFUND')}
                          className="flex-1 flex flex-col items-center justify-center gap-2 py-6 bg-rose-500/10 text-rose-500 text-[10px] font-bold rounded-[24px] hover:bg-rose-500/20 transition-all border border-rose-500/20 uppercase tracking-widest shadow-sm group/btn"
                        >
                          <XCircle size={24} className="mb-1 group-hover/btn:scale-110 transition-transform" />
                          Refund
                        </motion.button>
                      </div>
                    ) : (
                      <div className="p-8 bg-emerald-500/10 rounded-[24px] border border-emerald-500/20 text-center shadow-sm relative overflow-hidden group/resolved">
                        <div className="absolute top-0 right-0 p-2 opacity-10 group-hover/resolved:opacity-20 transition-opacity">
                          <CheckCircle size={48} className="text-emerald-500" />
                        </div>
                        <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-[0.3em] mb-3">Case Resolved</p>
                        <p className="text-xl font-bold text-white uppercase tracking-widest">{dispute.resolution}</p>
                        <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mt-4">Closed on {formatDate(dispute.resolvedAt || '')}</p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Mediation Modal */}
      <AnimatePresence>
        {selectedDispute && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedDispute(null)}
              className="absolute inset-0 bg-slate-900/20 backdrop-blur-xl"
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 40 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 40 }}
              className="bg-bg-panel w-full max-w-4xl relative z-10 overflow-hidden rounded-[40px] border border-white/10 shadow-2xl"
            >
              <div className="p-12 border-b border-white/5 flex items-center justify-between bg-black/20">
                <div className="space-y-2">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-accent-blue/10 flex items-center justify-center text-accent-blue border border-accent-blue/20">
                      <Scale size={16} />
                    </div>
                    <h3 className="text-3xl font-bold text-white tracking-tight">Case Mediation</h3>
                  </div>
                  <p className="text-[11px] font-bold text-white/20 uppercase tracking-[0.3em]">Neutral Third-Party Arbitration • ID: {selectedDispute.id.toUpperCase()}</p>
                </div>
                <button 
                  onClick={() => setSelectedDispute(null)}
                  className="p-4 text-white/20 hover:text-white transition-all bg-white/5 hover:bg-white/10 rounded-full border border-white/10 shadow-sm group"
                >
                  <X size={24} className="group-hover:rotate-90 transition-transform duration-300" />
                </button>
              </div>

              <div className="p-12 space-y-12">
                  <div className="space-y-8">
                    <div className="flex items-center justify-between">
                      <h4 className="text-[11px] font-bold text-white/20 uppercase tracking-[0.3em]">Evidence & Communication Log</h4>
                      <span className="text-[10px] font-bold text-accent-blue bg-accent-blue/10 px-4 py-1.5 rounded-full border border-accent-blue/20 uppercase tracking-widest">
                        {(selectedDispute.evidence?.length || 0) + 3} Entries Found
                      </span>
                    </div>
                    
                    <div className="space-y-6 max-h-[400px] overflow-y-auto pr-6 custom-scrollbar">
                      {/* Real Evidence */}
                      {selectedDispute.evidence?.map((log, i) => (
                        <div key={`real-${i}`} className={cn(
                          "p-8 rounded-[28px] border shadow-sm relative overflow-hidden group/log",
                          log.author === 'customer' ? "bg-white/5 border-white/10" : 
                          log.author === 'artisan' ? "bg-accent-blue/5 border-accent-blue/10" :
                          "bg-orange-500/5 border-orange-500/10 italic"
                        )}>
                          <div className="flex justify-between items-center mb-4">
                            <div className="flex items-center gap-3">
                              <div className={cn(
                                "w-2 h-2 rounded-full",
                                log.author === 'customer' ? "bg-white/20" : 
                                log.author === 'artisan' ? "bg-accent-blue" :
                                "bg-orange-500"
                              )} />
                              <span className={cn(
                                "text-[10px] font-bold uppercase tracking-[0.2em]",
                                log.author === 'customer' ? "text-white/40" : 
                                log.author === 'artisan' ? "text-accent-blue" :
                                "text-orange-500"
                              )}>{log.author}</span>
                            </div>
                            <span className="text-[10px] text-white/20 font-bold uppercase tracking-widest">{formatDate(log.timestamp)}</span>
                          </div>
                          <p className="text-base text-white/60 font-medium leading-relaxed">{log.content}</p>
                          {log.url && (
                            <div className="mt-4">
                              <img src={log.url} alt="Evidence" className="max-w-full rounded-xl border border-white/10" referrerPolicy="no-referrer" />
                            </div>
                          )}
                        </div>
                      ))}

                      {/* Mock Logs for Context */}
                      {[
                        { role: 'customer', msg: "The artisan didn't finish the piping work and left the site messy. I had to hire someone else to clean up.", time: '2 days ago', type: 'claim' },
                        { role: 'artisan', msg: "I finished the agreed work. The customer is asking for extra tasks not in the original quote without payment.", time: '1 day ago', type: 'rebuttal' },
                        { role: 'system', msg: "Escrow funds locked. Dispute initiated by customer. Mediation required.", time: '2 days ago', type: 'system' }
                      ].map((log, i) => (
                        <div key={`mock-${i}`} className={cn(
                          "p-8 rounded-[28px] border shadow-sm relative overflow-hidden group/log",
                          log.role === 'customer' ? "bg-white/5 border-white/10" : 
                          log.role === 'artisan' ? "bg-accent-blue/5 border-accent-blue/10" :
                          "bg-orange-500/5 border-orange-500/10 italic"
                        )}>
                          <div className="flex justify-between items-center mb-4">
                            <div className="flex items-center gap-3">
                              <div className={cn(
                                "w-2 h-2 rounded-full",
                                log.role === 'customer' ? "bg-white/20" : 
                                log.role === 'artisan' ? "bg-accent-blue" :
                                "bg-orange-500"
                              )} />
                              <span className={cn(
                                "text-[10px] font-bold uppercase tracking-[0.2em]",
                                log.role === 'customer' ? "text-white/40" : 
                                log.role === 'artisan' ? "text-accent-blue" :
                                "text-orange-500"
                              )}>{log.role}</span>
                            </div>
                            <span className="text-[10px] text-white/20 font-bold uppercase tracking-widest">{log.time}</span>
                          </div>
                          <p className="text-base text-white/60 font-medium leading-relaxed">{log.msg}</p>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    <div className="space-y-4">
                      <h4 className="text-[11px] font-bold text-white/20 uppercase tracking-[0.3em]">Internal Admin Notes</h4>
                      <textarea 
                        className="w-full h-32 p-6 bg-black/40 border border-white/10 rounded-[24px] text-sm font-medium text-white/60 outline-none focus:ring-2 focus:ring-white/10 focus:border-white/20 transition-all resize-none"
                        placeholder="Add internal notes visible only to admins..."
                        value={internalNote}
                        onChange={(e) => setInternalNote(e.target.value)}
                      />
                      <button 
                        onClick={() => handleSaveNote(selectedDispute.id)}
                        className="px-6 py-2.5 bg-white text-bg-dark text-[10px] font-bold rounded-xl hover:bg-white/90 transition-all shadow-sm uppercase tracking-widest"
                      >
                        Save Notes
                      </button>
                    </div>

                    <div className="space-y-4">
                      <h4 className="text-[11px] font-bold text-white/20 uppercase tracking-[0.3em]">Resolution Comment</h4>
                      <textarea 
                        className="w-full h-32 p-6 bg-black/40 border border-white/10 rounded-[24px] text-sm font-medium text-white/60 outline-none focus:ring-2 focus:ring-rose-500/10 focus:border-rose-500 transition-all resize-none"
                        placeholder="Explain the reason for this resolution (sent to both parties)..."
                        value={resolutionComment}
                        onChange={(e) => setResolutionComment(e.target.value)}
                      />
                      <p className="text-[10px] text-white/20 font-medium italic">* This comment will be included in the resolution notification.</p>
                    </div>
                  </div>

                  <div className="p-10 bg-rose-500/10 rounded-[32px] border border-rose-500/20 shadow-sm relative overflow-hidden">
                    <div className="absolute top-0 right-0 p-6 opacity-5">
                      <ShieldAlert size={80} className="text-rose-500" />
                    </div>
                    <div className="relative z-10 space-y-4">
                      <h4 className="text-[11px] font-bold text-rose-500 uppercase tracking-[0.3em]">Final Verdict Required</h4>
                      <p className="text-sm text-white/40 leading-relaxed font-medium max-w-2xl">
                        As an authorized administrator, your decision is final and legally binding within the platform's terms. This action will trigger immediate fund movement from the escrow account.
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-6">
                    <button 
                      onClick={() => handleResolve(selectedDispute.id, 'RELEASE')}
                      disabled={isResolving}
                      className="flex-1 py-6 bg-emerald-600 text-white text-[11px] font-bold rounded-2xl hover:bg-emerald-700 transition-all shadow-lg shadow-emerald-500/20 uppercase tracking-[0.2em] flex items-center justify-center gap-4 group/btn disabled:opacity-50"
                    >
                      <CheckCircle size={22} className="group-hover:scale-110 transition-transform" />
                      {isResolving ? 'Processing...' : 'Release to Artisan'}
                    </button>
                    <button 
                      onClick={() => handleResolve(selectedDispute.id, 'REFUND')}
                      disabled={isResolving}
                      className="flex-1 py-6 bg-rose-600 text-white text-[11px] font-bold rounded-2xl hover:bg-rose-700 transition-all shadow-lg shadow-rose-500/20 uppercase tracking-[0.2em] flex items-center justify-center gap-4 group/btn disabled:opacity-50"
                    >
                      <XCircle size={22} className="group-hover:scale-110 transition-transform" />
                      {isResolving ? 'Processing...' : 'Refund Customer'}
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
              "fixed bottom-12 left-1/2 z-[100] px-8 py-4 rounded-[20px] shadow-2xl flex items-center gap-4 min-w-[320px] border border-white/10 backdrop-blur-xl",
              toast.type === 'success' ? "bg-bg-panel text-white" : "bg-red-600 text-white"
            )}
          >
            <div className={cn(
              "w-2 h-2 rounded-full animate-pulse",
              toast.type === 'success' ? "bg-emerald-500" : "bg-white"
            )} />
            <span className="text-[11px] font-bold uppercase tracking-widest">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>

  );
}
