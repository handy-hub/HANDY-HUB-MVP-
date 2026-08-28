import React from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { cn } from '../utils';

interface SidePanelProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: string;
  className?: string;
}

export function SidePanel({ isOpen, onClose, title, children, width = "max-w-md", className }: SidePanelProps) {
  const panel = (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[9999] flex justify-end overflow-hidden">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 backdrop-blur-sm"
          />
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className={cn(
              "relative w-full h-full bg-bg-panel border-l border-white/5 shadow-2xl flex flex-col ml-auto",
              width,
              className
            )}
          >
            <div className={cn(
              "px-6 py-6 border-b border-white/5 flex items-center justify-between bg-bg-panel sticky top-0 z-10",
              className
            )}>
              <div>
                <p className="text-[10px] font-bold text-brand-400 uppercase tracking-[0.3em] mb-1">System</p>
                <h3 className="text-xl font-display font-black text-white tracking-tight">{title}</h3>
              </div>
              <button
                onClick={onClose}
                className="w-10 h-10 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/5 rounded-full transition-all"
              >
                <X size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );

  return createPortal(panel, document.body);
}
