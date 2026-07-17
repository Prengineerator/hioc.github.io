// Effective menu-item availability (S6 / C3 / XC-011). Pure + dependency-free
// so the server (order validation), the customer menu, and the staff menu all
// agree on one rule.
//
// 86/snooze semantics (no cron needed): a timed snooze sets `unavailable_until`
// to a future instant and leaves `is_available` true — the item is unavailable
// only while now < that instant, then auto-returns. A manual/indefinite 86 sets
// `is_available` false. So an item is orderable iff it's manually available AND
// not currently within a snooze window.

import type { MenuItem } from '@/lib/types';

export function isMenuItemAvailable(
  item: Pick<MenuItem, 'is_available' | 'unavailable_until'>,
  now: Date = new Date(),
): boolean {
  if (!item.is_available) return false;
  if (item.unavailable_until && new Date(item.unavailable_until).getTime() > now.getTime()) {
    return false;
  }
  return true;
}
