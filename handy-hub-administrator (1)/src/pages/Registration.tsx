import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { 
  createUserWithEmailAndPassword, 
  updateProfile 
} from 'firebase/auth';
import { doc, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import { 
  User, 
  Hammer, 
  Mail, 
  Lock, 
  MapPin, 
  Phone, 
  Briefcase, 
  ArrowRight,
  ShieldCheck,
  ChevronRight
} from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '../utils';

type UserType = 'customer' | 'artisan';

export function Registration() {
  const [userType, setUserType] = useState<UserType>('customer');
  const [loading, setLoading] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    phone: '',
    location: '', // for customer
    category: '', // for artisan
    region: 'Accra' // defaulting for now
  });
  const navigate = useNavigate();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      // 1. Create Auth User
      const { user } = await createUserWithEmailAndPassword(auth, formData.email, formData.password);
      
      // 2. Update Profile
      await updateProfile(user, { displayName: formData.name });

      // 3. Save to appropriate collection
      const commonData = {
        id: user.uid,
        name: formData.name,
        email: formData.email,
        phone: formData.phone,
        status: 'active',
        createdAt: new Date().toISOString(),
        joined: new Date().toISOString(),
        userType: userType
      };

      if (userType === 'artisan') {
        await setDoc(doc(db, 'artisans', user.uid), {
          ...commonData,
          category: formData.category,
          region: formData.region,
          rating: 0,
          jobs_completed: 0,
          earnings: 0,
          status: 'pending', // Artisans often need admin approval
          avatar: `https://ui-avatars.com/api/?name=${encodeURIComponent(formData.name)}&background=random`
        });
      } else {
        await setDoc(doc(db, 'customers', user.uid), {
          ...commonData,
          location: formData.location,
          bookings: 0,
          spent: 0
        });
      }

      navigate(`/${userType}-dashboard`);
    } catch (error: any) {
      console.error("Signup error:", error);
      alert(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg-dark flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="max-w-2xl w-full grid grid-cols-1 md:grid-cols-2 bg-bg-panel rounded-[40px] shadow-2xl overflow-hidden border border-white/10"
      >
        {/* Left Side: Illustration & Role Select */}
        <div className="p-8 bg-black/40 border-r border-white/5 flex flex-col justify-between">
          <div>
            <div className="flex items-center gap-3 mb-8">
              <div className="w-10 h-10 bg-accent-blue rounded-xl flex items-center justify-center text-white">
                <Hammer size={20} />
              </div>
              <span className="text-xl font-display font-bold text-white">HandyHub</span>
            </div>
            
            <h2 className="text-3xl font-display font-bold text-white mb-6 leading-tight">
              Join the <br />
              <span className="text-accent-blue">Community.</span>
            </h2>
            
            <div className="space-y-4">
              <button 
                type="button"
                onClick={() => setUserType('customer')}
                className={cn(
                  "w-full p-4 rounded-2xl border transition-all text-left flex items-center gap-4 group",
                  userType === 'customer' 
                    ? "bg-accent-blue/10 border-accent-blue/40 text-accent-blue" 
                    : "bg-white/5 border-white/5 text-white/40 hover:border-white/10"
                )}
              >
                <div className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center transition-colors",
                  userType === 'customer' ? "bg-accent-blue text-white" : "bg-white/5 text-white/20 group-hover:bg-white/10"
                )}>
                  <User size={20} />
                </div>
                <div>
                  <p className="text-sm font-bold text-white uppercase tracking-widest leading-none mb-1">Customer</p>
                  <p className="text-[11px] opacity-60">I want to hire professionals</p>
                </div>
              </button>

              <button 
                type="button"
                onClick={() => setUserType('artisan')}
                className={cn(
                  "w-full p-4 rounded-2xl border transition-all text-left flex items-center gap-4 group",
                  userType === 'artisan' 
                    ? "bg-accent-blue/10 border-accent-blue/40 text-accent-blue" 
                    : "bg-white/5 border-white/5 text-white/40 hover:border-white/10"
                )}
              >
                <div className={cn(
                  "w-10 h-10 rounded-xl flex items-center justify-center transition-colors",
                  userType === 'artisan' ? "bg-accent-blue text-white" : "bg-white/5 text-white/20 group-hover:bg-white/10"
                )}>
                  <Hammer size={20} />
                </div>
                <div>
                  <p className="text-sm font-bold text-white uppercase tracking-widest leading-none mb-1">Artisan</p>
                  <p className="text-[11px] opacity-60">I want to offer my services</p>
                </div>
              </button>
            </div>
          </div>

          <div className="pt-8">
            <p className="text-[11px] text-white/20 leading-relaxed italic">
              "Building the most trusted service marketplace in the region."
            </p>
          </div>
        </div>

        {/* Right Side: Form */}
        <div className="p-8">
          <form onSubmit={handleSignup} className="space-y-6">
            <div className="space-y-2">
              <label className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] ml-4">Full Name</label>
              <div className="relative group">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-accent-blue transition-colors">
                  <User size={18} />
                </div>
                <input 
                  required
                  type="text" 
                  value={formData.name}
                  onChange={(e) => setFormData({...formData, name: e.target.value})}
                  className="w-full bg-white/5 border border-white/5 rounded-2xl py-4 pl-12 pr-4 text-white outline-none focus:border-accent-blue/40 transition-all font-medium"
                  placeholder="John Doe"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] ml-4">Email Address</label>
              <div className="relative group">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-accent-blue transition-colors">
                  <Mail size={18} />
                </div>
                <input 
                  required
                  type="email" 
                  value={formData.email}
                  onChange={(e) => setFormData({...formData, email: e.target.value})}
                  className="w-full bg-white/5 border border-white/5 rounded-2xl py-4 pl-12 pr-4 text-white outline-none focus:border-accent-blue/40 transition-all font-medium"
                  placeholder="john@example.com"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] ml-4">Password</label>
              <div className="relative group">
                <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-accent-blue transition-colors">
                  <Lock size={18} />
                </div>
                <input 
                  required
                  type="password" 
                  value={formData.password}
                  onChange={(e) => setFormData({...formData, password: e.target.value})}
                  className="w-full bg-white/5 border border-white/5 rounded-2xl py-4 pl-12 pr-4 text-white outline-none focus:border-accent-blue/40 transition-all font-medium"
                  placeholder="••••••••"
                />
              </div>
            </div>

            {userType === 'customer' ? (
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] ml-4">Location</label>
                <div className="relative group">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-accent-blue transition-colors">
                    <MapPin size={18} />
                  </div>
                  <input 
                    required
                    type="text" 
                    value={formData.location}
                    onChange={(e) => setFormData({...formData, location: e.target.value})}
                    className="w-full bg-white/5 border border-white/5 rounded-2xl py-4 pl-12 pr-4 text-white outline-none focus:border-accent-blue/40 transition-all font-medium"
                    placeholder="Accra, Ghana"
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] ml-4">Category</label>
                <div className="relative group">
                  <div className="absolute left-4 top-1/2 -translate-y-1/2 text-white/20 group-focus-within:text-accent-blue transition-colors">
                    <Briefcase size={18} />
                  </div>
                  <select 
                    required
                    value={formData.category}
                    onChange={(e) => setFormData({...formData, category: e.target.value})}
                    className="w-full bg-white/5 border border-white/5 rounded-2xl py-4 pl-12 pr-4 text-white outline-none focus:border-accent-blue/40 transition-all font-medium appearance-none"
                  >
                    <option value="" className="bg-bg-panel">Select Category</option>
                    <option value="Electrician" className="bg-bg-panel">Electrician</option>
                    <option value="Plumber" className="bg-bg-panel">Plumber</option>
                    <option value="Carpenter" className="bg-bg-panel">Carpenter</option>
                    <option value="Cleaner" className="bg-bg-panel">Cleaner</option>
                  </select>
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full py-5 bg-accent-blue text-white rounded-2xl font-bold hover:bg-blue-600 transition-all shadow-lg shadow-blue-500/20 flex items-center justify-center gap-3 uppercase tracking-widest text-xs"
            >
              {loading ? (
                <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              ) : (
                <>
                  Create Account
                  <ArrowRight size={18} />
                </>
              )}
            </button>

            <p className="text-center text-xs text-white/40">
              Already have an account? <Link to="/login" className="text-accent-blue hover:underline">Log in</Link>
            </p>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
