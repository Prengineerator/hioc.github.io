// Inventory — the database half (docs/INVENTORY-SPEC.md). Reads shaped for
// the Stock screen, and the order-completion hook that takes recipe usage off
// stock. The rules themselves are lib/inventory/rules.ts (pure, tested); the
// multi-row writes are functions in supabase/2026-10-inventory.sql.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { flags } from '@/lib/flags';
import { istBusinessDate } from '@/lib/cash/date';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import { fetchAll, type PageResult } from '@/lib/reports/reconcileServer';
import {
  expiryState,
  orderUsage,
  OPEN_REQUEST_STATUSES,
  summarizeStock,
  type AddonRecipeLineLike,
  type ExpiryState,
  type InventoryUnit,
  type OrderLineLike,
  type RecipeLineLike,
  type StockRequestStatus,
  type StockRoute,
  type StockSummary,
} from '@/lib/inventory/rules';
import type { Resolution } from '@/lib/inventory/warehouse';

export const INVENTORY_MIGRATION_HINT =
  'are supabase/2026-10-inventory.sql and supabase/2026-10-inventory-addon-scopes.sql applied?';

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

/** The one method `selectAll` needs from a Supabase query builder. */
interface RangeableQuery {
  range(from: number, to: number): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

export type SelectAllResult<T> =
  | { data: T[]; error: null }
  | { data: null; error: { code?: string; message?: string } };

/**
 * Every row of a query, however many there are. PostgREST answers at most
 * 1,000 rows per request (the project's "max rows") and says nothing when it
 * cuts a list short, so an unpaged `.select()` on a table that can outgrow
 * that silently loses its tail: the recipe editor would open half a recipe and
 * saving it would delete the rest. The paging loop is fetchAll (also used by
 * the reports); this only fits it to a query and hands back the same
 * `{ data, error }` shape as one Supabase call, so callers keep their
 * `if (res.error)` checks. A page that fails fails the whole read — never a
 * partial list.
 *
 * `build` is called once per page and must ORDER BY something unique (the
 * primary key last, if nothing else is): offset paging over an unordered or
 * tied sort can repeat or skip rows between pages.
 */
export async function selectAll<T>(build: () => RangeableQuery): Promise<SelectAllResult<T>> {
  try {
    const data = await fetchAll<T>((from, to) => build().range(from, to) as PromiseLike<PageResult<T>>);
    return { data, error: null };
  } catch (err) {
    console.error('inventory: paged read failed', err);
    const e = err as { code?: string; message?: string };
    return { data: null, error: { code: e?.code, message: e?.message } };
  }
}

/** Every stock item with its live batches and where it stands. */
export async function loadInventoryItems(
  admin: SupabaseClient,
  today: string = istBusinessDate(),
): Promise<{ items: InventoryItemView[]; error: boolean }> {
  // All three grow without a fixed limit (a batch per delivery, a request per
  // top-up), so they are paged (selectAll), not read in one go.
  const [itemsRes, batchesRes, openRes] = await Promise.all([
    selectAll<InventoryItemRow>(() => admin.from('inventory_items').select(ITEM_COLUMNS).order('name').order('id')),
    selectAll<Record<string, unknown>>(() =>
      admin
        .from('inventory_batches')
        .select('id, item_id, qty_received, qty_remaining, expiry_date, received_at, source')
        .gt('qty_remaining', 0)
        .order('expiry_date', { ascending: true, nullsFirst: false })
        .order('id'),
    ),
    selectAll<{ request_number: number; status: string; stock_request_lines: { item_id: string }[] | null }>(() =>
      admin
        .from('stock_requests')
        .select('request_number, status, stock_request_lines(item_id)')
        .in('status', OPEN_REQUEST_STATUSES as string[])
        .order('created_at', { ascending: true })
        .order('id'),
    ),
  ]);
  if (itemsRes.error || batchesRes.error) return { items: [], error: true };

  const batchesByItem = new Map<string, Record<string, unknown>[]>();
  for (const b of batchesRes.data ?? []) {
    const list = batchesByItem.get(b.item_id as string) ?? [];
    list.push(b);
    batchesByItem.set(b.item_id as string, list);
  }
  const openByItem = new Map<string, number[]>();
  for (const r of openRes.data ?? []) {
    for (const l of r.stock_request_lines ?? []) {
      const list = openByItem.get(l.item_id) ?? [];
      list.push(r.request_number);
      openByItem.set(l.item_id, list);
    }
  }

  const items = (itemsRes.data ?? []).map((row) => {
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
  /** Picked — for a warehouse transfer, what was dispatched. */
  qtyPicked: number | null;
  qtyReceived: number | null;
  expiryDate: string | null;
  /** Warehouse transfers: the expiry of the first batch sent (a hint). */
  dispatchExpiry: string | null;
  /** How the owner settled a line that arrived different. */
  resolution: Resolution | null;
  resolvedQty: number | null;
}

export interface PersonRef {
  id: string;
  name: string;
}

export interface StockRequestView {
  id: string;
  number: number;
  status: StockRequestStatus;
  /** Where it comes from and goes to (lib/inventory/rules.ts StockRoute). */
  route: StockRoute;
  note: string;
  requestedBy: PersonRef;
  /** The picker — for a warehouse transfer, the team member delivering it. */
  assignedTo: PersonRef | null;
  /** A warehouse transfer carried by someone without a login (assignedTo is null). */
  deliverer: { name: string; phone: string } | null;
  /** Whoever carries it, as one name: assignedTo's or the deliverer's ('' = nobody yet). */
  deliveredBy: string;
  resolvedBy: PersonRef | null;
  resolvedAt: string | null;
  resolutionNote: string;
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

const LEGACY_REQUEST_SELECT = `
  id, request_number, status, note, requested_by, assigned_to, picked_by, received_by, cancelled_by,
  created_at, assigned_at, picked_at, received_at, has_discrepancy, cancel_reason,
  stock_request_lines ( item_id, qty_requested, qty_picked, qty_received, expiry_date,
    inventory_items ( name, unit, tracks_expiry ) )
`;

// With the warehouse columns (supabase/2026-11-warehouse.sql). Before that
// migration the read falls back to LEGACY_REQUEST_SELECT, and every request
// reads as a store-room one — which is what each of them is.
const REQUEST_SELECT = `
  id, request_number, status, route, note, requested_by, assigned_to, picked_by, received_by, cancelled_by,
  deliverer_name, deliverer_phone, resolved_by, resolved_at, resolution_note,
  created_at, assigned_at, picked_at, received_at, has_discrepancy, cancel_reason,
  stock_request_lines ( item_id, qty_requested, qty_picked, qty_received, expiry_date,
    dispatch_expiry, resolution, resolved_qty,
    inventory_items ( name, unit, tracks_expiry ) )
`;

type RequestRow = {
  id: string;
  request_number: number;
  status: StockRequestStatus;
  route?: StockRoute | null;
  deliverer_name?: string | null;
  deliverer_phone?: string | null;
  resolved_by?: string | null;
  resolved_at?: string | null;
  resolution_note?: string | null;
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
    dispatch_expiry?: string | null;
    resolution?: Resolution | null;
    resolved_qty?: number | null;
    inventory_items: { name: string; unit: InventoryUnit; tracks_expiry: boolean } | null;
  }[] | null;
};

const RECENT_CLOSED_LIMIT = 30;

/** How long a "the warehouse columns aren't there" answer is trusted before trying again. */
const LEGACY_RECHECK_MS = 5 * 60_000;
let legacyColumnsUntil = 0;

/** Tests: forget a remembered pre-migration database. */
export function resetRequestColumnsMemo(): void {
  legacyColumnsUntil = 0;
}

export interface LoadRequestsOptions {
  /** Only these routes (the owner's Warehouse page: the two warehouse ones). */
  routes?: StockRoute[];
  /**
   * Also every transfer received different and not settled yet, however old:
   * it is still waiting on the owner, so the recent-30 cut must not drop it.
   */
  includeUnsettled?: boolean;
}

/**
 * Open requests (all of them, paged: nothing caps how many stay open) plus the
 * most recent closed ones (a fixed 30, so one plain query), and with
 * `includeUnsettled` every transfer still waiting to be settled. Reads the
 * warehouse columns when the warehouse migration is applied, and falls back to
 * the original columns when it is not.
 */
export async function loadStockRequests(
  admin: SupabaseClient,
  options: LoadRequestsOptions = {},
): Promise<{ requests: StockRequestView[]; error: boolean }> {
  // Before supabase/2026-11-warehouse.sql every request is a store-room one,
  // so a filter for warehouse routes matches nothing.
  const legacyOnly = () =>
    options.routes && !options.routes.includes('store_room')
      ? null
      : readRequestRows(admin, LEGACY_REQUEST_SELECT, { ...options, routes: undefined, includeUnsettled: false });
  let res: Awaited<ReturnType<typeof readRequestRows>>;
  if (Date.now() < legacyColumnsUntil) {
    const legacy = legacyOnly();
    if (!legacy) return { requests: [], error: false };
    res = await legacy;
  } else {
    res = await readRequestRows(admin, REQUEST_SELECT, options);
    if (res.missingColumn) {
      // Remember it for a while: the Stock screen reloads on every focus, and
      // each miss is a failed query, a retry and an error in the logs.
      legacyColumnsUntil = Date.now() + LEGACY_RECHECK_MS;
      const legacy = legacyOnly();
      if (!legacy) return { requests: [], error: false };
      res = await legacy;
    }
  }
  if (res.error) return { requests: [], error: true };
  const seenIds = new Set<string>();
  const rows = res.rows.filter((r) => (seenIds.has(r.id) ? false : (seenIds.add(r.id), true)));

  const ids = rows
    .flatMap((r) => [r.requested_by, r.assigned_to, r.picked_by, r.received_by, r.resolved_by ?? null])
    .filter((v): v is string => Boolean(v));
  const names = await getStaffDisplayNames(admin, [...new Set(ids)]);
  const person = (id: string | null | undefined): PersonRef | null => (id ? { id, name: names.get(id) ?? 'Unknown staff' } : null);

  const requests = rows.map((r): StockRequestView => {
    const assignedTo = person(r.assigned_to);
    const outsideName = (r.deliverer_name ?? '').trim();
    const deliverer = !assignedTo && outsideName ? { name: outsideName, phone: (r.deliverer_phone ?? '').trim() } : null;
    return {
      id: r.id,
      number: r.request_number,
      status: r.status,
      route: r.route ?? 'store_room',
      note: r.note ?? '',
      requestedBy: person(r.requested_by) ?? { id: r.requested_by, name: 'Unknown staff' },
      assignedTo,
      deliverer,
      deliveredBy: assignedTo?.name ?? deliverer?.name ?? '',
      resolvedBy: person(r.resolved_by),
      resolvedAt: r.resolved_at ?? null,
      resolutionNote: r.resolution_note ?? '',
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
          dispatchExpiry: l.dispatch_expiry ?? null,
          resolution: l.resolution ?? null,
          resolvedQty: l.resolved_qty === null || l.resolved_qty === undefined ? null : Number(l.resolved_qty),
        }))
        .sort((a, b) => a.itemName.localeCompare(b.itemName)),
    };
  });
  return { requests, error: false };
}

async function readRequestRows(
  admin: SupabaseClient,
  select: string,
  options: LoadRequestsOptions,
): Promise<{ rows: RequestRow[]; error: boolean; missingColumn: boolean }> {
  const scoped = <Q extends { in: (col: string, vals: string[]) => Q }>(q: Q): Q =>
    options.routes ? q.in('route', options.routes) : q;
  const [openRes, closedRes, unsettledRes] = await Promise.all([
    selectAll<RequestRow>(() =>
      scoped(admin.from('stock_requests').select(select).in('status', OPEN_REQUEST_STATUSES as string[]))
        .order('created_at', { ascending: true })
        .order('id'),
    ),
    scoped(admin.from('stock_requests').select(select).in('status', ['received', 'cancelled']))
      .order('updated_at', { ascending: false })
      .limit(RECENT_CLOSED_LIMIT),
    options.includeUnsettled
      ? selectAll<RequestRow>(() =>
          scoped(admin.from('stock_requests').select(select).eq('status', 'received').eq('has_discrepancy', true))
            .is('resolved_at', null)
            .order('received_at', { ascending: true })
            .order('id'),
        )
      : Promise.resolve({ data: [] as RequestRow[], error: null }),
  ]);
  const errors = [openRes.error, closedRes.error, unsettledRes.error].filter(Boolean) as { code?: string; message?: string }[];
  if (errors.length > 0) {
    return { rows: [], error: true, missingColumn: errors.some((e) => isMissingColumnError(e)) };
  }
  return {
    rows: [
      ...(openRes.data ?? []),
      ...((unsettledRes.data ?? []) as RequestRow[]),
      ...((closedRes.data ?? []) as unknown as RequestRow[]),
    ],
    error: false,
    missingColumn: false,
  };
}

export interface AutoHideState {
  /** store_settings.stock_auto_hide (on unless the owner switched it off). */
  enabled: boolean;
  /** Menu items currently hidden because an ingredient ran out. */
  hidden: { id: string; name: string }[];
}

/** The auto-hide switch and what it has hidden right now. */
export async function loadAutoHide(admin: SupabaseClient): Promise<AutoHideState> {
  const [settingRes, hiddenRes] = await Promise.all([
    admin.from('store_settings').select('stock_auto_hide').eq('is_singleton', true).maybeSingle(),
    admin.from('menu_items').select('id, name').eq('stock_out_auto', true).order('name'),
  ]);
  const enabled = (settingRes.data as { stock_auto_hide?: boolean } | null)?.stock_auto_hide !== false;
  return { enabled, hidden: hiddenRes.error ? [] : ((hiddenRes.data ?? []) as { id: string; name: string }[]) };
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
 * takes nothing twice. Voided lines (order_items.voided) are left out: a line
 * that was voided was never made, so its recipe uses no stock. An add-on's
 * usage is the recipe for the line's menu item and size when it has one (see
 * addonRecipeFor), else its general recipe. A no-op with either flag off
 * (inventory, or inventorySales — the Stock screen can be live while sales
 * still leave stock alone), before the migration, or when nothing on the
 * order has a recipe.
 */
export async function consumeStockForOrder(orderId: string, actorId: string | null): Promise<void> {
  if (!flags.inventory || !flags.inventorySales) return;
  try {
    const admin = createAdminSupabaseClient();
    // weight_grams (2026-10-sell-by-weight.sql) may not exist yet: read without
    // it then, when no line can be weighed anyway.
    const readLines = (withWeight: boolean) =>
      admin
        .from('order_items')
        .select(
          `menu_item_id, variant_label_snapshot, quantity, ${withWeight ? 'weight_grams, ' : ''}order_item_addons(addon_option_id)`,
        )
        .eq('order_id', orderId)
        .eq('voided', false);
    let { data: lines, error: linesError } = await readLines(true);
    if (linesError && isMissingColumnError(linesError)) ({ data: lines, error: linesError } = await readLines(false));
    if (linesError) {
      console.error('consumeStockForOrder: order lines lookup failed', linesError);
      return;
    }
    type LineRow = {
      menu_item_id: string | null;
      variant_label_snapshot: string | null;
      quantity: number;
      weight_grams?: number | null;
      order_item_addons: { addon_option_id: string | null }[] | null;
    };
    const orderLines: OrderLineLike[] = ((lines ?? []) as unknown as LineRow[]).map((l) => ({
      menu_item_id: l.menu_item_id,
      variant_label: l.variant_label_snapshot,
      quantity: l.quantity,
      weight_grams: l.weight_grams ?? null,
      addon_option_ids: (l.order_item_addons ?? []).map((a) => a.addon_option_id),
    }));
    const menuIds = [...new Set(orderLines.map((l) => l.menu_item_id).filter((v): v is string => Boolean(v)))];
    const optionIds = [...new Set(orderLines.flatMap((l) => l.addon_option_ids ?? []).filter((v): v is string => Boolean(v)))];
    if (menuIds.length === 0 && optionIds.length === 0) return;

    const [recipeRes, addonRes] = await Promise.all([
      menuIds.length
        ? admin.from('recipe_lines').select('menu_item_id, size_label, item_id, qty').in('menu_item_id', menuIds)
        : Promise.resolve({ data: [], error: null }),
      optionIds.length
        ? admin
            .from('addon_recipe_lines')
            .select('addon_option_id, item_id, qty, menu_item_id, size_label')
            .in('addon_option_id', optionIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    if (recipeRes.error || addonRes.error) {
      console.error(`consumeStockForOrder: recipe lookup failed — ${INVENTORY_MIGRATION_HINT}`, recipeRes.error ?? addonRes.error);
      return;
    }
    const usage = orderUsage(
      orderLines,
      ((recipeRes.data ?? []) as RecipeLineLike[]).map((r) => ({ ...r, qty: Number(r.qty) })),
      ((addonRes.data ?? []) as AddonRecipeLineLike[]).map((r) => ({ ...r, qty: Number(r.qty) })),
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
