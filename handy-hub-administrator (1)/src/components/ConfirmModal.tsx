import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, X } from 'lucide-react';
import { cn } from '../utils';

interface ConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'danger' | 'warning' | 'info';
  isLoading?: boolean;
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  isLoading = false
}: ConfirmModalProps) {
  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm"
          />
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="relative w-full max-w-md bg-bg-panel border border-white/10 rounded-[32px] p-10 shadow-2xl overflow-hidden"
          >
            <div className={cn(
              "absolute top-0 left-0 w-full h-1.5",
              variant === 'danger' ? "bg-red-500" : variant === 'warning' ? "bg-amber-500" : "bg-accent-blue"
            )} />
            
            <div className="flex items-center gap-6 mb-8">
              <div className={cn(
                "w-14 h-14 rounded-2xl flex items-center justify-center border shadow-sm",
                variant === 'danger' ? "bg-red-500/10 text-red-500 border-red-500/20" : 
                variant === 'warning' ? "bg-amber-500/10 text-amber-500 border-amber-500/20" : 
                "bg-accent-blue/10 text-accent-blue border-accent-blue/20"
              )}>
                <AlertTriangle size={28} />
              </div>
              <div>
                <h3 className="text-2xl font-bold text-white tracking-tight">{title}</h3>
                <p className="text-[10px] font-bold text-white/40 uppercase tracking-widest mt-1">Action Required</p>
              </div>
            </div>

            <p className="text-white/60 text-sm leading-relaxed mb-10">
              {message}
            </p>

            <div className="flex gap-4">
              <button
                onClick={onClose}
                disabled={isLoading}
                className="flex-1 py-4 bg-white/5 text-slate-400 rounded-2xl font-bold hover:bg-white/10 transition-all uppercase tracking-widest text-[11px] border border-white/10"
              >
                {cancelText}
              </button>
              <button
                onClick={onConfirm}
                disabled={isLoading}
                className={cn(
                  "flex-1 py-4 rounded-2xl font-bold transition-all shadow-lg uppercase tracking-widest text-[11px]",
                  variant === 'danger' ? "bg-red-500 text-white hover:bg-red-600" : 
                  variant === 'warning' ? "bg-amber-500 text-white hover:bg-amber-600" : 
                  "bg-accent-blue text-white hover:bg-blue-600"
                )}
              >
                {isLoading ? 'Processing...' : confirmText}
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
