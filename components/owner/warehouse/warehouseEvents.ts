// How the Warehouse screen tells the owner header how many transfers are
// waiting on the owner, so the Warehouse badge is right after each action
// without the header polling (the same pattern as menuEvents.ts).

export const WAREHOUSE_WAITING_EVENT = 'hioc:warehouse-waiting-count';

export function publishWarehouseWaiting(count: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<number>(WAREHOUSE_WAITING_EVENT, { detail: count }));
}
