import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Command, User, Wrench, Briefcase, ChevronRight, X, Zap, Shield, AlertTriangle } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { collection, query, getDocs, limit, where, orderBy } from 'firebase/firestore';
import { db, auth } from '../firebase';
import { cn } from '../utils';

interface SearchResult {
  id: string;
  type: 'artisan' | 'customer' | 'job' | 'page';
  title: string;
  subtitle: string;
  url: string;
  status?: string;
}

export function CommandPalette() {
  const [isOpen, setIsOpen] = useState(false);
  const [queryText, setQueryText] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const PAGES: SearchResult[] = [
    { id: 'p1', type: 'page', title: 'Dashboard', subtitle: 'Platform overview and stats', url: '/' },
    { id: 'p2', type: 'page', title: 'Artisans', subtitle: 'Manage service providers', url: '/artisans' },
    { id: 'p3', type: 'page', title: 'Jobs', subtitle: 'Track active service requests', url: '/jobs' },
    { id: 'p4', type: 'page', title: 'Customers', subtitle: 'Manage user accounts', url: '/customers' },
    { id: 'p5', type: 'page', title: 'Escrow', subtitle: 'Financials and payouts', url: '/escrow' },
    { id: 'p6', type: 'page', title: 'Analysis', subtitle: 'Detailed reports and charts', url: '/analysis' },
    { id: 'p7', type: 'page', title: 'Settings', subtitle: 'Platform configuration', url: '/settings' },
  ];

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsOpen(prev => !prev);
      }
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus();
      setQueryText('');
      setResults(PAGES);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!queryText) {
      setResults(PAGES);
      return;
    }

    const searchData = async () => {
      if (!auth.currentUser) return;
      setLoading(true);
      try {
        const results: SearchResult[] = [];
        
        // Only allow admins to search these collections
        const adminDoc = await getDocs(query(collection(db, 'admins'), where('email', '==', auth.currentUser.email), limit(1)));
        const isAdmin = !adminDoc.empty || 
                       auth.currentUser.email === 'silas7korda@gmail.com' || 
                       auth.currentUser.email === 'clasceth4traders@gmail.com';

        if (isAdmin) {
          // Search Artisans
          const artisanSnap = await getDocs(query(
            collection(db, 'artisans'),
            limit(5)
          ));
          artisanSnap.docs.forEach(doc => {
            const data = doc.data();
            if (data.name.toLowerCase().includes(queryText.toLowerCase())) {
              results.push({
                id: doc.id,
                type: 'artisan',
                title: data.name,
                subtitle: `${data.category} • ${data.region}`,
                url: `/artisans?id=${doc.id}`,
                status: data.status
              });
            }
          });

          // Search Customers
          const customerSnap = await getDocs(query(
            collection(db, 'customers'),
            limit(5)
          ));
          customerSnap.docs.forEach(doc => {
            const data = doc.data();
            if (data.name.toLowerCase().includes(queryText.toLowerCase())) {
              results.push({
                id: doc.id,
                type: 'customer',
                title: data.name,
                subtitle: data.email,
                url: `/customers?id=${doc.id}`,
                status: data.status
              });
            }
          });

          // Search Jobs
          const jobSnap = await getDocs(query(
            collection(db, 'jobs'),
            limit(5)
          ));
          jobSnap.docs.forEach(doc => {
            const data = doc.data();
            if (doc.id.toLowerCase().includes(queryText.toLowerCase()) || data.category.toLowerCase().includes(queryText.toLowerCase())) {
              results.push({
                id: doc.id,
                type: 'job',
                title: `${data.category} Job`,
                subtitle: `ID: ${doc.id.substring(0, 8)}... • ${data.status}`,
                url: `/jobs?id=${doc.id}`,
                status: data.status
              });
            }
          });
        }

        // Add matching pages
        const matchingPages = PAGES.filter(p => 
          p.title.toLowerCase().includes(queryText.toLowerCase())
        );

        setResults([...matchingPages, ...results]);
      } catch (error) {
        console.error("Search failed", error);
      } finally {
        setLoading(false);
      }
    };

    const timer = setTimeout(searchData, 300);
    return () => clearTimeout(timer);
  }, [queryText]);

  const handleSelect = (result: SearchResult) => {
    navigate(result.url);
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(prev => (prev + 1) % results.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(prev => (prev - 1 + results.length) % results.length);
    } else if (e.key === 'Enter') {
      if (results[selectedIndex]) {
        handleSelect(results[selectedIndex]);
      }
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[10000] flex items-start justify-center pt-[15vh] px-4">
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsOpen(false)}
            className="absolute inset-0 bg-black/60 backdrop-blur-md"
          />
          
          <motion.div
            initial={{ scale: 0.95, opacity: 0, y: -20 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.95, opacity: 0, y: -20 }}
            className="w-full max-w-2xl bg-bg-panel border border-white/10 rounded-3xl shadow-2xl overflow-hidden relative z-10"
          >
            <div className="p-6 border-b border-white/5 flex items-center gap-4">
              <Search className="text-white/20" size={20} />
              <input
                ref={inputRef}
                value={queryText}
                onChange={(e) => setQueryText(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Search artisans, customers, jobs or commands..."
                className="flex-1 bg-transparent border-none outline-none text-white text-lg placeholder:text-white/10 font-medium"
              />
              <div className="flex items-center gap-1 px-2 py-1 bg-white/5 rounded-lg border border-white/10">
                <span className="text-[10px] font-bold text-white/40">ESC</span>
              </div>
            </div>

            <div className="max-h-[60vh] overflow-y-auto custom-scrollbar">
              {loading && results.length === 0 ? (
                <div className="p-12 text-center">
                  <div className="w-8 h-8 border-2 border-white/10 border-t-accent-blue rounded-full animate-spin mx-auto mb-4" />
                  <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Searching Database...</p>
                </div>
              ) : results.length > 0 ? (
                <div className="p-2">
                  {results.map((result, index) => (
                    <button
                      key={`${result.type}-${result.id}`}
                      onMouseEnter={() => setSelectedIndex(index)}
                      onClick={() => handleSelect(result)}
                      className={cn(
                        "w-full p-4 rounded-2xl flex items-center justify-between transition-all group text-left",
                        selectedIndex === index ? "bg-white/5 border border-white/10" : "border border-transparent"
                      )}
                    >
                      <div className="flex items-center gap-4">
                        <div className={cn(
                          "w-10 h-10 rounded-xl flex items-center justify-center border border-white/5",
                          result.type === 'artisan' ? "bg-accent-blue/10 text-accent-blue" :
                          result.type === 'customer' ? "bg-accent-green/10 text-accent-green" :
                          result.type === 'job' ? "bg-accent-orange/10 text-accent-orange" :
                          "bg-white/5 text-white/40"
                        )}>
                          {result.type === 'artisan' && <Wrench size={18} />}
                          {result.type === 'customer' && <User size={18} />}
                          {result.type === 'job' && <Briefcase size={18} />}
                          {result.type === 'page' && <Command size={18} />}
                        </div>
                        <div>
                          <p className="text-sm font-bold text-white tracking-tight">{result.title}</p>
                          <p className="text-[10px] text-white/40 uppercase tracking-widest mt-1">{result.subtitle}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        {result.status && (
                          <span className={cn(
                            "text-[8px] font-bold px-2 py-0.5 rounded-md border uppercase tracking-widest",
                            result.status === 'active' || result.status === 'Completed' ? "text-accent-green border-accent-green/20 bg-accent-green/10" :
                            result.status === 'pending' || result.status === 'In Progress' ? "text-accent-blue border-accent-blue/20 bg-accent-blue/10" :
                            "text-red-500 border-red-500/20 bg-red-500/10"
                          )}>
                            {result.status}
                          </span>
                        )}
                        <ChevronRight size={16} className={cn(
                          "transition-all",
                          selectedIndex === index ? "text-white translate-x-0" : "text-white/10 -translate-x-2"
                        )} />
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="p-12 text-center">
                  <Shield size={48} className="mx-auto text-white/5 mb-4" />
                  <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">No results found for "{queryText}"</p>
                </div>
              )}
            </div>

            <div className="p-4 bg-bg-dark/50 border-t border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <div className="px-1.5 py-0.5 bg-white/5 rounded border border-white/10 text-[9px] text-white/40 font-bold">↑↓</div>
                  <span className="text-[9px] text-white/20 font-bold uppercase tracking-widest">Navigate</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="px-1.5 py-0.5 bg-white/5 rounded border border-white/10 text-[9px] text-white/40 font-bold">ENTER</div>
                  <span className="text-[9px] text-white/20 font-bold uppercase tracking-widest">Select</span>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Zap size={12} className="text-accent-blue" />
                <span className="text-[9px] text-white/40 font-bold uppercase tracking-widest italic">Handy Hub Quick Access</span>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
