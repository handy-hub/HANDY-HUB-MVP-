import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}

export function Modal({ isOpen, onClose, title, children }: ModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="relative w-full max-w-2xl bg-bg-panel rounded-[32px] shadow-2xl overflow-hidden flex flex-col max-h-[90vh] border border-white/10"
          >
            <div className="px-8 py-6 border-b border-white/5 flex items-center justify-between bg-bg-panel sticky top-0 z-10">
              <h3 className="text-xl font-display font-black text-white tracking-tight">{title}</h3>
              <button
                onClick={onClose}
                className="w-10 h-10 flex items-center justify-center text-white/40 hover:text-white hover:bg-white/5 rounded-full transition-all"
              >
                <X size={20} />
              </button>
            </div>
            <div className="p-8 overflow-y-auto custom-scrollbar">
              {children}
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
