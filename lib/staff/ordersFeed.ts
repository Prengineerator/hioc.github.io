'use client';

// Today's orders, fetched ONCE per change for every staff screen that needs
// them (StaffShell drives it; lib/staff/ordersFeedRules.ts is the pure half).
//
// It used to be two fetches per order change on every POS: the staff shell
// asked GET /api/orders?status=received for the new-order alarm, and the board
// on screen (Live orders, Orders, Tables) asked GET /api/orders for the same
// event on its own realtime channel. Now there is one channel (the shell's)
// and one fetch:
//   - while a board is on screen, the whole of today (the board needs it, and
//     the alarm reads the waiting orders out of it);
//   - otherwise only the waiting orders (the alarm is all that is listening —
//     New order doesn't download the day's orders on every change).
// The list stays in memory across screen changes, so Live orders ↔ Tables
// draws at once, and a board that opens on a list fetched moments ago doesn't
// fetch it again.

import { useEffect, useSyncExternalStore } from 'react';
import { fetchWithTimeout } from '@/lib/pos/fetchWithTimeout';
import { kitchenOrders } from '@/lib/pos/ritual';
import type { RealtimeConnection } from '@/lib/realtime/hooks';
import type { OrderWithItems } from '@/lib/staff/tableOccupancy';
import { feedUrl, isFullListFresh, receivedKitchenIds } from '@/lib/staff/ordersFeedRules';

export interface OrdersFeedState {
  /** Today's orders, as last fetched in full; null until a board has asked once. */
  orders: OrderWithItems[] | null;
  /** When `orders` was fetched (ms); 0 = never. */
  fullAt: number;
  /** Ids of kitchen orders waiting to be accepted, from the latest fetch of either kind. */
  received: ReadonlySet<string> | null;
  /** The latest fetch failed (offline, timed out); the last good data stays. */
  failed: boolean;
  /** A fetch is on its way. */
  loading: boolean;
  /** The shell's realtime channel, for the boards' badge. */
  connection: RealtimeConnection;
}

let state: OrdersFeedState = {
  orders: null,
  fullAt: 0,
  received: null,
  failed: false,
  loading: false,
  connection: 'connecting',
};
const listeners = new Set<() => void>();
let fullSubscribers = 0;
let seq = 0;
/** Whole-day fetches on their way: a board opening meanwhile waits for that one. */
let fullInFlight = 0;

function set(patch: Partial<OrdersFeedState>) {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Fetch now: today's whole list while a board is on screen, else only the waiting orders. */
export async function fetchOrdersFeed(): Promise<void> {
  const full = fullSubscribers > 0;
  const mine = ++seq;
  if (full) fullInFlight += 1;
  set({ loading: true });
  try {
    const res = await fetchWithTimeout(feedUrl(full), { cache: 'no-store' });
    if (!res.ok) throw new Error(`orders ${res.status}`);
    const data = (await res.json()) as { orders?: OrderWithItems[] };
    if (mine !== seq) return; // a newer fetch is on its way; its answer wins
    const list = data.orders ?? [];
    set({
      received: receivedKitchenIds(kitchenOrders(list)),
      ...(full ? { orders: list, fullAt: Date.now() } : {}),
      failed: false,
      loading: false,
    });
  } catch {
    if (mine === seq) set({ failed: true, loading: false });
  } finally {
    if (full) fullInFlight -= 1;
  }
}

/** The first fetch, unless one has already run or is running (a board mounting first starts it). */
export function ensureOrdersFeedLoaded(): void {
  if (state.received === null && !state.loading) void fetchOrdersFeed();
}

/** The shell reports its channel's state here. */
export function setOrdersFeedConnection(connection: RealtimeConnection): void {
  if (state.connection !== connection) set({ connection });
}

/** Forget everything (sign-out). */
export function resetOrdersFeed(): void {
  seq += 1;
  set({ orders: null, fullAt: 0, received: null, failed: false, loading: false });
}

/** The feed as it stands (for code outside React; screens use useOrdersFeed). */
export function getOrdersFeedState(): OrdersFeedState {
  return state;
}

export function useOrdersFeed(): OrdersFeedState {
  return useSyncExternalStore(subscribe, getOrdersFeedState, getOrdersFeedState);
}

/**
 * A board on screen that needs today's whole list. While any is mounted the
 * feed fetches in full; on mount it fetches at once unless the list it holds
 * was fetched moments ago (Live orders → Tables).
 */
export function useOrdersFeedBoard(active: boolean = true): void {
  useEffect(() => {
    if (!active) return undefined;
    fullSubscribers += 1;
    if (fullInFlight === 0 && !isFullListFresh(state.fullAt, Date.now())) void fetchOrdersFeed();
    return () => {
      fullSubscribers -= 1;
    };
  }, [active]);
}
