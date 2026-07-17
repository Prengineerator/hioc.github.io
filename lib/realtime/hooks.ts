'use client';

// Client realtime hooks (F2) with a hard poll fallback (NFR-002). Each hook
// pushes updates in < 2s via Supabase Realtime AND keeps a slower polling
// backstop running, so a dropped socket (flaky cafe wifi) degrades to <=15s
// polling with a visible "reconnecting" state rather than going stale.
//
// - useStaffOrdersRealtime / useMenuAvailabilityRealtime → postgres_changes
//   (these tables are readable by the caller: staff = authenticated orders RLS;
//    menu = public read RLS).
// - useOrderRealtime → per-order broadcast channel (anon customers can't read
//   the orders table, so they listen for the server ping from broadcast.ts).

import { useCallback, useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { flags } from '@/lib/flags';

export type RealtimeConnection = 'connecting' | 'live' | 'reconnecting';

// Keep the latest callback in a ref so re-renders don't tear down the channel.
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/**
 * Subscribes to Postgres change events on `table` and calls `onChange` on each
 * (debounced to one refetch per animation-ish window). Always runs a poll
 * backstop at `pollMs`. Returns the current connection state for a UI badge.
 */
export function usePostgresChangesRefresh(opts: {
  table: string;
  channelName: string;
  onChange: () => void;
  filter?: string;
  event?: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
  pollMs?: number;
  enabled?: boolean;
}): RealtimeConnection {
  const { table, channelName, filter, event = '*', pollMs = 15000, enabled = true } = opts;
  const onChange = useLatest(opts.onChange);
  const [connection, setConnection] = useState<RealtimeConnection>('connecting');

  // Coalesce bursts of change events into a single refetch.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fire = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      onChange.current();
    }, 150);
  }, [onChange]);

  useEffect(() => {
    if (!enabled) return;

    // Poll backstop — runs regardless of socket health; on-focus refetch too.
    const poll = setInterval(() => onChange.current(), pollMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') onChange.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    let channel: ReturnType<ReturnType<typeof createClient>['channel']> | null = null;

    if (flags.realtime) {
      const supabase = createClient();
      channel = supabase
        .channel(channelName)
        .on(
          'postgres_changes',
          { event, schema: 'public', table, ...(filter ? { filter } : {}) },
          () => fire(),
        )
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') setConnection('live');
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setConnection('reconnecting');
          }
        });
    } else {
      setConnection('reconnecting'); // realtime off → polling only
    }

    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      if (pending.current) clearTimeout(pending.current);
      if (channel) channel.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, channelName, filter, event, pollMs, enabled, fire]);

  return connection;
}

/**
 * Customer live-status realtime: listens on the per-order broadcast channel the
 * server pings on each transition, plus a fast poll backstop. `onChange` should
 * refetch /api/orders/[id].
 */
export function useOrderRealtime(
  orderId: string | null,
  onChange: () => void,
  pollMs = 4000,
): RealtimeConnection {
  const cb = useLatest(onChange);
  const [connection, setConnection] = useState<RealtimeConnection>('connecting');

  useEffect(() => {
    if (!orderId) return;

    const poll = setInterval(() => cb.current(), pollMs);
    const onVisible = () => {
      if (document.visibilityState === 'visible') cb.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);

    let channel: ReturnType<ReturnType<typeof createClient>['channel']> | null = null;
    if (flags.realtime) {
      const supabase = createClient();
      channel = supabase
        .channel(`order-${orderId}`)
        .on('broadcast', { event: 'status' }, () => cb.current())
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') setConnection('live');
          else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setConnection('reconnecting');
          }
        });
    } else {
      setConnection('reconnecting');
    }

    return () => {
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      if (channel) channel.unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, pollMs]);

  return connection;
}

/** Staff order board realtime (postgres_changes on `orders`). */
export function useStaffOrdersRealtime(onChange: () => void, pollMs = 15000): RealtimeConnection {
  return usePostgresChangesRefresh({
    table: 'orders',
    channelName: 'staff-orders',
    onChange,
    pollMs,
  });
}

/** Customer menu availability realtime (postgres_changes on `menu_items`, XC-011). */
export function useMenuAvailabilityRealtime(onChange: () => void, pollMs = 15000): RealtimeConnection {
  return usePostgresChangesRefresh({
    table: 'menu_items',
    channelName: 'menu-availability',
    onChange,
    pollMs,
  });
}
