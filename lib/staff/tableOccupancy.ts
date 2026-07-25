// Tables-board occupancy logic (POS-3) — pure, client-safe, and unit-tested.
// The board is a read-only projection of two existing feeds (GET /api/tables +
// GET /api/orders); all the "is this table free or busy, and what's on it"
// reasoning lives here so TablesBoard.tsx stays a thin renderer and the rules
// can be tested without mounting React.
//
// Occupancy model (FND3-3 counter model / POS-3 AC): a table is OCCUPIED when it
// holds >= 1 OPEN dine-in order. "Open" = status in accepted/preparing/ready
// (staff-created dine-in orders start at 'accepted' and never hit 'received').
// A single table may hold SEVERAL open orders (a second visit is a new order,
// decision D2) — so we GROUP them rather than assume one order per table.

import type { Order, OrderItem, OrderStatus } from '@/lib/types';

export type OrderWithItems = Order & { items: OrderItem[] };

// Shape returned by GET /api/tables (active tables only; never carries qr_token).
export interface StaffTable {
  id: string;
  label: string;
  zone: string;
  capacity: number;
  is_active: boolean;
  sort_order: number;
}

// The open dine-in statuses that make a table "occupied" (POS-3 AC). Deliberately
// NOT ACTIVE_LANES: 'received' is a web-order lane a dine-in order never enters.
export const OPEN_DINE_IN_STATUSES: readonly OrderStatus[] = ['accepted', 'preparing', 'ready'];

export function isOpenDineInOrder(order: Pick<Order, 'order_type' | 'status' | 'table_id'>): boolean {
  return (
    order.order_type === 'dine_in' &&
    order.table_id !== null &&
    OPEN_DINE_IN_STATUSES.includes(order.status)
  );
}

// Item count for a tile/summary — excludes voided lines so it matches the
// server-recomputed total (FND3-4: voided lines survive for audit but are out of
// the bill).
export function orderItemCount(order: OrderWithItems): number {
  return order.items.reduce((n, i) => (i.voided ? n : n + i.quantity), 0);
}

// Display total (₹). total_inr can be null on very old rows — fall back to
// subtotal exactly like OrderCard. Display-only; never recomputed client-side.
export function orderDisplayTotal(order: OrderWithItems): number {
  return order.total_inr ?? order.subtotal_inr;
}

// Group the OPEN dine-in orders by their table_id, newest-first within a table.
export function openDineInOrdersByTable(orders: OrderWithItems[]): Map<string, OrderWithItems[]> {
  const byTable = new Map<string, OrderWithItems[]>();
  for (const order of orders) {
    if (!isOpenDineInOrder(order) || !order.table_id) continue;
    const list = byTable.get(order.table_id) ?? [];
    list.push(order);
    byTable.set(order.table_id, list);
  }
  for (const list of byTable.values()) {
    list.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  return byTable;
}

export interface TableOccupancy {
  table: StaffTable;
  // The open dine-in orders currently holding this table (empty = free).
  orders: OrderWithItems[];
}

export function isOccupied(occ: TableOccupancy): boolean {
  return occ.orders.length > 0;
}

export interface ZoneGroup {
  zone: string; // '' = tables with no zone assigned (rendered last, labelled)
  tables: TableOccupancy[];
}

// Group active tables by zone with each table's open orders attached. Tables sort
// by (sort_order, label) — the same display order the API returns; zones appear in
// first-table order, with the unzoned group pushed to the end.
export function groupTablesByZone(tables: StaffTable[], orders: OrderWithItems[]): ZoneGroup[] {
  const byTable = openDineInOrdersByTable(orders);
  const sorted = [...tables].sort(
    (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label),
  );

  const zoneOrder: string[] = [];
  const zones = new Map<string, TableOccupancy[]>();
  for (const table of sorted) {
    const zone = (table.zone ?? '').trim();
    if (!zones.has(zone)) {
      zones.set(zone, []);
      zoneOrder.push(zone);
    }
    zones.get(zone)!.push({ table, orders: byTable.get(table.id) ?? [] });
  }

  // Unzoned tables sort to the end; stable order keeps the rest as encountered.
  zoneOrder.sort((a, b) => (a === '' ? 1 : 0) - (b === '' ? 1 : 0));
  return zoneOrder.map((zone) => ({ zone, tables: zones.get(zone)! }));
}
