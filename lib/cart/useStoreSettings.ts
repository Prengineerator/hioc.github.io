'use client';

// Client hook for GET /api/store-settings — shared by /menu (C3 closed
// banner + live-availability gating) and /checkout (C4 slot picker, C5 bill
// breakdown). Polls slowly so a staff-side pause/resume or hours edit is
// reflected without a page reload; menu *item* 86s are handled separately
// and much faster by useMenuAvailabilityRealtime (lib/realtime/hooks.ts).
//
// Only while the tab is visible: every poll is a Vercel function call, and a
// menu left open in a background tab used to make 120 of them an hour for
// nobody. Coming back to the tab refetches at once, so what the customer sees
// on return is never older than the poll would have allowed.

import { useEffect, useState } from 'react';
import type { StoreSettings } from '@/lib/types';
import type { StoreOpenState } from '@/lib/store/hours';

const POLL_MS = 30000;
/** A return to the tab within this long of the last load doesn't load again. */
const REFOCUS_MIN_GAP_MS = 5_000;

export interface StoreSettingsState {
  settings: StoreSettings | null;
  openState: StoreOpenState | null;
  loading: boolean;
}

export function useStoreSettings(): StoreSettingsState {
  const [state, setState] = useState<StoreSettingsState>({
    settings: null,
    openState: null,
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    let lastLoad = 0;
    const visible = () => document.visibilityState === 'visible';

    async function load() {
      lastLoad = Date.now();
      try {
        const res = await fetch('/api/store-settings');
        const data = await res.json();
        if (cancelled) return;
        setState({
          settings: data.settings ?? null,
          openState: data.openState ?? null,
          loading: false,
        });
      } catch {
        if (!cancelled) setState((prev) => ({ ...prev, loading: false }));
      }
    }

    const onVisible = () => {
      if (visible() && Date.now() - lastLoad >= REFOCUS_MIN_GAP_MS) void load();
    };

    void load();
    const interval = setInterval(() => {
      if (visible()) void load();
    }, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return state;
}
