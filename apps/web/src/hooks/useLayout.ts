import { useSyncExternalStore } from 'react';

/** Narrow screens (phones, folded/unfolded foldables in portrait, small tablets) get the drawer layout. */
export const COMPACT_MAX_WIDTH = 1024;

function subscribe(cb: () => void) {
  window.addEventListener('resize', cb);
  const mq = window.matchMedia('(pointer: coarse)');
  mq.addEventListener('change', cb);
  return () => {
    window.removeEventListener('resize', cb);
    mq.removeEventListener('change', cb);
  };
}

export function useCompact(): boolean {
  return useSyncExternalStore(subscribe, () => window.innerWidth < COMPACT_MAX_WIDTH);
}

/** Primary input is a finger (phones, tablets): pan with one finger, bigger targets, no hover/right-click. */
export function useTouch(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia('(pointer: coarse)').matches);
}
