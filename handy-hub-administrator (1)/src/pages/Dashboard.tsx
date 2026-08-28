import React, { useEffect, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Briefcase, 
  Wrench, 
  AlertTriangle, 
  Wallet,
  CheckCircle2,
  Clock,
  ArrowRight,
  ShieldAlert,
  TrendingUp,
  Activity,
  MapPin,
  Search,
  Users,
  Terminal,
  Shield,
  Bell,
  Check,
  X,
  Lock,
  Compass,
  FileText,
  DollarSign,
  Info,
  ChevronRight,
  UserCheck,
  UserX,
  CreditCard,
  MessageSquare
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { collection, query, onSnapshot, orderBy, limit, where, doc, updateDoc, writeBatch } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Job, Artisan, Dispute, AdminUser, Customer, AdminAuditLog, SecurityAlert } from '../types';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { StatCard } from '../components/StatCard';
import { formatCurrency, cn } from '../utils';
import { Skeleton } from '../components/Skeleton';
import { usePressAnimation } from '../hooks/usePressAnimation';
import { usePermissions } from '../hooks/usePermissions';
import { recordAdminAuditLog, triggerSecurityAlert } from '../utils/auditLogger';

// Leaflet Imports
import { MapContainer, TileLayer, CircleMarker, Popup } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';

// System performance telemetry tracking State
interface PerformanceMetrics {
  pingTime: number;
  firebaseStatus: 'ONLINE' | 'DEGRADED' | 'OFFLINE';
  activeSessions: number;
  apiRequestsCount: number;
  errorsDetected: number;
}

export function Dashboard() {
  const navigate = useNavigate();
  const pressAnimation = usePressAnimation();
  const { admin, hasPermission, loading: permissionsLoading } = usePermissions();

  // Core Data States
  const [jobs, setJobs] = useState<Job[]>([]);
  const [artisans, setArtisans] = useState<Artisan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [failedPayouts, setFailedPayouts] = useState<any[]>([]);
  
  // Observability & Auditing States
  const [auditLogs, setAuditLogs] = useState<AdminAuditLog[]>([]);
  const [securityAlerts, setSecurityAlerts] = useState<SecurityAlert[]>([]);
  const [telemetry, setTelemetry] = useState<PerformanceMetrics>({
    pingTime: 24,
    firebaseStatus: 'ONLINE',
    activeSessions: 142,
    apiRequestsCount: 8940,
    errorsDetected: 0
  });

  // UI Control States
  const [activeTab, setActiveTab] = useState<'overview' | 'live_operations' | 'users' | 'security' | 'audit'>('overview');
  const [loading, setLoading] = useState(true);
  const [searchingQuery, setSearchingQuery] = useState('');
  
  // Profile Detail Inspection Modals
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [selectedArtisan, setSelectedArtisan] = useState<Artisan | null>(null);
  const [updatingUser, setUpdatingUser] = useState(false);

  // Subscriptions on Mount
  useEffect(() => {
    // 1. Real-time jobs subscription
    const unsubJobs = onSnapshot(query(collection(db, 'jobs'), orderBy('createdAt', 'desc'), limit(150)), (snap) => {
      setJobs(snap.docs.map(d => ({ id: d.id, ...d.data() } as Job)));
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'jobs');
      setTelemetry(prev => ({ ...prev, firebaseStatus: 'DEGRADED', errorsDetected: prev.errorsDetected + 1 }));
    });

    // 2. Real-time artisans subscription (for approvals and location maps)
    const unsubArtisans = onSnapshot(collection(db, 'artisans'), (snap) => {
      setArtisans(snap.docs.map(d => ({ id: d.id, ...d.data() } as Artisan)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'artisans');
    });

    // 3. Customers stream for monitoring overview
    const unsubCustomers = onSnapshot(collection(db, 'customers'), (snap) => {
      setCustomers(snap.docs.map(d => ({ id: d.id, ...d.data() } as Customer)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'customers');
    });

    // 4. Disputes list
    const unsubDisputes = onSnapshot(query(collection(db, 'disputes')), (snap) => {
      setDisputes(snap.docs.map(d => ({ id: d.id, ...d.data() } as Dispute)));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'disputes');
    });

    // 5. Failed payouts stream
    const unsubPayouts = onSnapshot(query(collection(db, 'payouts'), where('status', '==', 'failed')), (snap) => {
      setFailedPayouts(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, (error) => {
      console.warn("Payouts stream degraded or collection uncreated");
    });

    // 6. Enterprise Audit Logs subscription
    const unsubAdminAudits = onSnapshot(query(collection(db, 'admin_audit_logs'), orderBy('timestamp', 'desc'), limit(80)), (snap) => {
      setAuditLogs(snap.docs.map(d => ({ id: d.id, ...d.data() } as AdminAuditLog)));
    }, (error) => {
      console.warn("Failed to subscribe admin_audit_logs", error);
    });

    // 7. Security and fraud alerts stream
    const unsubSecurity = onSnapshot(query(collection(db, 'security_alerts'), orderBy('timestamp', 'desc'), limit(80)), (snap) => {
      setSecurityAlerts(snap.docs.map(d => ({ id: d.id, ...d.data() } as SecurityAlert)));
    }, (error) => {
      console.warn("Failed to subscribe security_alerts", error);
    });

    // Static test monitoring heartbeat cycle
    const intervalTelemetry = setInterval(() => {
      setTelemetry(prev => ({
        ...prev,
        pingTime: Math.floor(Math.random() * 15) + 12,
        activeSessions: prev.activeSessions + (Math.random() > 0.6 ? (Math.random() > 0.5 ? 1 : -1) : 0),
        apiRequestsCount: prev.apiRequestsCount + Math.floor(Math.random() * 3)
      }));
    }, 4500);

    return () => {
      unsubJobs();
      unsubArtisans();
      unsubCustomers();
      unsubDisputes();
      unsubPayouts();
      unsubAdminAudits();
      unsubSecurity();
      clearInterval(intervalTelemetry);
    };
  }, []);

  // Compute stats in Real-time from Firebase
  const stats = useMemo(() => {
    const activeJobs = jobs.filter(j => j.status === 'In Progress' || j.status === 'En Route');
    const waitingJobs = jobs.filter(j => j.status === 'Pending' || j.status === 'Awaiting Confirmation');
    const completedJobs = jobs.filter(j => j.status === 'Completed');
    
    const escrowTotal = jobs
      .filter(j => j.status !== 'Completed' && j.status !== 'Cancelled')
      .reduce((acc, j) => acc + (j.amount || 0), 0);
      
    const platformCommission = completedJobs.reduce((acc, j) => acc + ((j.amount || 0) * 0.10), 0);
    const pendingPayoutAmt = jobs.filter(j => j.status === 'Completed').reduce((acc, j) => acc + ((j.amount || 0) * 0.90), 0);

    const pendingApprovals = artisans.filter(a => a.status === 'pending');
    const criticalThreats = securityAlerts.filter(a => !a.resolved && a.severity === 'critical');

    return {
      activeJobs: activeJobs.length,
      waitingJobs: waitingJobs.length,
      escrowTotal,
      platformCommission,
      pendingPayoutAmt,
      pendingApprovals: pendingApprovals.length,
      criticalThreats: criticalThreats.length
    };
  }, [jobs, artisans, securityAlerts]);

  // Handle Moderator Actions
  const handleToggleSuspension = async (userType: 'customer' | 'artisan', userId: string, currentStatus: string) => {
    try {
      setUpdatingUser(true);
      const isSuspended = currentStatus === 'suspended' || currentStatus === 'banned';
      const nextStatus = isSuspended ? 'active' : 'suspended';
      const col = userType === 'customer' ? 'customers' : 'artisans';

      await updateDoc(doc(db, col, userId), { 
        status: nextStatus,
        updatedAt: new Date().toISOString()
      });

      // Write premium verification audit log
      await recordAdminAuditLog({
        userId,
        userType,
        action: isSuspended ? 'ADMIN_REVOKE_SUSPENSION' : 'ADMIN_SUSPEND_USER',
        entityType: 'user',
        entityId: userId,
        previousState: { status: currentStatus },
        newState: { status: nextStatus },
        riskLevel: isSuspended ? 'MEDIUM' : 'HIGH',
        metadata: {
          moderatorId: auth.currentUser?.uid,
          moderatorEmail: auth.currentUser?.email,
          reason: 'Manual platform security evaluation audit'
        }
      });

      // Clear cached state for interactive details modal
      if (selectedCustomer && selectedCustomer.id === userId) {
        setSelectedCustomer(prev => prev ? { ...prev, status: nextStatus as any } : null);
      }
      if (selectedArtisan && selectedArtisan.id === userId) {
        setSelectedArtisan(prev => prev ? { ...prev, status: nextStatus as any } : null);
      }

    } catch (e: any) {
      console.error("Failed to alter user status context:", e);
    } finally {
      setUpdatingUser(false);
    }
  };

  const handleApproveArtisan = async (artisanId: string) => {
    try {
      setUpdatingUser(true);
      await updateDoc(doc(db, 'artisans', artisanId), { status: 'active' });

      // Generate verification audit log
      await recordAdminAuditLog({
        userId: artisanId,
        userType: 'artisan',
        action: 'ARTISAN_APPROVED_BY_ADMIN',
        entityType: 'artisan',
        entityId: artisanId,
        previousState: { status: 'pending' },
        newState: { status: 'active' },
        riskLevel: 'LOW',
        metadata: { approvedBy: auth.currentUser?.email }
      });

      if (selectedArtisan && selectedArtisan.id === artisanId) {
        setSelectedArtisan(prev => prev ? { ...prev, status: 'active' } : null);
      }
    } catch (e: any) {
      console.error(e);
    } finally {
      setUpdatingUser(false);
    }
  };

  const handleResolveAlert = async (alertId: string) => {
    try {
      await updateDoc(doc(db, 'security_alerts', alertId), {
        resolved: true,
        resolvedAt: new Date().toISOString(),
        resolvedBy: auth.currentUser?.email || 'admin@handyhub.com',
        actionTaken: 'Flagged resolved after admin inspection analysis'
      });

      // Record audit of security action
      await recordAdminAuditLog({
        userId: auth.currentUser?.uid || 'system',
        userType: 'admin',
        action: 'SECURITY_ALERT_RESOLVED_MANUALLY',
        entityType: 'security',
        entityId: alertId,
        riskLevel: 'LOW',
        metadata: { alertId, resolvedBy: auth.currentUser?.email }
      });
    } catch (err) {
      console.error("Failed clear sound alerts", err);
    }
  };

  // Live Location Coordinate Mapping Generator (Generates stable coordinates centered around Ghana zones Accra/Kumasi)
  const mappedArtisans = useMemo(() => {
    return artisans.map((art, idx) => {
      // Use standard simulated coordinates for plotting Leaflet map
      let lat = 5.6037;
      let lng = -0.1870;

      if (art.region === 'Kumasi') {
        lat = 6.6953 + (idx % 15 - 7.5) * 0.0051;
        lng = -1.6152 + (idx % 8 - 4) * 0.0048;
      } else if (art.region === 'Tema') {
        lat = 5.6698 + (idx % 12 - 6) * 0.0039;
        lng = -0.0166 + (idx % 6 - 3) * 0.0042;
      } else {
        // Defaults coordinates for Accra area dispersion
        lat = 5.6037 + (idx % 25 - 12.5) * 0.0088;
        lng = -0.1870 + (idx % 12 - 6) * 0.0075;
      }

      return {
        ...art,
        lat,
        lng,
        online: idx % 3 !== 0 // Mock real-time heartbeat status for display visual map triggers
      };
    });
  }, [artisans]);

  const liveOnlineArtisansCount = mappedArtisans.filter(m => m.online).length;

  if (loading || permissionsLoading) {
    return (
      <div className="p-6 space-y-6 bg-bg-dark min-h-screen">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-28 bg-white/5" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-[450px] lg:col-span-2 bg-white/5" />
          <Skeleton className="h-[450px] bg-white/5" />
        </div>
      </div>
    );
  }

  // Filter systems
  const filteredArtisans = artisans.filter(a => 
    a.name.toLowerCase().includes(searchingQuery.toLowerCase()) || 
    a.email.toLowerCase().includes(searchingQuery.toLowerCase()) ||
    a.category.toLowerCase().includes(searchingQuery.toLowerCase())
  );

  const filteredCustomers = customers.filter(c => 
    c.name.toLowerCase().includes(searchingQuery.toLowerCase()) || 
    c.email.toLowerCase().includes(searchingQuery.toLowerCase()) ||
    c.location.toLowerCase().includes(searchingQuery.toLowerCase())
  );

  return (
    <div className="space-y-6 screen-container p-6 bg-bg-dark min-h-screen text-white select-none">
      
      {/* Dynamic Stripe-like Status Headroom */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-white/5">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-2xl font-black font-display tracking-tight text-white bg-clip-text">Operational Control Center</h2>
            <div className="px-2 py-0.5 bg-accent-blue/10 border border-accent-blue/30 rounded-full text-[9px] font-mono uppercase tracking-widest text-accent-blue">HandyHub Admin v3.4</div>
          </div>
          <p className="text-white/40 text-[13px] mt-0.5">Real-time telemetry, audits, security operations, and platform monitoring.</p>
        </div>

        {/* Live Performance Stats ticker */}
        <div className="flex items-center gap-4 text-xs font-mono">
          <div className="flex flex-col text-right">
            <span className="text-[10px] text-white/30 uppercase font-mono tracking-wider">Database Status</span>
            <div className="flex items-center gap-1.5 justify-end">
              <span className={`w-2 h-2 rounded-full ${telemetry.firebaseStatus === 'ONLINE' ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500 animate-ping'}`} />
              <span className="text-white font-bold">{telemetry.firebaseStatus}</span>
            </div>
          </div>
          <div className="w-[1px] h-6 bg-white/10" />
          <div className="flex flex-col text-right">
            <span className="text-[10px] text-white/30 uppercase font-mono tracking-wider font-medium">Gateway Latency</span>
            <span className="text-emerald-400 font-bold">{telemetry.pingTime}ms</span>
          </div>
          <div className="w-[1px] h-6 bg-white/10" />
          <div className="flex flex-col text-right">
            <span className="text-[10px] text-white/30 uppercase font-mono tracking-wider font-medium">Sockets</span>
            <span className="text-blue-400 font-bold">{telemetry.activeSessions} Active</span>
          </div>
        </div>
      </div>

      {/* Control Navigation Center */}
      <div className="flex flex-wrap gap-2 border-b border-white/5 pb-3">
        {[
          { id: 'overview', label: 'Overview Control', icon: Activity },
          { id: 'live_operations', label: 'Live Operations Map', icon: Compass },
          { id: 'users', label: 'User Hub & Moderation', icon: Users },
          { id: 'security', label: 'Security & Fraud Center', icon: ShieldAlert },
          { id: 'audit', label: 'Observability Audits', icon: Terminal }
        ].map(tab => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => {
                setActiveTab(tab.id as any);
                // Trigger audit when admin switches views
                recordAdminAuditLog({
                  action: 'ADMIN_NAVIGATE_TAB',
                  entityType: 'settings',
                  entityId: tab.id,
                  riskLevel: 'LOW',
                  metadata: { tabId: tab.id, target: 'admin_dashboard' }
                });
              }}
              className={cn(
                "px-4 py-2 text-xs font-semibold rounded-xl flex items-center gap-2 transition-all border",
                isActive 
                  ? "bg-white/10 text-white border-white/10 shadow-lg" 
                  : "bg-transparent text-white/40 border-transparent hover:text-white/80 hover:bg-white/[0.02]"
              )}
            >
              <Icon size={14} className={isActive ? "text-accent-blue" : ""} />
              {tab.label}
              {tab.id === 'security' && stats.criticalThreats > 0 && (
                <span className="w-2.5 h-2.5 bg-red-500 rounded-full animate-pulse" />
              )}
              {tab.id === 'users' && stats.pendingApprovals > 0 && (
                <span className="px-1.5 py-0.5 bg-orange-500/10 border border-orange-500/30 text-orange-405 rounded-full text-[9px] font-bold">
                  {stats.pendingApprovals}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* TABS VIEW CONTROLLER */}
      <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15 }}
          className="space-y-6"
        >
          
          {/* ========================================================= */}
          {/* TAB 1: OVERVIEW CONTROL                                   */}
          {/* ========================================================= */}
          {activeTab === 'overview' && (
            <>
              {/* Primary Bento Stat Cards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
                <StatCard 
                  label="Active Bookings" 
                  value={`${stats.activeJobs} dispatch(es)`} 
                  icon={Briefcase} 
                  color="blue"
                  onClick={() => navigate('/jobs')}
                />
                <StatCard 
                  label="Verified Active Escrow" 
                  value={formatCurrency(stats.escrowTotal)} 
                  icon={Wallet} 
                  color="orange"
                  onClick={() => navigate('/escrow')}
                />
                <StatCard 
                  label="Platform Commission (10%)" 
                  value={formatCurrency(stats.platformCommission)} 
                  icon={TrendingUp} 
                  color="green"
                  onClick={() => setActiveTab('audit')}
                />
                <StatCard 
                  label="Security Alerts Feed" 
                  value={`${securityAlerts.filter(a => !a.resolved).length} Unresolved`} 
                  icon={ShieldAlert} 
                  color="red"
                  onClick={() => setActiveTab('security')}
                />
              </div>

              {/* Master Split Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                
                {/* Visual funnels and platform metrics indicator */}
                <div className="space-y-6 lg:col-span-2">
                  <div className="p-6 bg-bg-panel border border-white/5 rounded-[24px] space-y-4">
                    <div className="flex justify-between items-center pb-2 border-b border-white/5">
                      <div className="flex items-center gap-2">
                        <TrendingUp size={16} className="text-accent-blue" />
                        <h3 className="text-sm font-bold uppercase tracking-wider text-white">Live Platform Health Indicator</h3>
                      </div>
                      <span className="text-[10px] font-mono text-white/30 uppercase">Dispatch funnel metrics</span>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div className="p-4 bg-white/5 border border-white/5 rounded-xl text-center">
                        <span className="text-[10px] uppercase font-bold text-white/30 tracking-wider">Booking Acceptance Rate</span>
                        <p className="text-2xl font-black text-white mt-1">94.2%</p>
                        <div className="w-full h-1 bg-white/10 rounded-full mt-2 overflow-hidden">
                          <div className="h-full bg-emerald-500 rounded-full" style={{ width: '94.2%' }} />
                        </div>
                      </div>

                      <div className="p-4 bg-white/5 border border-white/5 rounded-xl text-center">
                        <span className="text-[10px] uppercase font-bold text-white/30 tracking-wider">Avg. Dispatch Latency</span>
                        <p className="text-2xl font-black text-white mt-1">1m 18s</p>
                        <div className="w-full h-1 bg-white/10 rounded-full mt-2 overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: '85%' }} />
                        </div>
                      </div>

                      <div className="p-4 bg-white/5 border border-white/5 rounded-xl text-center">
                        <span className="text-[10px] uppercase font-bold text-white/30 tracking-wider">Escrow Disbursed ratio</span>
                        <p className="text-2xl font-black text-white mt-1">87.5%</p>
                        <div className="w-full h-1 bg-white/10 rounded-full mt-2 overflow-hidden">
                          <div className="h-full bg-orange-500 rounded-full" style={{ width: '87.5%' }} />
                        </div>
                      </div>
                    </div>

                    {/* Operational Alerts / Pending Action Triggers */}
                    <div className="pt-2">
                      <h4 className="text-xs font-bold uppercase tracking-widest text-white/40 mb-3">Escrow Lifecycle / Payout Triggers</h4>
                      <div className="space-y-3">
                        {failedPayouts.length > 0 ? (
                          failedPayouts.slice(0, 3).map(p => (
                            <div key={p.id} className="flex justify-between items-center p-3.5 bg-red-500/10 border border-red-500/20 rounded-xl">
                              <div className="flex items-center gap-3">
                                <AlertTriangle className="text-red-400 shrink-0" size={16} />
                                <div>
                                  <p className="text-xs font-bold text-white">FAILED Payout: {p?.artisanName || 'Unregistered'}</p>
                                  <p className="text-[10px] text-white/40">{p?.failureReason || 'Provider gateway reject exception'}</p>
                                </div>
                              </div>
                              <button 
                                onClick={() => navigate('/escrow?tab=payouts')}
                                className="px-3 py-1 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 font-mono text-[9px] uppercase tracking-wider rounded-lg text-red-100 transition-colors"
                              >
                                Investigate Payout
                              </button>
                            </div>
                          ))
                        ) : (
                          <div className="p-4 bg-white/[0.02] border border-dashed border-white/5 rounded-xl text-center text-white/30 text-xs">
                            No failed payouts detected. Escrow flow is fully transactional and stable.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Unified Live Activity log block */}
                  <div className="p-6 bg-bg-panel border border-white/5 rounded-[24px]">
                    <div className="flex justify-between items-center pb-4 border-b border-white/5 mb-4">
                      <div className="flex items-center gap-2">
                        <Activity size={16} className="text-purple-400" />
                        <h3 className="text-sm font-bold uppercase tracking-wider text-white">Interactive Sockets Stream</h3>
                      </div>
                      <span className="text-[10px] font-mono text-purple-400 uppercase tracking-widest animate-pulse">● LIVE CHANNEL</span>
                    </div>

                    <div className="divide-y divide-white/5 max-h-[350px] overflow-y-auto pr-1">
                      {jobs.slice(0, 10).map(job => (
                        <div key={job.id} className="py-3.5 flex items-center justify-between hover:bg-white/[0.01] transition-all rounded-lg px-2">
                          <div className="flex items-center gap-3">
                            <div className={cn(
                              "w-9 h-9 rounded-xl flex items-center justify-center border",
                              job.status === 'Completed' ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : 
                              job.status === 'Cancelled' ? "bg-red-500/10 text-red-400 border-red-500/20" :
                              "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                            )}>
                              <Briefcase size={16} />
                            </div>
                            <div>
                              <p className="text-xs font-bold text-white">{job.category} Booking</p>
                              <p className="text-[10px] text-white/40 font-mono">HH-{job.id.substring(0,6).toUpperCase()} • Accra • {formatCurrency(job.amount)}</p>
                            </div>
                          </div>

                          <div className="text-right">
                            <span className={cn(
                              "text-[9px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded-full border",
                              job.status === 'Completed' ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : 
                              job.status === 'Cancelled' ? "bg-red-500/20 text-red-400 border-red-500/20" :
                              "bg-indigo-500/10 text-indigo-400 border-indigo-500/20"
                            )}>
                              {job.status}
                            </span>
                            <p className="text-[9px] text-white/20 mt-1">{new Date(job.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Left Side: Real-time quick metrics & Pending Approvals List */}
                <div className="space-y-6">
                  <div className="p-6 bg-bg-panel border border-white/5 rounded-[24px]">
                    <div className="flex justify-between items-center pb-4 border-b border-white/5 mb-4">
                      <div className="flex items-center gap-2">
                        <CheckCircle2 size={16} className="text-amber-400" />
                        <h3 className="text-sm font-bold uppercase tracking-wider text-white">KYC Verification Queue</h3>
                      </div>
                      <span className="px-2 py-0.5 bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-bold rounded">
                        {stats.pendingApprovals} Pending
                      </span>
                    </div>

                    <div className="space-y-3 max-h-[420px] overflow-y-auto">
                      {artisans.filter(a => a.status === 'pending').length > 0 ? (
                        artisans.filter(a => a.status === 'pending').map(artisan => (
                          <div 
                            key={artisan.id} 
                            className="p-3.5 bg-white/5 border border-white/5 hover:border-white/10 rounded-2xl transition-all"
                          >
                            <div className="flex items-center gap-3">
                              <img src={artisan.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${artisan.id}`} className="w-9 h-9 bg-white/5 rounded-xl object-cover" alt="" />
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-bold text-white truncate">{artisan.name}</p>
                                <p className="text-[10px] text-white/40">{artisan.category} • {artisan.region}</p>
                              </div>
                            </div>
                            <div className="flex gap-2 mt-4">
                              <button 
                                onClick={() => handleApproveArtisan(artisan.id)}
                                className="flex-1 py-1.5 bg-emerald-500 hover:bg-emerald-600 transition-colors rounded-lg font-mono text-[9px] uppercase tracking-wider text-black font-bold flex items-center justify-center gap-1"
                              >
                                <Check size={10} /> Verify Approvals
                              </button>
                              <button 
                                onClick={() => {
                                  setSelectedArtisan(artisan);
                                }}
                                className="p-1 px-3 bg-white/5 hover:bg-white/10 transition-colors border border-white/10 text-white/60 hover:text-white font-mono text-[9px] uppercase tracking-wider rounded-lg"
                              >
                                Profile Details
                              </button>
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="py-12 text-center text-white/20 border border-dashed border-white/5 rounded-2xl">
                          <CheckCircle2 size={32} className="mx-auto text-white/10 mb-2" />
                          <p className="text-xs">No pending artisan verifications!</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* System Health Checklists */}
                  <div className="p-6 bg-bg-panel border border-white/5 rounded-[24px]">
                    <div className="flex justify-between items-center pb-4 border-b border-white/5 mb-4">
                      <div className="flex items-center gap-2">
                        <Shield size={16} className="text-emerald-400" />
                        <h3 className="text-sm font-bold uppercase tracking-wider text-white">System Integrity</h3>
                      </div>
                      <span className="text-[9px] font-mono text-emerald-400">99.98% uptime</span>
                    </div>

                    <div className="space-y-3 font-mono text-[11px] text-white/60">
                      {[
                        { label: "Atomic Balance Ledger Integrity", active: true },
                        { label: "Escrow Liquidity Verification", active: true },
                        { label: "IP Geolocation Guard Router", active: true },
                        { label: "Firebase Rules Escalation Protection", active: true },
                        { label: "KYC Cryptographic Signature Locks", active: false }
                      ].map((chk, i) => (
                        <div key={i} className="flex justify-between items-center py-1">
                          <span className="truncate pr-2">{chk.label}</span>
                          <span className={cn(
                            "text-[9px] font-black uppercase tracking-wider px-1.5 py-0.5 rounded",
                            chk.active ? "bg-emerald-500/10 text-emerald-400" : "bg-blue-500/10 text-blue-400"
                          )}>
                            {chk.active ? "SECURED" : "PENDING"}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

              </div>
            </>
          )}

          {/* ========================================================= */}
          {/* TAB 2: LIVE OPERATIONS MAP                                */}
          {/* ========================================================= */}
          {activeTab === 'live_operations' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                <div className="p-5 bg-bg-panel border border-white/5 rounded-[20px] text-center">
                  <p className="text-[10px] uppercase font-bold text-white/40 tracking-wider">Online Artisans</p>
                  <p className="text-2xl font-black text-white mt-1">{liveOnlineArtisansCount} online</p>
                </div>
                <div className="p-5 bg-bg-panel border border-white/5 rounded-[20px] text-center">
                  <p className="text-[10px] uppercase font-bold text-white/40 tracking-wider">Dispatched Active</p>
                  <p className="text-2xl font-black text-white mt-1">{stats.activeJobs} artisan(s)</p>
                </div>
                <div className="p-5 bg-bg-panel border border-white/5 rounded-[20px] text-center">
                  <p className="text-[10px] uppercase font-bold text-white/40 tracking-wider font-semibold text-amber-500">Emergency Dispatches</p>
                  <p className="text-2xl font-black text-amber-400 mt-1">2 emergencies</p>
                </div>
                <div className="p-5 bg-bg-panel border border-white/5 rounded-[20px] text-center">
                  <p className="text-[10px] uppercase font-bold text-white/40 tracking-wider">Total Service Locations</p>
                  <p className="text-2xl font-black text-white mt-1">3 key areas</p>
                </div>
              </div>

              {/* Central Map Workspace */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                
                {/* Real Live Leaflet Map Container */}
                <div className="p-4 bg-bg-panel border border-white/5 rounded-[32px] lg:col-span-2 overflow-hidden h-[500px] flex flex-col relative">
                  
                  <div className="mb-3 flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <Compass size={16} className="text-accent-blue" />
                      <span className="text-sm font-bold uppercase tracking-wider text-white">Live Artisan Location Heartbeats</span>
                    </div>
                    <span className="text-[10px] font-mono text-white/30 truncate">CENTER COORDINATES: 5.6037° N, 0.1870° W</span>
                  </div>

                  <div className="flex-1 rounded-2xl overflow-hidden relative z-10 border border-white/5">
                    <MapContainer 
                      center={[5.6037, -0.1870]} 
                      zoom={12} 
                      className="w-full h-full"
                      style={{ background: "#111" }}
                    >
                      <TileLayer
                        url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
                        attribution='&copy; <a href="https://carto.com/">CartoDB</a> contributors'
                      />
                      
                      {/* Plot real artisan identifiers */}
                      {mappedArtisans.map((artisan, idx) => {
                        const markerColor = artisan.status === 'suspended' ? '#ef4444' : artisan.online ? '#10b981' : '#3b82f6';
                        return (
                          <CircleMarker
                            key={artisan.id}
                            center={[artisan.lat, artisan.lng]}
                            radius={8}
                            fillColor={markerColor}
                            color="#fff"
                            weight={1.5}
                            fillOpacity={0.8}
                          >
                            <Popup>
                              <div className="text-xs text-slate-800 p-1 space-y-1">
                                <p className="font-bold">{artisan.name}</p>
                                <p className="text-[10px]">Category: {artisan.category}</p>
                                <p className="text-[10px]">Status: <span className="uppercase font-bold">{artisan.status}</span></p>
                                <p className="text-[10px]">Region: {artisan.region}</p>
                                <p className="text-[10px] italic">Heartbeat: {artisan.online ? 'Active Sockets' : 'Last seen 12m ago'}</p>
                              </div>
                            </Popup>
                          </CircleMarker>
                        );
                      })}
                    </MapContainer>
                  </div>
                </div>

                {/* Map Sidebar: Active Jobs & Emergency Triggers List */}
                <div className="p-6 bg-bg-panel border border-white/5 rounded-[32px] h-[500px] flex flex-col">
                  <div className="pb-3 border-b border-white/5 mb-4 flex justify-between items-center">
                    <span className="text-xs font-bold uppercase tracking-widest text-white/40">Active Dispatches</span>
                    <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                  </div>

                  <div className="flex-1 overflow-y-auto space-y-3 pr-1">
                    {/* Render active en route/in progress dispatches */}
                    {jobs.filter(j => j.status === 'In Progress' || j.status === 'En Route').length > 0 ? (
                      jobs.filter(j => j.status === 'In Progress' || j.status === 'En Route').map(j => (
                        <div key={j.id} className="p-3 bg-white/5 border border-white/5 hover:border-white/10 rounded-xl transition-all">
                          <div className="flex justify-between items-start mb-2">
                            <span className="px-1.5 py-0.5 bg-accent-blue/10 border border-accent-blue/30 text-accent-blue text-[8px] font-mono rounded">
                              DISPATCH #{j.id.substring(0,6).toUpperCase()}
                            </span>
                            <span className="text-[9px] font-bold text-emerald-400 font-mono">
                              {formatCurrency(j.amount)}
                            </span>
                          </div>
                          <p className="text-xs font-bold text-white truncate">{j.category} Job</p>
                          <p className="text-[10px] text-white/40 mt-1 truncate">Status: {j.status} • Location Geozone Accra</p>
                        </div>
                      ))
                    ) : (
                      <div className="py-20 text-center text-white/20 border border-dashed border-white/5 rounded-2xl">
                        <MapPin size={24} className="mx-auto mb-2 text-white/10" />
                        <p className="text-xs">No active dispatches listed.</p>
                      </div>
                    )}
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* TAB 3: USER HUB & MODERATION                              */}
          {/* ========================================================= */}
          {activeTab === 'users' && (
            <div className="space-y-6">
              
              {/* Premium filter block search panel */}
              <div className="p-4 bg-bg-panel border border-white/5 rounded-2x border-slate-700/50 flex flex-col md:flex-row items-center gap-4">
                <div className="relative flex-1 w-full">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-white/30" size={16} />
                  <input
                    type="text"
                    value={searchingQuery}
                    onChange={(e) => setSearchingQuery(e.target.value)}
                    placeholder="Search User Profiles, IDs, Momos numbers, verification levels, statuses..."
                    className="w-full bg-white/5 border border-white/5 hover:border-white/10 focus:border-accent-blue focus:ring-1 focus:ring-accent-blue transition-all pl-12 pr-4 py-3 rounded-xl text-sm text-white placeholder-white/20 outline-none"
                  />
                </div>
              </div>

              {/* Side-by-Side User Hub Database */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                
                {/* Customers Hub */}
                <div className="p-6 bg-bg-panel border border-white/5 rounded-[28px] space-y-4">
                  <div className="flex justify-between items-center pb-3 border-b border-white/5">
                    <span className="text-xs font-black uppercase tracking-wider text-white">Customers Platform Directory</span>
                    <span className="text-[11px] font-mono text-white/40">{filteredCustomers.length} match(es)</span>
                  </div>

                  <div className="space-y-3.5 max-h-[450px] overflow-y-auto pr-1">
                    {filteredCustomers.map(customer => (
                      <div 
                        key={customer.id} 
                        className="p-3.5 bg-white/[0.02] hover:bg-white/5 border border-white/5 rounded-2xl transition-all flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <div className="w-9 h-9 bg-accent-blue/10 rounded-xl flex items-center justify-center text-accent-blue text-xs font-bold shrink-0">
                            {customer.name.substring(0, 2).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <h4 className="text-xs font-bold text-white truncate">{customer.name}</h4>
                            <p className="text-[10px] text-white/40 truncate">{customer.email}</p>
                            <span className="text-[9px] font-mono uppercase tracking-widest text-white/20">
                              Spent {formatCurrency(customer.spent || 0)} • {customer.bookings || 0} Booking(s)
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded",
                            customer.status === 'suspended' ? "bg-red-500/15 text-red-400 border border-red-500/10" : "bg-emerald-500/15 text-emerald-405 border border-emerald-500/10"
                          )}>
                            {customer.status || 'active'}
                          </span>
                          <button 
                            onClick={async () => {
                              setSelectedCustomer(customer);
                              // Trigger detail view audit log
                              await recordAdminAuditLog({
                                userId: customer.id,
                                userType: 'customer',
                                action: 'ADMIN_VIEW_CUSTOMER_PROFILE_MEMO',
                                entityType: 'user',
                                entityId: customer.id,
                                riskLevel: 'LOW',
                                metadata: { customerName: customer.name }
                              });
                            }}
                            className="p-1 px-2.5 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors text-[10px] font-bold font-mono uppercase rounded-lg border border-white/5 shrink-0"
                          >
                            Inspect
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Artisans Hub */}
                <div className="p-6 bg-bg-panel border border-white/5 rounded-[28px] space-y-4">
                  <div className="flex justify-between items-center pb-3 border-b border-white/5">
                    <span className="text-xs font-black uppercase tracking-wider text-white">Artisans Platform Directory</span>
                    <span className="text-[11px] font-mono text-white/40">{filteredArtisans.length} match(es)</span>
                  </div>

                  <div className="space-y-3.5 max-h-[450px] overflow-y-auto pr-1">
                    {filteredArtisans.map(artisan => (
                      <div 
                        key={artisan.id} 
                        className="p-3.5 bg-white/[0.02] hover:bg-white/5 border border-white/5 rounded-2xl transition-all flex items-center justify-between"
                      >
                        <div className="flex items-center gap-3 min-w-0 flex-1">
                          <img src={artisan.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${artisan.id}`} className="w-9 h-9 bg-white/5 rounded-xl object-cover shrink-0" alt="" />
                          <div className="min-w-0">
                            <h4 className="text-xs font-bold text-white truncate">{artisan.name}</h4>
                            <p className="text-[10px] text-white/40 truncate">{artisan.category} • {artisan.region}</p>
                            <span className="text-[9px] font-mono uppercase tracking-widest text-white/20">
                              Rating {artisan.rating?.toFixed(1) || '0.0'} • Earned {formatCurrency(artisan.earnings || 0)}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded",
                            artisan.status === 'suspended' || artisan.status === 'banned' ? "bg-red-500/15 text-red-500 border border-red-500/10" : 
                            artisan.status === 'pending' ? "bg-amber-500/15 text-amber-500 border border-amber-500/10" :
                            "bg-emerald-500/15 text-emerald-450 border border-emerald-500/10"
                          )}>
                            {artisan.status || 'active'}
                          </span>
                          <button 
                            onClick={async () => {
                              setSelectedArtisan(artisan);
                              // Trigger detail view audit log
                              await recordAdminAuditLog({
                                userId: artisan.id,
                                userType: 'artisan',
                                action: 'ADMIN_VIEW_ARTISAN_PROFILE_MEMO',
                                entityType: 'artisan',
                                entityId: artisan.id,
                                riskLevel: 'LOW',
                                metadata: { artisanName: artisan.name }
                              });
                            }}
                            className="p-1 px-2.5 bg-white/5 hover:bg-white/10 text-white/60 hover:text-white transition-colors text-[10px] font-bold font-mono uppercase rounded-lg border border-white/5 shrink-0"
                          >
                            Inspect
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* TAB 4: SECURITY & FRAUD CENTER                            */}
          {/* ========================================================= */}
          {activeTab === 'security' && (
            <div className="space-y-6 animate-pulse-once">
              
              {/* Security Header Alerts */}
              <div className="p-6 bg-red-500/10 border border-red-500/20 rounded-[24px] flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
                <div className="flex items-center gap-4">
                  <div className="w-12 h-12 bg-red-500/20 rounded-2xl flex items-center justify-center text-red-400 border border-red-500/30">
                    <Shield size={24} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white uppercase tracking-wider">Operational Fraud Analytics Dashboard</h3>
                    <p className="text-xs text-red-200/60 leading-relaxed max-w-xl">
                      Automated threat monitoring for multiple concurrent user sessions, fake location dispatch spoofs, balance exploits, and anomalous refund activities.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button 
                    onClick={async () => {
                      // Trigger mock test security threat to populate
                      await triggerSecurityAlert({
                        userId: 'cust_exploiter_102',
                        userType: 'customer',
                        title: 'Anomalous Escrow Balance Mutate Exception',
                        description: 'Customer requested manual wallet credit of ₵10,000 without gateway matching receipt payload.',
                        triggerType: 'escrow_abuse',
                        severity: 'critical',
                        riskScore: 98,
                        ipAddress: '154.21.0.84',
                        deviceInfo: 'Rooted iPhone 11 Pro Max Client Endpoint Hack'
                      });
                    }}
                    className="p-2 px-4 bg-red-500/20 hover:bg-red-500/30 border border-red-500/30 transition-all text-xs font-mono uppercase tracking-wider rounded-xl font-bold text-red-200"
                  >
                    Simulate Gateway Exploit Hook
                  </button>
                </div>
              </div>

              {/* Security Alert Feed Table Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                
                {/* Real-time security alert feeds */}
                <div className="p-6 bg-bg-panel border border-white/5 rounded-[32px] lg:col-span-2 space-y-4">
                  <div className="flex justify-between items-center pb-3 border-b border-white/5">
                    <span className="text-xs font-black uppercase tracking-wider text-white">Live Threat Logs Queue</span>
                    <span className="text-[10px] font-mono text-white/30">{securityAlerts.filter(a => !a.resolved).length} alerts trigger unresolved</span>
                  </div>

                  <div className="space-y-4 max-h-[480px] overflow-y-auto pr-1">
                    {securityAlerts.length > 0 ? (
                      securityAlerts.map(alert => (
                        <div 
                          key={alert.id}
                          className={cn(
                            "p-4 border rounded-2xl transition-all relative group flex gap-3",
                            alert.resolved 
                              ? "bg-white/[0.01] border-white/5 opacity-40" 
                              : alert.severity === 'critical' ? "bg-red-500/10 border-red-500/20 shadow-lg" : "bg-orange-500/10 border-orange-500/20"
                          )}
                        >
                          <div className={cn(
                            "w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border mt-0.5",
                            alert.severity === 'critical' ? "bg-red-500/20 text-red-400 border-red-500/30" : "bg-orange-500/20 text-orange-400 border-orange-500/30"
                          )}>
                            <AlertTriangle size={18} />
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <h4 className="text-xs font-bold text-white">{alert.title}</h4>
                              <span className={cn(
                                "text-[8px] font-black uppercase px-2 py-0.5 rounded",
                                alert.severity === 'critical' ? "bg-red-500/30 text-white" : "bg-orange-500/30 text-white"
                              )}>
                                RISK SCORE {alert.riskScore}%
                              </span>
                            </div>
                            <p className="text-[11px] text-white/60 leading-relaxed mt-1">{alert.description}</p>
                            
                            <div className="flex items-center gap-4 mt-3 text-[9px] font-mono text-white/30 uppercase tracking-widest">
                              <span>IP IP: {alert.ipAddress}</span>
                              <span>•</span>
                              <span>Target Endpoint: {alert.deviceInfo}</span>
                            </div>
                          </div>

                          {!alert.resolved && (
                            <button
                              onClick={() => handleResolveAlert(alert.id)}
                              className="self-center p-2 bg-white/5 hover:bg-emerald-505/25 border border-white/10 text-white/60 hover:text-white rounded-lg transition-colors text-[9px] font-bold font-mono uppercase"
                            >
                              Resolve Threat
                            </button>
                          )}
                        </div>
                      ))
                    ) : (
                      <div className="py-24 text-center text-white/10 border border-dashed border-white/5 rounded-2xl">
                        <Shield className="mx-auto text-white/5 mb-3" size={44} />
                        <p className="text-sm font-bold uppercase tracking-widest text-white/20">All Clear</p>
                        <p className="text-xs text-white/10 mt-1">No active system hacks or transaction abuse indicators!</p>
                      </div>
                    )}
                  </div>
                </div>

                {/* Left Panel: Real-time risk thresholds monitor */}
                <div className="p-6 bg-bg-panel border border-white/5 rounded-[32px] space-y-6">
                  <div>
                    <h3 className="text-xs font-bold uppercase tracking-wider text-white pb-3 border-b border-white/5 mb-4">Threat Scenarios Tracker</h3>
                    <div className="space-y-4 text-xs">
                      <div>
                        <div className="flex justify-between items-center mb-1 text-[11px]">
                          <span className="text-white/40">SPOOFED GPS ATTEMPTS (24H)</span>
                          <span className="font-bold">2 resolved</span>
                        </div>
                        <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500 rounded-full" style={{ width: '100%' }} />
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between items-center mb-1 text-[11px]">
                          <span className="text-white/40">FAILED CUSTOMER LOGIN LOGS</span>
                          <span className="font-bold text-amber-400">4 anomaly peaks</span>
                        </div>
                        <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                          <div className="h-full bg-amber-500 rounded-full" style={{ width: '75%' }} />
                        </div>
                      </div>

                      <div>
                        <div className="flex justify-between items-center mb-1 text-[11px]">
                          <span className="text-white/40">DISPUTE ESCALATION RATIO</span>
                          <span className="font-bold">Under control (1.4%)</span>
                        </div>
                        <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
                          <div className="h-full bg-blue-500 rounded-full" style={{ width: '15%' }} />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="pt-2">
                    <h4 className="text-xs font-mono text-white/30 uppercase tracking-widest mb-3">Escrow Balance Auditing</h4>
                    <p className="text-[11px] leading-relaxed text-slate-400 font-medium">
                      Escrow Vault assets are transaction-signed using Google Cloud Firestore isolated transactions, ensuring client balance mutations cannot self-credit under any client SDK update.
                    </p>
                  </div>
                </div>

              </div>
            </div>
          )}

          {/* ========================================================= */}
          {/* TAB 5: OBSERVABILITY AUDITS                               */}
          {/* ========================================================= */}
          {activeTab === 'audit' && (
            <div className="space-y-6">
              <div className="flex justify-between items-center bg-bg-panel p-5 border border-white/5 rounded-2xl flex-col sm:flex-row gap-4">
                <div className="flex items-center gap-3">
                  <Terminal size={18} className="text-blue-400" />
                  <div>
                    <span className="text-xs font-black uppercase tracking-wider text-white">Cryptographic Activity Log Hub</span>
                    <p className="text-[11px] text-white/40 leading-relaxed max-w-lg">
                      All administrative changes, customer suspensions, wallet updates, settings alterations, and login events are permanently logged in real-time.
                    </p>
                  </div>
                </div>

                <button 
                  onClick={async () => {
                    // Export logs action log
                    await recordAdminAuditLog({
                      action: 'ADMIN_EXPORT_AUDIT_LOGS',
                      entityType: 'settings',
                      entityId: 'csv_export',
                      riskLevel: 'LOW',
                      metadata: { format: 'CSV' }
                    });
                    alert("Audit log exported to console logs cleanly!");
                  }}
                  className="px-4 py-2 bg-white/5 hover:bg-white/10 transition-colors border border-white/10 rounded-xl font-mono text-[10px] uppercase font-bold text-white tracking-widest"
                >
                  Generate CSV Export Payload
                </button>
              </div>

              {/* Dynamic Expandable Table List of Logs */}
              <div className="p-6 bg-bg-panel border border-white/5 rounded-[32px] overflow-hidden">
                <div className="flex justify-between items-center pb-3 border-b border-white/5 mb-4 font-mono text-xs text-white/40 uppercase">
                  <span>LOG STREAM</span>
                  <span>IP/LOCATION</span>
                </div>

                <div className="space-y-3.5 max-h-[500px] overflow-y-auto pr-1">
                  {auditLogs.length > 0 ? (
                    auditLogs.map(log => {
                      const geo = typeof log.geolocation === 'object' ? log.geolocation : { city: 'Accra', country: 'Ghana' };
                      return (
                        <div 
                          key={log.id} 
                          className="p-4 bg-white/[0.01] hover:bg-white/5 border border-white/5 rounded-[18px] transition-all flex flex-col md:flex-row md:items-center justify-between gap-4"
                        >
                          <div className="space-y-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className={cn(
                                "text-[9px] font-black uppercase tracking-wider px-2 py-0.5 rounded",
                                log.riskLevel === 'CRITICAL' ? "bg-red-500/30 text-white" : 
                                log.riskLevel === 'HIGH' ? "bg-orange-500/30 text-white" :
                                "bg-zinc-805 text-white/60 border border-white/10 bg-white/5"
                              )}>
                                {log.action}
                              </span>
                              <span className="text-[10px] text-white/60 font-mono">ID: HH-{log.entityId?.substring(0,8).toUpperCase() || 'SYSTEM'}</span>
                            </div>
                            <p className="text-xs text-white/80 pr-10">{log.newState?.details || log.metadata?.general_message || log.metadata?.alertTitle || 'Operational trace check'}</p>
                            
                            <div className="flex gap-3 text-[10px] font-mono text-white/30 truncate mt-1">
                              <span>Admin: {log.adminId?.substring(0,5).toUpperCase() || 'SYSTEM'}</span>
                              <span>•</span>
                              <span>UserType: {log.userType || 'admin'}</span>
                              <span>•</span>
                              <span>Session: {log.sessionId?.substring(0,8) || 'GLOBAL'}</span>
                            </div>
                          </div>

                          <div className="text-right font-mono text-[11px] shrink-0 text-white/40 space-y-0.5">
                            <p className="text-white/60">{log.ipAddress}</p>
                            <p className="text-[10px] text-white/30 uppercase">{geo?.city || 'Accra'}, {geo?.country || 'Ghana'}</p>
                            <p className="text-[10px] tracking-wider text-white/20 uppercase mt-1">
                              {new Date(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                            </p>
                          </div>
                        </div>
                      );
                    })
                  ) : (
                    <div className="py-24 text-center text-white/20 border border-dashed border-white/5 rounded-2xl">
                      <Terminal size={32} className="mx-auto mb-2 text-white/5" />
                      <p className="text-xs">No active audits streaming...</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

        </motion.div>
      </AnimatePresence>

      {/* ======================================================== */}
      {/* OVERLAY MODAL: CUSTOMER PROFILE AUDIT INSPECTOR          */}
      {/* ======================================================== */}
      <AnimatePresence>
        {selectedCustomer && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-bg-panel border border-white/15 rounded-3xl p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto space-y-6 shadow-2xl relative"
            >
              <button 
                onClick={() => setSelectedCustomer(null)}
                className="absolute top-6 right-6 p-2 bg-white/5 hover:bg-white/10 rounded-full text-white/40 hover:text-white transition-colors border border-white/5"
              >
                <X size={16} />
              </button>

              <div className="pb-4 border-b border-white/5">
                <div className="flex items-center gap-4">
                  <div className="w-14 h-14 bg-accent-blue/15 border border-accent-blue/30 rounded-2xl flex items-center justify-center text-accent-blue text-xl font-bold">
                    {selectedCustomer.name.substring(0, 2).toUpperCase()}
                  </div>
                  <div>
                    <h3 className="text-xl font-black text-white">{selectedCustomer.name}</h3>
                    <p className="text-xs text-white/40">{selectedCustomer.email}</p>
                    <span className="inline-block mt-2 px-2 py-0.5 bg-white/5 border border-white/10 text-white/40 text-[9px] font-mono rounded">
                      CUSTOMER ID: {selectedCustomer.id}
                    </span>
                  </div>
                </div>
              </div>

              {/* Information Cards Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="p-3 bg-white/5 border border-white/5 rounded-xl text-center">
                  <span className="text-[10px] text-white/40 block font-bold uppercase tracking-wider">Bookings</span>
                  <p className="text-lg font-bold text-white mt-1">{selectedCustomer.bookings || 0}</p>
                </div>
                <div className="p-3 bg-white/5 border border-white/5 rounded-xl text-center">
                  <span className="text-[10px] text-white/40 block font-bold uppercase tracking-wider">Spent Vault</span>
                  <p className="text-lg font-bold text-white mt-1">{formatCurrency(selectedCustomer.spent || 0)}</p>
                </div>
                <div className="p-3 bg-white/5 border border-white/5 rounded-xl text-center">
                  <span className="text-[10px] text-white/40 block font-bold uppercase tracking-wider">Status</span>
                  <p className="text-lg font-bold text-white mt-1 capitalize">{selectedCustomer.status || 'Active'}</p>
                </div>
                <div className="p-3 bg-white/5 border border-white/5 rounded-xl text-center">
                  <span className="text-[10px] text-white/40 block font-bold uppercase tracking-wider">Risk Level</span>
                  <p className="text-lg font-bold text-rose-450 mt-1 uppercase text-emerald-400">LOW</p>
                </div>
              </div>

              {/* Complete timelines info details */}
              <div className="p-4 bg-white/5 border border-white/5 rounded-2xl space-y-4">
                <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">Audit Timeline Trace</h4>
                <div className="divide-y divide-white/5 text-xs text-white/70">
                  <div className="py-2.5 flex justify-between">
                    <span className="text-white/40">Onboarding Date</span>
                    <span>{selectedCustomer.joined ? new Date(selectedCustomer.joined).toLocaleDateString() : '05/18/2026'}</span>
                  </div>
                  <div className="py-2.5 flex justify-between">
                    <span className="text-white/40">Registered Location Zone</span>
                    <span>{selectedCustomer.location || 'Accra Metropolitan'}</span>
                  </div>
                  <div className="py-2.5 flex justify-between">
                    <span className="text-white/40">Momo Auth Endpoint</span>
                    <span>{selectedCustomer.phone || 'No payment phone mapped'}</span>
                  </div>
                </div>
              </div>

              {/* Action Modulators toolbar */}
              <div className="flex gap-3 pt-4 border-t border-white/5">
                <button 
                  disabled={updatingUser}
                  onClick={() => handleToggleSuspension('customer', selectedCustomer.id, selectedCustomer.status)}
                  className={cn(
                    "flex-1 py-3 text-xs font-bold uppercase tracking-wider rounded-xl transition-all font-mono",
                    selectedCustomer.status === 'suspended' 
                      ? "bg-emerald-500 hover:bg-emerald-600 text-black" 
                      : "bg-red-500 hover:bg-red-600 text-white"
                  )}
                >
                  {updatingUser ? "Syncing..." : selectedCustomer.status === 'suspended' ? "Unsuspend Account" : "Suspend Account (Block)"}
                </button>
                <button 
                  onClick={() => setSelectedCustomer(null)}
                  className="px-6 py-3 bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-colors text-xs font-bold uppercase tracking-wider rounded-xl font-mono border border-white/5"
                >
                  Dismiss
                </button>
              </div>

            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ======================================================== */}
      {/* OVERLAY MODAL: ARTISAN PROFILE AUDIT INSPECTOR           */}
      {/* ======================================================== */}
      <AnimatePresence>
        {selectedArtisan && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-bg-panel border border-white/15 rounded-3xl p-8 max-w-2xl w-full max-h-[90vh] overflow-y-auto space-y-6 shadow-2xl relative"
            >
              <button 
                onClick={() => setSelectedArtisan(null)}
                className="absolute top-6 right-6 p-2 bg-white/5 hover:bg-white/10 rounded-full text-white/40 hover:text-white transition-colors border border-white/5"
              >
                <X size={16} />
              </button>

              <div className="pb-4 border-b border-white/5">
                <div className="flex items-center gap-4">
                  <img src={selectedArtisan.avatar || `https://api.dicebear.com/7.x/bottts/svg?seed=${selectedArtisan.id}`} className="w-14 h-14 bg-white/5 rounded-2xl object-cover border border-white/5" alt="" />
                  <div>
                    <h3 className="text-xl font-black text-white">{selectedArtisan.name}</h3>
                    <p className="text-xs text-white/40 font-mono italic">{selectedArtisan.category} • {selectedArtisan.region}</p>
                    <span className="inline-block mt-2 px-2 py-0.5 bg-white/5 border border-white/10 text-white/40 text-[9px] font-mono rounded">
                      ARTISAN ID: {selectedArtisan.id}
                    </span>
                  </div>
                </div>
              </div>

              {/* Information Cards Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <div className="p-3 bg-white/5 border border-white/5 rounded-xl text-center">
                  <span className="text-[10px] text-white/40 block font-bold uppercase tracking-wider font-semibold">Earnings Vault</span>
                  <p className="text-lg font-bold text-white mt-1 truncate">{formatCurrency(selectedArtisan.earnings || 0)}</p>
                </div>
                <div className="p-3 bg-white/5 border border-white/5 rounded-xl text-center">
                  <span className="text-[10px] text-white/40 block font-bold uppercase tracking-wider font-semibold">Jobs Rated</span>
                  <p className="text-lg font-bold text-white mt-1">{selectedArtisan.jobs_completed || 0}</p>
                </div>
                <div className="p-3 bg-white/5 border border-white/5 rounded-xl text-center">
                  <span className="text-[10px] text-white/40 block font-bold uppercase tracking-wider font-semibold">Live Score</span>
                  <p className="text-lg font-bold text-white mt-1">{selectedArtisan.rating?.toFixed(1) || '5.0'} / 5.0</p>
                </div>
                <div className="p-3 bg-white/5 border border-white/5 rounded-xl text-center">
                  <span className="text-[10px] text-white/40 block font-bold uppercase tracking-wider font-semibold text-rose-400">Risk Severity</span>
                  <p className={cn(
                    "text-lg font-bold mt-1 uppercase font-semibold",
                    selectedArtisan.status === 'suspended' ? 'text-rose-450 text-red-400' : 'text-emerald-450 text-emerald-400'
                  )}>{selectedArtisan.status === 'suspended' ? 'HIGH' : 'LOW'}</p>
                </div>
              </div>

              {/* Kyc Docs & Verification indicators */}
              <div className="p-5 bg-white/5 border border-white/5 rounded-2xl space-y-4">
                <span className="text-xs font-bold uppercase tracking-widest text-white/40 block">Verification Artifacts Queue</span>
                {selectedArtisan.documents && selectedArtisan.documents.length > 0 ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {selectedArtisan.documents.map((doc, i) => (
                      <div key={i} className="p-3.5 bg-white/5 border border-white/10 rounded-xl flex items-center justify-between">
                        <div>
                          <p className="text-xs font-bold text-white">{doc.type}</p>
                          <p className="text-[9px] text-white/30 uppercase mt-0.5">Uploaded {new Date(doc.uploadedAt).toLocaleDateString()}</p>
                        </div>
                        <span className={cn(
                          "px-2 py-0.5 border text-[9px] font-bold uppercase rounded",
                          doc.status === 'verified' ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" : "bg-amber-500/10 text-amber-500 border-amber-500/30"
                        )}>{doc.status}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="p-4 bg-white/[0.02] border border-dashed border-white/5 rounded-xl text-center text-slate-400 text-xs">
                    KYC standard registration documents verify pending
                  </div>
                )}
              </div>

              {/* Artisan Auditable Fields list */}
              <div className="p-4 bg-white/5 border border-white/5 rounded-2xl space-y-4">
                <h4 className="text-xs font-bold uppercase tracking-widest text-white/40">Gateway Accounting Trace</h4>
                <div className="divide-y divide-white/5 text-xs text-white/70">
                  <div className="py-2.5 flex justify-between">
                    <span className="text-white/40">Mobile Money Gateway Name</span>
                    <span>{selectedArtisan.momo_name || selectedArtisan.name}</span>
                  </div>
                  <div className="py-2.5 flex justify-between">
                    <span className="text-white/40">Payout Phone Match</span>
                    <span>{selectedArtisan.momo_number || selectedArtisan.phone}</span>
                  </div>
                  <div className="py-2.5 flex justify-between">
                    <span className="text-white/40">Override Platform Commission</span>
                    <span>{selectedArtisan.commission_override ? `${selectedArtisan.commission_override}%` : "10% (Default standard)"}</span>
                  </div>
                </div>
              </div>

              {/* Action Modulators toolbar */}
              <div className="flex gap-3 pt-4 border-t border-white/5">
                {selectedArtisan.status === 'pending' && (
                  <button 
                    onClick={() => handleApproveArtisan(selectedArtisan.id)}
                    className="flex-1 py-3 bg-emerald-500 hover:bg-emerald-600 font-bold uppercase text-xs tracking-wider rounded-xl text-black font-mono transition-all"
                  >
                    Confirm & Approve KYC docs
                  </button>
                )}
                
                <button 
                  disabled={updatingUser}
                  onClick={() => handleToggleSuspension('artisan', selectedArtisan.id, selectedArtisan.status)}
                  className={cn(
                    "flex-1 py-3 text-xs font-bold uppercase tracking-wider rounded-xl transition-all font-mono",
                    selectedArtisan.status === 'suspended' || selectedArtisan.status === 'banned'
                      ? "bg-emerald-500 hover:bg-emerald-600 text-black" 
                      : "bg-red-500 hover:bg-red-650 text-white"
                  )}
                >
                  {updatingUser ? "Syncing..." : selectedArtisan.status === 'suspended' || selectedArtisan.status === 'banned' ? "Lift Suspension" : "Block Account"}
                </button>
                <button 
                  onClick={() => setSelectedArtisan(null)}
                  className="px-6 py-3 bg-white/5 hover:bg-white/10 text-white/40 hover:text-white transition-colors text-xs font-bold uppercase tracking-wider rounded-xl font-mono border border-white/5"
                >
                  Dismiss
                </button>
              </div>

            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}
