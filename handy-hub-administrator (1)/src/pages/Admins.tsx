import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Shield, UserPlus, User, Mail, Clock, MoreVertical, ShieldCheck, 
  ShieldAlert, X, Check, Edit2, History, Info, AlertTriangle,
  ExternalLink, Activity, Terminal, Trash2, RefreshCw, Copy, Printer, Lock
} from 'lucide-react';
import { 
  collection, 
  onSnapshot, 
  doc, 
  updateDoc, 
  addDoc, 
  deleteDoc,
  setDoc,
  query, 
  where, 
  orderBy, 
  limit,
  Timestamp
} from 'firebase/firestore';
import { auth, db } from '../firebase';
import firebaseConfig from '../../firebase-applet-config.json';
import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth, createUserWithEmailAndPassword, updateProfile, signOut } from 'firebase/auth';
import { AdminUser, PlatformSettings, AuditLog, AdminRole } from '../types';
import { cn } from '../utils';
import { handleFirestoreError, OperationType } from '../utils/firestoreErrorHandler';
import { notificationService } from '../services/notificationService';
import { ConfirmModal } from '../components/ConfirmModal';

export function Admins() {
  const [admins, setAdmins] = React.useState<AdminUser[]>([]);
  const [settings, setSettings] = React.useState<PlatformSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [selectedAdmin, setSelectedAdmin] = React.useState<AdminUser | null>(null);
  const [showRoleModal, setShowRoleModal] = React.useState(false);
  const [editingRole, setEditingRole] = React.useState<any>(null);
  const [roleForm, setRoleForm] = React.useState({ name: '', permissions: [] as string[] });
  const [isRoleSaving, setIsRoleSaving] = React.useState(false);
  const [adminAudits, setAdminAudits] = React.useState<AuditLog[]>([]);
  const [loadingAudits, setLoadingAudits] = React.useState(false);
  const [isUpdatingRole, setIsUpdatingRole] = React.useState(false);
  const [showGlobalAudits, setShowGlobalAudits] = React.useState(false);
  const [globalAudits, setGlobalAudits] = React.useState<AuditLog[]>([]);
  const [toast, setToast] = React.useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [currentUserData, setCurrentUserData] = React.useState<AdminUser | null>(null);
  const [confirmModal, setConfirmModal] = React.useState<{
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

  React.useEffect(() => {
    // Listen for admins
    const unsubAdmins = onSnapshot(collection(db, 'admins'), (snapshot) => {
      const adminsData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AdminUser));
      setAdmins(adminsData);
      
      // Set current user data
      if (auth.currentUser) {
        const current = adminsData.find(a => a.id === auth.currentUser?.uid);
        if (current) setCurrentUserData(current);
      }
      
      setLoading(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'admins');
    });

    // Listen for settings
    const unsubSettings = onSnapshot(doc(db, 'settings', 'platform'), (doc) => {
      if (doc.exists()) {
        setSettings(doc.data() as PlatformSettings);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, 'settings/platform');
    });

    return () => {
      unsubAdmins();
      unsubSettings();
    };
  }, []);

  const AVAILABLE_PERMISSIONS = [
    'Artisans', 'Jobs', 'Escrow', 'Customers', 'Disputes', 'Admins', 'Settings', 'Audit Logs'
  ];

  const rolePermissions: Record<AdminRole, { description: string; permissions: string[] }> = {
    super_admin: {
      description: 'Full system access and administrative control',
      permissions: [
        'Manage Administrators',
        'System Configuration',
        'Financial Oversight',
        'Audit Log Access',
        'Artisan Management',
        'Customer Management',
        'Job Control',
        'Dispute Resolution'
      ]
    },
    operations_admin: {
      description: 'Day-to-day platform operations and management',
      permissions: [
        'Artisan Management',
        'Customer Management',
        'Job Control',
        'Dispute Resolution',
        'View Audit Logs (Partial)',
        'Region Management'
      ]
    },
    finance_admin: {
      description: 'Financial reporting and payment management',
      permissions: [
        'Financial Oversight',
        'Payment Configuration',
        'Revenue Reporting',
        'View Artisans (Read-only)',
        'View Jobs (Read-only)'
      ]
    },
    support_admin: {
      description: 'Customer support and dispute handling',
      permissions: [
        'Dispute Resolution',
        'Customer Support',
        'View Artisans (Read-only)',
        'View Customers (Read-only)',
        'View Jobs (Read-only)'
      ]
    }
  };

  const [activeTab, setActiveTab] = React.useState<'admins' | 'permissions' | 'audits'>('admins');

  const isSuperAdmin = currentUserData?.role === 'super_admin' || (auth.currentUser?.email === 'silas7korda@gmail.com' && auth.currentUser?.emailVerified);

  const fetchAdminAudits = (adminId: string) => {
    setLoadingAudits(true);
    const q = query(
      collection(db, 'audit_logs'),
      where('adminId', '==', adminId),
      orderBy('timestamp', 'desc'),
      limit(50)
    );

    return onSnapshot(q, (snapshot) => {
      const audits = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AuditLog));
      setAdminAudits(audits);
      setLoadingAudits(false);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'audit_logs');
    });
  };

  const fetchGlobalAudits = () => {
    setLoadingAudits(true);
    const q = query(
      collection(db, 'audit_logs'),
      orderBy('timestamp', 'desc'),
      limit(100)
    );

    const unsub = onSnapshot(q, (snapshot) => {
      const audits = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as AuditLog));
      setGlobalAudits(audits);
      setLoadingAudits(false);
      setShowGlobalAudits(true);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'audit_logs');
    });

    return unsub;
  };

  const handleUpdateRole = async (adminId: string, newRole: AdminRole) => {
    if (!isSuperAdmin) {
      showToast("Unauthorized: Super Admin access required", "error");
      return;
    }

    setIsUpdatingRole(true);
    try {
      await updateDoc(doc(db, 'admins', adminId), {
        role: newRole,
        updatedAt: new Date().toISOString()
      });

      // Log the action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: currentUserData?.name || 'Unknown Admin',
        action: 'UPDATE_ROLE',
        target: `Admin: ${adminId}`,
        details: `Changed role to ${newRole}`,
        timestamp: new Date().toISOString(),
        ip: 'Internal'
      });

      showToast("Admin role updated successfully");

      // Notify the target admin
      notificationService.sendNotification({
        userId: adminId,
        title: 'Role Updated',
        message: `Your administrative role has been updated to ${newRole.replace('_', ' ')}.`,
        type: 'info',
        category: 'security'
      });
    } catch (error) {
      console.error("Failed to update role", error);
      showToast("Failed to update role", "error");
    } finally {
      setIsUpdatingRole(false);
    }
  };

  const handleUpdateStatus = async (adminId: string, newStatus: 'active' | 'suspended' | 'pending') => {
    if (!isSuperAdmin) {
      showToast("Unauthorized: Super Admin access required", "error");
      return;
    }

    try {
      await updateDoc(doc(db, 'admins', adminId), {
        status: newStatus,
        updatedAt: new Date().toISOString()
      });

      // Log the action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: currentUserData?.name || 'Unknown Admin',
        action: 'UPDATE_STATUS',
        target: `Admin: ${adminId}`,
        details: `Changed status to ${newStatus}`,
        timestamp: new Date().toISOString(),
        ip: 'Internal'
      });

      showToast(`Admin status updated to ${newStatus}`);

      // Notify the target admin
      notificationService.sendNotification({
        userId: adminId,
        title: 'Account Status Updated',
        message: `Your account status has been changed to ${newStatus}.`,
        type: newStatus === 'active' ? 'success' : 'warning',
        category: 'security'
      });
    } catch (error) {
      console.error("Failed to update status", error);
      showToast("Failed to update status", "error");
    }
  };

  const [showInviteModal, setShowInviteModal] = React.useState(false);
  const [inviteForm, setInviteForm] = React.useState({ name: '', email: '', password: '', role: 'operations_admin' as AdminRole });
  const [isCreating, setIsCreating] = React.useState(false);

  const handleCreateAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin) {
      showToast("Unauthorized: Super Admin access required", "error");
      return;
    }

    setIsCreating(true);
    try {
      const trimmedEmail = inviteForm.email.trim().toLowerCase();

      if (!inviteForm.password || inviteForm.password.length < 6) {
        showToast("Password must be at least 6 characters", "error");
        setIsCreating(false);
        return;
      }

      // Create a secondary Firebase app to avoid logging out the current admin
      const secondaryApp = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
      const secondaryAuth = getAuth(secondaryApp);

      try {
        // 1. Create the user in Auth
        const userCredential = await createUserWithEmailAndPassword(secondaryAuth, trimmedEmail, inviteForm.password);
        const newUser = userCredential.user;

        // 2. Set the display name
        await updateProfile(newUser, { displayName: inviteForm.name });

        // 3. Create the admin document in Firestore (using primary db instance)
        await setDoc(doc(db, 'admins', newUser.uid), {
          id: newUser.uid,
          name: inviteForm.name,
          email: trimmedEmail,
          role: inviteForm.role,
          status: 'active',
          createdAt: new Date().toISOString(),
          lastLogin: 'Never'
        });

        // 4. Sign out the secondary instance and clean up
        await signOut(secondaryAuth);
        await deleteApp(secondaryApp);

        showToast(`Admin account created! They can now log in directly at /login`, 'success');
        
        // Log the action
        await addDoc(collection(db, 'audit_logs'), {
          adminId: auth.currentUser?.uid,
          adminName: currentUserData?.name || 'Unknown Admin',
          action: 'DIRECT_CREATE_ADMIN',
          target: trimmedEmail,
          details: `Directly created admin with role ${inviteForm.role}`,
          timestamp: new Date().toISOString(),
          ip: 'Internal'
        });

        setShowInviteModal(false);
        setInviteForm({ name: '', email: '', password: '', role: 'operations_admin' });
      } catch (authError: any) {
        console.error("Auth Error during admin creation:", authError);
        await deleteApp(secondaryApp);
        throw authError;
      }
    } catch (error: any) {
      console.error("Failed to create admin. Full error:", error);
      
      let errorMsg = "Failed to create admin";
      const errorCode = error.code || (error.message && error.message.includes('auth/email-already-in-use') ? 'auth/email-already-in-use' : null);
      
      if (errorCode === 'auth/email-already-in-use') {
        errorMsg = "This email is already registered. Please use a different email or check the existing admin list.";
      } else if (errorCode === 'auth/invalid-email') {
        errorMsg = "The email address provided is not valid.";
      } else if (errorCode === 'auth/weak-password') {
        errorMsg = "The password provided is too weak. Please use a stronger password.";
      } else if (error.message) {
        errorMsg = error.message;
      }
      
      showToast(errorMsg, "error");
    } finally {
      setIsCreating(false);
    }
  };

  const handleSaveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings || !isSuperAdmin) return;
    setIsRoleSaving(true);
    try {
      let newRoles = [...(settings.security.roles || [])];
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
      
      await updateDoc(doc(db, 'settings', 'platform'), newSettings as any);
      showToast(editingRole ? 'Role updated' : 'Role created', 'success');
      setShowRoleModal(false);
      setEditingRole(null);
      setRoleForm({ name: '', permissions: [] });

      // Log action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: currentUserData?.name || 'Admin',
        action: 'ROLE_MANAGEMENT',
        details: `${editingRole ? 'Updated' : 'Created'} role: ${roleForm.name}`,
        timestamp: new Date().toISOString(),
        ip: '0.0.0.0'
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'settings/platform');
      showToast('Failed to save role', 'error');
    } finally {
      setIsRoleSaving(false);
    }
  };

  const handleDeleteRole = async (roleId: string, roleName: string) => {
    if (!settings || !isSuperAdmin) return;
    setConfirmModal({
      isOpen: true,
      title: 'Delete Role',
      message: `Are you sure you want to delete the "${roleName}" role?`,
      variant: 'danger',
      onConfirm: () => performDeleteRole(roleId, roleName)
    });
  };

  const performDeleteRole = async (roleId: string, roleName: string) => {
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
      await updateDoc(doc(db, 'settings', 'platform'), newSettings as any);
      showToast('Role deleted', 'success');

      // Log action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: currentUserData?.name || 'Admin',
        action: 'ROLE_DELETION',
        details: `Deleted role: ${roleName}`,
        timestamp: new Date().toISOString(),
        ip: '0.0.0.0'
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'settings/platform');
      showToast('Failed to delete role', 'error');
    } finally {
      setConfirmModal(prev => ({ ...prev, isOpen: false }));
    }
  };

  const handleDeleteAdmin = async (adminId: string) => {
    if (!isSuperAdmin) {
      showToast("Unauthorized: Super Admin access required", "error");
      return;
    }

    if (adminId === auth.currentUser?.uid) {
      showToast("You cannot delete your own account", "error");
      return;
    }

    setConfirmModal({
      isOpen: true,
      title: 'Delete Administrator',
      message: 'Are you sure you want to delete this administrator? This action cannot be undone.',
      variant: 'danger',
      onConfirm: () => performDeleteAdmin(adminId)
    });
  };

  const performDeleteAdmin = async (adminId: string) => {
    try {
      await deleteDoc(doc(db, 'admins', adminId));

      // Log the action
      await addDoc(collection(db, 'audit_logs'), {
        adminId: auth.currentUser?.uid,
        adminName: currentUserData?.name || 'Unknown Admin',
        action: 'DELETE_ADMIN',
        target: `Admin: ${adminId}`,
        details: `Deleted administrator account`,
        timestamp: new Date().toISOString(),
        ip: 'Internal'
      });

      showToast("Administrator deleted successfully");
      setSelectedAdmin(null);
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `admins/${adminId}`);
      showToast("Failed to delete admin", "error");
    } finally {
      setConfirmModal(prev => ({ ...prev, isOpen: false }));
    }
  };

  const activeAdmins = admins;

  if (loading) return (
    <div className="flex items-center justify-center h-[calc(100vh-64px)] bg-bg-dark">
      <div className="w-12 h-12 border-4 border-white/10 border-t-accent-blue rounded-full animate-spin"></div>
    </div>
  );

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-10 pb-12 max-w-[1600px] mx-auto"
    >
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-2 mb-6">
        <div>
          <h1 className="text-xl font-bold text-white tracking-tight">Admin Management</h1>
          <p className="text-slate-500 text-xs font-medium">Manage platform administrators and their access levels.</p>
        </div>
        <div className="flex items-center gap-2">
          <button 
            onClick={() => {
              setActiveTab('audits');
              fetchGlobalAudits();
            }}
            className="flex items-center gap-2 px-3 py-1.5 bg-white/5 text-white text-[10px] font-bold rounded-lg hover:bg-white/10 transition-all border border-white/10 uppercase tracking-widest"
          >
            <History size={14} /> Global Logs
          </button>
          {isSuperAdmin && (
            <button 
              onClick={() => setShowInviteModal(true)}
              className="flex items-center gap-2 px-3 py-1.5 bg-white text-bg-dark text-[10px] font-bold rounded-lg hover:bg-slate-200 transition-all shadow-lg uppercase tracking-widest"
            >
              <UserPlus size={14} /> Create Admin
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 bg-white/5 p-0.5 rounded-xl border border-white/10 w-fit mb-6">
        {[
          { id: 'admins', label: 'Administrators', icon: UserPlus },
          { id: 'permissions', label: 'Role Permissions', icon: ShieldCheck },
          { id: 'audits', label: 'Security Logs', icon: Terminal }
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id as any);
              if (tab.id === 'audits') fetchGlobalAudits();
            }}
            className={cn(
              "flex items-center gap-2 px-4 py-1.5 rounded-lg text-[9px] font-bold uppercase tracking-widest transition-all",
              activeTab === tab.id 
                ? "bg-white text-bg-dark shadow-md" 
                : "text-slate-400 hover:text-white"
            )}
          >
            <tab.icon size={12} />
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'admins' && (
        <div className="space-y-16">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {activeAdmins?.map((admin) => (
              <div key={admin.id} className="bg-bg-panel border border-white/10 rounded-2xl overflow-hidden hover:border-white/20 transition-all duration-500 group shadow-sm relative">
                <div className={cn(
                  "absolute top-0 left-0 w-full h-1 opacity-20",
                  admin.role === 'super_admin' ? "bg-white" :
                  admin.role === 'operations_admin' ? "bg-accent-blue" : "bg-accent-green"
                )} />
                <div className="p-5">
                  <div className="flex justify-between items-start mb-4">
                    <div className={cn(
                      "w-10 h-10 rounded-lg flex items-center justify-center text-white/40 font-bold text-lg border border-white/10 shadow-sm overflow-hidden",
                      admin.role === 'super_admin' ? "bg-white/5" :
                      admin.role === 'operations_admin' ? "bg-accent-blue/10 text-accent-blue" : "bg-accent-green/10 text-accent-green"
                    )}>
                      {admin.photoURL ? (
                        <img src={admin.photoURL} alt="" className="w-full h-full object-cover" />
                      ) : (
                        admin.name?.split(' ').map(n => n[0]).join('')
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      <button 
                        onClick={() => {
                          setSelectedAdmin(admin);
                          fetchAdminAudits(admin.id);
                        }}
                        className="p-1.5 bg-white/5 hover:bg-white/10 rounded-lg border border-white/10 transition-all text-white/40 hover:text-white shadow-sm"
                      >
                        <Info size={16} />
                      </button>
                      {isSuperAdmin && admin.id !== auth.currentUser?.uid && (
                        <button 
                          onClick={() => handleDeleteAdmin(admin.id)}
                          className="p-1.5 bg-white/5 hover:bg-red-500/10 rounded-lg border border-white/10 transition-all text-red-500/70 hover:text-red-500 shadow-sm"
                          title="Delete Admin"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <h3 className="font-bold text-white text-base tracking-tight leading-none">{admin.name}</h3>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className={cn(
                        "px-2 py-0.5 text-[8px] font-bold rounded-full border uppercase tracking-widest shadow-sm",
                        admin.role === 'super_admin' ? "bg-white text-bg-dark border-white" :
                        admin.role === 'operations_admin' ? "bg-accent-blue/10 text-accent-blue border-accent-blue/20" : "bg-accent-green/10 text-accent-green border-accent-green/20"
                      )}>
                        {admin.role.replace('_', ' ')}
                      </span>
                      {isSuperAdmin && admin.id !== auth.currentUser?.uid && (
                        <div className="flex gap-1">
                          <select 
                            value={admin.role}
                            onChange={(e) => handleUpdateRole(admin.id, e.target.value as AdminRole)}
                            className="text-[8px] bg-white/5 border border-white/10 rounded-lg px-1.5 py-0.5 font-bold text-white/40 outline-none focus:border-accent-blue transition-all"
                          >
                            <option value="super_admin" className="bg-bg-panel text-white">Super Admin</option>
                            <option value="operations_admin" className="bg-bg-panel text-white">Operations</option>
                            <option value="finance_admin" className="bg-bg-panel text-white">Finance</option>
                            <option value="support_admin" className="bg-bg-panel text-white">Support</option>
                          </select>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 space-y-2">
                    <div className="flex items-center gap-2 text-slate-400">
                      <Mail size={10} />
                      <span className="text-[10px] font-medium">{admin.email}</span>
                    </div>
                    <div className="flex items-center gap-2 text-slate-400">
                      <Clock size={10} />
                      <span className="text-[10px] font-medium">Last Login: {admin.lastLogin}</span>
                    </div>
                  </div>

                  <div className="mt-6 pt-4 border-t border-white/5 flex items-center justify-between">
                    <div className="flex items-center gap-1.5">
                      <div className={cn(
                        "w-1 h-1 rounded-full",
                        admin.status === 'active' ? "bg-emerald-500" : "bg-red-500"
                      )}></div>
                      <span className="text-[8px] font-bold text-slate-500 uppercase tracking-widest">{admin.status}</span>
                      {isSuperAdmin && admin.id !== auth.currentUser?.uid && (
                        <button 
                          onClick={() => handleUpdateStatus(admin.id, admin.status === 'active' ? 'suspended' : 'active')}
                          className={cn(
                            "ml-2 text-[8px] font-bold uppercase tracking-widest px-2 py-1 rounded-lg transition-all border shadow-sm",
                            admin.status === 'active' ? "bg-red-500/10 text-red-500 border-red-500/20 hover:bg-red-500/20" : "bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20"
                          )}
                        >
                          {admin.status === 'active' ? 'Suspend' : 'Activate'}
                        </button>
                      )}
                    </div>
                    <button 
                      onClick={() => {
                        setSelectedAdmin(admin);
                        fetchAdminAudits(admin.id);
                      }}
                      className="text-[8px] font-bold text-white hover:text-slate-400 transition-colors uppercase tracking-widest"
                    >
                      Details
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-white/5 p-12 rounded-[40px] border border-white/10 border-dashed relative overflow-hidden group/audit">
            <div className="absolute top-0 right-0 p-12 opacity-5 group-hover/audit:opacity-10 transition-opacity">
              <Terminal size={120} className="text-white" />
            </div>
            <div className="flex flex-col items-center text-center max-w-md mx-auto space-y-8 relative z-10">
              <div className="w-20 h-20 rounded-[28px] bg-bg-panel border border-white/10 flex items-center justify-center text-slate-500 shadow-sm">
                <Shield size={40} className="text-white" />
              </div>
              <div className="space-y-3">
                <h4 className="text-2xl font-bold text-white tracking-tight">Security Audit Log</h4>
                <p className="text-base text-slate-400 font-medium leading-relaxed">All administrative actions are logged and audited with cryptographic integrity for platform security.</p>
              </div>
              <button 
                onClick={() => {
                  setActiveTab('audits');
                  fetchGlobalAudits();
                }}
                className="px-10 py-4 bg-white text-bg-dark rounded-2xl text-[11px] font-bold hover:bg-slate-200 transition-all shadow-lg uppercase tracking-widest"
              >
                View Full Audit Trail
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'permissions' && (
        <div className="space-y-10">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-3xl font-bold text-white tracking-tight">Role Permissions</h2>
              <p className="text-slate-400 mt-2 font-medium">Define and manage administrative authority levels.</p>
            </div>
            {isSuperAdmin && (
              <button 
                onClick={() => {
                  setEditingRole(null);
                  setRoleForm({ name: '', permissions: [] });
                  setShowRoleModal(true);
                }}
                className="flex items-center gap-3 px-8 py-4 bg-accent-blue text-white text-[11px] font-bold rounded-2xl hover:bg-blue-600 transition-all shadow-xl shadow-blue-500/20 uppercase tracking-widest"
              >
                <Shield size={18} /> Create Custom Role
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {settings?.security?.roles?.map((role) => (
              <motion.div
                key={role.id}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-bg-panel rounded-[32px] border border-white/10 overflow-hidden shadow-sm relative group/role"
              >
                <div className="absolute top-0 left-0 w-full h-1.5 bg-accent-orange" />
                <div className="p-10 border-b border-white/5 bg-white/[0.02]">
                  <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-6">
                      <div className="w-14 h-14 rounded-2xl flex items-center justify-center bg-accent-orange/10 text-accent-orange border border-accent-orange/20 shadow-sm">
                        <Shield size={28} />
                      </div>
                      <div>
                        <h3 className="text-2xl font-bold text-white capitalize tracking-tight leading-none">{role.name}</h3>
                        <p className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em] mt-2">Custom Dynamic Role</p>
                      </div>
                    </div>
                    {isSuperAdmin && (
                      <div className="flex items-center gap-2 opacity-0 group-hover/role:opacity-100 transition-all">
                        <button 
                          onClick={() => {
                            setEditingRole(role);
                            setRoleForm({ name: role.name, permissions: role.permissions });
                            setShowRoleModal(true);
                          }}
                          className="p-2.5 bg-bg-panel border border-white/10 text-slate-500 hover:text-white rounded-xl shadow-sm transition-all"
                        >
                          <Edit2 size={16} />
                        </button>
                        <button 
                          onClick={() => handleDeleteRole(role.id, role.name)}
                          className="p-2.5 bg-bg-panel border border-white/10 text-slate-500 hover:text-red-500 rounded-xl shadow-sm transition-all"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
                <div className="p-10">
                  <h4 className="text-[10px] font-bold text-slate-500 mb-6 flex items-center gap-3 uppercase tracking-[0.3em]">
                    <ShieldCheck size={16} className="text-accent-blue" />
                    Assigned Permissions
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {role.permissions.map((permission, idx) => (
                      <div key={idx} className="flex items-center gap-3 text-sm text-slate-400 font-medium group/perm">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-blue/40 group-hover/perm:bg-accent-blue transition-colors" />
                        {permission}
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            ))}
            {(Object.entries(rolePermissions) as [AdminRole, typeof rolePermissions['super_admin']][]).map(([role, data]) => (
              <motion.div
                key={role}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-bg-panel rounded-[32px] border border-white/10 overflow-hidden shadow-sm relative group/role"
              >
                <div className={cn(
                  "absolute top-0 left-0 w-full h-1.5",
                  role === 'super_admin' ? "bg-white" :
                  role === 'operations_admin' ? "bg-accent-blue" :
                  role === 'finance_admin' ? "bg-accent-green" :
                  "bg-accent-orange"
                )} />
                <div className="p-10 border-b border-white/5 bg-white/[0.02]">
                  <div className="flex items-center gap-6">
                    <div className={cn(
                      "w-14 h-14 rounded-2xl flex items-center justify-center border shadow-sm",
                      role === 'super_admin' ? "bg-white text-bg-dark border-white" :
                      role === 'operations_admin' ? "bg-accent-blue/10 text-accent-blue border-accent-blue/20" :
                      role === 'finance_admin' ? "bg-accent-green/10 text-accent-green border-accent-green/20" :
                      "bg-accent-orange/10 text-accent-orange border-accent-orange/20"
                    )}>
                      <Shield size={28} />
                    </div>
                    <div>
                      <h3 className="text-2xl font-bold text-white capitalize tracking-tight leading-none">{role.replace('_', ' ')}</h3>
                      <p className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.2em] mt-2">{data.description}</p>
                    </div>
                  </div>
                </div>
                <div className="p-10">
                  <h4 className="text-[10px] font-bold text-slate-500 mb-6 flex items-center gap-3 uppercase tracking-[0.3em]">
                    <ShieldCheck size={16} className="text-accent-blue" />
                    Assigned Permissions
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {data.permissions.map((permission, idx) => (
                      <div key={idx} className="flex items-center gap-3 text-sm text-slate-400 font-medium group/perm">
                        <div className="w-1.5 h-1.5 rounded-full bg-accent-blue/40 group-hover/perm:bg-accent-blue transition-colors" />
                        {permission}
                      </div>
                    ))}
                  </div>
                </div>
              </motion.div>
            ))}
          </div>

          <div className="bg-bg-panel rounded-[32px] p-10 border border-white/10 shadow-sm relative overflow-hidden">
            <div className="absolute top-0 right-0 p-8 opacity-5">
              <Info size={100} className="text-white" />
            </div>
            <div className="flex gap-8 relative z-10">
              <div className="w-14 h-14 rounded-2xl bg-white/5 flex items-center justify-center text-slate-400 border border-white/10 shadow-sm shrink-0">
                <Info size={28} />
              </div>
              <div className="space-y-3">
                <h3 className="text-2xl font-bold text-white tracking-tight">About RBAC Visibility</h3>
                <p className="text-lg text-slate-400 leading-relaxed font-medium max-w-4xl">
                  Handy Hub utilizes a sophisticated Role-Based Access Control (RBAC) architecture to ensure that administrative authority is precisely distributed. 
                  Permissions are cryptographically enforced at the database layer, ensuring that even in the event of a client-side breach, system integrity remains uncompromised.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Role Modal */}
      <AnimatePresence>
        {showRoleModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowRoleModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-xl bg-bg-panel rounded-3xl border border-white/10 shadow-2xl overflow-hidden"
            >
              <div className="absolute top-0 left-0 w-full h-1.5 bg-white" />
              
              <div className="p-6">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center text-slate-400 border border-white/10 shadow-sm">
                      <Shield size={24} />
                    </div>
                    <div>
                      <h2 className="text-xl font-bold text-white tracking-tight">{editingRole ? 'Edit Role' : 'Create Custom Role'}</h2>
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.2em] mt-1">Define platform access levels</p>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowRoleModal(false)}
                    className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-slate-400 hover:bg-white/10 hover:text-white transition-all border border-white/10"
                  >
                    <X size={18} />
                  </button>
                </div>

                <form onSubmit={handleSaveRole} className="space-y-6">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.2em] ml-1">Role Name</label>
                      <input
                        type="text"
                        required
                        value={roleForm.name}
                        onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
                        placeholder="e.g. Finance Supervisor"
                        className="w-full bg-white/5 border border-white/10 rounded-xl py-3 px-4 text-white placeholder:text-slate-600 focus:outline-none focus:border-white/20 focus:bg-white/[0.08] transition-all text-sm font-medium"
                      />
                    </div>

                    <div className="space-y-2">
                      <label className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.2em] ml-1">Permissions</label>
                      <div className="grid grid-cols-2 gap-2">
                        {[
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
                        ].map((perm) => (
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
                              "flex items-center gap-2 p-3 rounded-xl border text-left transition-all",
                              roleForm.permissions.includes(perm.id)
                                ? "bg-white border-white text-bg-dark shadow-md"
                                : "bg-white/5 border-white/10 text-slate-400 hover:border-white/20"
                            )}
                          >
                            <div className={cn(
                              "w-4 h-4 rounded-lg border flex items-center justify-center shrink-0",
                              roleForm.permissions.includes(perm.id) ? "border-bg-dark" : "border-white/20"
                            )}>
                              {roleForm.permissions.includes(perm.id) && <Check size={10} />}
                            </div>
                            <span className="text-[11px] font-bold">{perm.label}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="pt-2 flex gap-3">
                    <button
                      type="button"
                      onClick={() => setShowRoleModal(false)}
                      className="flex-1 px-6 py-3 rounded-xl bg-white/5 text-slate-400 text-[10px] font-bold hover:bg-white/10 transition-all uppercase tracking-widest border border-white/10"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isRoleSaving}
                      className="flex-1 px-6 py-3 rounded-xl bg-white text-bg-dark text-[10px] font-bold hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all uppercase tracking-widest shadow-lg shadow-slate-900/10"
                    >
                      {isRoleSaving ? 'Saving...' : (editingRole ? 'Update Role' : 'Create Role')}
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Invite Admin Modal */}
      <AnimatePresence>
        {showInviteModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowInviteModal(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-lg bg-bg-panel rounded-3xl border border-white/10 shadow-2xl overflow-hidden"
            >
              <div className="absolute top-0 left-0 w-full h-1.5 bg-white" />
              
              <div className="p-5">
                <div className="flex items-center justify-between mb-5">
                  <div className="flex items-center gap-4">
                    <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center text-slate-400 border border-white/10 shadow-sm">
                      <UserPlus size={24} />
                    </div>
                    <div>
                      <h2 className="text-lg font-bold text-white tracking-tight">
                        Create Administrator
                      </h2>
                      <p className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.2em] mt-1">
                        Directly add and set login details
                      </p>
                    </div>
                  </div>
                  <button
                    onClick={() => setShowInviteModal(false)}
                    className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-slate-400 hover:bg-white/10 hover:text-white transition-all border border-white/10"
                  >
                    <X size={18} />
                  </button>
                </div>

                <form onSubmit={handleCreateAdmin} className="space-y-6">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <label className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.2em] ml-1">Full Name</label>
                      <div className="relative group">
                        <User className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-white transition-colors" size={18} />
                        <input
                          type="text"
                          required
                          value={inviteForm.name}
                          onChange={(e) => setInviteForm({ ...inviteForm, name: e.target.value })}
                          placeholder="Kwame Mensah"
                          className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-white placeholder:text-slate-600 focus:outline-none focus:border-white/20 focus:bg-white/[0.08] transition-all text-sm font-medium"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.2em] ml-1">Email Address</label>
                      <div className="relative group">
                        <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-white transition-colors" size={18} />
                        <input
                          type="email"
                          required
                          value={inviteForm.email}
                          onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                          placeholder="admin@handyhub.com"
                          className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-white placeholder:text-slate-600 focus:outline-none focus:border-white/20 focus:bg-white/[0.08] transition-all text-sm font-medium"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <label className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.2em] ml-1">Temporary Password</label>
                      <div className="relative group">
                        <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 group-focus-within:text-white transition-colors" size={18} />
                        <input
                          type="password"
                          required
                          value={inviteForm.password}
                          onChange={(e) => setInviteForm({ ...inviteForm, password: e.target.value })}
                          placeholder="••••••••"
                          className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-12 pr-4 text-white placeholder:text-slate-600 focus:outline-none focus:border-white/20 focus:bg-white/[0.08] transition-all text-sm font-medium"
                        />
                      </div>
                      <p className="text-[8px] text-white/20 ml-1 italic">* User will use this to login for the first time.</p>
                    </div>


                    <div className="space-y-2">
                      <label className="text-[9px] font-bold text-slate-500 uppercase tracking-[0.2em] ml-1">Administrative Role</label>
                      <div className="grid grid-cols-2 gap-3">
                        {(Object.keys(rolePermissions) as AdminRole[]).map((role) => (
                          <button
                            key={role}
                            type="button"
                            onClick={() => setInviteForm({ ...inviteForm, role })}
                            className={cn(
                              "p-3 rounded-xl border text-left transition-all relative overflow-hidden group/role-btn",
                              inviteForm.role === role 
                                ? "bg-white border-white text-bg-dark shadow-md" 
                                : "bg-white/5 border-white/10 text-slate-500 hover:border-white/20 hover:bg-white/10"
                            )}
                          >
                            <div className="flex items-center justify-between mb-1">
                              <Shield size={14} className={inviteForm.role === role ? "text-bg-dark" : "text-slate-500"} />
                              {inviteForm.role === role && (
                                <motion.div layoutId="active-check" className="w-4 h-4 rounded-full bg-white flex items-center justify-center">
                                  <Check size={10} className="text-bg-dark" />
                                </motion.div>
                              )}
                            </div>
                            <span className="block font-bold text-[10px] capitalize">{role.replace('_', ' ')}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="bg-blue-500/5 border border-blue-500/10 rounded-xl p-4">
                    <p className="text-[10px] text-blue-400 font-medium leading-relaxed">
                      <Info size={12} className="inline mr-2 mb-0.5" />
                      The account will be created immediately. You must provide the user with their temporary password.
                    </p>
                  </div>

                  <div className="pt-2 flex gap-3">
                    <button
                      type="button"
                      onClick={() => setShowInviteModal(false)}
                      className="flex-1 px-6 py-3 rounded-xl bg-white/5 text-slate-400 text-[10px] font-bold hover:bg-white/10 transition-all uppercase tracking-widest border border-white/10"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={isCreating}
                      className="flex-1 px-6 py-3 rounded-xl bg-white text-bg-dark text-[10px] font-bold hover:bg-slate-200 disabled:opacity-50 disabled:cursor-not-allowed transition-all uppercase tracking-widest shadow-lg shadow-slate-900/10"
                    >
                      {isCreating ? 'Processing...' : 'Create Account'}
                    </button>
                  </div>
                </form>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Admin Details & Audits Modal */}
      <AnimatePresence>
        {selectedAdmin && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setSelectedAdmin(null)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-3xl bg-bg-panel rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] border border-white/10"
            >
              <div className="p-4 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "w-10 h-10 rounded-xl flex items-center justify-center text-bg-dark font-bold text-base",
                    selectedAdmin.role === 'super_admin' ? "bg-white" : "bg-accent-blue"
                  )}>
                    {selectedAdmin.name?.split(' ').map(n => n[0]).join('')}
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-white leading-none">{selectedAdmin.name}</h3>
                    <p className="text-[10px] text-slate-500 font-sans mt-1">{selectedAdmin.email}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => window.print()}
                    className="flex items-center gap-2 px-3 py-1.5 bg-white/5 text-white text-[10px] font-bold rounded-lg hover:bg-white/10 transition-all border border-white/10 uppercase tracking-widest shadow-sm"
                  >
                    <Printer size={14} /> Print Audit
                  </button>
                  <button 
                    onClick={() => setSelectedAdmin(null)}
                    className="p-1.5 hover:bg-white/5 rounded-lg transition-colors text-slate-400 hover:text-white border border-transparent hover:border-white/10 shadow-sm"
                  >
                    <X size={18} />
                  </button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-6">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                  {/* Left Column: Info & Role Management */}
                  <div className="space-y-6">
                    <section className="space-y-3">
                      <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                        <Activity size={12} />
                        Account Status
                      </h4>
                      <div className="p-3 bg-white/5 rounded-xl border border-white/10 space-y-2">
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] text-slate-500">Current Role</span>
                          <span className="text-[10px] font-bold text-white uppercase">{selectedAdmin.role.replace('_', ' ')}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] text-slate-500">Status</span>
                          <span className={cn(
                            "px-1.5 py-0.5 rounded text-[9px] font-bold uppercase",
                            selectedAdmin.status === 'active' ? "bg-accent-green/10 text-accent-green" : "bg-red-500/10 text-red-500"
                          )}>{selectedAdmin.status}</span>
                        </div>
                        <div className="flex justify-between items-center">
                          <span className="text-[10px] text-slate-500">Last Login</span>
                          <span className="text-[10px] font-medium text-white">{selectedAdmin.lastLogin}</span>
                        </div>
                      </div>
                    </section>

                    {isSuperAdmin && (
                      <section className="space-y-4">
                        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                          <Shield size={14} />
                          Assign Role
                        </h4>
                        <div className="space-y-2">
                          {settings?.security?.roles?.map((role) => (
                            <button
                              key={role.name}
                              disabled={isUpdatingRole || selectedAdmin.role === role.name}
                              onClick={() => handleUpdateRole(selectedAdmin.id, role.name as AdminRole)}
                              className={cn(
                                "w-full flex items-center justify-between p-3 rounded-xl border transition-all text-left",
                                selectedAdmin.role === role.name
                                  ? "bg-white border-white text-bg-dark"
                                  : "bg-white/5 border-white/10 text-slate-400 hover:border-white/20 hover:bg-white/10"
                              )}
                            >
                              <div className="flex items-center gap-3">
                                {selectedAdmin.role === role.name ? <ShieldCheck size={16} /> : <Shield size={16} />}
                                <span className="text-sm font-bold uppercase">{role.name.replace('_', ' ')}</span>
                              </div>
                              {selectedAdmin.role === role.name && <Check size={16} />}
                            </button>
                          ))}
                        </div>
                        <p className="text-[10px] text-slate-500 font-sans leading-relaxed italic">
                          * Changing an admin's role will immediately update their platform permissions.
                        </p>
                      </section>
                    )}
                  </div>

                  {/* Right Column: Audit Logs */}
                  <div className="lg:col-span-2 space-y-4">
                    <h4 className="text-xs font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                      <Terminal size={14} />
                      Activity Audit Logs
                    </h4>
                    
                    <div className="bg-white/5 rounded-2xl overflow-hidden border border-white/10 shadow-inner min-h-[400px]">
                      {loadingAudits ? (
                        <div className="flex items-center justify-center h-full py-20">
                          <div className="w-8 h-8 border-2 border-white/10 border-t-white rounded-full animate-spin"></div>
                        </div>
                      ) : adminAudits.length > 0 ? (
                        <div className="divide-y divide-white/5">
                          {adminAudits?.map((log) => (
                            <div key={log.id} className="p-4 hover:bg-white/[0.02] transition-colors group">
                              <div className="flex items-start justify-between gap-4">
                                <div className="space-y-1">
                                  <div className="flex items-center gap-2">
                                    <span className="text-white text-xs font-mono font-bold">{log.action}</span>
                                    <span className="text-slate-600 text-[10px] font-mono">on</span>
                                    <span className="text-slate-400 text-xs font-mono font-medium">{log.target}</span>
                                  </div>
                                  <p className="text-slate-500 text-[11px] font-sans leading-relaxed">{log.details}</p>
                                </div>
                                <div className="text-right shrink-0">
                                  <p className="text-slate-500 text-[10px] font-mono">{new Date(log.timestamp).toLocaleString()}</p>
                                  <p className="text-slate-600 text-[9px] font-mono mt-1">{log.ip}</p>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="flex flex-col items-center justify-center h-full py-20 text-slate-600 space-y-3">
                          <Terminal size={32} className="opacity-20" />
                          <p className="text-xs font-sans">No activity logs found for this administrator.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              <div className="p-6 bg-white/[0.02] border-t border-white/5 flex justify-between items-center">
                <p className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">
                  Admin ID: {selectedAdmin.id}
                </p>
                <button 
                  onClick={() => setSelectedAdmin(null)}
                  className="px-6 py-2 bg-white text-bg-dark rounded-xl text-sm font-bold hover:bg-slate-200 transition-all"
                >
                  Done
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Global Audit Logs Modal */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, x: '-50%' }}
            animate={{ opacity: 1, y: 0, x: '-50%' }}
            exit={{ opacity: 0, y: 20, x: '-50%' }}
            className={cn(
              "fixed bottom-8 left-1/2 z-50 px-6 py-3 rounded-2xl shadow-2xl flex items-center gap-3 min-w-[300px]",
              toast.type === 'success' ? "bg-white text-bg-dark" : "bg-red-600 text-white"
            )}
          >
            <span className="text-sm font-bold">{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showGlobalAudits && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowGlobalAudits(false)}
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
            />
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 20 }}
              className="relative w-full max-w-4xl bg-bg-panel rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh] border border-white/10"
            >
              <div className="p-4 border-b border-white/5 flex items-center justify-between bg-white text-bg-dark">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-bg-dark rounded-lg flex items-center justify-center text-white">
                    <History size={18} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold leading-none">System-wide Security Audit</h3>
                    <p className="text-[9px] text-slate-500 uppercase tracking-widest mt-1">Real-time administrative activity monitor</p>
                  </div>
                </div>
                <button 
                  onClick={() => setShowGlobalAudits(false)}
                  className="p-1.5 hover:bg-bg-dark/10 rounded-lg transition-colors text-slate-500 hover:text-bg-dark"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="flex-1 overflow-auto bg-bg-panel">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-white/[0.02] z-10 backdrop-blur-md">
                    <tr>
                      <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Administrator</th>
                      <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Action</th>
                      <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Target</th>
                      <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Details</th>
                      <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest">Timestamp</th>
                      <th className="px-6 py-4 text-[10px] font-bold text-white/40 uppercase tracking-widest text-right">IP Address</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {globalAudits?.map((log) => (
                      <tr key={log.id} className="group hover:bg-white/[0.02] transition-colors">
                        <td className="px-6 py-5">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center text-[10px] font-bold text-white/20 border border-white/5 group-hover:border-accent-blue/30 transition-colors">
                              {log.adminName?.split(' ').map(n => n[0]).join('')}
                            </div>
                            <span className="text-xs font-bold text-white group-hover:text-accent-blue transition-colors">{log.adminName}</span>
                          </div>
                        </td>
                        <td className="px-6 py-5">
                          <span className="text-[10px] font-mono font-bold text-white/60 bg-white/5 px-2 py-1 rounded border border-white/5">{log.action}</span>
                        </td>
                        <td className="px-6 py-5">
                          <span className="text-[10px] font-mono text-white/40">{log.target}</span>
                        </td>
                        <td className="px-6 py-5">
                          <p className="text-[11px] text-white/40 font-medium max-w-xs truncate group-hover:text-white/60 transition-colors">{log.details}</p>
                        </td>
                        <td className="px-6 py-5">
                          <span className="text-[10px] font-mono text-white/20">{new Date(log.timestamp).toLocaleString()}</span>
                        </td>
                        <td className="px-6 py-5 text-right">
                          <span className="text-[10px] font-mono text-white/20">{log.ip}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="p-6 bg-white/[0.02] border-t border-white/5 flex justify-between items-center">
                <div className="flex items-center gap-2 text-slate-500">
                  <Activity size={14} className="animate-pulse text-emerald-500" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">Live Monitoring Active</span>
                </div>
                <button 
                  onClick={() => setShowGlobalAudits(false)}
                  className="px-6 py-2 bg-slate-900 text-white rounded-xl text-sm font-bold hover:bg-slate-800 transition-all"
                >
                  Close Monitor
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
