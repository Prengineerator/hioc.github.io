// The shared orders feed (lib/staff/ordersFeed.ts) — the pure half.

/** A board opening on a list fetched this recently doesn't fetch it again. */
export const FULL_LIST_FRESH_MS = 10_000;

/** Today's whole list while a board needs it; otherwise only the waiting orders, for the alarm. */
export function feedUrl(full: boolean): string {
  return full ? '/api/orders' : '/api/orders?status=received';
}

/** Whether a full list fetched at `fullAt` can be shown as it is, without fetching. */
export function isFullListFresh(fullAt: number, now: number): boolean {
  return fullAt > 0 && now >= fullAt && now - fullAt < FULL_LIST_FRESH_MS;
}

/**
 * Ids of the orders waiting to be accepted. Pass it kitchen orders only
 * (kitchenOrders, lib/pos/ritual.ts): a HIOC Ritual sale never rings the
 * alarm. From the whole day's list or from the waiting-only list, the answer
 * is the same, so the alarm works whichever fetch ran last.
 */
export function receivedKitchenIds(orders: readonly { id: string; status?: string }[]): Set<string> {
  return new Set(orders.filter((o) => o.status === 'received').map((o) => o.id));
}
