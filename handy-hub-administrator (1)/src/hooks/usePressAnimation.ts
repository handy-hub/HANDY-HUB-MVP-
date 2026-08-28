import { useMemo } from 'react';

export function usePressAnimation() {
  return useMemo(() => ({
    whileTap: { scale: 0.96 },
    transition: { type: 'spring', stiffness: 400, damping: 17 }
  }), []);
}
