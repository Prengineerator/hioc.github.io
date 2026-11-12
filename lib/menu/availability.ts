// Effective menu-item availability (S6 / C3 / XC-011). Pure + dependency-free
// so the server (order validation), the customer menu, and the staff menu all
// agree on one rule.
//
// 86/snooze semantics (no cron needed): a timed snooze sets `unavailable_until`
// to a future instant and leaves `is_available` true — the item is unavailable
// only while now < that instant, then auto-returns. A manual/indefinite 86 sets
// `is_available` false. So an item is orderable iff it's manually available AND
// not currently within a snooze window.
//
// Three columns make the state, read together here (menuItemAvailability):
//
//   is_available  unavailable_until  stock_out_auto   state
//   false         (any)              true             out_of_stock  hidden by inventory auto-hide
//                                                                  (docs/INVENTORY-SPEC.md INV-D16/17)
//   false         (any)              false/absent     sold_out      a person's indefinite 86
//   true          after now          (any)            snoozed       a timed 86; comes back by itself
//   true          null / past        (any)            available
//
// What a person's sold-out / snooze / back-on click writes is
// manualAvailabilityBody (the POS menu page and the owner's menu share it), and
// what the server adds to any edit that switches an item back on is
// clearsStaleSnooze (lib/menu/applyMenuChange.ts).

import type { MenuItem } from '@/lib/types';

export const MENU_AVAILABILITY_STATES = ['available', 'snoozed', 'sold_out', 'out_of_stock'] as const;
export type MenuAvailabilityState = (typeof MENU_AVAILABILITY_STATES)[number];

export interface MenuAvailability {
  state: MenuAvailabilityState;
  /** When a snooze ends (state 'snoozed' only), else null. */
  until: string | null;
}

type AvailabilityColumns = Pick<MenuItem, 'is_available' | 'unavailable_until'> & {
  stock_out_auto?: boolean | null;
};

/** The item's availability right now, from its three columns (table above). */
export function menuItemAvailability(item: AvailabilityColumns, now: Date = new Date()): MenuAvailability {
  if (!item.is_available) {
    return { state: item.stock_out_auto ? 'out_of_stock' : 'sold_out', until: null };
  }
  if (item.unavailable_until && new Date(item.unavailable_until).getTime() > now.getTime()) {
    return { state: 'snoozed', until: item.unavailable_until };
  }
  return { state: 'available', until: null };
}

export function isMenuItemAvailable(
  item: Pick<MenuItem, 'is_available' | 'unavailable_until'>,
  now: Date = new Date(),
): boolean {
  return menuItemAvailability(item, now).state === 'available';
}

// ---------------------------------------------------------------------------
// A person's sold-out / snooze / back-on
// ---------------------------------------------------------------------------

/** How long "Mark sold out" lasts: 2 hours, until midnight IST, or until switched back on. */
export type SnoozeDuration = '2h' | 'eod' | 'indefinite';

/** The table's buttons: one of the sold-out durations, or "Mark available". */
export type ManualAvailabilityAction = SnoozeDuration | 'back_on';

export interface ManualAvailabilityBody {
  is_available: boolean;
  unavailable_until: string | null;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Today's 24:00 IST ("end of day") as a UTC ISO instant — the IST wall-clock
 * convention of lib/store/hours.ts (whose helpers are private).
 */
export function endOfDayIstIso(now: Date): string {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  const nextMidnightUtcMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + 1, 0, 0, 0) - IST_OFFSET_MS;
  return new Date(nextMidnightUtcMs).toISOString();
}

/**
 * The PATCH body for a sold-out / snooze / back-on click. Every body names both
 * columns, so no click leaves an old snooze behind: an indefinite 86 drops any
 * timed one it replaces (otherwise switching back on later would still find the
 * item snoozed until that old time), and back on clears it.
 */
export function manualAvailabilityBody(action: ManualAvailabilityAction, now: Date = new Date()): ManualAvailabilityBody {
  switch (action) {
    case 'indefinite':
      return { is_available: false, unavailable_until: null };
    case '2h':
      return { is_available: true, unavailable_until: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString() };
    case 'eod':
      return { is_available: true, unavailable_until: endOfDayIstIso(now) };
    case 'back_on':
      return { is_available: true, unavailable_until: null };
  }
}

/**
 * True when an edit switches a sold-out item back on without saying anything
 * about the snooze, while the item still carries one — the server then clears
 * it too. Otherwise "available" would not mean available: the item would stay
 * hidden until a snooze from before it was sold out runs out (the edit form and
 * a staff edit that only moved the availability switch send is_available alone).
 * An edit that keeps an available item available leaves its snooze alone.
 */
export function clearsStaleSnooze(
  current: Pick<MenuItem, 'is_available' | 'unavailable_until'>,
  updates: { is_available?: boolean; unavailable_until?: string | null },
): boolean {
  return (
    updates.is_available === true &&
    !('unavailable_until' in updates) &&
    current.is_available === false &&
    Boolean(current.unavailable_until)
  );
}
