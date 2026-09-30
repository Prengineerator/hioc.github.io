// Customer-facing wording for the prepaid coffee pass (docs/COFFEE-PASS-SPEC.md).
//
// The program is branded "HIOC Ritual" and its drinks are "cups". Every
// technical name stays as it is — the coffee_pass_* tables and functions,
// order_kind = 'coffee_pass', the NEXT_PUBLIC_FLAG_COFFEE_PASS flag, lib/passes
// — because renaming them would cost a migration and buy the customer nothing.
// Only DISPLAY strings come from here, so the day the owner changes the name
// again it is one file, not a hunt through every screen.
//
// Pure (no server-only, no imports): screens, routes, receipts and tests all
// use it.

/** The program as the customer knows it. */
export const PASS_PROGRAM_NAME = 'HIOC Ritual';

/** The short form for tight places (a chip on a menu item, a nav link). */
export const PASS_SHORT_NAME = 'Ritual';

/** What one pass drink is called. */
export const PASS_UNIT = { one: 'cup', many: 'cups' } as const;

/** "1 cup" / "5 cups" (and "0 cups": nothing left reads as a plural). */
export function cupsLabel(n: number): string {
  return `${n} ${n === 1 ? PASS_UNIT.one : PASS_UNIT.many}`;
}
