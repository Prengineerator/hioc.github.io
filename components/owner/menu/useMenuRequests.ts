'use client';

// Loads the owner's menu change requests (GET /api/owner/menu-requests) for one
// status. `reload` refreshes quietly (no spinner) so a list that is already on
// screen doesn't flash; `apply` swaps in a request the owner just decided, so
// its card updates before the reload comes back.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';

export type RequestsStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'all';

export interface MenuRequestsState {
  requests: MenuChangeRequest[];
  /** Requests still waiting as of the last load, whatever status was asked for. null until the first load. */
  pendingCount: number | null;
  loading: boolean;
  error: string | null;
  /** Refetch without a spinner (the list on screen stays put). */
  reload: () => Promise<void>;
  /** Refetch with the spinner, for a "Try again" button. */
  retry: () => Promise<void>;
  apply: (updated: MenuChangeRequest) => void;
}

export function useMenuRequests(status: RequestsStatus, { skip = false }: { skip?: boolean } = {}): MenuRequestsState {
  const [requests, setRequests] = useState<MenuChangeRequest[]>([]);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(!skip);
  // Which status `requests` belongs to: after a filter switch, the old list must
  // not show (or read as "empty") for the frame before the new fetch starts.
  const [loaded, setLoaded] = useState<RequestsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only the latest request may write state: switching filters quickly must not
  // let a slow earlier answer overwrite the list the owner is looking at.
  const latest = useRef(0);

  const load = useCallback(
    async (quiet: boolean) => {
      const mine = ++latest.current;
      if (!quiet) {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await fetch(`/api/owner/menu-requests?status=${status}`, { cache: 'no-store' });
        const data = await res.json().catch(() => ({}));
        if (mine !== latest.current) return;
        if (!res.ok) throw new Error(data.error ?? 'Could not load menu requests.');
        setRequests((data.requests ?? []) as MenuChangeRequest[]);
        setPendingCount(typeof data.pendingCount === 'number' ? data.pendingCount : null);
        setLoaded(status);
        setError(null);
      } catch (err) {
        // A failed quiet refresh leaves the list on screen as it was.
        if (mine !== latest.current || quiet) return;
        setRequests([]);
        setLoaded(status);
        setError(err instanceof Error ? err.message : 'Could not load menu requests.');
      } finally {
        if (mine === latest.current) setLoading(false);
      }
    },
    [status],
  );

  useEffect(() => {
    if (skip) return;
    void load(false);
  }, [load, skip]);

  const reload = useCallback(() => load(true), [load]);
  const retry = useCallback(() => load(false), [load]);

  const apply = useCallback(
    (updated: MenuChangeRequest) => {
      setRequests((prev) =>
        // A filtered list drops a request that no longer fits it; "all" keeps it, updated.
        status !== 'all' && updated.status !== status
          ? prev.filter((r) => r.id !== updated.id)
          : prev.map((r) => (r.id === updated.id ? updated : r)),
      );
    },
    [status],
  );

  const current = loaded === status;
  return {
    requests: current ? requests : [],
    pendingCount,
    loading: !skip && (loading || !current),
    error: current ? error : null,
    reload,
    retry,
    apply,
  };
}
