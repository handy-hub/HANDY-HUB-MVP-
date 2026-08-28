import React, { useEffect, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { AdminUser, AdminRole, PlatformSettings } from '../types';
import { DEFAULT_SETTINGS } from '../constants/defaultSettings';
import { useFirebase } from './FirebaseProvider';

interface AuthGuardProps {
  children: React.ReactNode;
  requiredRole?: AdminRole | 'any_admin';
  requiredPermission?: string;
}

export const AuthGuard: React.FC<AuthGuardProps> = ({ children, requiredRole, requiredPermission }) => {
  const { user: firebaseUser, loading: authLoading } = useFirebase();
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<AdminUser | null>(null);
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const location = useLocation();

  useEffect(() => {
    const fetchUserData = async () => {
      if (firebaseUser) {
        try {
          // Fetch settings first
          let currentSettings = DEFAULT_SETTINGS;
          const settingsDoc = await getDoc(doc(db, 'settings', 'platform'));
          if (settingsDoc.exists()) {
            currentSettings = { ...DEFAULT_SETTINGS, ...settingsDoc.data() as PlatformSettings };
            setSettings(currentSettings);
          } else if (firebaseUser.email === 'silas7korda@gmail.com' || firebaseUser.email === 'clasceth4traders@gmail.com') {
            await setDoc(doc(db, 'settings', 'platform'), DEFAULT_SETTINGS);
            setSettings(DEFAULT_SETTINGS);
          }

          // 1. Check Admins
          const adminDoc = await getDoc(doc(db, 'admins', firebaseUser.uid));
          if (adminDoc.exists()) {
            setUser({ id: firebaseUser.uid, ...adminDoc.data(), userType: 'admin' } as AdminUser);
            setLoading(false);
            return;
          }

          // 2. Check Artisans
          const artisanDoc = await getDoc(doc(db, 'artisans', firebaseUser.uid));
          if (artisanDoc.exists()) {
            setUser({ id: firebaseUser.uid, ...artisanDoc.data(), userType: 'artisan' } as any);
            setLoading(false);
            return;
          }

          // 3. Check Customers
          const customerDoc = await getDoc(doc(db, 'customers', firebaseUser.uid));
          if (customerDoc.exists()) {
            setUser({ id: firebaseUser.uid, ...customerDoc.data(), userType: 'customer' } as any);
            setLoading(false);
            return;
          }

          // 4. Special case: Bootstrap Owner
          if ((firebaseUser.email === 'silas7korda@gmail.com' || firebaseUser.email === 'clasceth4traders@gmail.com') && firebaseUser.emailVerified) {
            const superAdminData = {
              id: firebaseUser.uid,
              name: firebaseUser.displayName || 'System Owner',
              email: firebaseUser.email,
              role: 'super_admin' as AdminRole,
              status: 'active' as const,
              userType: 'admin' as const,
              createdAt: new Date().toISOString(),
              lastLogin: new Date().toISOString()
            };
            await setDoc(doc(db, 'admins', firebaseUser.uid), superAdminData);
            setUser(superAdminData as AdminUser);
          } else {
            setUser(null);
          }
        } catch (error) {
          console.error("Error fetching user data:", error);
          setUser(null);
        }
      } else {
        setUser(null);
      }
      setLoading(false);
    };

    if (!authLoading) {
      fetchUserData();
    }
  }, [firebaseUser, authLoading]);

  if (authLoading || loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg-dark">
        <div className="w-10 h-10 border-4 border-white/5 border-t-accent-blue rounded-full animate-spin"></div>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Handle Artisan & Customer redirections if they try to access Admin routes
  if (user.userType !== 'admin' && location.pathname !== `/${user.userType}-dashboard`) {
     return <Navigate to={`/${user.userType}-dashboard`} replace />;
  }

  if (user.status === 'suspended') {
    return (
      <div className="flex items-center justify-center h-screen bg-bg-dark p-4">
        <div className="max-w-md w-full bg-bg-panel rounded-3xl shadow-2xl p-8 text-center border border-white/10">
          <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center text-red-500 mx-auto mb-6">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">Account Suspended</h2>
          <p className="text-white/40 mb-8">Your administrator account has been suspended. Please contact the system owner for more information.</p>
          <button 
            onClick={() => auth.signOut()}
            className="w-full py-3 bg-white text-bg-dark rounded-xl font-bold hover:bg-white/90 transition-all"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  if (user.status === 'pending') {
    return (
      <div className="flex items-center justify-center h-screen bg-bg-dark p-4">
        <div className="max-w-md w-full bg-bg-panel rounded-3xl shadow-2xl p-8 text-center border border-white/10">
          <div className="w-16 h-16 bg-accent-orange/10 rounded-2xl flex items-center justify-center text-accent-orange mx-auto mb-6">
            <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">Approval Pending</h2>
          <p className="text-white/40 mb-8">Your account is currently awaiting approval from a Super Admin. You will be notified once your access is granted.</p>
          <button 
            onClick={() => auth.signOut()}
            className="w-full py-3 bg-white text-bg-dark rounded-xl font-bold hover:bg-white/90 transition-all"
          >
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  // Super Admin always has access
  if (user.role === 'super_admin') return <>{children}</>;

  // Check permissions if required
  if (requiredPermission) {
    // Built-in roles permissions
    const builtInPermissions: Record<string, string[]> = {
      operations_admin: ['Artisans', 'Jobs', 'Customers', 'Disputes', 'Regions'],
      finance_admin: ['Escrow', 'Payments', 'Commission', 'Payouts'],
      support_admin: ['Customers', 'Disputes', 'Jobs'],
    };

    const userPermissions = builtInPermissions[user.role] || [];
    
    // Check custom roles in settings
    const customRole = settings?.security.roles.find(r => r.id === user.role || r.name.toLowerCase() === user.role.toLowerCase());
    if (customRole) {
      userPermissions.push(...customRole.permissions);
    }

    if (!userPermissions.includes(requiredPermission)) {
      return <Navigate to="/" replace />;
    }
  }

  // Check role if required (legacy support)
  if (requiredRole && requiredRole !== 'any_admin') {
    if (user.role !== requiredRole) {
      return <Navigate to="/" replace />;
    }
  }

  return <>{children}</>;
};
