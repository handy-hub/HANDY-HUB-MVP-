import React, { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, 
  LineChart, Line, AreaChart, Area, PieChart, Pie, Cell, Legend
} from 'recharts';
import { 
  TrendingUp, TrendingDown, Users, Briefcase, Wallet, 
  AlertTriangle, Calendar, Filter, Download, RefreshCw,
  MapPin, ShieldAlert, Zap, Lock
} from 'lucide-react';
import { collection, query, onSnapshot, orderBy, limit, doc, getDoc } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { Job, Artisan, Customer, Dispute } from '../types';
import { formatCurrency, cn } from '../utils';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { Skeleton } from '../components/Skeleton';
import { StatCard } from '../components/StatCard';

const COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export function Analysis() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [artisans, setArtisans] = useState<Artisan[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState<'7d' | '30d' | '90d' | 'all'>('all');
  const [userRole, setUserRole] = useState<string | null>(null);
  const [isAuthorized, setIsAuthorized] = useState<boolean | null>(null);

  useEffect(() => {
    const checkAuth = async () => {
      if (auth.currentUser) {
        try {
          const adminDoc = await getDoc(doc(db, 'admins', auth.currentUser.uid));
          if (adminDoc.exists()) {
            const role = adminDoc.data().role;
            const email = adminDoc.data().email;
            setUserRole(role);
            
            // Normalize role for comparison
            const normalizedRole = role?.toLowerCase().replace(/[\s_]+/g, '');
            const allowedRoles = ['superadmin', 'operationsadmin', 'financeadmin', 'supportadmin'];
            
            console.log("Analysis Auth Check:", { role, normalizedRole, email: auth.currentUser.email });

            // Only Super Admin or specific roles can see full analytics
            // Fallback for the owner email
            if (allowedRoles.includes(normalizedRole) || 
                auth.currentUser.email === 'silas7korda@gmail.com' || 
                email === 'silas7korda@gmail.com' ||
                normalizedRole === 'superadmin') {
              setIsAuthorized(true);
            } else {
              setIsAuthorized(false);
            }
          } else {
            // If no admin doc exists, they shouldn't even be here, but let's be safe
            setIsAuthorized(false);
          }
        } catch (error) {
          console.error("Error checking authorization:", error);
          setIsAuthorized(false);
        }
      } else {
        setIsAuthorized(false);
      }
    };
    checkAuth();

    const unsubJobs = onSnapshot(collection(db, 'jobs'), (snap) => {
      setJobs(snap.docs.map(d => ({ id: d.id, ...d.data() } as Job)));
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
    const unsubDisputes = onSnapshot(collection(db, 'disputes'), (snap) => {
      setDisputes(snap.docs.map(d => ({ id: d.id, ...d.data() } as Dispute)));
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'disputes');
      setLoading(false);
    });

    return () => {
      unsubJobs();
      unsubArtisans();
      unsubCustomers();
      unsubDisputes();
    };
  }, []);

  if (isAuthorized === null || loading) {
    return (
      <div className="p-8 space-y-8 bg-bg-dark min-h-screen">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-12 w-64 bg-white/5" />
          <Skeleton className="h-4 w-96 bg-white/5" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-32 bg-white/5 rounded-3xl" />)}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Skeleton className="h-[400px] bg-white/5 rounded-[32px]" />
          <Skeleton className="h-[400px] bg-white/5 rounded-[32px]" />
        </div>
      </div>
    );
  }

  if (isAuthorized === false) {
    return (
      <div className="flex flex-col items-center justify-center h-[calc(100vh-80px)] space-y-6 p-8 text-center">
        <div className="w-24 h-24 bg-red-500/10 rounded-full flex items-center justify-center text-red-500">
          <Lock size={48} />
        </div>
        <div className="space-y-2">
          <h2 className="text-2xl font-bold text-white">Access Restricted</h2>
          <p className="text-white/40 max-w-md mb-4">You do not have the necessary permissions to view the Analytics Engine.</p>
          <div className="bg-white/5 rounded-xl p-4 text-left max-w-md mx-auto">
            <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-2">Debug Information</p>
            <p className="text-xs text-white/60">Role: <span className="text-white font-mono">{userRole || 'None'}</span></p>
            <p className="text-xs text-white/60">Email: <span className="text-white font-mono">{auth.currentUser?.email}</span></p>
          </div>
        </div>
      </div>
    );
  }

  // Filter data based on date range
  const filteredJobs = jobs.filter(job => {
    if (dateRange === 'all') return true;
    const date = new Date(job.createdAt);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const days = diff / (1000 * 60 * 60 * 24);
    if (dateRange === '7d') return days <= 7;
    if (dateRange === '30d') return days <= 30;
    if (dateRange === '90d') return days <= 90;
    return true;
  });

  // Process data for charts
  const jobsByCategory = filteredJobs.reduce((acc, job) => {
    acc[job.category] = (acc[job.category] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const categoryData = Object.entries(jobsByCategory).map(([name, value]) => ({ name, value }));

  const totalRevenue = filteredJobs.reduce((a, b) => a + (Number(b.amount) || 0), 0);
  const disputeRate = filteredJobs.length > 0 ? (disputes.length / filteredJobs.length) * 100 : 0;
  const avgJobValue = filteredJobs.length > 0 ? totalRevenue / filteredJobs.length : 0;

  const revenueByMonth = filteredJobs.reduce((acc, job) => {
    const date = new Date(job.createdAt);
    const month = date.toLocaleString('default', { month: 'short' });
    acc[month] = (acc[month] || 0) + (Number(job.amount) || 0);
    return acc;
  }, {} as Record<string, number>);

  const revenueData = Object.entries(revenueByMonth).map(([name, revenue]) => ({ name, revenue }));

  const userGrowthByMonth = [...artisans, ...customers].reduce((acc, user) => {
    const date = new Date(user.joined || user.createdAt);
    const month = date.toLocaleString('default', { month: 'short' });
    acc[month] = (acc[month] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  const userGrowthData = Object.entries(userGrowthByMonth).map(([name, users]) => ({ name, users }));

  const revenueByRegion: Record<string, number> = filteredJobs.reduce((acc, job) => {
    const region = job.region || 'Unknown';
    acc[region] = (acc[region] || 0) + (Number(job.amount) || 0);
    return acc;
  }, {} as Record<string, number>);

  const regionRevenueData = Object.entries(revenueByRegion).map(([name, revenue]: [string, number]) => {
    const regionJobs = filteredJobs.filter(j => (j.region || 'Unknown') === name);
    const completionRate = regionJobs.length > 0 ? (regionJobs.filter(j => j.status === 'Completed').length / regionJobs.length) * 100 : 0;
    return { name, revenue, jobs: regionJobs.length, completionRate };
  }).sort((a, b) => b.revenue - a.revenue);

  return (
    <div className="space-y-6 screen-container p-6 bg-bg-dark min-h-screen">
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <p className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] mb-1.5">Platform Intelligence</p>
          <h2 className="text-[17px] font-bold text-white tracking-tight">Analytics Engine</h2>
          <p className="text-white/40 text-[13px] mt-0.5 font-medium">Deep insights into platform performance and user behavior.</p>
        </div>
        <div className="flex gap-3">
          <select 
            className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl text-[10px] font-bold text-white/60 outline-none uppercase tracking-widest shadow-sm"
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value as any)}
          >
            <option value="7d" className="bg-bg-dark">Last 7 Days</option>
            <option value="30d" className="bg-bg-dark">Last 30 Days</option>
            <option value="90d" className="bg-bg-dark">Last 90 Days</option>
            <option value="all" className="bg-bg-dark">All Time</option>
          </select>
          <button className="px-6 py-2.5 bg-accent-blue text-white rounded-xl text-[10px] font-bold hover:bg-blue-600 transition-all flex items-center gap-2 uppercase tracking-widest shadow-lg shadow-blue-500/20">
            <Download size={14} /> Export Report
          </button>
        </div>
      </div>

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard 
          label="Total Revenue" 
          value={totalRevenue} 
          icon={Wallet} 
          color="blue" 
          trend="+12.5%" 
          changeType="up" 
          prefix="₵"
        />
        <StatCard 
          label="Active Jobs" 
          value={filteredJobs.filter(j => j.status !== 'Completed' && j.status !== 'Cancelled').length} 
          icon={Briefcase} 
          color="green" 
          trend="+5.2%" 
          changeType="up" 
        />
        <StatCard 
          label="New Artisans" 
          value={artisans.length} 
          icon={Users} 
          color="purple" 
          trend="+8.1%" 
          changeType="up" 
        />
        <StatCard 
          label="Dispute Rate" 
          value={disputeRate.toFixed(1) + '%'} 
          icon={AlertTriangle} 
          color="red" 
          trend="-2.4%" 
          changeType="down" 
        />
      </div>

      {/* Charts Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Revenue Trend */}
        <div className="bg-bg-panel border border-white/10 rounded-[32px] p-8 shadow-2xl">
          <div className="flex items-center justify-between mb-8">
            <h4 className="text-sm font-bold text-white uppercase tracking-wider">Revenue Growth</h4>
            <select className="bg-transparent text-[10px] font-bold text-white/20 outline-none uppercase tracking-widest">
              <option className="bg-bg-dark">Last 6 Months</option>
              <option className="bg-bg-dark">Last Year</option>
            </select>
          </div>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={revenueData}>
                <defs>
                  <linearGradient id="colorRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="name" stroke="rgba(255,255,255,0.2)" fontSize={10} axisLine={false} tickLine={false} />
                <YAxis stroke="rgba(255,255,255,0.2)" fontSize={10} axisLine={false} tickLine={false} tickFormatter={(value) => `₵${value}`} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#1e2023', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px', fontSize: '12px', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.5)' }}
                  itemStyle={{ color: '#fff' }}
                />
                <Area type="monotone" dataKey="revenue" stroke="#3b82f6" fillOpacity={1} fill="url(#colorRev)" strokeWidth={3} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* User Growth */}
        <div className="bg-bg-panel border border-white/10 rounded-[32px] p-8 shadow-2xl">
          <div className="flex items-center justify-between mb-8">
            <h4 className="text-sm font-bold text-white uppercase tracking-wider">User Acquisition</h4>
            <div className="flex items-center gap-2 px-3 py-1 bg-white/5 rounded-lg text-[10px] font-bold text-white/40 uppercase tracking-widest border border-white/5">
              <Users size={12} className="text-accent-purple" />
              Total: {artisans.length + customers.length}
            </div>
          </div>
          <div className="h-[300px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={userGrowthData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="name" stroke="rgba(255,255,255,0.2)" fontSize={10} axisLine={false} tickLine={false} />
                <YAxis stroke="rgba(255,255,255,0.2)" fontSize={10} axisLine={false} tickLine={false} />
                <Tooltip 
                  contentStyle={{ backgroundColor: '#1e2023', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '16px', fontSize: '12px', boxShadow: '0 20px 25px -5px rgb(0 0 0 / 0.5)' }}
                />
                <Line type="monotone" dataKey="users" stroke="#8b5cf6" strokeWidth={3} dot={{ r: 4, fill: '#8b5cf6', strokeWidth: 2, stroke: '#1e2023' }} activeDot={{ r: 6 }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Regional Performance Table */}
      <div className="card-panel overflow-hidden">
        <div className="p-5 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MapPin size={18} className="text-blue-500" />
            <h4 className="text-sm font-bold text-white uppercase tracking-wider">Regional Performance</h4>
          </div>
          <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Actionable Insights</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/5 bg-white/[0.02]">
                <th className="px-4 py-3 text-[10px] font-bold text-white/20 uppercase tracking-[0.2em]">Region</th>
                <th className="px-4 py-3 text-[10px] font-bold text-white/20 uppercase tracking-[0.2em]">Total Jobs</th>
                <th className="px-4 py-3 text-[10px] font-bold text-white/20 uppercase tracking-[0.2em]">Revenue</th>
                <th className="px-4 py-3 text-[10px] font-bold text-white/20 uppercase tracking-[0.2em]">Completion Rate</th>
                <th className="px-4 py-3 text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {regionRevenueData.map((reg, i) => (
                <tr key={i} className="hover:bg-white/[0.02] transition-colors group">
                  <td className="px-4 py-3">
                    <span className="text-[13px] font-bold text-white group-hover:text-blue-500 transition-colors">{reg.name}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[13px] font-bold text-white/40">{reg.jobs}</span>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-[13px] font-bold text-white">{formatCurrency(reg.revenue)}</span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 h-1 bg-white/5 rounded-full overflow-hidden max-w-[100px]">
                        <div 
                          className={cn(
                            "h-full rounded-full transition-all duration-1000",
                            reg.completionRate > 80 ? "bg-green-500" : reg.completionRate > 50 ? "bg-orange-500" : "bg-red-500"
                          )}
                          style={{ width: `${reg.completionRate}%` }}
                        />
                      </div>
                      <span className="text-[11px] font-bold text-white/60">{reg.completionRate.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <span className={cn(
                      "px-2 py-1 rounded-md text-[10px] font-bold uppercase tracking-widest border",
                      reg.completionRate > 80 ? "bg-green-500/10 text-green-500 border-green-500/20" : "bg-red-500/10 text-red-500 border-red-500/20"
                    )}>
                      {reg.completionRate > 80 ? 'Optimal' : 'Needs Attention'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
