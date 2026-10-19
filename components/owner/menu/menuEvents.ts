// How the Menu screen tells the owner header how many staff menu requests are
// waiting, so the badge on the "Menu" tab stays right after a decision without
// the header polling. The header fetches the count once on its own; the screen
// publishes it whenever it loads a fresh one.

export const MENU_PENDING_COUNT_EVENT = 'hioc:menu-pending-count';

export function publishMenuPendingCount(count: number): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<number>(MENU_PENDING_COUNT_EVENT, { detail: count }));
}
