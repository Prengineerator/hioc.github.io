// Inventory — the database half (docs/INVENTORY-SPEC.md). Reads shaped for
// the Stock screen, and the order-completion hook that takes recipe usage off
// stock. The rules themselves are lib/inventory/rules.ts (pure, tested); the
// multi-row writes are functions in supabase/2026-10-inventory.sql.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { flags } from '@/lib/flags';
import { istBusinessDate } from '@/lib/cash/date';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import {
  expiryState,
  orderUsage,
  OPEN_REQUEST_STATUSES,
  summarizeStock,
  type ExpiryState,
  type InventoryUnit,
  type RecipeLineLike,
  type StockRequestStatus,
  type StockSummary,
} from '@/lib/inventory/rules';

export const INVENTORY_MIGRATION_HINT = 'is supabase/2026-10-inventory.sql applied?';

export const INVENTORY_OFF_MESSAGE = 'Inventory is not switched on for this environment.';

export interface InventoryItemRow {
  id: string;
  name: string;
  unit: InventoryUnit;
  category: string;
  par_level: number;
  reorder_qty: number;
  tracks_expiry: boolean;
  is_active: boolean;
  shortfall_since_count: number;
  last_counted_at: string | null;
}

export interface BatchView {
  id: string;
  qtyRemaining: number;
  qtyReceived: number;
  expiryDate: string | null;
  receivedAt: string;
  source: 'receive' | 'count';
  state: ExpiryState;
}

export interface InventoryItemView extends StockSummary {
  id: string;
  name: string;
  unit: InventoryUnit;
  category: string;
  parLevel: number;
  reorderQty: number;
  tracksExpiry: boolean;
  isActive: boolean;
  shortfall: number;
  lastCountedAt: string | null;
  batches: BatchView[];
  /** Open stock requests this item is on, so nobody requests it twice. */
  openRequestNumbers: number[];
}

export const ITEM_COLUMNS =
  'id, name, unit, category, par_level, reorder_qty, tracks_expiry, is_active, shortfall_since_count, last_counted_at';

/** Every stock item with its live batches and where it stands. */
export async function loadInventoryItems(
  admin: SupabaseClient,
  today: string = istBusinessDate(),
): Promise<{ items: InventoryItemView[]; error: boolean }> {
  const [itemsRes, batchesRes, openRes] = await Promise.all([
    admin.from('inventory_items').select(ITEM_COLUMNS).order('name'),
    admin
      .from('inventory_batches')
      .select('id, item_id, qty_received, qty_remaining, expiry_date, received_at, source')
      .gt('qty_remaining', 0)
      .order('expiry_date', { ascending: true, nullsFirst: false }),
    admin
      .from('stock_requests')
      .select('request_number, status, stock_request_lines(item_id)')
      .in('status', OPEN_REQUEST_STATUSES as string[]),
  ]);
  if (itemsRes.error || batchesRes.error) return { items: [], error: true };

  const batchesByItem = new Map<string, Record<string, unknown>[]>();
  for (const b of (batchesRes.data ?? []) as Record<string, unknown>[]) {
    const list = batchesByItem.get(b.item_id as string) ?? [];
    list.push(b);
    batchesByItem.set(b.item_id as string, list);
  }
  const openByItem = new Map<string, number[]>();
  for (const r of (openRes.data ?? []) as { request_number: number; stock_request_lines: { item_id: string }[] | null }[]) {
    for (const l of r.stock_request_lines ?? []) {
      const list = openByItem.get(l.item_id) ?? [];
      list.push(r.request_number);
      openByItem.set(l.item_id, list);
    }
  }

  const items = ((itemsRes.data ?? []) as InventoryItemRow[]).map((row) => {
    const rawBatches = batchesByItem.get(row.id) ?? [];
    const batches: BatchView[] = rawBatches.map((b) => ({
      id: b.id as string,
      qtyRemaining: Number(b.qty_remaining),
      qtyReceived: Number(b.qty_received),
      expiryDate: (b.expiry_date as string | null) ?? null,
      receivedAt: b.received_at as string,
      source: (b.source as 'receive' | 'count') ?? 'receive',
      state: expiryState((b.expiry_date as string | null) ?? null, today),
    }));
    const summary = summarizeStock(
      { par_level: Number(row.par_level), shortfall_since_count: Number(row.shortfall_since_count) },
      rawBatches.map((b) => ({ qty_remaining: Number(b.qty_remaining), expiry_date: (b.expiry_date as string | null) ?? null })),
      today,
    );
    return {
      ...summary,
      id: row.id,
      name: row.name,
      unit: row.unit,
      category: row.category ?? '',
      parLevel: Number(row.par_level),
      reorderQty: Number(row.reorder_qty),
      tracksExpiry: row.tracks_expiry,
      isActive: row.is_active,
      shortfall: Number(row.shortfall_since_count),
      lastCountedAt: row.last_counted_at,
      batches,
      openRequestNumbers: (openByItem.get(row.id) ?? []).sort((a, b) => a - b),
    } satisfies InventoryItemView;
  });
  return { items, error: false };
}

export interface StockRequestLineView {
  itemId: string;
  itemName: string;
  unit: InventoryUnit;
  tracksExpiry: boolean;
  qtyRequested: number;
  qtyPicked: number | null;
  qtyReceived: number | null;
  expiryDate: string | null;
}

export interface PersonRef {
  id: string;
  name: string;
}

export interface StockRequestView {
  id: string;
  number: number;
  status: StockRequestStatus;
  note: string;
  requestedBy: PersonRef;
  assignedTo: PersonRef | null;
  pickedBy: PersonRef | null;
  receivedBy: PersonRef | null;
  createdAt: string;
  assignedAt: string | null;
  pickedAt: string | null;
  receivedAt: string | null;
  hasDiscrepancy: boolean;
  cancelReason: string;
  lines: StockRequestLineView[];
}

const REQUEST_SELECT = `
  id, request_number, status, note, requested_by, assigned_to, picked_by, received_by, cancelled_by,
  created_at, assigned_at, picked_at, received_at, has_discrepancy, cancel_reason,
  stock_request_lines ( item_id, qty_requested, qty_picked, qty_received, expiry_date,
    inventory_items ( name, unit, tracks_expiry ) )
`;

type RequestRow = {
  id: string;
  request_number: number;
  status: StockRequestStatus;
  note: string;
  requested_by: string;
  assigned_to: string | null;
  picked_by: string | null;
  received_by: string | null;
  created_at: string;
  assigned_at: string | null;
  picked_at: string | null;
  received_at: string | null;
  has_discrepancy: boolean;
  cancel_reason: string;
  stock_request_lines: {
    item_id: string;
    qty_requested: number;
    qty_picked: number | null;
    qty_received: number | null;
    expiry_date: string | null;
    inventory_items: { name: string; unit: InventoryUnit; tracks_expiry: boolean } | null;
  }[] | null;
};

const RECENT_CLOSED_LIMIT = 30;

/** Open requests (all of them) plus the most recent closed ones. */
export async function loadStockRequests(admin: SupabaseClient): Promise<{ requests: StockRequestView[]; error: boolean }> {
  const [openRes, closedRes] = await Promise.all([
    admin
      .from('stock_requests')
      .select(REQUEST_SELECT)
      .in('status', OPEN_REQUEST_STATUSES as string[])
      .order('created_at', { ascending: true }),
    admin
      .from('stock_requests')
      .select(REQUEST_SELECT)
      .in('status', ['received', 'cancelled'])
      .order('updated_at', { ascending: false })
      .limit(RECENT_CLOSED_LIMIT),
  ]);
  if (openRes.error || closedRes.error) return { requests: [], error: true };
  const rows = [...((openRes.data ?? []) as unknown as RequestRow[]), ...((closedRes.data ?? []) as unknown as RequestRow[])];

  const ids = rows.flatMap((r) => [r.requested_by, r.assigned_to, r.picked_by, r.received_by]).filter((v): v is string => Boolean(v));
  const names = await getStaffDisplayNames(admin, [...new Set(ids)]);
  const person = (id: string | null): PersonRef | null => (id ? { id, name: names.get(id) ?? 'Unknown staff' } : null);

  const requests = rows.map((r) => ({
    id: r.id,
    number: r.request_number,
    status: r.status,
    note: r.note ?? '',
    requestedBy: person(r.requested_by) ?? { id: r.requested_by, name: 'Unknown staff' },
    assignedTo: person(r.assigned_to),
    pickedBy: person(r.picked_by),
    receivedBy: person(r.received_by),
    createdAt: r.created_at,
    assignedAt: r.assigned_at,
    pickedAt: r.picked_at,
    receivedAt: r.received_at,
    hasDiscrepancy: r.has_discrepancy,
    cancelReason: r.cancel_reason ?? '',
    lines: (r.stock_request_lines ?? [])
      .map((l) => ({
        itemId: l.item_id,
        itemName: l.inventory_items?.name ?? 'Unknown item',
        unit: l.inventory_items?.unit ?? 'pcs',
        tracksExpiry: l.inventory_items?.tracks_expiry ?? false,
        qtyRequested: Number(l.qty_requested),
        qtyPicked: l.qty_picked === null ? null : Number(l.qty_picked),
        qtyReceived: l.qty_received === null ? null : Number(l.qty_received),
        expiryDate: l.expiry_date,
      }))
      .sort((a, b) => a.itemName.localeCompare(b.itemName)),
  }));
  return { requests, error: false };
}

/** Active team members a request can be assigned to. */
export async function loadAssignees(admin: SupabaseClient): Promise<PersonRef[]> {
  const { data, error } = await admin
    .from('profiles')
    .select('id, name, role')
    .in('role', ['staff', 'manager', 'owner']);
  if (error) return [];
  const rows = (data ?? []) as { id: string; name: string | null }[];
  const names = await getStaffDisplayNames(admin, rows.filter((r) => !r.name?.trim()).map((r) => r.id));
  return rows
    .map((r) => ({ id: r.id, name: r.name?.trim() || names.get(r.id) || 'Staff' }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Order completion hook (app/api/orders/[id]/status): take the order's recipe
 * usage off stock. Best-effort in the same way as the loyalty earn beside it —
 * it logs and returns, and can never fail the transition: the order is
 * already complete and the customer already has their food. Idempotent in the
 * database (one 'sale' movement per order and item), so a retried completion
 * takes nothing twice. A no-op with the flag off, before the migration, or
 * when nothing on the order has a recipe.
 */
export async function consumeStockForOrder(orderId: string, actorId: string | null): Promise<void> {
  if (!flags.inventory) return;
  try {
    const admin = createAdminSupabaseClient();
    const { data: lines, error: linesError } = await admin
      .from('order_items')
      .select('menu_item_id, variant_id, quantity')
      .eq('order_id', orderId);
    if (linesError) {
      console.error('consumeStockForOrder: order lines lookup failed', linesError);
      return;
    }
    const orderLines = (lines ?? []) as { menu_item_id: string | null; variant_id: string | null; quantity: number }[];
    const menuIds = [...new Set(orderLines.map((l) => l.menu_item_id).filter((v): v is string => Boolean(v)))];
    if (menuIds.length === 0) return;

    const { data: recipe, error: recipeError } = await admin
      .from('recipe_lines')
      .select('menu_item_id, variant_id, item_id, qty')
      .in('menu_item_id', menuIds);
    if (recipeError) {
      console.error(`consumeStockForOrder: recipe lookup failed — ${INVENTORY_MIGRATION_HINT}`, recipeError);
      return;
    }
    const usage = orderUsage(
      orderLines,
      ((recipe ?? []) as RecipeLineLike[]).map((r) => ({ ...r, qty: Number(r.qty) })),
    );
    if (usage.size === 0) return;

    const { error } = await admin.rpc('inventory_apply_sale', {
      p_order_id: orderId,
      p_actor: actorId,
      p_lines: [...usage].map(([item_id, qty]) => ({ item_id, qty })),
    });
    if (error) console.error('consumeStockForOrder: inventory_apply_sale failed', error);
  } catch (err) {
    console.error('consumeStockForOrder: unexpected failure', err);
  }
}
