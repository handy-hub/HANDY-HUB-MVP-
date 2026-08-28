import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Grid, 
  Wrench, 
  User, 
  Briefcase, 
  CreditCard, 
  Gavel, 
  BarChart3, 
  Settings, 
  Shield,
  LogOut,
  ChevronDown,
  ArrowLeft,
  Settings as SettingsIcon,
  Users,
  Bell,
  CreditCard as PaymentIcon,
  MapPin,
  History,
  Terminal,
  Calendar,
  DollarSign,
  Globe,
  Cpu,
  MessageSquare
} from 'lucide-react';
import { cn } from '../utils';
import { auth, db } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { AdminUser } from '../types';

const navItems = [
  { id: 'dashboard', path: '/', label: 'Dashboard', icon: Grid, roles: ['super_admin', 'finance_admin', 'operations_admin', 'support_admin'] },
  { id: 'artisans', path: '/artisans', label: 'Artist', icon: Wrench, roles: ['super_admin', 'operations_admin'] },
  { id: 'customers', path: '/customers', label: 'Users', icon: User, roles: ['super_admin', 'support_admin'] },
  { id: 'jobs', path: '/jobs', label: 'Job', icon: Briefcase, roles: ['super_admin', 'operations_admin'] },
  { 
    id: 'financials', 
    label: 'Escrow & Payments', 
    icon: CreditCard, 
    hasDropdown: true,
    roles: ['super_admin', 'finance_admin'],
    subItems: [
      { id: 'escrow', path: '/escrow', label: 'Escrow Overview' },
      { id: 'payouts', path: '/escrow?tab=payouts', label: 'Payout Requests' },
      { id: 'transactions', path: '/escrow?tab=history', label: 'Transactions' },
    ]
  },
  { 
    id: 'disputes', 
    label: 'Dispute', 
    icon: Gavel, 
    hasDropdown: true,
    roles: ['super_admin', 'support_admin'],
    subItems: [
      { id: 'dispute_center', path: '/disputes', label: 'Dispute Center' },
      { id: 'refunds', path: '/disputes?tab=refunds', label: 'Refunds' },
    ]
  },
  { id: 'analysis', path: '/analysis', label: 'Analysis', icon: BarChart3, roles: ['super_admin', 'finance_admin', 'operations_admin', 'support_admin'] },
  { id: 'settings', path: '/settings', label: 'Settings', icon: Settings, roles: ['super_admin'] },
  { id: 'connect', path: '/connect', label: 'Connect', icon: MessageSquare, roles: ['super_admin', 'finance_admin', 'operations_admin', 'support_admin'] },
  { id: 'admins', path: '/admins', label: 'Admins', icon: Shield, roles: ['super_admin'] },
];

const settingsSections = [
  {
    title: "System Core",
    items: [
      { id: 'general', label: 'General System', icon: SettingsIcon },
      { id: 'regions', label: 'Operational Regions', icon: Globe },
    ]
  },
  {
    title: "Platform Modules",
    items: [
      { id: 'users', label: 'User Management', icon: Users },
      { id: 'artisans', label: 'Artisan Management', icon: Briefcase },
      { id: 'marketplace', label: 'Marketplace Logic', icon: Calendar },
    ]
  },
  {
    title: "Financials",
    items: [
      { id: 'financials', label: 'Financial Systems', icon: DollarSign },
    ]
  },
  {
    title: "Security & Audit",
    items: [
      { id: 'security', label: 'Security & Privacy', icon: Shield },
      { id: 'audit', label: 'Audit & Compliance', icon: History },
    ]
  },
  {
    title: "Connectivity",
    items: [
      { id: 'communications', label: 'Communication Hub', icon: Bell },
      { id: 'api', label: 'API & Webhooks', icon: Terminal },
      { id: 'advanced', label: 'Advanced Controls', icon: Cpu },
    ]
  }
];

export function Sidebar({ isOpen, onClose }: { isOpen: boolean, onClose: () => void }) {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const location = useLocation();
  const isSettingsPage = location.pathname.startsWith('/settings');

  useEffect(() => {
    const fetchUser = async () => {
      if (auth.currentUser) {
        const adminDoc = await getDoc(doc(db, 'admins', auth.currentUser.uid));
        if (adminDoc.exists()) {
          setUser({ id: auth.currentUser.uid, ...adminDoc.data() } as AdminUser);
        }
      }
    };
    fetchUser();
  }, []);

  const handleLogout = () => {
    auth.signOut();
  };

  const userRole = user?.role || 'any_admin';

  const isAuthorized = (itemRoles: string[]) => {
    if (userRole === 'super_admin') return true;
    return itemRoles.includes(userRole);
  };

  return (
    <>
      {/* Mobile Overlay */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="fixed inset-0 bg-black/60 z-[60] lg:hidden backdrop-blur-sm"
          />
        )}
      </AnimatePresence>

      <aside className={cn(
        "fixed lg:sticky top-0 left-0 w-64 h-screen flex flex-col z-[70] transition-transform duration-300 lg:translate-x-0 border-r border-white/5",
        "bg-bg-dark",
        isOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        {/* Logo Area - Dark Theme */}
        <div className="p-4 flex flex-col items-center justify-center mb-4 border-b border-white/5 relative">
          {isSettingsPage && (
            <Link 
              to="/" 
              className="absolute left-4 top-1/2 -translate-y-1/2 p-2 bg-blue-600/20 text-blue-500 rounded-lg hover:bg-blue-600/30 transition-all border border-blue-600/30"
              title="Back to Dashboard"
            >
              <ArrowLeft size={18} />
            </Link>
          )}
          <h1 className="text-white text-[17px] font-black tracking-tight leading-none">Handy Hub</h1>
          <p className="text-white/40 text-[9px] font-bold uppercase tracking-[0.2em] mt-1">{user?.role.replace('_', ' ') || 'Administrator'}</p>
        </div>

        <nav className="flex-1 px-2 space-y-0.5 overflow-y-auto custom-scrollbar">
          {isSettingsPage ? (
            <div className="space-y-6">
              <div className="px-3 py-2">
                <p className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em]">Platform Management</p>
                <h2 className="text-[17px] font-bold text-white tracking-tight mt-1">Settings</h2>
              </div>
              
              {settingsSections.map((section) => (
                <div key={section.title} className="space-y-1">
                  <div className="px-3 py-1">
                    <p className="text-[9px] font-bold text-white/20 uppercase tracking-[0.15em]">{section.title}</p>
                  </div>
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    const searchParams = new URLSearchParams(location.search);
                    const currentSection = searchParams.get('section') || 'general';
                    const isActive = currentSection === item.id;
                    
                    return (
                      <Link
                        key={item.id}
                        to={`/settings?section=${item.id}`}
                        className={cn(
                          "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-300 group relative",
                          isActive 
                            ? "bg-white/10 text-white shadow-lg" 
                            : "text-white/40 hover:text-white hover:bg-white/5"
                        )}
                      >
                        <Icon size={16} className={cn(
                          "transition-all duration-300",
                          isActive ? "text-white" : "text-white/40 group-hover:text-white"
                        )} />
                        <span className="flex-1 text-[13px] font-semibold">{item.label}</span>
                      </Link>
                    );
                  })}
                </div>
              ))}
            </div>
          ) : (
            navItems.filter(item => isAuthorized(item.roles)).map((item) => {
              const Icon = item.icon;
              const isActive = item.path ? (location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path))) : false;
              const isDropdownOpen = openDropdown === item.id;
              
              if (item.hasDropdown) {
                return (
                  <div 
                    key={item.id} 
                    className="space-y-0.5"
                  >
                    <button
                      onClick={() => setOpenDropdown(isDropdownOpen ? null : item.id)}
                      className={cn(
                        "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-300 group relative",
                        isDropdownOpen ? "bg-white/10 text-white" : "text-white/40 hover:text-white hover:bg-white/5"
                      )}
                    >
                      <Icon size={16} className={cn(
                        "transition-all duration-300",
                        isDropdownOpen ? "text-white" : "text-white/40 group-hover:text-white"
                      )} />
                      <span className="flex-1 text-[13px] font-semibold text-left">{item.label}</span>
                      <ChevronDown size={14} className={cn(
                        "transition-transform duration-300",
                        isDropdownOpen ? "rotate-180 text-white" : "text-white/20"
                      )} />
                    </button>
                    
                    <AnimatePresence>
                      {isDropdownOpen && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          className="overflow-hidden pl-9 space-y-0.5"
                        >
                          {item.subItems?.map((sub) => (
                            <Link
                              key={sub.id}
                              to={sub.path}
                              onClick={() => {
                                if (window.innerWidth < 1024) onClose();
                              }}
                              className={cn(
                                "block py-1.5 text-[12px] font-medium transition-colors",
                                location.pathname + location.search === sub.path
                                  ? "text-blue-400"
                                  : "text-white/30 hover:text-white"
                              )}
                            >
                              {sub.label}
                            </Link>
                          ))}
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                );
              }

              return (
                <Link
                  key={item.id}
                  to={item.path!}
                  onClick={() => {
                    if (window.innerWidth < 1024) onClose();
                  }}
                  className={cn(
                    "w-full flex items-center gap-2.5 px-3 py-2 rounded-lg transition-all duration-300 group relative",
                    isActive 
                      ? "bg-white/10 text-white shadow-lg" 
                      : "text-white/40 hover:text-white hover:bg-white/5"
                  )}
                >
                  <Icon size={16} className={cn(
                    "transition-all duration-300",
                    isActive ? "text-white" : "text-white/40 group-hover:text-white"
                  )} />
                  
                  <span className="flex-1 text-[13px] font-semibold">{item.label}</span>
                </Link>
              );
            })
          )}
        </nav>

        {/* User Profile Section */}
        <div className="p-3 border-t border-white/5">
          <div className="flex items-center gap-2.5 p-2 rounded-xl bg-white/5 group">
            <Link 
              to="/profile"
              onClick={() => {
                if (window.innerWidth < 1024) onClose();
              }}
              className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center overflow-hidden shrink-0 border border-white/10 hover:border-accent-blue/50 transition-colors"
            >
              {user?.photoURL ? (
                <img src={user.photoURL} alt={user.name} className="w-full h-full object-cover" />
              ) : (
                <User size={16} className="text-white/40 group-hover:text-accent-blue transition-colors" />
              )}
            </Link>
            <div className="flex-1 min-w-0">
              <Link 
                to="/profile"
                onClick={() => {
                  if (window.innerWidth < 1024) onClose();
                }}
                className="text-[12px] font-bold text-white truncate hover:text-accent-blue transition-colors block"
              >
                {user?.name || 'Admin User'}
              </Link>
              <button 
                onClick={handleLogout}
                className="flex items-center gap-1 text-[10px] font-bold text-white/30 hover:text-red-400 transition-colors mt-0.5"
              >
                <span>Sign Out</span>
                <LogOut size={10} />
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}
