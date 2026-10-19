'use client';

// The menu changes waiting for the owner, for the badge on the staff header's
// Menu tab and the list behind it. One instance for the whole shell: it fetches
// on mount, when the tab regains focus, and every minute while visible; the Menu
// screen pushes fresh lists through STAFF_MENU_PENDING_EVENT in between. Anything
// but a good answer (signed out, migration not applied, offline) reads as empty,
// so the badge just stays off.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';
import { STAFF_MENU_PENDING_EVENT, type StaffMenuPendingDetail } from '@/components/staff/menu/menuEvents';
import { parseMenuRequestViewer, type MenuRequestViewer } from '@/components/staff/menu/requestViewer';

const POLL_MS = 60_000;

interface Snapshot {
  requests: MenuChangeRequest[];
  viewer: MenuRequestViewer | null;
}

const EMPTY: Snapshot = { requests: [], viewer: null };

export interface PendingMenuRequestsState extends Snapshot {
  count: number;
  /** Fetch now (after a cancel); resolves when the answer is in. */
  refresh: () => Promise<void>;
}

export function usePendingMenuRequests(enabled = true): PendingMenuRequestsState {
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY);
  // Only the latest answer may land: a pushed list, a newer fetch or unmounting
  // all bump it, so a slow older response can't overwrite fresher state.
  const seq = useRef(0);
  const invalidate = useCallback(() => {
    seq.current++;
  }, []);

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    let next = EMPTY;
    try {
      const res = await fetch('/api/menu/requests?status=pending', { cache: 'no-store' });
      if (res.ok) {
        const data = (await res.json()) as { requests?: unknown; viewer?: unknown } | null;
        if (Array.isArray(data?.requests)) {
          next = { requests: data.requests as MenuChangeRequest[], viewer: parseMenuRequestViewer(data.viewer) };
        }
      }
    } catch {
      // Offline or a bad body: no badge until the next try.
    }
    if (mine === seq.current) setSnapshot(next);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(EMPTY);
      return undefined;
    }
    const onPushed = (e: Event) => {
      const detail = (e as CustomEvent<StaffMenuPendingDetail>).detail;
      if (!detail || !Array.isArray(detail.requests)) return;
      invalidate();
      setSnapshot((prev) => ({ requests: detail.requests, viewer: detail.viewer ?? prev.viewer }));
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    void refresh();
    const timer = setInterval(onVisible, POLL_MS);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener(STAFF_MENU_PENDING_EVENT, onPushed);
    return () => {
      invalidate();
      clearInterval(timer);
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener(STAFF_MENU_PENDING_EVENT, onPushed);
    };
  }, [enabled, refresh, invalidate]);

  const current = enabled ? snapshot : EMPTY;
  return { requests: current.requests, count: current.requests.length, viewer: current.viewer, refresh };
}
