import React from 'react';
import { motion } from 'motion/react';

export function PlaceholderPage({ title }: { title: string }) {
  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center h-[calc(100vh-160px)] text-center"
    >
      <div className="w-20 h-20 bg-white/5 rounded-3xl flex items-center justify-center text-white/20 mb-6 border border-white/10">
        <div className="w-10 h-10 border-4 border-white/10 border-t-accent-blue rounded-full animate-spin"></div>
      </div>
      <h2 className="text-2xl font-display font-bold text-white">{title}</h2>
      <p className="text-white/40 mt-2 max-w-md">
        This module is currently under development. Check back soon for full functionality.
      </p>
    </motion.div>
  );
}
