import React from 'react';
import { cn } from '../utils';

interface SkeletonProps {
  className?: string;
  key?: React.Key;
}

export function Skeleton({ className }: SkeletonProps) {
  return (
    <div className={cn("animate-pulse bg-white/5 rounded-lg", className)} />
  );
}

export function TableSkeleton() {
  return (
    <div className="space-y-4 w-full">
      <div className="flex items-center justify-between mb-8">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-10 w-32" />
      </div>
      <div className="card-panel overflow-hidden">
        <div className="p-6 border-b border-white/5 flex gap-4">
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-32" />
        </div>
        <div className="p-6 space-y-6">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center gap-4">
              <Skeleton className="h-12 w-12 rounded-lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-1/4" />
                <Skeleton className="h-3 w-1/6" />
              </div>
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-8 rounded-full" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="card-panel p-6 space-y-4">
      <div className="flex items-center gap-4">
        <Skeleton className="h-12 w-12 rounded-lg" />
        <div className="space-y-2 flex-1">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/4" />
        </div>
      </div>
      <div className="space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>
      <div className="flex justify-between pt-4">
        <Skeleton className="h-8 w-20" />
        <Skeleton className="h-8 w-20" />
      </div>
    </div>
  );
}
