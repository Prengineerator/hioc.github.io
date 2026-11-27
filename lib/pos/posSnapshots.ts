// The POS screens' kept answers (lib/pos/localSnapshot.ts), named in one place
// so the screens that share one agree on its shape.
//
//   tables          GET /api/tables — the registry. No customer details, so it
//                   is kept across restarts: Tables and the dine-in picker on
//                   New order draw at once, even on the first screen of the day.
//   tables-board    The open dine-in orders the tables board needs, with the
//                   customer details taken out. Kept for the tab's session, so
//                   the board still draws right after a reload.
//
// Today's orders in full live in memory, in the shared orders feed
// (lib/staff/ordersFeed.ts) that Live orders and Tables both read.

import type { OrderWithItems, StaffTable } from '@/lib/staff/tableOccupancy';
import { isOpenDineInOrder } from '@/lib/staff/tableOccupancy';
import type { SnapshotOptions } from '@/lib/pos/localSnapshot';

export const TABLES_SNAPSHOT = 'tables';
export const TABLES_BOARD_SNAPSHOT = 'tables-board';

function isTableList(v: unknown): v is StaffTable[] {
  return (
    Array.isArray(v) &&
    v.every(
      (t) =>
        t !== null &&
        typeof t === 'object' &&
        typeof (t as StaffTable).id === 'string' &&
        typeof (t as StaffTable).label === 'string',
    )
  );
}

function isOrderList(v: unknown): v is OrderWithItems[] {
  return (
    Array.isArray(v) &&
    v.every(
      (o) =>
        o !== null &&
        typeof o === 'object' &&
        typeof (o as OrderWithItems).id === 'string' &&
        typeof (o as OrderWithItems).status === 'string' &&
        Array.isArray((o as OrderWithItems).items),
    )
  );
}

export const TABLES_SNAPSHOT_OPTS: SnapshotOptions<StaffTable[]> = {
  store: 'local',
  // The registry changes when the owner adds a table, not by the hour; a screen
  // reads it again on open unless it was read in the last minute. This only
  // bounds a machine left off.
  maxAgeMs: 14 * 24 * 60 * 60 * 1000,
  validate: isTableList,
};

export const TABLES_BOARD_SNAPSHOT_OPTS: SnapshotOptions<OrderWithItems[]> = {
  store: 'session',
  maxAgeMs: 30 * 60 * 1000,
  validate: isOrderList,
};

/**
 * Pure: what the tables board keeps across a reload — only the open dine-in
 * orders (the only ones a tile shows), with the customer's name, number, email
 * and the order notes blanked. A tile never shows those, and they have no
 * business sitting in browser storage.
 */
export function toTablesBoardSnapshot(orders: OrderWithItems[]): OrderWithItems[] {
  return orders.filter(isOpenDineInOrder).map((o) => ({
    ...o,
    customer_name: '',
    customer_phone: '',
    customer_email: null,
    notes: '',
  }));
}
