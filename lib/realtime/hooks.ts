'use client';

// Client realtime hooks (F2) with a hard poll fallback (NFR-002). Each hook
// pushes updates in < 2s via Supabase Realtime AND keeps a polling backstop, so
// a dropped socket (flaky cafe wifi) degrades to <=15s polling with a visible
// "reconnecting" state rather than going stale. While the socket is live the
// backstop slows to a safety net: every request it makes is a Vercel function
// call, and at a flat 15 s the polls were most of the POS's traffic.
//
// - useStaffOrdersRealtime / useMenuAvailabilityRealtime → postgres_changes
//   (these tables are readable by the caller: staff = authenticated orders RLS;
//    menu = public read RLS).
// - useOrderRealtime → per-order broadcast channel (anon customers can't read
//   the orders table, so they listen for the server ping from broadcast.ts).

import { useEffect, useRef, useState } from 'react';
import { createClient } from '@/lib/supabase';
import { flags } from '@/lib/flags';

export type RealtimeConnection = 'connecting' | 'live' | 'reconnecting';

// Keep the latest callback in a ref so re-renders don't tear down the channel.
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

/** Backstop while realtime can't be relied on: a dropped socket degrades to this (NFR-002). */
export const FALLBACK_POLL_MS = 15_000;
/** Backstop while realtime is live and its events can reach this browser. */
export const LIVE_POLL_MS = 120_000;
/** A focus or "tab visible again" refetch within this long of the last one is skipped. */
export const REFOCUS_MIN_GAP_MS = 5_000;
/** Coalescing window for `orders` events: one order is an insert plus a payment and print update or two. */
export const ORDERS_COALESCE_MS = 1_000;
/**
 * The menu's safety net while realtime is live. Availability (86 / un-86 and
 * every other menu_items change) still arrives by realtime within seconds; this
 * only bounds how stale a variant, add-on or menu-switch change can be, since
 * those tables send no events here.
 */
export const MENU_LIVE_POLL_MS = 300_000;
/** The customer's order page: a status ping arrives by broadcast; this is the net under it. */
export const ORDER_PAGE_POLL_MS = 4_000;
export const ORDER_PAGE_LIVE_POLL_MS = 30_000;

/**
 * How long until the next backstop poll, or null for none.
 *
 * Pure so the request budget it encodes is testable. While the channel is live
 * and trusted, events do the work and the poll is only a safety net; while it
 * isn't, the poll is the only way new data arrives.
 */
export function backstopDelay(opts: {
  /** Subscribed, and the events can reach this browser (see requiresSession). */
  trusted: boolean;
  hidden: boolean;
  /** 'pause' stops all refetching while the tab is hidden; 'run' keeps going. */
  whileHidden: 'pause' | 'run';
  pollMs: number;
  livePollMs: number;
}): number | null {
  if (opts.hidden && opts.whileHidden === 'pause') return null;
  return opts.trusted ? opts.livePollMs : opts.pollMs;
}

type Channel = ReturnType<ReturnType<typeof createClient>['channel']>;

export interface LoopOptions {
  pollMs: number;
  livePollMs: number;
  requiresSession: boolean;
  whileHidden: 'pause' | 'run';
  coalesceMs: number;
  /** Attach the listeners to a fresh channel; the loop subscribes it. */
  build: (channel: Channel, fire: () => void) => Channel;
  channelName: string;
}

/**
 * The shared refresh loop: realtime events, the backstop poll and the
 * return-to-tab refetch, all funnelled through one coalescer. Returns the
 * cleanup for the caller's effect. Exported for its tests; screens use the
 * hooks below.
 */
export function startRefreshLoop(
  opts: LoopOptions,
  onChange: { current: () => void },
  setConnection: (c: RealtimeConnection) => void,
): () => void {
  const { pollMs, livePollMs, requiresSession, whileHidden, coalesceMs } = opts;
  let disposed = false;
  let subscribed = false;
  let everSubscribed = false;
  let hasSession = false; // only consulted when requiresSession
  let missed = false; // an event or a poll was skipped while hidden
  let lastRun = Date.now(); // the consumer's own mount fetch has just run
  let pending: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setTimeout> | null = null;

  const isHidden = () => document.visibilityState === 'hidden';
  const trusted = () => subscribed && (!requiresSession || hasSession);

  const run = () => {
    lastRun = Date.now();
    missed = false;
    onChange.current();
  };

  // Coalesce bursts (an order's insert, then its payment and print updates)
  // into a single refetch.
  const fire = () => {
    if (pending || disposed) return;
    if (isHidden() && whileHidden === 'pause') {
      missed = true; // the visible refetch covers it
      return;
    }
    pending = setTimeout(() => {
      pending = null;
      run();
    }, coalesceMs);
  };

  const schedule = () => {
    if (poll) clearTimeout(poll);
    poll = null;
    if (disposed) return;
    const hidden = isHidden();
    const delay = backstopDelay({ trusted: trusted(), hidden, whileHidden, pollMs, livePollMs });
    if (delay === null) {
      if (hidden) missed = true;
      return;
    }
    poll = setTimeout(() => {
      run();
      schedule();
    }, delay);
  };

  // visibilitychange and focus fire together on a return to the tab; the
  // coalescer and the minimum gap turn that pair into at most one refetch.
  const onVisibility = () => {
    if (!isHidden() && (missed || Date.now() - lastRun >= REFOCUS_MIN_GAP_MS)) fire();
    schedule();
  };
  const onFocus = () => {
    if (missed || Date.now() - lastRun >= REFOCUS_MIN_GAP_MS) fire();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);

  let channel: Channel | null = null;
  if (flags.realtime) {
    const supabase = createClient();
    if (requiresSession) {
      void supabase.auth
        .getSession()
        .then(({ data }) => {
          hasSession = Boolean(data.session);
          schedule();
        })
        .catch(() => {});
    }
    channel = opts.build(supabase.channel(opts.channelName), fire).subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        subscribed = true;
        setConnection('live');
        // A RE-subscribe means events may have been missed while the socket
        // was down: catch up once. The first subscribe follows the consumer's
        // own mount fetch, and the backstop covers the moment between them.
        if (everSubscribed) fire();
        everSubscribed = true;
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        subscribed = false;
        setConnection('reconnecting');
      }
      schedule();
    });
  } else {
    setConnection('reconnecting'); // realtime off → polling only
  }

  schedule();

  return () => {
    disposed = true;
    if (poll) clearTimeout(poll);
    if (pending) clearTimeout(pending);
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    if (channel) channel.unsubscribe();
  };
}

let mountSeq = 0;

/**
 * A topic unique to this mount, for a postgres_changes channel.
 *
 * supabase-js hands back the EXISTING channel when asked for a topic it still
 * holds, and a channel stays held until the server acknowledges the leave. A
 * screen switch unmounts one screen and mounts the next in the same instant, so
 * Live orders → Tables (both 'staff-orders') got the old, leaving channel back:
 * its subscribe() was a no-op, the new board never went live, and it sat on the
 * 15 s fallback poll. A fresh topic per mount always gets a fresh channel.
 *
 * Never for broadcast channels (useOrderRealtime): there the topic is the
 * address the server sends to.
 */
export function mountChannelName(base: string): string {
  mountSeq += 1;
  return `${base}:${mountSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Subscribes to Postgres change events on `table` and calls `onChange` on each
 * (coalesced to one refetch per `coalesceMs` window), with a poll backstop:
 * every `livePollMs` while the channel is live and trusted, every `pollMs`
 * while it isn't. Returns the current connection state for a UI badge.
 *
 * `requiresSession`: the table's RLS only lets a signed-in user see rows. A
 * browser with no Supabase session (a PIN-only counter) still gets SUBSCRIBED,
 * but no events ever arrive, so the channel is only trusted when a session
 * exists, and the fast poll keeps running otherwise.
 *
 * `whileHidden: 'pause'` (the default) stops polls and event refetches while
 * the tab is hidden and refetches once when it's visible again: a board no one
 * can see needn't be kept fresh. Use 'run' for a watch that must keep going in
 * a background tab, like the new-order alarm.
 */
export function usePostgresChangesRefresh(opts: {
  table: string;
  channelName: string;
  onChange: () => void;
  filter?: string;
  event?: '*' | 'INSERT' | 'UPDATE' | 'DELETE';
  pollMs?: number;
  livePollMs?: number;
  requiresSession?: boolean;
  whileHidden?: 'pause' | 'run';
  coalesceMs?: number;
  enabled?: boolean;
}): RealtimeConnection {
  const {
    table,
    channelName,
    filter,
    event = '*',
    pollMs = FALLBACK_POLL_MS,
    livePollMs = LIVE_POLL_MS,
    requiresSession = false,
    whileHidden = 'pause',
    coalesceMs = 150,
    enabled = true,
  } = opts;
  const onChange = useLatest(opts.onChange);
  const [connection, setConnection] = useState<RealtimeConnection>('connecting');

  useEffect(() => {
    if (!enabled) return;
    return startRefreshLoop(
      {
        pollMs,
        livePollMs,
        requiresSession,
        whileHidden,
        coalesceMs,
        // One topic per mount (see mountChannelName): a postgres_changes
        // topic is only a local label, so nothing on the server cares.
        channelName: mountChannelName(channelName),
        build: (channel, fire) =>
          channel.on(
            'postgres_changes',
            { event, schema: 'public', table, ...(filter ? { filter } : {}) },
            () => fire(),
          ),
      },
      onChange,
      setConnection,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table, channelName, filter, event, pollMs, livePollMs, requiresSession, whileHidden, coalesceMs, enabled]);

  return connection;
}

/**
 * Customer live-status realtime: listens on the per-order broadcast channel the
 * server pings on each transition, with a poll backstop: every `pollMs` until
 * the channel is live, every `livePollMs` after. The page has no background
 * alert, so it rests while hidden and refetches on return. `onChange` should
 * refetch /api/orders/[id].
 */
export function useOrderRealtime(
  orderId: string | null,
  onChange: () => void,
  pollMs = ORDER_PAGE_POLL_MS,
  livePollMs = ORDER_PAGE_LIVE_POLL_MS,
): RealtimeConnection {
  const cb = useLatest(onChange);
  const [connection, setConnection] = useState<RealtimeConnection>('connecting');

  useEffect(() => {
    if (!orderId) return;
    return startRefreshLoop(
      {
        pollMs,
        livePollMs,
        // A broadcast channel: no RLS between the ping and the customer.
        requiresSession: false,
        whileHidden: 'pause',
        coalesceMs: 150,
        channelName: `order-${orderId}`,
        build: (channel, fire) => channel.on('broadcast', { event: 'status' }, () => fire()),
      },
      cb,
      setConnection,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderId, pollMs, livePollMs]);

  return connection;
}

/** Staff order board realtime (postgres_changes on `orders`). */
export function useStaffOrdersRealtime(onChange: () => void, pollMs = FALLBACK_POLL_MS): RealtimeConnection {
  return usePostgresChangesRefresh({
    table: 'orders',
    channelName: 'staff-orders',
    onChange,
    pollMs,
    // Orders RLS is is_staff(): no session, no events.
    requiresSession: true,
    coalesceMs: ORDERS_COALESCE_MS,
  });
}

/** Customer menu availability realtime (postgres_changes on `menu_items`, XC-011). */
export function useMenuAvailabilityRealtime(onChange: () => void, pollMs = FALLBACK_POLL_MS): RealtimeConnection {
  return usePostgresChangesRefresh({
    table: 'menu_items',
    channelName: 'menu-availability',
    onChange,
    pollMs,
    // menu_items is public-read, so its events reach every browser.
    livePollMs: MENU_LIVE_POLL_MS,
  });
}
