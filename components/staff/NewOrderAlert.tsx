'use client';

import { useEffect, useRef } from 'react';
import { playChime } from '@/lib/staff/chime';

// How often the reminder chime repeats while an order is unacknowledged.
const CHIME_INTERVAL_MS = 5000;

/**
 * Banner + repeating audio chime shown while newly-arrived orders sit
 * unacknowledged in "received". Audio plays through the shared, pre-unlocked
 * AudioContext (lib/staff/chime.ts) — it stays silent until the staff taps
 * "Enable sound" (browser autoplay policy), which is why `soundEnabled` gates it.
 * Chimes only when the count goes UP (a genuine new order); accepting/clearing
 * one of several (count down) stays silent, and it clears once count hits 0.
 */
export function NewOrderAlert({ count, soundEnabled }: { count: number; soundEnabled: boolean }) {
  const prevCountRef = useRef(0);

  useEffect(() => {
    const prevCount = prevCountRef.current;
    prevCountRef.current = count;
    if (count <= 0) return undefined;

    if (soundEnabled && count > prevCount) playChime();
    const interval = setInterval(() => {
      if (soundEnabled) playChime();
    }, CHIME_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [count, soundEnabled]);

  if (count <= 0) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex items-center gap-2 rounded-md bg-charcoal px-4 py-2 text-sm font-bold text-cream shadow-sm"
    >
      <span aria-hidden="true">🔔</span>
      <span>
        {count} new order{count === 1 ? '' : 's'} waiting — Accept or Reject to clear
        {!soundEnabled ? ' · tap “Enable sound” to hear alerts' : ''}
      </span>
    </div>
  );
}
