import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Save, Shield, Percent, Clock, Phone, Globe, Plus, Trash2, Edit2,
  CreditCard, MapPin, Bell, FileText, Settings as SettingsIcon, 
  AlertTriangle, Check, X, ChevronRight, Info, Database, Loader2, Mail,
  Lock, Fingerprint, Key, ShieldCheck, History, Activity, ShieldAlert, Search,
  Users, UserCheck, Briefcase, Calendar, MessageSquare, Zap, Terminal, Cpu,
  Languages, Timer, ShieldQuestion, CreditCard as PaymentIcon,
  Smartphone, DollarSign, Server
} from 'lucide-react';
import { useNavigate, useLocation } from 'react-router-dom';
import { doc, onSnapshot, updateDoc, collection, addDoc, deleteDoc, setDoc, query, orderBy } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { PlatformSettings, Region } from '../types';
import { DEFAULT_SETTINGS } from '../constants/defaultSettings';
import { cn } from '../utils';
import { seedDatabase } from '../services/seed';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { usePressAnimation } from '../hooks/usePressAnimation';
import { notificationService } from '../services/notificationService';
import { ConfirmModal } from '../components/ConfirmModal';

type MainSection = 
  | 'general'
  | 'users'
  | 'artisans'
  | 'marketplace'
  | 'financials'
  | 'security'
  | 'communications'
  | 'audit'
  | 'advanced'
  | 'regions'
  | 'api';

const AVAILABLE_PERMISSIONS = [
  { id: 'all', label: 'All Access' },
  { id: 'jobs', label: 'Manage Jobs' },
  { id: 'artisans', label: 'Manage Artisans' },
  { id: 'customers', label: 'Manage Customers' },
  { id: 'payments', label: 'Manage Payments' },
  { id: 'commission', label: 'Manage Commission' },
  { id: 'payouts', label: 'Manage Payouts' },
  { id: 'disputes', label: 'Manage Disputes' },
  { id: 'notifications', label: 'Manage Notifications' },
  { id: 'settings', label: 'Manage Settings' },
];

import GhanaMap from '../components/GhanaMap';

const GHANA_REGIONS = [
  { name: 'Greater Accra', code: 'GA' },
  { name: 'Ashanti', code: 'AS' },
  { name: 'Western', code: 'W' },
  { name: 'Eastern', code: 'E' },
  { name: 'Central', code: 'C' },
  { name: 'Volta', code: 'V' },
  { name: 'Northern', code: 'N' },
  { name: 'Upper East', code: 'UE' },
  { name: 'Upper West', code: 'UW' },
  { name: 'Bono', code: 'B' },
  { name: 'Bono East', code: 'BE' },
  { name: 'Ahafo', code: 'AH' },
  { name: 'Savannah', code: 'S' },
  { name: 'North East', code: 'NE' },
  { name: 'Oti', code: 'O' },
  { name: 'Western North', code: 'WN' }
];

export function Settings() {
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const activeSection = (searchParams.get('section') as MainSection) || 'general';

  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [artisans, setArtisans] = useState<any[]>([]);
  const [jobs, setJobs] = useState<any[]>([]);
  const [regions, setRegions] = useState<Region[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [activeSubSection, setActiveSubSection] = useState<string>('general');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [auditLogs, setAuditLogs] = useState<any[]>([]);
  const [auditFilter, setAuditFilter] = useState({ admin: '', action: '', search: '' });
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

  const setActiveSection = (section: MainSection) => {
    navigate(`/settings?section=${section}`);
  };

  // Role Management State
  const [showRoleModal, setShowRoleModal] = useState(false);
  const [editingRole, setEditingRole] = useState<any>(null);
  const [roleForm, setRoleForm] = useState({ name: '', permissions: [] as string[] });
  const [isRoleSaving, setIsRoleSaving] = useState(false);

  const savePress = usePressAnimation();
  const seedPress = usePressAnimation();

  // Region Management State
  const [showRegionModal, setShowRegionModal] = useState(false);
  const [editingRegion, setEditingRegion] = useState<Region | null>(null);
  const [regionForm, setRegionForm] = useState({ name: '', code: '', active: true });
  const [isRegionSaving, setIsRegionSaving] = useState(false);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3000);
  };

  const updateSettings = (path: string, value: any) => {
    if (!settings) return;
    const newSettings = JSON.parse(JSON.stringify(settings));
    const parts = path.split('.');
    let current: any = newSettings;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) current[parts[i]] = {};
      current = current[parts[i]];
    }
    current[parts[parts.length - 1]] = value;
    setSettings(newSettings);
  };

  useEffect(() => {
    let settingsLoaded = false;
    let regionsLoaded = false;
    let artisansLoaded = false;
    let jobsLoaded = false;
    let auditLoaded = false;

    const checkLoaded = () => {
      if (settingsLoaded && regionsLoaded && artisansLoaded && jobsLoaded && auditLoaded) {
        setLoading(false);
      }
    };

    const unsubSettings = onSnapshot(doc(db, 'settings', 'platform'), (snap) => {
      if (snap.exists()) {
        const data = snap.data() as PlatformSettings;
        setSettings({ ...DEFAULT_SETTINGS, ...data });
      } else {
        // If document doesn't exist, use defaults so user can see the UI
        setSettings(DEFAULT_SETTINGS);
      }
      settingsLoaded = true;
      checkLoaded();
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'settings/platform');
      settingsLoaded = true;
      checkLoaded();
    });

    const unsubArtisans = onSnapshot(collection(db, 'artisans'), (snap) => {
      setArtisans(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      artisansLoaded = true;
      checkLoaded();
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'artisans');
      artisansLoaded = true;
      checkLoaded();
    });

    const unsubJobs = onSnapshot(collection(db, 'jobs'), (snap) => {
      setJobs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      jobsLoaded = true;
      checkLoaded();
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'jobs');
      jobsLoaded = true;
      checkLoaded();
    });

    const unsubRegions = onSnapshot(query(collection(db, 'regions'), orderBy('name')), (snap) => {
      setRegions(snap.docs.map(d => ({ id: d.id, ...d.data() } as Region)));
      regionsLoaded = true;
      checkLoaded();
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'regions');
      regionsLoaded = true;
      checkLoaded();
    });

    const unsubAudit = onSnapshot(query(collection(db, 'audit_logs'), orderBy('timestamp', 'desc')), (snap) => {
      setAuditLogs(snap.docs.map(d => ({ id: d.id, ...d.data() })));
      auditLoaded = true;
      checkLoaded();
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'audit_logs');
      auditLoaded = true;
      checkLoaded();
    });

    return () => {
      unsubSettings();
      unsubArtisans();
      unsubJobs();
      unsubRegions();
      unsubAudit();
    };
  }, []);

  // Calculate regional data dynamically
  const regionalData = regions.reduce((acc, region) => {
    acc[region.name] = { artisans: 0, active_jobs: 0, revenue: 0, growth: '+0%' };
    return acc;
  }, {} as { [key: string]: any });

  artisans.forEach(artisan => {
    const region = artisan.region || 'Unknown';
    if (regionalData[region]) {
      regionalData[region].artisans += 1;
    }
  });

  jobs.forEach(job => {
    const artisan = artisans.find(a => a.id === job.artisanId);
    if (artisan && artisan.region && regionalData[artisan.region]) {
      if (['In Progress', 'En Route', 'Awaiting Confirmation'].includes(job.status)) {
        regionalData[artisan.region].active_jobs += 1;
      }
      if (job.status === 'Completed') {
        regionalData[artisan.region].revenue += job.amount;
      }
    }
  });

  const handleSave = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await setDoc(doc(db, 'settings', 'platform'), settings as any);
      
      // Log action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: auth.currentUser?.displayName || 'Admin',
        action: 'SETTINGS_UPDATE',
        details: 'Global platform settings updated',
        timestamp: new Date().toISOString(),
        ip: '0.0.0.0'
      });

      showToast('Settings saved successfully', 'success');

      // Notify other admins
      notificationService.sendGlobalNotification(
        'Platform Settings Updated',
        `Global platform settings were updated by ${auth.currentUser?.displayName || 'an administrator'}.`,
        'warning',
        'system'
      );
    } catch (error) {
      console.error('Error saving settings:', error);
      showToast('Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveRegion = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsRegionSaving(true);
    try {
      if (editingRegion) {
        await updateDoc(doc(db, 'regions', editingRegion.id), {
          ...regionForm
        });
        showToast('Region updated successfully');
      } else {
        const id = regionForm.name.toLowerCase().replace(/\s+/g, '-');
        await setDoc(doc(db, 'regions', id), {
          ...regionForm,
          id,
          createdAt: new Date().toISOString()
        });
        showToast('Region added successfully');
      }
      setShowRegionModal(false);
      setEditingRegion(null);
      setRegionForm({ name: '', code: '', active: true });
    } catch (error) {
      console.error('Error saving region:', error);
      showToast('Failed to save region', 'error');
    } finally {
      setIsRegionSaving(false);
    }
  };

  const handleDeleteRegion = async (id: string) => {
    setConfirmModal({
      isOpen: true,
      title: 'Delete Region',
      message: 'Are you sure you want to delete this region? This may affect existing data.',
      variant: 'danger',
      onConfirm: () => performDeleteRegion(id)
    });
  };

  const performDeleteRegion = async (id: string) => {
    try {
      await deleteDoc(doc(db, 'regions', id));
      showToast('Region deleted successfully');
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `regions/${id}`);
      showToast('Failed to delete region', 'error');
    } finally {
      setConfirmModal(prev => ({ ...prev, isOpen: false }));
    }
  };

  const handleSaveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings) return;
    setIsRoleSaving(true);
    try {
      let newRoles = [...settings.security.roles];
      if (editingRole) {
        newRoles = newRoles.map(r => r.id === editingRole.id ? { ...r, ...roleForm } : r);
      } else {
        newRoles.push({
          id: `role-${Date.now()}`,
          ...roleForm
        });
      }
      
      const newSettings = {
        ...settings,
        security: {
          ...settings.security,
          roles: newRoles
        }
      };
      
      await setDoc(doc(db, 'settings', 'platform'), newSettings as any);
      setSettings(newSettings);
      showToast(editingRole ? 'Role updated' : 'Role created');
      setShowRoleModal(false);
      setEditingRole(null);
      setRoleForm({ name: '', permissions: [] });
    } catch (error) {
      console.error('Error saving role:', error);
      showToast('Failed to save role', 'error');
    } finally {
      setIsRoleSaving(false);
    }
  };

  const handleDeleteRole = async (roleId: string) => {
    if (!settings) return;
    setConfirmModal({
      isOpen: true,
      title: 'Delete Role',
      message: 'Are you sure you want to delete this role?',
      variant: 'danger',
      onConfirm: () => performDeleteRole(roleId)
    });
  };

  const performDeleteRole = async (roleId: string) => {
    if (!settings) return;
    try {
      const newRoles = settings.security.roles.filter(r => r.id !== roleId);
      const newSettings = {
        ...settings,
        security: {
          ...settings.security,
          roles: newRoles
        }
      };
      await setDoc(doc(db, 'settings', 'platform'), newSettings as any);
      setSettings(newSettings);
      showToast('Role deleted');
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, 'settings/platform');
      showToast('Failed to delete role', 'error');
    } finally {
      setConfirmModal(prev => ({ ...prev, isOpen: false }));
    }
  };
  const handleSeed = async () => {
    setConfirmModal({
      isOpen: true,
      title: 'Seed Database',
      message: 'This will populate the database with initial data. Continue?',
      variant: 'warning',
      onConfirm: performSeed
    });
  };

  const performSeed = async () => {
    setSeeding(true);
    try {
      await seedDatabase();
      showToast('Database seeded successfully', 'success');
    } catch (error) {
      console.error('Seeding failed', error);
      showToast('Seeding failed', 'error');
    } finally {
      setSeeding(false);
      setConfirmModal(prev => ({ ...prev, isOpen: false }));
    }
  };

  if (loading) return (
    <div className="flex items-center justify-center h-[calc(100vh-80px)] bg-bg-dark">
      <div className="w-10 h-10 border-4 border-white/10 border-t-accent-blue rounded-full animate-spin"></div>
    </div>
  );

  const isFullyInitialized = settings && 
    settings.general && 
    settings.users && 
    settings.artisans && 
    settings.marketplace && 
    settings.financials && 
    settings.security && 
    settings.communications && 
    settings.audit && 
    settings.advanced;

  if (!isFullyInitialized) return (
    <div className="max-w-7xl mx-auto p-12 text-center space-y-8">
      <div className="relative">
        <div className="absolute inset-0 bg-accent-blue/20 blur-[100px] rounded-full" />
        <div className="relative w-24 h-24 bg-white/5 rounded-[32px] flex items-center justify-center mx-auto text-white/20 border border-white/10 shadow-2xl">
          <SettingsIcon size={48} />
        </div>
      </div>
      <div className="space-y-3 relative">
        <h2 className="text-4xl font-bold text-white tracking-tight">Platform Setup Required</h2>
        <p className="text-white/40 max-w-lg mx-auto text-lg leading-relaxed">
          The core platform parameters have not been initialized. To activate the system and enable all administrative features, please run the initialization sequence.
        </p>
      </div>
      <div className="flex flex-col items-center gap-4 relative">
        <motion.button 
          {...seedPress}
          onClick={handleSeed}
          disabled={seeding}
          className="px-10 py-5 bg-white text-black rounded-[24px] font-bold hover:bg-slate-200 transition-all shadow-2xl shadow-white/10 flex items-center gap-3 text-lg"
        >
          {seeding ? (
            <>
              <Loader2 className="animate-spin" size={24} />
              Initializing...
            </>
          ) : (
            <>
              <Zap size={24} className="fill-current" />
              Initialize Platform
            </>
          )}
        </motion.button>
        <p className="text-[10px] font-bold text-white/20 uppercase tracking-[0.3em]">Estimated time: &lt; 5 seconds</p>
      </div>
    </div>
  );

  const mainSections: { id: MainSection; label: string; icon: React.ElementType }[] = [
    { id: 'general', label: 'General System', icon: SettingsIcon },
    { id: 'users', label: 'User Management', icon: Users },
    { id: 'artisans', label: 'Artisan Management', icon: Briefcase },
    { id: 'marketplace', label: 'Marketplace Logic', icon: Calendar },
    { id: 'financials', label: 'Financial Systems', icon: DollarSign },
    { id: 'security', label: 'Security & Privacy', icon: Shield },
    { id: 'communications', label: 'Communication Hub', icon: Bell },
    { id: 'regions', label: 'Operational Regions', icon: Globe },
    { id: 'api', label: 'API & Webhooks', icon: Terminal },
    { id: 'audit', label: 'Audit & Compliance', icon: History },
    { id: 'advanced', label: 'Advanced Controls', icon: Cpu },
  ];

  return (
    <>
      <div className="min-h-screen bg-bg-dark flex flex-col">
      <div className="max-w-7xl mx-auto w-full pb-6">
        <div className="flex items-center justify-between gap-4 mb-6 pt-6">
          <div>
            <h2 className="text-2xl font-bold text-white tracking-tight capitalize">{activeSection.replace('_', ' ')}</h2>
            <p className="text-white/40 text-[13px] mt-0.5">Manage business rules and system parameters.</p>
          </div>
          <div className="flex gap-2">
            <motion.button 
              {...seedPress}
              onClick={handleSeed}
              disabled={seeding}
              className="px-4 py-2 bg-white/5 border border-white/10 rounded-lg text-[12px] font-bold text-white/60 hover:bg-white/10 transition-all flex items-center gap-2 shadow-sm"
            >
              <Database size={14} /> {seeding ? 'Seeding...' : 'Seed Data'}
            </motion.button>
            <motion.button 
              {...savePress}
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 bg-white text-black rounded-lg text-[12px] font-bold hover:bg-white/90 transition-all shadow-sm flex items-center gap-2"
            >
              <Save size={14} /> {saving ? 'Saving...' : 'Save Settings'}
            </motion.button>
          </div>
        </div>
        
        <div className="flex-1 min-w-0 space-y-4">
        <motion.div
          key={activeSection}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          className="bg-black/20 backdrop-blur-md rounded-3xl border border-white/10 shadow-2xl p-8"
        >
          <div className="mb-6 flex items-center justify-between">
            <div>
              <h3 className="text-[15px] font-bold text-white capitalize">{activeSection.replace('_', ' ')} Configuration</h3>
              <p className="text-white/40 text-[12px] mt-0.5">Configure parameters for {activeSection.replace('_', ' ')} module.</p>
            </div>
            {activeSection === 'security' && (
              <div className="flex items-center gap-2 px-2.5 py-1 bg-white/5 border border-white/10 rounded-lg">
                <ShieldCheck size={12} className="text-white/60" />
                <span className="text-[9px] font-bold text-white/60 uppercase tracking-widest">Security Active</span>
              </div>
            )}
          </div>

          <div className="space-y-6">
            {settings && activeSection === 'general' && (
              <div className="space-y-4 max-w-4xl">
                <div className="p-4 bg-white/5 border border-white/5 rounded-xl space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[14px] font-bold text-white">Maintenance Mode</p>
                      <p className="text-[12px] text-white/40">Disable platform access for all users except admins.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('general.maintenance_mode', !settings.general.maintenance_mode)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.general.maintenance_mode ? "bg-red-600" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                        settings.general.maintenance_mode ? "left-5.5" : "left-0.5"
                      )} />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">App Availability</label>
                      <select 
                        value={settings.general.app_availability}
                        onChange={(e) => updateSettings('general.app_availability', e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      >
                        <option value="public">Public (Open to all)</option>
                        <option value="invite_only">Private (Invite only)</option>
                        <option value="closed">Closed</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Default Language</label>
                      <select 
                        value={settings.general.default_language}
                        onChange={(e) => updateSettings('general.default_language', e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      >
                        <option value="en">English</option>
                        <option value="fr">French</option>
                        <option value="es">Spanish</option>
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Timezone</label>
                      <input 
                        type="text"
                        value={settings.general.timezone}
                        onChange={(e) => updateSettings('general.timezone', e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                        placeholder="UTC"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Support Email</label>
                      <input 
                        type="email"
                        value={settings.general.support_email}
                        onChange={(e) => updateSettings('general.support_email', e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                        placeholder="support@artisan.com"
                      />
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Support Phone</label>
                    <input 
                      type="text"
                      value={settings.general.support_phone}
                      onChange={(e) => updateSettings('general.support_phone', e.target.value)}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      placeholder="+1234567890"
                    />
                  </div>
                </div>
              </div>
            )}

            {settings && activeSection === 'users' && (
              <div className="space-y-4 max-w-4xl">
                <div className="p-4 bg-white/5 border border-white/5 rounded-xl space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[14px] font-bold text-white">Allow Registration</p>
                      <p className="text-[12px] text-white/40">Enable or disable new user signups.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('users.allow_registration', !settings.users.allow_registration)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.users.allow_registration ? "bg-accent-blue" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                        settings.users.allow_registration ? "left-5.5" : "left-0.5"
                      )} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[14px] font-bold text-white">Email Verification</p>
                      <p className="text-[12px] text-white/40">Require users to verify their email address.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('users.require_email_verification', !settings.users.require_email_verification)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.users.require_email_verification ? "bg-accent-blue" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                        settings.users.require_email_verification ? "left-5.5" : "left-0.5"
                      )} />
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Max Login Attempts</label>
                      <input 
                        type="number"
                        value={settings.users.max_failed_login_attempts}
                        onChange={(e) => updateSettings('users.max_failed_login_attempts', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Deletion Grace Period (Days)</label>
                      <input 
                        type="number"
                        value={settings.users.account_deletion_grace_period_days}
                        onChange={(e) => updateSettings('users.account_deletion_grace_period_days', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {settings && activeSection === 'artisans' && (
              <div className="space-y-6 max-w-4xl">
                <div className="p-4 bg-white/5 border border-white/5 rounded-xl space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/5">
                      <div>
                        <p className="text-[13px] font-bold text-white">Allow Registration</p>
                      </div>
                      <button 
                        onClick={() => updateSettings('artisans.allow_new_registrations', !settings.artisans.allow_new_registrations)}
                        className={cn(
                          "w-10 h-5 rounded-full transition-all relative",
                          settings.artisans.allow_new_registrations ? "bg-accent-blue" : "bg-white/20"
                        )}
                      >
                        <div className={cn(
                          "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                          settings.artisans.allow_new_registrations ? "left-5.5" : "left-0.5"
                        )} />
                      </button>
                    </div>

                    <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/5">
                      <div>
                        <p className="text-[13px] font-bold text-white">Require Verification</p>
                      </div>
                      <button 
                        onClick={() => updateSettings('artisans.require_verification', !settings.artisans.require_verification)}
                        className={cn(
                          "w-10 h-5 rounded-full transition-all relative",
                          settings.artisans.require_verification ? "bg-accent-blue" : "bg-white/20"
                        )}
                      >
                        <div className={cn(
                          "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                          settings.artisans.require_verification ? "left-5.5" : "left-0.5"
                        )} />
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Max Active Jobs</label>
                      <input 
                        type="number"
                        value={settings.artisans.max_active_jobs}
                        onChange={(e) => updateSettings('artisans.max_active_jobs', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Broadcast Radius (KM)</label>
                      <input 
                        type="number"
                        value={settings.artisans.broadcast_radius_km}
                        onChange={(e) => updateSettings('artisans.broadcast_radius_km', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Commission Rate (%)</label>
                      <input 
                        type="number"
                        value={settings.artisans.commission_rate}
                        onChange={(e) => updateSettings('artisans.commission_rate', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                    <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/5 self-end">
                      <div>
                        <p className="text-[13px] font-bold text-white">Enable Wallet</p>
                      </div>
                      <button 
                        onClick={() => updateSettings('artisans.enable_wallet', !settings.artisans.enable_wallet)}
                        className={cn(
                          "w-10 h-5 rounded-full transition-all relative",
                          settings.artisans.enable_wallet ? "bg-accent-blue" : "bg-white/20"
                        )}
                      >
                        <div className={cn(
                          "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                          settings.artisans.enable_wallet ? "left-5.5" : "left-0.5"
                        )} />
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h4 className="text-lg font-bold text-white">Service Categories</h4>
                    <button 
                      onClick={() => {
                        const newCats = [...settings.artisans.categories, { id: `cat-${Date.now()}`, name: 'New Category', icon: '🛠️', active: true, base_price: 50 }];
                        updateSettings('artisans.categories', newCats);
                      }}
                      className="flex items-center gap-2 px-4 py-2 bg-white text-black text-xs font-bold rounded-xl hover:bg-white/90 transition-all shadow-sm"
                    >
                      <Plus size={14} /> Add Category
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {settings.artisans.categories.map((cat, idx) => (
                      <div key={cat.id} className="p-4 bg-white/5 border border-white/5 rounded-xl space-y-4 hover:border-white/10 transition-all">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-white/5 border border-white/10 rounded-xl flex items-center justify-center text-xl">
                              {cat.icon}
                            </div>
                            <input 
                              type="text"
                              className="bg-transparent font-bold text-white outline-none focus:ring-2 focus:ring-white/10 rounded px-1 w-32"
                              value={cat.name}
                              onChange={(e) => {
                                const newCats = [...settings.artisans.categories];
                                newCats[idx].name = e.target.value;
                                updateSettings('artisans.categories', newCats);
                              }}
                            />
                          </div>
                          <button 
                            onClick={() => {
                              const newCats = settings.artisans.categories.filter((_, i) => i !== idx);
                              updateSettings('artisans.categories', newCats);
                            }}
                            className="p-2 text-white/20 hover:text-red-500 transition-colors"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                        <div className="space-y-3">
                          <div>
                            <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest mb-1 block">Base Price</label>
                            <input 
                              type="number"
                              className="w-full px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-sm font-bold text-white outline-none focus:ring-2 focus:ring-white/10"
                              value={cat.base_price}
                              onChange={(e) => {
                                const newCats = [...settings.artisans.categories];
                                newCats[idx].base_price = Number(e.target.value);
                                updateSettings('artisans.categories', newCats);
                              }}
                            />
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-bold text-white/40 uppercase">{cat.active ? 'Active' : 'Hidden'}</span>
                            <button 
                              onClick={() => {
                                const newCats = [...settings.artisans.categories];
                                newCats[idx].active = !newCats[idx].active;
                                updateSettings('artisans.categories', newCats);
                              }}
                              className={cn(
                                "w-10 h-5 rounded-full transition-all relative",
                                cat.active ? "bg-accent-blue" : "bg-white/20"
                              )}
                            >
                              <div className={cn(
                                "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                                cat.active ? "left-5.5" : "left-0.5"
                              )} />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {settings && activeSection === 'marketplace' && (
              <div className="space-y-6 max-w-4xl">
                <div className="p-4 bg-white/5 border border-white/5 rounded-xl space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Auto-Cancel (Min)</label>
                      <input 
                        type="number"
                        value={settings.marketplace.auto_cancel_minutes}
                        onChange={(e) => updateSettings('marketplace.auto_cancel_minutes', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Acceptance Timeout (Min)</label>
                      <input 
                        type="number"
                        value={settings.marketplace.artisan_acceptance_timeout_minutes}
                        onChange={(e) => updateSettings('marketplace.artisan_acceptance_timeout_minutes', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Buffer Time (Min)</label>
                      <input 
                        type="number"
                        value={settings.marketplace.buffer_time_between_jobs_minutes}
                        onChange={(e) => updateSettings('marketplace.buffer_time_between_jobs_minutes', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Featured Listing Price</label>
                      <input 
                        type="number"
                        value={settings.marketplace.featured_listing_price}
                        onChange={(e) => updateSettings('marketplace.featured_listing_price', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between p-3 bg-white/5 rounded-lg border border-white/5">
                    <div>
                      <p className="text-[13px] font-bold text-white">Auto-Reassign on Timeout</p>
                      <p className="text-[11px] text-white/40">Automatically find new artisan if timeout reached.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('marketplace.auto_reassign_on_timeout', !settings.marketplace.auto_reassign_on_timeout)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.marketplace.auto_reassign_on_timeout ? "bg-accent-blue" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                        settings.marketplace.auto_reassign_on_timeout ? "left-5.5" : "left-0.5"
                      )} />
                    </button>
                  </div>
                </div>
              </div>
            )}

            {settings && activeSection === 'financials' && (
              <div className="space-y-6 max-w-4xl">
                <div className="p-4 bg-white/5 border border-white/5 rounded-xl space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Currency Code</label>
                      <input 
                        type="text"
                        value={settings.financials.currency}
                        onChange={(e) => updateSettings('financials.currency', e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Currency Symbol</label>
                      <input 
                        type="text"
                        value={settings.financials.currency_symbol}
                        onChange={(e) => updateSettings('financials.currency_symbol', e.target.value)}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Global Commission (%)</label>
                      <input 
                        type="number"
                        value={settings.financials.global_commission_rate}
                        onChange={(e) => updateSettings('financials.global_commission_rate', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Call-out Fee</label>
                      <input 
                        type="number"
                        value={settings.financials.call_out_fee}
                        onChange={(e) => updateSettings('financials.call_out_fee', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Min Job Value</label>
                      <input 
                        type="number"
                        value={settings.financials.min_job_value}
                        onChange={(e) => updateSettings('financials.min_job_value', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-[11px] font-bold text-white/40 uppercase tracking-widest">Min Withdrawal</label>
                      <input 
                        type="number"
                        value={settings.financials.min_withdrawal_amount}
                        onChange={(e) => updateSettings('financials.min_withdrawal_amount', Number(e.target.value))}
                        className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-[13px] text-white outline-none focus:border-accent-blue/50 transition-colors"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {settings && activeSection === 'communications' && (
              <div className="space-y-6 max-w-4xl">
                <div className="p-4 bg-white/5 border border-white/5 rounded-xl space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[14px] font-bold text-white">Email Notifications</p>
                      <p className="text-[12px] text-white/40">Send system alerts via email.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('communications.email_notifications', !settings.communications.email_notifications)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.communications.email_notifications ? "bg-accent-blue" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                        settings.communications.email_notifications ? "left-5.5" : "left-0.5"
                      )} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[14px] font-bold text-white">Push Notifications</p>
                      <p className="text-[12px] text-white/40">Send real-time alerts to mobile apps.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('communications.push_notifications', !settings.communications.push_notifications)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.communications.push_notifications ? "bg-accent-blue" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                        settings.communications.push_notifications ? "left-5.5" : "left-0.5"
                      )} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[14px] font-bold text-white">SMS Notifications</p>
                      <p className="text-[12px] text-white/40">Critical alerts via SMS.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('communications.sms_notifications', !settings.communications.sms_notifications)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.communications.sms_notifications ? "bg-accent-blue" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                        settings.communications.sms_notifications ? "left-5.5" : "left-0.5"
                      )} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[14px] font-bold text-white">Admin Alerts</p>
                      <p className="text-[12px] text-white/40">Notify admins of critical system events.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('communications.admin_alerts', !settings.communications.admin_alerts)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.communications.admin_alerts ? "bg-accent-blue" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                        settings.communications.admin_alerts ? "left-5.5" : "left-0.5"
                      )} />
                    </button>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[14px] font-bold text-white">Enable Chat</p>
                      <p className="text-[12px] text-white/40">Allow in-app messaging between users and artisans.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('communications.enable_chat', !settings.communications.enable_chat)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.communications.enable_chat ? "bg-accent-blue" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all",
                        settings.communications.enable_chat ? "left-5.5" : "left-0.5"
                      )} />
                    </button>
                  </div>
                </div>
              </div>
            )}


            {settings && activeSection === 'regions' && (
              <div className="space-y-6 max-w-4xl">
                <div className="flex items-center justify-between">
                    <h4 className="text-lg font-bold text-white">Operational Regions</h4>
                    <div className="flex items-center gap-3">
                      <select 
                        onChange={async (e) => {
                          const regionName = e.target.value;
                          if (!regionName) return;
                          
                          const regionCode = GHANA_REGIONS.find(r => r.name === regionName)?.code || '';
                          const id = regionName.toLowerCase().replace(/\s+/g, '-');
                          
                          // Check if region already exists
                          if (regions.some(r => r.id === id)) {
                            showToast('Region already added', 'error');
                            return;
                          }

                          setIsRegionSaving(true);
                          try {
                            const path = `regions/${id}`;
                            await setDoc(doc(db, 'regions', id), {
                              name: regionName,
                              code: regionCode,
                              active: true,
                              id,
                              createdAt: new Date().toISOString()
                            });
                            showToast(`${regionName} added successfully`);
                          } catch (error) {
                            handleFirestoreError(error, OperationType.WRITE, `regions/${id}`);
                            showToast('Failed to add region', 'error');
                          } finally {
                            setIsRegionSaving(false);
                            e.target.value = ''; // Reset dropdown
                          }
                        }}
                        className="px-4 py-2 bg-white/5 border border-white/10 rounded-xl font-bold text-white text-xs focus:ring-2 focus:ring-white/10 outline-none transition-all cursor-pointer"
                        defaultValue=""
                        disabled={isRegionSaving}
                      >
                        <option value="" disabled className="bg-bg-panel">Add Region...</option>
                        {GHANA_REGIONS.map(r => (
                          <option key={r.code} value={r.name} className="bg-bg-panel">
                            {r.name} ({r.code})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {regions.map((region) => (
                      <div key={region.id} className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden shadow-sm hover:border-white/20 transition-all group">
                        <div className="p-5 space-y-4">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div className="w-10 h-10 bg-black/40 rounded-xl flex items-center justify-center text-white/60 font-bold border border-white/10">
                                {region.code}
                              </div>
                              <div>
                                <h5 className="font-bold text-white">{region.name}</h5>
                                <span className={cn(
                                  "text-[10px] font-bold uppercase tracking-widest",
                                  region.active ? "text-accent-green" : "text-white/20"
                                )}>
                                  {region.active ? 'Active' : 'Inactive'}
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                              <button 
                                onClick={() => {
                                  setEditingRegion(region);
                                  setRegionForm({ name: region.name, code: region.code, active: region.active });
                                  setShowRegionModal(true);
                                }}
                                className="p-2 text-white/40 hover:text-white hover:bg-white/10 rounded-lg transition-all"
                              >
                                <Edit2 size={14} />
                              </button>
                              <button 
                                onClick={() => handleDeleteRegion(region.id)}
                                className="p-2 text-white/40 hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-all"
                              >
                                <Trash2 size={14} />
                              </button>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-4 pt-2">
                            <div className="p-3 bg-black/40 rounded-xl border border-white/10">
                              <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-1">Artisans</p>
                              <p className="text-lg font-bold text-white">{regionalData[region.name]?.artisans || 0}</p>
                            </div>
                            <div className="p-3 bg-black/40 rounded-xl border border-white/10">
                              <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-1">Active Jobs</p>
                              <p className="text-lg font-bold text-white">{regionalData[region.name]?.active_jobs || 0}</p>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="bg-white/5 border border-white/10 rounded-2xl p-8">
                    <div className="flex flex-col md:flex-row gap-8 items-center">
                      <div className="w-full md:w-1/2">
                        <GhanaMap 
                          regionalData={regionalData} 
                          onRegionClick={(regionName) => {
                            const region = regions.find(r => r.name === regionName);
                            if (region) {
                              setEditingRegion(region);
                              setRegionForm({ name: region.name, code: region.code, active: region.active });
                              setShowRegionModal(true);
                            }
                          }}
                        />
                      </div>
                      <div className="flex-1 space-y-6">
                        <h5 className="text-xl font-bold text-white">Regional Distribution</h5>
                        <p className="text-white/40 text-sm leading-relaxed">
                          Visual representation of artisan density and job activity across Ghana. 
                          Click on a region to manage its specific parameters.
                        </p>
                        <div className="space-y-3">
                          {regions?.slice(0, 4).map(r => (
                            <div key={r.id} className="flex items-center justify-between p-3 bg-black/40 border border-white/10 rounded-xl">
                              <span className="text-sm font-bold text-white/60">{r.name}</span>
                              <div className="flex items-center gap-3">
                                <div className="h-1.5 w-24 bg-white/5 rounded-full overflow-hidden">
                                  <div 
                                    className="h-full bg-white rounded-full" 
                                    style={{ width: `${Math.min(100, (regionalData[r.name]?.artisans || 0) * 10)}%` }}
                                  />
                                </div>
                                <span className="text-xs font-bold text-white">{regionalData[r.name]?.artisans || 0}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

            {settings && activeSection === 'security' && (
              <div className="space-y-6 max-w-4xl">
                <div className="p-6 bg-white/5 border border-white/5 rounded-2xl space-y-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-bold text-white">Require 2FA</p>
                      <p className="text-xs text-white/40">Force two-factor authentication for all admins.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('security.two_factor_authentication', !settings.security.two_factor_authentication)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.security.two_factor_authentication ? "bg-white" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-1 w-3 h-3 bg-black rounded-full transition-all",
                        settings.security.two_factor_authentication ? "left-6" : "left-1"
                      )} />
                    </button>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Session Timeout (Min)</label>
                      <input 
                        type="number"
                        className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl font-bold text-white focus:ring-2 focus:ring-white/10 outline-none transition-all"
                        value={settings.security.admin_session_timeout}
                        onChange={(e) => updateSettings('security.admin_session_timeout', Number(e.target.value))}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Max Login Attempts</label>
                      <input 
                        type="number"
                        className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl font-bold text-white focus:ring-2 focus:ring-white/10 outline-none transition-all"
                        value={settings.security.max_login_attempts}
                        onChange={(e) => updateSettings('security.max_login_attempts', Number(e.target.value))}
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between p-4 bg-black/20 rounded-xl border border-white/5">
                    <div>
                      <p className="font-bold text-white text-sm">IP Whitelisting</p>
                      <p className="text-[10px] text-white/40">Restrict admin access to specific IP addresses.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('security.ip_whitelist_enabled', !settings.security.ip_whitelist_enabled)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.security.ip_whitelist_enabled ? "bg-white" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-1 w-3 h-3 bg-black rounded-full transition-all",
                        settings.security.ip_whitelist_enabled ? "left-6" : "left-1"
                      )} />
                    </button>
                  </div>
                </div>

                  <div className="space-y-4">
                    <div className="flex items-center justify-between">
                      <h4 className="text-sm font-bold text-white/40 uppercase tracking-wider">Admin Roles</h4>
                      <button 
                        onClick={() => {
                          setEditingRole(null);
                          setRoleForm({ name: '', permissions: [] });
                          setShowRoleModal(true);
                        }}
                        className="flex items-center gap-2 px-3 py-1.5 bg-white text-black text-[10px] font-bold rounded-lg hover:bg-white/90 transition-all shadow-sm"
                      >
                        <Plus size={12} /> Create Role
                      </button>
                    </div>
                    <div className="grid grid-cols-1 gap-4">
                      {settings.security.roles.map((role) => (
                        <div key={role.id} className="p-4 bg-white/5 border border-white/10 rounded-xl flex items-center justify-between group hover:border-white/20 transition-all shadow-sm">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-white/5 rounded-lg flex items-center justify-center text-white/40">
                              <Shield size={16} />
                            </div>
                            <div>
                              <p className="text-sm font-bold text-white">{role.name}</p>
                              <p className="text-[10px] text-white/40 font-medium">{role.permissions.length} Permissions Assigned</p>
                            </div>
                          </div>
                          <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-all">
                            <button 
                              onClick={() => {
                                setEditingRole(role);
                                setRoleForm({ name: role.name, permissions: role.permissions });
                                setShowRoleModal(true);
                              }}
                              className="p-1.5 text-white/40 hover:text-white hover:bg-white/10 rounded-md transition-all"
                            >
                              <Edit2 size={14} />
                            </button>
                            <button 
                              onClick={() => handleDeleteRole(role.id)}
                              className="p-1.5 text-white/40 hover:text-red-500 hover:bg-red-500/10 rounded-md transition-all"
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

            {settings && activeSection === 'advanced' && (
              <div className="space-y-6 max-w-4xl">
                  <div className="p-6 bg-white/5 border border-white/5 rounded-2xl space-y-6">
                    <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Environment</label>
                        <select 
                          value={settings.advanced.environment}
                          onChange={(e) => updateSettings('advanced.environment', e.target.value)}
                          className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl font-bold text-white focus:ring-2 focus:ring-white/10 outline-none transition-all"
                        >
                          <option value="production">Production</option>
                          <option value="staging">Staging</option>
                          <option value="development">Development</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Node Version</label>
                        <input 
                          type="text"
                          className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl font-bold text-white focus:ring-2 focus:ring-white/10 outline-none transition-all"
                          value={settings.advanced.node_version}
                          onChange={(e) => updateSettings('advanced.node_version', e.target.value)}
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Backup Frequency</label>
                        <select 
                          value={settings.advanced.backup_frequency}
                          onChange={(e) => updateSettings('advanced.backup_frequency', e.target.value)}
                          className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl font-bold text-white focus:ring-2 focus:ring-white/10 outline-none transition-all"
                        >
                          <option value="daily">Daily</option>
                          <option value="weekly">Weekly</option>
                          <option value="monthly">Monthly</option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Log Level</label>
                        <select 
                          value={settings.advanced.log_level}
                          onChange={(e) => updateSettings('advanced.log_level', e.target.value)}
                          className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl font-bold text-white focus:ring-2 focus:ring-white/10 outline-none transition-all"
                        >
                          <option value="error">Error</option>
                          <option value="warn">Warn</option>
                          <option value="info">Info</option>
                          <option value="debug">Debug</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>
              )}

            {settings && activeSection === 'api' && (
              <div className="space-y-6 max-w-4xl">
                  <div className="p-6 bg-white/5 border border-white/5 rounded-2xl space-y-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Base URL</label>
                      <input 
                        type="text"
                        className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl font-bold text-white focus:ring-2 focus:ring-white/10 outline-none transition-all"
                        value={settings.api.base_url}
                        onChange={(e) => updateSettings('api.base_url', e.target.value)}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-6">
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Rate Limit (Req/Min)</label>
                        <input 
                          type="number"
                          className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl font-bold text-white focus:ring-2 focus:ring-white/10 outline-none transition-all"
                          value={settings.api.rate_limit_per_minute}
                          onChange={(e) => updateSettings('api.rate_limit_per_minute', Number(e.target.value))}
                        />
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Timeout (MS)</label>
                        <input 
                          type="number"
                          className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl font-bold text-white focus:ring-2 focus:ring-white/10 outline-none transition-all"
                          value={settings.api.timeout_ms}
                          onChange={(e) => updateSettings('api.timeout_ms', Number(e.target.value))}
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-bold text-white">Enable Webhooks</p>
                        <p className="text-xs text-white/40">Allow external systems to receive event notifications.</p>
                      </div>
                      <button 
                        onClick={() => updateSettings('api.enable_webhooks', !settings.api.enable_webhooks)}
                        className={cn(
                          "w-10 h-5 rounded-full transition-all relative",
                          settings.api.enable_webhooks ? "bg-white" : "bg-white/20"
                        )}
                      >
                        <div className={cn(
                          "absolute top-1 w-3 h-3 bg-black rounded-full transition-all",
                          settings.api.enable_webhooks ? "left-6" : "left-1"
                        )} />
                      </button>
                    </div>
                  </div>
                </div>
              )}


            {settings && activeSection === 'audit' && (
              <div className="space-y-8 max-w-4xl">
                <div className="p-6 bg-white/5 border border-white/5 rounded-2xl space-y-6">
                  <h4 className="text-sm font-bold text-white/40 uppercase tracking-wider">Audit Configuration</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Retention Days</label>
                      <input 
                        type="number"
                        className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl font-bold text-white focus:ring-2 focus:ring-white/10 outline-none transition-all"
                        value={settings.audit.retention_days}
                        onChange={(e) => updateSettings('audit.retention_days', Number(e.target.value))}
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-[10px] font-bold text-white/40 uppercase tracking-widest">Log Level</label>
                      <select 
                        value={settings.audit.log_level}
                        onChange={(e) => updateSettings('audit.log_level', e.target.value)}
                        className="w-full px-4 py-2.5 bg-white/5 border border-white/10 rounded-xl font-bold text-white focus:ring-2 focus:ring-white/10 outline-none transition-all"
                      >
                        <option value="info">Info</option>
                        <option value="warn">Warn</option>
                        <option value="error">Error</option>
                        <option value="debug">Debug</option>
                      </select>
                    </div>
                  </div>

                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-bold text-white">Notify on Critical Errors</p>
                      <p className="text-xs text-white/40">Send alerts to admins when critical system errors occur.</p>
                    </div>
                    <button 
                      onClick={() => updateSettings('audit.notify_on_critical_errors', !settings.audit.notify_on_critical_errors)}
                      className={cn(
                        "w-10 h-5 rounded-full transition-all relative",
                        settings.audit.notify_on_critical_errors ? "bg-white" : "bg-white/20"
                      )}
                    >
                      <div className={cn(
                        "absolute top-1 w-3 h-3 bg-black rounded-full transition-all",
                        settings.audit.notify_on_critical_errors ? "left-6" : "left-1"
                      )} />
                    </button>
                  </div>
                </div>

                <div className="space-y-6">
                  <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                    <div>
                      <h4 className="text-lg font-bold text-white">System Audit Trail</h4>
                      <p className="text-white/40 text-xs mt-1">Track all administrative actions across the platform.</p>
                    </div>
                    <div className="flex flex-wrap gap-3">
                      <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20" size={14} />
                        <input 
                          type="text"
                          placeholder="Search logs..."
                          className="pl-9 pr-4 py-2 bg-white/5 border border-white/10 rounded-xl text-xs text-white outline-none focus:ring-2 focus:ring-accent-blue/20 transition-all w-48"
                          value={auditFilter.search}
                          onChange={(e) => setAuditFilter({ ...auditFilter, search: e.target.value })}
                        />
                      </div>
                      <select 
                        className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-xs font-bold text-white/60 outline-none focus:ring-2 focus:ring-accent-blue/20"
                        value={auditFilter.admin}
                        onChange={(e) => setAuditFilter({ ...auditFilter, admin: e.target.value })}
                      >
                        <option value="" className="bg-bg-dark">All Admins</option>
                        {Array.from(new Set(auditLogs.map(l => l.adminName))).map(name => (
                          <option key={name} value={name} className="bg-bg-dark">{name}</option>
                        ))}
                      </select>
                      <select 
                        className="px-3 py-2 bg-white/5 border border-white/10 rounded-xl text-xs font-bold text-white/60 outline-none focus:ring-2 focus:ring-accent-blue/20"
                        value={auditFilter.action}
                        onChange={(e) => setAuditFilter({ ...auditFilter, action: e.target.value })}
                      >
                        <option value="" className="bg-bg-dark">All Actions</option>
                        <option value="SETTINGS_UPDATE" className="bg-bg-dark">Settings Update</option>
                        <option value="DISPUTE_RESOLUTION" className="bg-bg-dark">Dispute Resolution</option>
                        <option value="ADMIN_INVITE" className="bg-bg-dark">Admin Invite</option>
                        <option value="MAINTENANCE_TOGGLE" className="bg-bg-dark">Maintenance Toggle</option>
                        <option value="ARTISAN_STATUS_UPDATE" className="bg-bg-dark">Artisan Status Update</option>
                        <option value="CUSTOMER_STATUS_UPDATE" className="bg-bg-dark">Customer Status Update</option>
                        <option value="JOB_CANCEL" className="bg-bg-dark">Job Cancellation</option>
                      </select>
                    </div>
                  </div>

                  <div className="bg-black/20 rounded-3xl border border-white/5 shadow-xl overflow-hidden">
                    <div className="p-6 border-b border-white/5 bg-white/[0.02] flex items-center justify-between">
                      <div className="flex items-center gap-4">
                        <div className="w-1.5 h-6 bg-accent-blue rounded-full" />
                        <h3 className="font-bold text-[15px] text-white tracking-tight">Audit Ledger</h3>
                      </div>
                      <div className="flex items-center gap-4">
                        <span className="text-[10px] font-bold text-white/20 uppercase tracking-widest opacity-60">System-wide event tracking</span>
                      </div>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="bg-white/[0.02]">
                            <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Admin / Action</th>
                            <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Details</th>
                            <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest text-right">Timestamp</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-white/5">
                          {auditLogs
                            .filter(log => {
                              const matchesAction = !auditFilter.action || log.action === auditFilter.action;
                              const matchesAdmin = !auditFilter.admin || log.adminName === auditFilter.admin;
                              const matchesSearch = !auditFilter.search || 
                                log.details.toLowerCase().includes(auditFilter.search.toLowerCase()) ||
                                log.adminName.toLowerCase().includes(auditFilter.search.toLowerCase()) ||
                                log.action.toLowerCase().includes(auditFilter.search.toLowerCase());
                              return matchesAction && matchesAdmin && matchesSearch;
                            })
                            .map((log) => (
                              <tr key={log.id} className="group hover:bg-white/[0.02] transition-colors">
                                <td className="px-6 py-5">
                                  <div className="flex items-center gap-4">
                                    <div className="w-10 h-10 bg-white/5 rounded-xl flex items-center justify-center text-white/40 shrink-0 border border-white/5 group-hover:border-accent-blue/30 transition-all">
                                      <Shield size={16} />
                                    </div>
                                    <div className="min-w-0">
                                      <p className="text-sm font-bold text-white truncate group-hover:text-accent-blue transition-colors tracking-tight">{log.adminName}</p>
                                      <p className="text-[10px] font-bold text-accent-blue uppercase tracking-widest mt-0.5">{log.action.replace(/_/g, ' ')}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className="px-6 py-5">
                                  <p className="text-xs text-white/60 leading-relaxed line-clamp-2">{log.details}</p>
                                </td>
                                <td className="px-6 py-5 text-right">
                                  <p className="text-[11px] font-bold text-white/40 uppercase tracking-widest">{new Date(log.timestamp).toLocaleString()}</p>
                                  <p className="text-[10px] text-white/20 font-mono mt-0.5">{log.ipAddress || log.ip || '0.0.0.0'}</p>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                      {auditLogs.length === 0 && (
                        <div className="p-12 text-center">
                          <div className="w-16 h-16 bg-white/5 rounded-full flex items-center justify-center mx-auto mb-4">
                            <History size={24} className="text-white/10" />
                          </div>
                          <p className="text-white/40 font-bold uppercase tracking-widest text-[10px]">No audit logs found</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
            </div>
          </motion.div>
        </div>
      </div>

      {/* Role Modal */}
      <AnimatePresence>
        {showRoleModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowRoleModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-2xl bg-bg-panel rounded-3xl shadow-2xl overflow-hidden border border-white/10"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/5">
                <h3 className="text-xl font-bold text-white">{editingRole ? 'Edit Role' : 'Create New Role'}</h3>
                <button 
                  onClick={() => setShowRoleModal(false)}
                  className="p-2 text-white/40 hover:text-white hover:bg-white/10 rounded-xl transition-all"
                >
                  <X size={20} />
                </button>
              </div>

              <form onSubmit={handleSaveRole} className="p-6 space-y-6">
                <div className="space-y-6">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Role Name</label>
                    <input 
                      type="text"
                      required
                      placeholder="e.g. Support Lead"
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold text-white focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue/50 outline-none transition-all"
                      value={roleForm.name}
                      onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
                    />
                  </div>

                  <div className="space-y-3">
                    <label className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Permissions</label>
                    <div className="grid grid-cols-2 gap-3">
                      {AVAILABLE_PERMISSIONS.map((perm) => (
                        <button
                          key={perm.id}
                          type="button"
                          onClick={() => {
                            const newPerms = roleForm.permissions.includes(perm.id)
                              ? roleForm.permissions.filter(p => p !== perm.id)
                              : [...roleForm.permissions, perm.id];
                            setRoleForm({ ...roleForm, permissions: newPerms });
                          }}
                          className={cn(
                            "flex items-center gap-3 p-3 rounded-xl border text-left transition-all",
                            roleForm.permissions.includes(perm.id)
                              ? "bg-accent-blue border-accent-blue text-white shadow-lg shadow-accent-blue/20"
                              : "bg-white/5 border-white/10 text-white/40 hover:border-white/20"
                          )}
                        >
                          <div className={cn(
                            "w-4 h-4 rounded border flex items-center justify-center shrink-0",
                            roleForm.permissions.includes(perm.id) ? "border-white" : "border-white/20"
                          )}>
                            {roleForm.permissions.includes(perm.id) && <Check size={10} />}
                          </div>
                          <span className="text-xs font-bold">{perm.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <button 
                    type="button"
                    onClick={() => setShowRoleModal(false)}
                    className="flex-1 py-3 bg-white/5 border border-white/10 text-sm font-bold text-white/60 rounded-xl hover:bg-white/10 transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    disabled={isRoleSaving}
                    className="flex-1 py-3 bg-white text-bg-dark text-sm font-bold rounded-xl hover:bg-white/90 transition-all shadow-lg flex items-center justify-center gap-2"
                  >
                    {isRoleSaving ? (
                      <Loader2 size={18} className="animate-spin" />
                    ) : (
                      <Check size={18} />
                    )}
                    {editingRole ? 'Update Role' : 'Create Role'}
                  </button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Region Modal */}
      <AnimatePresence>
        {showRegionModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowRegionModal(false)}
              className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-md bg-bg-panel rounded-3xl shadow-2xl overflow-hidden border border-white/10"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between bg-white/5">
                <h3 className="text-xl font-bold text-white">{editingRegion ? 'Edit Region' : 'Add New Region'}</h3>
                <button 
                  onClick={() => setShowRegionModal(false)}
                  className="p-2 text-white/40 hover:text-white hover:bg-white/10 rounded-xl transition-all"
                >
                  <X size={20} />
                </button>
              </div>

              <form onSubmit={handleSaveRegion} className="p-6 space-y-6">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Region Name</label>
                    <input 
                      type="text"
                      required
                      placeholder="e.g. Greater Accra"
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold text-white focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue/50 outline-none transition-all"
                      value={regionForm.name}
                      onChange={(e) => setRegionForm({ ...regionForm, name: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Region Code</label>
                    <input 
                      type="text"
                      required
                      placeholder="e.g. GA"
                      maxLength={3}
                      className="w-full px-4 py-3 bg-white/5 border border-white/10 rounded-xl text-sm font-bold text-white focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue/50 outline-none transition-all uppercase"
                      value={regionForm.code}
                      onChange={(e) => setRegionForm({ ...regionForm, code: e.target.value.toUpperCase() })}
                    />
                  </div>
                  <div className="flex items-center justify-between p-4 bg-white/5 border border-white/10 rounded-xl">
                    <div>
                      <p className="text-sm font-bold text-white">Active Status</p>
                      <p className="text-[10px] text-white/40 font-medium">Enable operations in this region</p>
                    </div>
                    <button 
                      type="button"
                      onClick={() => setRegionForm({ ...regionForm, active: !regionForm.active })}
                      className={cn(
                        "w-12 h-6 rounded-full transition-all relative",
                        regionForm.active ? "bg-accent-blue" : "bg-white/10"
                      )}
                    >
                      <div className={cn(
                        "absolute top-1 w-4 h-4 bg-white rounded-full transition-all shadow-sm",
                        regionForm.active ? "left-7" : "left-1"
                      )} />
                    </button>
                  </div>
                </div>

                <div className="flex gap-3 pt-2">
                  <button 
                    type="button"
                    onClick={() => setShowRegionModal(false)}
                    className="flex-1 py-3 bg-white/5 border border-white/10 text-sm font-bold text-white/60 rounded-xl hover:bg-white/10 transition-all"
                  >
                    Cancel
                  </button>
                  <button 
                    type="submit"
                    disabled={isRegionSaving}
                    className="flex-1 py-3 bg-white text-bg-dark text-sm font-bold rounded-xl hover:bg-white/90 transition-all shadow-lg flex items-center justify-center gap-2"
                  >
                    {isRegionSaving ? (
                      <Loader2 size={18} className="animate-spin" />
                    ) : (
                      <Check size={18} />
                    )}
                    {editingRegion ? 'Update' : 'Create'}
                  </button>
                </div>
              </form>
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
              "fixed bottom-8 left-1/2 z-50 px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 min-w-[300px]",
              toast.type === 'success' ? "bg-bg-panel border border-accent-green/20 text-white" : "bg-red-500 text-white"
            )}
          >
            <div className={cn(
              "w-2 h-2 rounded-full",
              toast.type === 'success' ? "bg-accent-green" : "bg-white"
            )} />
            <span className="text-sm font-medium">{toast.message}</span>
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
      </div>
    </>
  );
}
