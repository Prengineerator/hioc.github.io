// The staff header's store pill ("Open" / "Busy" / "Closed").
//
// The pill is two things: the settings (open override, accepting orders,
// hours, holidays), which change a few times a day, and the clock, which turns
// those settings into open/closed. Only the first needs the server. So the
// header asks GET /api/store-settings every few minutes and works out the
// open state itself once a minute from the answer it already has
// (computeStoreOpenState is pure and shared with the server). The pill still
// flips on time at opening, closing and last-order cutoff, and a change made
// on another device shows within STORE_BADGE_FETCH_MS. A change made on THIS
// device shows at once ('hioc:store-changed').
//
// It used to ask the server every minute: 60 function calls an hour, and
// 120 with middleware, per open staff tab, for a pill that rarely changes.

import type { StoreOpenState } from '@/lib/store/hours';

/** How often the pill re-derives the open state from the settings it holds. */
export const STORE_BADGE_TICK_MS = 60_000;
/** How often the pill asks the server for the settings while the tab is visible. */
export const STORE_BADGE_FETCH_MS = 5 * 60_000;
/** Timer slack, so the fifth one-minute tick counts as five minutes. */
const TICK_SLACK_MS = 1_000;

/** What a visible tick does: ask the server, or just re-read the clock. */
export function storeBadgeTick(opts: { now: number; lastLoad: number; hasSettings: boolean }): 'fetch' | 'recompute' {
  if (!opts.hasSettings) return 'fetch';
  return opts.now - opts.lastLoad >= STORE_BADGE_FETCH_MS - TICK_SLACK_MS ? 'fetch' : 'recompute';
}

/** Whether two open states would draw the same pill (so a tick needn't re-render the header). */
export function sameOpenState(a: StoreOpenState | null, b: StoreOpenState | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.isOpen === b.isOpen &&
    a.acceptingOrders === b.acceptingOrders &&
    a.reason === b.reason &&
    a.nextOpenLabel === b.nextOpenLabel
  );
}
