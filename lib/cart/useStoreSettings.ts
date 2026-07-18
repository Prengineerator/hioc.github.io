'use client';

// Client hook for GET /api/store-settings — shared by /menu (C3 closed
// banner + live-availability gating) and /checkout (C4 slot picker, C5 bill
// breakdown). Polls slowly so a staff-side pause/resume or hours edit is
// reflected without a page reload; menu *item* 86s are handled separately
// and much faster by useMenuAvailabilityRealtime (lib/realtime/hooks.ts).

import { useEffect, useState } from 'react';
import type { StoreSettings } from '@/lib/types';
import type { StoreOpenState } from '@/lib/store/hours';

const POLL_MS = 30000;

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

    async function load() {
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

    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  return state;
}
