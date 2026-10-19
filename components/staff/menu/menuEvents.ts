// How the Menu screen and the staff header keep each other current without
// fetching twice.
//
//   PENDING  the Menu screen -> header: the fresh pending list, published
//            whenever the screen loads one, so the badge on the Menu tab (and
//            the list behind it) follows a submit or cancel at once instead of
//            at the next poll.
//   CHANGED  header -> Menu screen: a request was cancelled from the badge, so
//            the screen reloads its own "waiting for owner approval" panel.
//
// The header fetches on its own too (usePendingMenuRequests); these only close
// the gap between polls.

import type { MenuChangeRequest } from '@/lib/menu/changeRequestTypes';
import type { MenuRequestViewer } from '@/components/staff/menu/requestViewer';

export const STAFF_MENU_PENDING_EVENT = 'hioc:staff-menu-pending';
export const STAFF_MENU_CHANGED_EVENT = 'hioc:staff-menu-changed';

export interface StaffMenuPendingDetail {
  requests: MenuChangeRequest[];
  viewer: MenuRequestViewer | null;
}

export function publishStaffMenuPending(detail: StaffMenuPendingDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<StaffMenuPendingDetail>(STAFF_MENU_PENDING_EVENT, { detail }));
}

export function publishStaffMenuRequestsChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(STAFF_MENU_CHANGED_EVENT));
}
