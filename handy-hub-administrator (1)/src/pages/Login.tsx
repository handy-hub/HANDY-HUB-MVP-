import React, { useState } from 'react';
import { 
  signInWithPopup, 
  signInWithEmailAndPassword, 
  sendSignInLinkToEmail,
  signOut
} from 'firebase/auth';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { auth, db, googleProvider, actionCodeSettings } from '../firebase';
import { 
  Lock, 
  Mail, 
  AlertTriangle, 
  ChevronRight, 
  Send, 
  ShieldAlert, 
  Hammer, 
  ShieldCheck, 
  BarChart3, 
  Users,
  ArrowRight,
  Fingerprint,
  CheckCircle2,
  XCircle
} from 'lucide-react';
import { cn } from '../utils';
import { motion, AnimatePresence } from 'motion/react';

type LoginMethod = 'google' | 'email';

export function Login() {
  const [method, setMethod] = useState<LoginMethod>('google');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [emailSent, setEmailSent] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const navigate = useNavigate();
  const location = useLocation();

  const from = location.state?.from?.pathname || "/";

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  const checkUserRecord = async (uid: string, email: string, displayName?: string | null) => {
    // 1. Check Admins
    const adminDoc = await getDoc(doc(db, 'admins', uid));
    if (adminDoc.exists()) return { ...adminDoc.data(), userType: 'admin' };

    // 2. Check Artisans
    const artisanDoc = await getDoc(doc(db, 'artisans', uid));
    if (artisanDoc.exists()) return { ...artisanDoc.data(), userType: 'artisan' };

    // 3. Check Customers
    const customerDoc = await getDoc(doc(db, 'customers', uid));
    if (customerDoc.exists()) return { ...customerDoc.data(), userType: 'customer' };

    // 4. Special case: Primary Owner Bootstrap
    const isOwner = email.toLowerCase() === 'silas7korda@gmail.com' || 
                   email.toLowerCase() === 'clasceth4traders@gmail.com' ||
                   email.toLowerCase() === 'paakumisam@gmail.com';
    if (isOwner) {
      const superAdminData = {
        id: uid,
        name: displayName || 'System Owner',
        email: email.toLowerCase(),
        role: 'super_admin',
        status: 'active',
        userType: 'admin',
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString()
      };
      await setDoc(doc(db, 'admins', uid), superAdminData);
      showToast('Super Admin account recognized', 'success');
      return superAdminData;
    }

    // No account found
    await signOut(auth);
    throw new Error('No account found for this email. Please sign up first.');
  };

  const handleGoogleLogin = async () => {
    setLoading(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const userData = await checkUserRecord(result.user.uid, result.user.email || '', result.user.displayName);
      showToast(`Login successful as ${userData.userType}`, 'success');
      
      // Redirect based on user type
      if (userData.userType === 'admin') {
        navigate(from, { replace: true });
      } else {
        navigate(`/${userData.userType}-dashboard`, { replace: true });
      }
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user') {
        setLoading(false);
        return;
      }
      console.error('Login error:', err);
      showToast(err.message || 'Failed to sign in.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleEmailPasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      const userData = await checkUserRecord(result.user.uid, result.user.email || '', result.user.displayName);
      showToast(`Login successful as ${userData.userType}`, 'success');
      
      if (userData.userType === 'admin') {
        navigate(from, { replace: true });
      } else {
        navigate(`/${userData.userType}-dashboard`, { replace: true });
      }
    } catch (err: any) {
      console.error('Email login error:', err);
      showToast(err.message || 'Invalid credentials.', 'error');
    } finally {
      setLoading(false);
    }
  };

  const roles = [
    { name: 'Super Admin', icon: ShieldCheck, color: 'text-accent-blue', desc: 'Full system control' },
    { name: 'Operations', icon: Hammer, color: 'text-accent-green', desc: 'Artisan & Job management' },
    { name: 'Finance', icon: BarChart3, color: 'text-accent-orange', desc: 'Payments & Escrow' },
    { name: 'Support', icon: Users, color: 'text-accent-purple', desc: 'Customer relations' },
  ];

  if (emailSent) {
    return (
      <div className="min-h-screen bg-bg-dark flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-bg-panel rounded-3xl shadow-2xl p-8 text-center border border-white/10"
        >
          <div className="w-16 h-16 bg-accent-blue/10 rounded-2xl flex items-center justify-center text-accent-blue mx-auto mb-6">
            <Send size={32} />
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">Check Your Email</h2>
          <p className="text-white/40 mb-8">
            We've sent a secure sign-in link to <strong>{email}</strong>. 
            Click the link in the email to complete your sign-in.
          </p>
          <button 
            onClick={() => setEmailSent(false)}
            className="w-full py-3 bg-white text-bg-dark rounded-xl font-bold hover:bg-white/90 transition-all shadow-lg"
          >
            Back to Login
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg-dark flex flex-col md:flex-row overflow-hidden">
      {/* Left Side: Branding & Info */}
      <div className="hidden md:flex md:w-1/2 lg:w-3/5 bg-black relative flex-col justify-between p-12 overflow-hidden">
        {/* Background Image with Overlay */}
        <div className="absolute inset-0 z-0">
          <img 
            src="https://images.unsplash.com/photo-1581092160562-40aa08e78837?auto=format&fit=crop&q=80&w=2070" 
            alt="Craftsmanship" 
            className="w-full h-full object-cover opacity-40 grayscale"
            referrerPolicy="no-referrer"
          />
          <div className="absolute inset-0 bg-gradient-to-br from-bg-dark via-bg-dark/80 to-transparent" />
        </div>

        <div className="relative z-10">
          <div className="flex items-center gap-3 mb-12">
            <div className="w-10 h-10 bg-accent-blue rounded-xl flex items-center justify-center text-white shadow-lg shadow-accent-blue/20">
              <Hammer size={20} />
            </div>
            <span className="text-2xl font-display font-bold text-white tracking-tight">HandyHub</span>
          </div>

          <motion.div
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.2 }}
            className="max-w-xl"
          >
            <h1 className="text-5xl lg:text-7xl font-display font-bold text-white leading-[0.9] mb-6">
              Platform <br />
              <span className="text-accent-blue">Control Center.</span>
            </h1>
            <p className="text-xl text-white/40 leading-relaxed max-w-md">
              Manage artisans, monitor jobs, and oversee platform operations in real-time.
            </p>
          </motion.div>
        </div>

        <div className="relative z-10">
          <div className="grid grid-cols-2 gap-6 max-w-lg">
            {roles.map((role, idx) => (
              <motion.div 
                key={role.name}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.4 + (idx * 0.1) }}
                className="p-4 bg-white/5 border border-white/10 rounded-2xl backdrop-blur-sm"
              >
                <role.icon className={cn("mb-3", role.color)} size={20} />
                <h3 className="text-white font-bold text-sm mb-1">{role.name}</h3>
                <p className="text-white/30 text-xs">{role.desc}</p>
              </motion.div>
            ))}
          </div>
        </div>

        {/* Decorative element */}
        <div className="absolute -bottom-24 -left-24 w-96 h-96 bg-accent-blue/10 rounded-full blur-[120px]" />
      </div>

      {/* Right Side: Login Form */}
      <div className="flex-1 flex items-center justify-center p-6 md:p-12 bg-bg-dark relative">
        <div className="max-w-md w-full">
          <div className="mb-10 md:hidden text-center">
            <div className="w-12 h-12 bg-accent-blue rounded-xl flex items-center justify-center text-white mx-auto mb-4">
              <Hammer size={24} />
            </div>
            <h1 className="text-2xl font-display font-bold text-white">HandyHub Admin</h1>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-bg-panel rounded-[2rem] shadow-2xl p-8 border border-white/10 relative overflow-hidden"
          >
            {/* Subtle background pattern */}
            <div className="absolute top-0 right-0 p-4 opacity-[0.02] pointer-events-none">
              <Fingerprint size={120} />
            </div>

            <div className="relative z-10">
              <div className="mb-8">
                <h2 className="text-2xl font-bold text-white mb-2">Welcome Back</h2>
                <p className="text-white/40 text-sm">Please enter your credentials to access the dashboard.</p>
              </div>

              <div className="space-y-6">
                <div className="flex p-1 bg-black/40 rounded-xl mb-6 border border-white/5">
                  {(['google', 'email'] as LoginMethod[]).map((m) => (
                    <button 
                      key={m}
                      onClick={() => setMethod(m)}
                      className={cn(
                        "flex-1 py-2 text-[10px] font-bold uppercase tracking-wider rounded-lg transition-all",
                        method === m ? "bg-white/10 text-white shadow-sm" : "text-white/20 hover:text-white/40"
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>

                <AnimatePresence mode="wait">
                  {method === 'google' && (
                    <motion.div 
                      key="google"
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      className="space-y-4"
                    >
                      <button 
                        onClick={handleGoogleLogin}
                        disabled={loading}
                        className="w-full py-4 bg-white/5 border border-white/10 text-white rounded-xl font-bold hover:bg-white/10 transition-all shadow-sm flex items-center justify-center gap-3 disabled:opacity-70 disabled:cursor-not-allowed group"
                      >
                        <svg className="w-5 h-5" viewBox="0 0 24 24">
                          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
                          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                          <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" />
                          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.66l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                        </svg>
                        Sign In with Google
                        <ArrowRight size={16} className="opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all" />
                      </button>
                    </motion.div>
                  )}

                  {method === 'email' && (
                    <motion.form 
                      key="email"
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      onSubmit={handleEmailPasswordLogin} 
                      className="space-y-4"
                    >
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-white/20 uppercase tracking-widest ml-1">Email Address</label>
                        <div className="relative">
                          <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" size={18} />
                          <input 
                            type="email" 
                            required
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full pl-12 pr-4 py-3 bg-black/40 border border-white/10 rounded-xl text-white focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all"
                            placeholder="admin@handyhub.com"
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <label className="text-[10px] font-bold text-white/20 uppercase tracking-widest ml-1">Password</label>
                        <div className="relative">
                          <Lock className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20" size={18} />
                          <input 
                            type="password" 
                            required
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            className="w-full pl-12 pr-4 py-3 bg-black/40 border border-white/10 rounded-xl text-white focus:ring-2 focus:ring-accent-blue/20 focus:border-accent-blue outline-none transition-all"
                            placeholder="••••••••"
                          />
                        </div>
                      </div>
                      <button 
                        type="submit"
                        disabled={loading}
                        className="w-full py-4 bg-white text-bg-dark rounded-xl font-bold hover:bg-white/90 transition-all shadow-lg flex items-center justify-center gap-2 disabled:opacity-70 disabled:cursor-not-allowed"
                      >
                        {loading ? <div className="w-5 h-5 border-2 border-bg-dark/30 border-t-bg-dark rounded-full animate-spin"></div> : 'Sign In'}
                      </button>
                    </motion.form>
                  )}
                </AnimatePresence>

                <div className="pt-6 border-t border-white/5 text-center">
                  <p className="text-white/20 text-xs">
                    New to HandyHub? <Link to="/signup" className="text-accent-blue font-bold hover:underline">Sign up as Artisan or Customer</Link>
                  </p>
                </div>
              </div>
            </div>
          </motion.div>

          <div className="mt-8 flex items-center justify-center gap-6 text-[10px] text-white/20 uppercase tracking-[0.2em] font-bold">
            <span className="flex items-center gap-1.5"><ShieldCheck size={12} /> Secure</span>
            <span className="flex items-center gap-1.5"><Fingerprint size={12} /> Encrypted</span>
            <span className="flex items-center gap-1.5"><Users size={12} /> Audited</span>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 50, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.9 }}
            className={cn(
              "fixed bottom-8 left-1/2 -translate-x-1/2 z-[100] flex items-center gap-3 px-6 py-4 rounded-2xl shadow-2xl backdrop-blur-xl border min-w-[320px]",
              toast.type === 'success' 
                ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" 
                : "bg-red-500/10 border-red-500/20 text-red-400"
            )}
          >
            {toast.type === 'success' ? (
              <CheckCircle2 size={20} className="shrink-0" />
            ) : (
              <AlertTriangle size={20} className="shrink-0" />
            )}
            <p className="text-sm font-bold tracking-tight">{toast.message}</p>
            <button 
              onClick={() => setToast(null)}
              className="ml-auto p-1 hover:bg-white/10 rounded-lg transition-colors"
            >
              <XCircle size={16} className="opacity-40" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
