import React from 'react';
import { motion } from 'motion/react';
import { LucideIcon } from 'lucide-react';
import { cn } from '../utils';
import { usePressAnimation } from '../hooks/usePressAnimation';

import { TrendingUp, TrendingDown } from 'lucide-react';

interface StatCardProps {
  label: string;
  value: string | number;
  icon: LucideIcon;
  color?: 'blue' | 'green' | 'orange' | 'purple' | 'pink' | 'red' | 'teal';
  onClick?: () => void;
  trend?: string;
  changeType?: 'up' | 'down' | 'neutral';
  prefix?: string;
}

const colorMap = {
  blue: 'text-blue-400 bg-blue-500/10 border-blue-500/20',
  green: 'text-green-400 bg-green-500/10 border-green-500/20',
  orange: 'text-orange-400 bg-orange-500/10 border-orange-500/20',
  purple: 'text-purple-400 bg-purple-500/10 border-purple-500/20',
  pink: 'text-pink-400 bg-pink-500/10 border-pink-500/20',
  red: 'text-red-400 bg-red-500/10 border-red-500/20',
  teal: 'text-teal-400 bg-teal-500/10 border-teal-500/20',
};

export function StatCard({ 
  label, 
  value, 
  icon: Icon, 
  color = 'blue', 
  onClick,
  trend,
  changeType,
  prefix
}: StatCardProps) {
  const pressAnimation = usePressAnimation();

  return (
    <motion.div 
      {...pressAnimation}
      onClick={onClick}
      className={cn(
        "card-panel p-4 flex flex-col gap-3 cursor-pointer transition-all hover:bg-white/5",
        onClick ? "active:opacity-80" : "cursor-default"
      )}
    >
      <div className="flex items-start justify-between">
        <div className={cn(
          "w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border",
          colorMap[color]
        )}>
          <Icon size={20} />
        </div>
        
        {trend && (
          <div className={cn(
            "px-2 py-0.5 rounded-lg text-[9px] font-bold flex items-center gap-1",
            changeType === 'up' ? "bg-green-500/10 text-green-400 border border-green-500/20" : 
            changeType === 'down' ? "bg-red-500/10 text-red-400 border border-red-500/20" : 
            "bg-white/5 text-white/40 border border-white/10"
          )}>
            {changeType === 'up' ? <TrendingUp size={9} /> : 
             changeType === 'down' ? <TrendingDown size={9} /> : null}
            {trend}
          </div>
        )}
      </div>
      
      <div className="flex flex-col min-w-0">
        <p className="text-white/40 text-[9px] font-bold uppercase tracking-widest mb-0.5 truncate">{label}</p>
        <h3 className="text-[22px] font-display font-bold text-white tracking-tight truncate">
          {prefix}{typeof value === 'number' ? value.toLocaleString() : value}
        </h3>
      </div>
    </motion.div>
  );
}
