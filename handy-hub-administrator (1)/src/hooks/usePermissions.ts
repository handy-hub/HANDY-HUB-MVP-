import { useState, useEffect } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { AdminUser } from '../types';
import { onAuthStateChanged, User } from 'firebase/auth';

export function usePermissions() {
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(auth.currentUser);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      if (!u) {
        setAdmin(null);
        setSettings(null);
        setLoading(false);
      }
    });
    return () => unsub();
  }, []);

  useEffect(() => {
    if (!user) return;

    const unsubAdmin = onSnapshot(doc(db, 'admins', user.uid), (snap) => {
      if (snap.exists()) {
        setAdmin({ id: snap.id, ...snap.data() } as AdminUser);
      }
      setLoading(false);
    }, (error) => {
      console.warn("Failed to fetch admin permissions:", error.message);
      setLoading(false);
    });

    const unsubSettings = onSnapshot(doc(db, 'settings', 'platform'), (snap) => {
      if (snap.exists()) {
        setSettings(snap.data());
      }
    }, (error) => {
      console.warn("Failed to fetch platform settings for permissions:", error.message);
    });

    return () => {
      unsubAdmin();
      unsubSettings();
    };
  }, [user]);

  const hasPermission = (permission: string) => {
    if (!admin) return false;
    if (admin.role === 'super_admin') return true;

    // Check built-in roles
    const builtInPermissions: Record<string, string[]> = {
      operations_admin: ['Artisans', 'Jobs'],
      finance_admin: ['Escrow'],
      support_admin: ['Customers', 'Disputes']
    };

    if (builtInPermissions[admin.role]?.includes(permission)) return true;

    // Check custom roles from settings
    const customRole = settings?.security?.roles?.find((r: any) => r.id === admin.role);
    if (customRole?.permissions?.includes(permission)) return true;

    return false;
  };

  return { admin, settings, hasPermission, loading };
}
