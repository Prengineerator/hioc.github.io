// Warehouse — the database half (docs/WAREHOUSE-SPEC.md): the owner's gate,
// the warehouse stock sheet, and the transfers the Warehouse page works
// through. Rules are lib/inventory/warehouse.ts (pure); the multi-row writes
// are functions in supabase/2026-11-warehouse.sql.

import 'server-only';
import type { NextResponse } from 'next/server';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse } from '@/lib/api/http';
import { flags } from '@/lib/flags';
import { istBusinessDate } from '@/lib/cash/date';
import { expiryState, summarizeStock, type ExpiryState, type InventoryUnit } from '@/lib/inventory/rules';
import {
  loadAssignees,
  loadInventoryItems,
  loadStockRequests,
  selectAll,
  type PersonRef,
  type StockRequestView,
} from '@/lib/inventory/server';
import { ownerWaiting, transitByItem, warehouseLow, type OwnerWaiting } from '@/lib/inventory/warehouse';

export const WAREHOUSE_MIGRATION_HINT = 'is supabase/2026-11-warehouse.sql applied?';
export const WAREHOUSE_OFF_MESSAGE = 'The warehouse is not switched on for this environment.';

/** The owner, with inventory and the warehouse switched on. */
export async function requireWarehouseOwner(): Promise<{ owner: User } | { response: NextResponse }> {
  const owner = await getOwnerUser();
  if (!owner) return { response: errorResponse(403, 'Owner access required') };
  if (!flags.inventory || !flags.warehouse) return { response: errorResponse(404, WAREHOUSE_OFF_MESSAGE) };
  return { owner };
}

export type WarehouseBatchSource = 'purchase' | 'return' | 'count' | 'transit_back';

export interface WarehouseBatchView {
  id: string;
  qtyRemaining: number;
  qtyReceived: number;
  expiryDate: string | null;
  receivedAt: string;
  source: WarehouseBatchSource;
  supplier: string;
  state: ExpiryState;
}

export interface WarehouseSheetRow {
  id: string;
  name: string;
  unit: InventoryUnit;
  category: string;
  tracksExpiry: boolean;
  isActive: boolean;
  warehouse: {
    onHand: number;
    /** Warehouse low level: at or below it, time to buy. */
    parLevel: number;
    low: boolean;
    /** Dispatched more than its records held: count it. */
    countNeeded: boolean;
    shortfall: number;
    lastCountedAt: string | null;
    expiredQty: number;
    soonQty: number;
    nextExpiry: string | null;
    batches: WarehouseBatchView[];
  };
  storeOnHand: number;
  storeLow: boolean;
  inTransit: { toStore: number; toWarehouse: number };
  /** Asked for by the store and not dispatched yet. */
  awaitingDispatch: number;
}

type WarehouseItemRow = { item_id: string; par_level: number; shortfall_since_count: number; last_counted_at: string | null };
type WarehouseBatchRow = {
  id: string;
  item_id: string;
  qty_received: number;
  qty_remaining: number;
  expiry_date: string | null;
  received_at: string;
  source: WarehouseBatchSource;
  supplier: string;
};

/** Every stock item, as the warehouse and the store each hold it, and what is between them. */
export async function loadWarehouseSheet(
  admin: SupabaseClient,
  transfers: StockRequestView[],
  today: string = istBusinessDate(),
): Promise<{ rows: WarehouseSheetRow[]; error: boolean }> {
  const [store, whItems, whBatches] = await Promise.all([
    loadInventoryItems(admin, today),
    selectAll<WarehouseItemRow>(() =>
      admin.from('warehouse_items').select('item_id, par_level, shortfall_since_count, last_counted_at').order('item_id'),
    ),
    selectAll<WarehouseBatchRow>(() =>
      admin
        .from('warehouse_batches')
        .select('id, item_id, qty_received, qty_remaining, expiry_date, received_at, source, supplier')
        .gt('qty_remaining', 0)
        .order('expiry_date', { ascending: true, nullsFirst: false })
        .order('id'),
    ),
  ]);
  if (store.error || whItems.error || whBatches.error) return { rows: [], error: true };

  const settings = new Map((whItems.data ?? []).map((r) => [r.item_id, r]));
  const batchesByItem = new Map<string, WarehouseBatchRow[]>();
  for (const b of whBatches.data ?? []) batchesByItem.set(b.item_id, [...(batchesByItem.get(b.item_id) ?? []), b]);
  const transit = transitByItem(transfers);
  const awaiting = new Map<string, number>();
  for (const t of transfers) {
    if (t.route !== 'from_warehouse' || (t.status !== 'requested' && t.status !== 'assigned')) continue;
    for (const l of t.lines) awaiting.set(l.itemId, (awaiting.get(l.itemId) ?? 0) + l.qtyRequested);
  }

  const rows = store.items
    .map((item): WarehouseSheetRow => {
      const s = settings.get(item.id);
      const raw = batchesByItem.get(item.id) ?? [];
      const summary = summarizeStock(
        { par_level: Number(s?.par_level ?? 0), shortfall_since_count: Number(s?.shortfall_since_count ?? 0) },
        raw.map((b) => ({ qty_remaining: Number(b.qty_remaining), expiry_date: b.expiry_date })),
        today,
      );
      return {
        id: item.id,
        name: item.name,
        unit: item.unit,
        category: item.category,
        tracksExpiry: item.tracksExpiry,
        isActive: item.isActive,
        warehouse: {
          onHand: summary.onHand,
          parLevel: Number(s?.par_level ?? 0),
          low: warehouseLow(summary.onHand, Number(s?.par_level ?? 0)),
          countNeeded: summary.countNeeded,
          shortfall: Number(s?.shortfall_since_count ?? 0),
          lastCountedAt: s?.last_counted_at ?? null,
          expiredQty: summary.expiredQty,
          soonQty: summary.soonQty,
          nextExpiry: summary.nextExpiry,
          batches: raw.map((b) => ({
            id: b.id,
            qtyRemaining: Number(b.qty_remaining),
            qtyReceived: Number(b.qty_received),
            expiryDate: b.expiry_date,
            receivedAt: b.received_at,
            source: b.source,
            supplier: b.supplier ?? '',
            state: expiryState(b.expiry_date, today),
          })),
        },
        storeOnHand: item.onHand,
        storeLow: item.low,
        inTransit: transit.get(item.id) ?? { toStore: 0, toWarehouse: 0 },
        awaitingDispatch: awaiting.get(item.id) ?? 0,
      };
    })
    // Retired items stay on the sheet only while either side still holds some.
    .filter((r) => r.isActive || r.warehouse.onHand > 0 || r.storeOnHand > 0 || r.inTransit.toStore > 0 || r.inTransit.toWarehouse > 0);
  return { rows, error: false };
}

export interface WarehousePayload {
  today: string;
  items: WarehouseSheetRow[];
  requests: StockRequestView[];
  assignees: PersonRef[];
  waiting: OwnerWaiting;
  actorId: string;
}

/** Everything the owner's Warehouse page shows, in one load. */
export async function loadWarehouse(
  admin: SupabaseClient,
  actorId: string,
): Promise<{ payload: WarehousePayload } | { error: string }> {
  const today = istBusinessDate();
  const [{ requests, error: requestsError }, assignees] = await Promise.all([
    loadStockRequests(admin, { routes: ['from_warehouse', 'to_warehouse'], includeUnsettled: true }),
    loadAssignees(admin),
  ]);
  if (requestsError) return { error: `Could not load the transfers — ${WAREHOUSE_MIGRATION_HINT}` };
  const sheet = await loadWarehouseSheet(admin, requests, today);
  if (sheet.error) return { error: `Could not load the warehouse sheet — ${WAREHOUSE_MIGRATION_HINT}` };
  return { payload: { today, items: sheet.rows, requests, assignees, waiting: ownerWaiting(requests), actorId } };
}

/**
 * What is waiting on the owner, as four counts — for the owner header's
 * Warehouse badge, so the header doesn't load the whole page to draw a number.
 * Zeros before the migration.
 */
export async function countOwnerWaiting(admin: SupabaseClient): Promise<OwnerWaiting> {
  const count = async (route: string, status: string, unsettled = false) => {
    let q = admin.from('stock_requests').select('id', { count: 'exact', head: true }).eq('route', route).eq('status', status);
    if (unsettled) q = q.eq('has_discrepancy', true).is('resolved_at', null);
    const { count: n, error } = await q;
    return error ? 0 : n ?? 0;
  };
  const [toAssign, toDispatch, toReceive, settleIn, settleOut] = await Promise.all([
    count('from_warehouse', 'requested'),
    count('from_warehouse', 'assigned'),
    count('to_warehouse', 'picked'),
    count('from_warehouse', 'received', true),
    count('to_warehouse', 'received', true),
  ]);
  const toSettle = settleIn + settleOut;
  return { toAssign, toDispatch, toReceive, toSettle, total: toAssign + toDispatch + toReceive + toSettle };
}
