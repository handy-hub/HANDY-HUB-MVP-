import React, { Component } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';
import { Topbar } from './components/Topbar';
import { Dashboard } from './pages/Dashboard';
import { Artisans } from './pages/Artisans';
import { Jobs } from './pages/Jobs';
import { Escrow } from './pages/Escrow';
import { Customers } from './pages/Customers';
import { Disputes } from './pages/Disputes';
import { Analysis } from './pages/Analysis';
import { Settings } from './pages/Settings';
import { Admins } from './pages/Admins';
import { Profile } from './pages/Profile';
import Connect from './pages/Connect';
import { Login } from './pages/Login';
import { LoginCallback } from './pages/LoginCallback';
import { Registration } from './pages/Registration';
import { ArtisanDashboard } from './pages/ArtisanDashboard';
import { CustomerDashboard } from './pages/CustomerDashboard';
import { AuthGuard } from './components/AuthGuard';
import { AnimatePresence, motion } from 'motion/react';

function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [isSidebarOpen, setIsSidebarOpen] = React.useState(false);

  return (
    <div className="flex min-h-screen bg-bg-dark">
      <Sidebar isOpen={isSidebarOpen} onClose={() => setIsSidebarOpen(false)} />
      
      <div className="flex-1 flex flex-col min-w-0">
        <Topbar onMenuClick={() => setIsSidebarOpen(true)} />
        
        <main className="flex-1 p-4 lg:p-8 overflow-y-auto">
          <div className="min-h-full">
            <AnimatePresence mode="wait">
              <motion.div 
                key={location.pathname}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </div>
        </main>
      </div>
    </div>
  );
}

import { useSessionTimeout } from './hooks/useSessionTimeout';
import { AlertTriangle } from 'lucide-react';
import { CommandPalette } from './components/CommandPalette';
import { BroadcastCenter } from './components/BroadcastCenter';

// Error Boundary Component
interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };
  props: ErrorBoundaryProps;

  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.props = props;
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("Uncaught error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-bg-dark flex items-center justify-center p-6 text-center">
          <div className="max-w-md w-full p-8 bg-bg-panel border border-white/10 rounded-2xl shadow-xl">
            <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center text-red-500 mx-auto mb-6">
              <AlertTriangle size={32} />
            </div>
            <h2 className="text-2xl font-bold text-white mb-4">Something went wrong</h2>
            <p className="text-slate-400 mb-8 text-sm leading-relaxed">
              The application encountered an unexpected error. This has been logged for review.
            </p>
            <button 
              onClick={() => window.location.reload()}
              className="w-full py-3 bg-accent-blue text-white rounded-xl font-bold hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function AppContent() {
  const { showWarning, remainingSeconds, extendSession, logout } = useSessionTimeout();
  
  return (
    <>
      <CommandPalette />
      <BroadcastCenter />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Registration />} />
        <Route path="/login-callback" element={<LoginCallback />} />
        
        <Route path="/artisan-dashboard" element={
          <AuthGuard>
            <ArtisanDashboard />
          </AuthGuard>
        } />

        <Route path="/customer-dashboard" element={
          <AuthGuard>
            <CustomerDashboard />
          </AuthGuard>
        } />
        
        <Route path="/" element={
          <AuthGuard requiredRole="any_admin">
            <Layout>
              <Dashboard />
            </Layout>
          </AuthGuard>
        } />

        <Route path="/artisans" element={
          <AuthGuard requiredPermission="Artisans">
            <Layout>
              <Artisans />
            </Layout>
          </AuthGuard>
        } />

        <Route path="/jobs" element={
          <AuthGuard requiredPermission="Jobs">
            <Layout>
              <Jobs />
            </Layout>
          </AuthGuard>
        } />

        <Route path="/escrow" element={
          <AuthGuard requiredPermission="Escrow">
            <Layout>
              <Escrow />
            </Layout>
          </AuthGuard>
        } />

        <Route path="/customers" element={
          <AuthGuard requiredPermission="Customers">
            <Layout>
              <Customers />
            </Layout>
          </AuthGuard>
        } />

        <Route path="/disputes" element={
          <AuthGuard requiredPermission="Disputes">
            <Layout>
              <Disputes />
            </Layout>
          </AuthGuard>
        } />

        <Route path="/analysis" element={
          <AuthGuard requiredRole="any_admin">
            <Layout>
              <Analysis />
            </Layout>
          </AuthGuard>
        } />

        <Route path="/settings" element={
          <AuthGuard requiredPermission="Settings">
            <Layout>
              <Settings />
            </Layout>
          </AuthGuard>
        } />

        <Route path="/admins" element={
          <AuthGuard requiredPermission="Admins">
            <Layout>
              <Admins />
            </Layout>
          </AuthGuard>
        } />

        <Route path="/profile" element={
          <AuthGuard requiredRole="any_admin">
            <Layout>
              <Profile />
            </Layout>
          </AuthGuard>
        } />

        <Route path="/connect" element={
          <AuthGuard requiredRole="any_admin">
            <Layout>
              <Connect />
            </Layout>
          </AuthGuard>
        } />

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      {/* Session Timeout Warning Modal */}
      <AnimatePresence>
        {showWarning && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-bg-panel border border-white/10 rounded-3xl p-8 max-w-md w-full shadow-2xl"
            >
              <div className="w-16 h-16 bg-accent-orange/10 rounded-2xl flex items-center justify-center text-accent-orange mx-auto mb-6">
                <AlertTriangle size={32} />
              </div>
              <h3 className="text-2xl font-bold text-white text-center mb-2">Session Expiring</h3>
              <p className="text-slate-400 text-center mb-8">
                Your session will expire in <span className="text-white font-mono font-bold">{Math.floor(remainingSeconds / 60)}:{(remainingSeconds % 60).toString().padStart(2, '0')}</span> due to inactivity. Would you like to stay logged in?
              </p>
              <div className="flex flex-col gap-3">
                <button 
                  onClick={extendSession}
                  className="w-full py-4 bg-accent-blue text-white rounded-2xl font-bold hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20"
                >
                  Extend Session
                </button>
                <button 
                  onClick={logout}
                  className="w-full py-4 bg-white/5 text-slate-400 rounded-2xl font-bold hover:bg-white/10 transition-all"
                >
                  Log Out
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <AppContent />
      </ErrorBoundary>
    </BrowserRouter>
  );
}
