// Inventory rules (docs/INVENTORY-SPEC.md) — everything about stock that is a
// decision rather than a database write: units and quantities, low stock and
// expiry, who may move a stock request to its next step, and how an order's
// lines turn into ingredient usage through recipes.
//
// Pure (no Supabase, no clock unless one is passed in) so the API routes and
// the screens apply the same rules and every rule is unit-tested. The atomic
// writes live in supabase/2026-10-inventory.sql.

import type { StaffSurface } from '@/lib/staff/surfaceRules';

// ── Units and quantities ────────────────────────────────────────────────────

export const INVENTORY_UNITS = ['g', 'kg', 'ml', 'l', 'pcs', 'pack'] as const;
export type InventoryUnit = (typeof INVENTORY_UNITS)[number];

export function isInventoryUnit(value: unknown): value is InventoryUnit {
  return typeof value === 'string' && (INVENTORY_UNITS as readonly string[]).includes(value);
}

export const UNIT_LABELS: Record<InventoryUnit, string> = {
  g: 'g',
  kg: 'kg',
  ml: 'ml',
  l: 'L',
  pcs: 'pcs',
  pack: 'packs',
};

/** numeric(12,3) in the database. */
export const MAX_QTY = 999_999;

/** Rounds to the database's three decimals, so 0.1 + 0.2 never shows as
 * 0.30000000000000004 and what the screen shows is what gets stored. */
export function roundQty(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * A quantity typed by a person or sent by a client: a finite number (or
 * numeric string) between 0 and MAX_QTY, rounded to three decimals. Returns
 * null when it isn't one. `allowZero` for "picked/received none of this".
 */
export function parseQty(value: unknown, { allowZero = false }: { allowZero?: boolean } = {}): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return null;
  const q = roundQty(n);
  if (q < 0 || q > MAX_QTY) return null;
  if (q === 0 && !allowZero) return null;
  return q;
}

export function formatQty(qty: number, unit: InventoryUnit | string): string {
  const q = roundQty(qty);
  const label = isInventoryUnit(unit) ? UNIT_LABELS[unit] : unit;
  const text = Number.isInteger(q) ? String(q) : q.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  return `${text} ${label}`;
}

// ── Dates ───────────────────────────────────────────────────────────────────

/** Batches expiring within this many days (today included) show as "soon". */
export const EXPIRY_WARN_DAYS = 3;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date as 'YYYY-MM-DD' (rejects 2026-02-30). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function daysBetween(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split('-').map(Number);
  const [ty, tm, td] = toIso.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

export type ExpiryState = 'expired' | 'soon' | 'ok' | 'none';

/** `today` is the IST business date (lib/cash/date.ts istBusinessDate). A
 * batch is still good ON its expiry date and expired the day after. */
export function expiryState(expiryDate: string | null, today: string, warnDays = EXPIRY_WARN_DAYS): ExpiryState {
  if (!expiryDate) return 'none';
  const days = daysBetween(today, expiryDate);
  if (days < 0) return 'expired';
  if (days < warnDays) return 'soon';
  return 'ok';
}

// ── Stock levels ────────────────────────────────────────────────────────────

export interface BatchLike {
  qty_remaining: number;
  expiry_date: string | null;
}

export interface ItemLevelInput {
  par_level: number;
  shortfall_since_count: number;
}

export interface StockSummary {
  onHand: number;
  /** At or below par (and par is set). */
  low: boolean;
  /** Sold more than the records held — someone should count it. */
  countNeeded: boolean;
  expiredQty: number;
  soonQty: number;
  /** Earliest expiry among batches with stock left, or null. */
  nextExpiry: string | null;
}

export function summarizeStock(item: ItemLevelInput, batches: BatchLike[], today: string): StockSummary {
  let onHand = 0;
  let expiredQty = 0;
  let soonQty = 0;
  let nextExpiry: string | null = null;
  for (const b of batches) {
    const q = Number(b.qty_remaining) || 0;
    if (q <= 0) continue;
    onHand += q;
    const state = expiryState(b.expiry_date, today);
    if (state === 'expired') expiredQty += q;
    if (state === 'soon') soonQty += q;
    if (b.expiry_date && (nextExpiry === null || b.expiry_date < nextExpiry)) nextExpiry = b.expiry_date;
  }
  onHand = roundQty(onHand);
  const par = Number(item.par_level) || 0;
  return {
    onHand,
    low: par > 0 && onHand <= par,
    countNeeded: (Number(item.shortfall_since_count) || 0) > 0,
    expiredQty: roundQty(expiredQty),
    soonQty: roundQty(soonQty),
    nextExpiry,
  };
}

/** What the "Request stock" sheet pre-fills for an item: its reorder
 * quantity, or enough to get back to par, or nothing (0 — the person types it). */
export function suggestedRequestQty(item: { par_level: number; reorder_qty: number }, onHand: number): number {
  const reorder = Number(item.reorder_qty) || 0;
  if (reorder > 0) return roundQty(reorder);
  const par = Number(item.par_level) || 0;
  return par > onHand ? roundQty(par - onHand) : 0;
}

// ── Stock requests ──────────────────────────────────────────────────────────

export const REQUEST_STATUSES = ['requested', 'assigned', 'picked', 'received', 'cancelled'] as const;
export type StockRequestStatus = (typeof REQUEST_STATUSES)[number];
export const OPEN_REQUEST_STATUSES: readonly StockRequestStatus[] = ['requested', 'assigned', 'picked'];

export const REQUEST_STATUS_LABELS: Record<StockRequestStatus, string> = {
  requested: 'Requested',
  assigned: 'Assigned',
  picked: 'Picked — verify at POS',
  received: 'Received',
  cancelled: 'Cancelled',
};

export interface RequestActor {
  userId: string;
  role: string;
  surface: StaffSurface;
}

export interface RequestFacts {
  status: StockRequestStatus;
  requested_by: string;
  assigned_to: string | null;
  picked_by: string | null;
}

export type Verdict = { ok: true } | { ok: false; status: 403 | 409; message: string };

const OK: Verdict = { ok: true };

export function isManagerRole(role: string): boolean {
  return role === 'manager' || role === 'owner';
}

export const RECEIVE_POS_ONLY_MESSAGE =
  'Stock is verified and received at the POS only — count it in at the counter.';

/** Assign (or re-assign) who picks: a manager or the owner, before picking. */
export function canAssign(req: RequestFacts, actor: RequestActor): Verdict {
  if (!isManagerRole(actor.role)) return { ok: false, status: 403, message: 'Only a manager or the owner can assign a request.' };
  if (req.status !== 'requested' && req.status !== 'assigned') {
    return { ok: false, status: 409, message: `This request is already ${req.status}.` };
  }
  return OK;
}

/** Record the pick: the assignee, or a manager/owner standing in. */
export function canPick(req: RequestFacts, actor: RequestActor): Verdict {
  if (req.status !== 'assigned') {
    return { ok: false, status: 409, message: req.status === 'requested' ? 'Assign this request before picking it.' : `This request is already ${req.status}.` };
  }
  if (req.assigned_to !== actor.userId && !isManagerRole(actor.role)) {
    return { ok: false, status: 403, message: 'This request is assigned to someone else.' };
  }
  return OK;
}

/**
 * Verify and receive: at the POS only, and by a second pair of eyes — not the
 * person who picked it. A manager or the owner may verify their own pick (a
 * small team can't always have two people on).
 */
export function canReceive(req: RequestFacts, actor: RequestActor): Verdict {
  if (actor.surface !== 'pos') return { ok: false, status: 403, message: RECEIVE_POS_ONLY_MESSAGE };
  if (req.status !== 'picked') {
    return { ok: false, status: 409, message: req.status === 'received' ? 'This request has already been received.' : 'Only a picked request can be received.' };
  }
  if (req.picked_by === actor.userId && !isManagerRole(actor.role)) {
    return { ok: false, status: 403, message: 'Someone other than the picker has to verify it.' };
  }
  return OK;
}

/** Cancel: the requester while nobody has been assigned yet; a manager or
 * the owner any time before it is received. */
export function canCancel(req: RequestFacts, actor: RequestActor): Verdict {
  if (req.status === 'received' || req.status === 'cancelled') {
    return { ok: false, status: 409, message: `This request is already ${req.status}.` };
  }
  if (isManagerRole(actor.role)) return OK;
  if (req.requested_by === actor.userId && req.status === 'requested') return OK;
  return { ok: false, status: 403, message: 'Only a manager or the owner can cancel this now.' };
}

// ── Line validation ─────────────────────────────────────────────────────────

export interface RequestLineInput {
  itemId: string;
  qty: number;
}

export interface ReceiveLineInput extends RequestLineInput {
  expiryDate: string | null;
}

type LinesResult<T> = { ok: true; lines: T[] } | { ok: false; message: string };

function asArray(raw: unknown): unknown[] | null {
  return Array.isArray(raw) ? raw : null;
}

function field(obj: unknown, ...keys: string[]): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) if (k in o) return o[k];
  return undefined;
}

const MAX_LINES = 60;

/** "Request stock" lines: at least one, each a known-shaped id and qty > 0,
 * no item twice. */
export function parseRequestLines(raw: unknown, isId: (v: unknown) => v is string): LinesResult<RequestLineInput> {
  const arr = asArray(raw);
  if (!arr || arr.length === 0) return { ok: false, message: 'Add at least one item to the request.' };
  if (arr.length > MAX_LINES) return { ok: false, message: `A request can have at most ${MAX_LINES} items.` };
  const seen = new Set<string>();
  const lines: RequestLineInput[] = [];
  for (const entry of arr) {
    const itemId = field(entry, 'itemId', 'item_id');
    if (!isId(itemId)) return { ok: false, message: 'Every line needs a stock item.' };
    if (seen.has(itemId)) return { ok: false, message: 'Each item can appear only once in a request.' };
    seen.add(itemId);
    const qty = parseQty(field(entry, 'qty'));
    if (qty === null) return { ok: false, message: 'Every requested quantity must be more than 0.' };
    lines.push({ itemId, qty });
  }
  return { ok: true, lines };
}

/** Picked quantities: exactly one per request line (0 = none available), and
 * at least one thing picked — an all-zero pick is a cancel, not a pick. */
export function parsePickLines(raw: unknown, requestItemIds: string[]): LinesResult<RequestLineInput> {
  const arr = asArray(raw);
  if (!arr) return { ok: false, message: 'Give a picked quantity for every line.' };
  const expected = new Set(requestItemIds);
  const lines: RequestLineInput[] = [];
  const seen = new Set<string>();
  for (const entry of arr) {
    const itemId = field(entry, 'itemId', 'item_id');
    if (typeof itemId !== 'string' || !expected.has(itemId) || seen.has(itemId)) {
      return { ok: false, message: 'The picked lines do not match the request.' };
    }
    seen.add(itemId);
    const qty = parseQty(field(entry, 'qty'), { allowZero: true });
    if (qty === null) return { ok: false, message: 'Picked quantities must be 0 or more.' };
    lines.push({ itemId, qty });
  }
  if (seen.size !== expected.size) return { ok: false, message: 'Give a picked quantity for every line.' };
  if (lines.every((l) => l.qty === 0)) {
    return { ok: false, message: 'Nothing was picked — cancel the request instead.' };
  }
  return { ok: true, lines };
}

export interface ReceivableItem {
  id: string;
  name: string;
  tracks_expiry: boolean;
}

/**
 * What arrived, verified at the POS. With `requestItemIds`, exactly one line
 * per request line (0 = did not arrive); without (a direct delivery), any
 * items, each once, at least one > 0. Every line with stock of an item that
 * tracks expiry needs an expiry date, and that date can't already be past —
 * expired stock is refused at the door, not received and then thrown away.
 */
export function parseReceiveLines(
  raw: unknown,
  items: Map<string, ReceivableItem>,
  today: string,
  requestItemIds?: string[],
): LinesResult<ReceiveLineInput> {
  const arr = asArray(raw);
  if (!arr || arr.length === 0) return { ok: false, message: 'Nothing to receive.' };
  if (arr.length > MAX_LINES) return { ok: false, message: `At most ${MAX_LINES} items at a time.` };
  const expected = requestItemIds ? new Set(requestItemIds) : null;
  const seen = new Set<string>();
  const lines: ReceiveLineInput[] = [];
  for (const entry of arr) {
    const itemId = field(entry, 'itemId', 'item_id');
    const item = typeof itemId === 'string' ? items.get(itemId) : undefined;
    if (typeof itemId !== 'string' || !item || seen.has(itemId) || (expected && !expected.has(itemId))) {
      return { ok: false, message: expected ? 'The counted lines do not match the request.' : 'Every line needs a stock item, once.' };
    }
    seen.add(itemId);
    const qty = parseQty(field(entry, 'qty'), { allowZero: true });
    if (qty === null) return { ok: false, message: `Enter how much ${item.name} arrived (0 if none).` };
    const rawExpiry = field(entry, 'expiryDate', 'expiry_date');
    let expiryDate: string | null = null;
    if (rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== '') {
      if (!isIsoDate(rawExpiry)) return { ok: false, message: `The expiry date for ${item.name} is not a valid date.` };
      expiryDate = rawExpiry;
    }
    if (qty > 0 && item.tracks_expiry && !expiryDate) {
      return { ok: false, message: `Enter the expiry date for ${item.name}.` };
    }
    if (qty > 0 && expiryDate && expiryState(expiryDate, today) === 'expired') {
      return { ok: false, message: `${item.name} is already past its expiry date — don't accept it.` };
    }
    lines.push({ itemId, qty, expiryDate: qty > 0 ? expiryDate : null });
  }
  if (expected && seen.size !== expected.size) return { ok: false, message: 'Count every line of the request.' };
  if (!expected && lines.every((l) => l.qty === 0)) return { ok: false, message: 'Nothing to receive.' };
  return { ok: true, lines };
}

/** A line whose received quantity differs from what was picked. */
export function lineHasDiscrepancy(line: { qty_picked: number | null; qty_received: number | null }): boolean {
  if (line.qty_received === null || line.qty_received === undefined) return false;
  return roundQty(Number(line.qty_picked) || 0) !== roundQty(Number(line.qty_received));
}

// ── Recipes ─────────────────────────────────────────────────────────────────

export interface RecipeLineLike {
  menu_item_id: string;
  variant_id: string | null;
  item_id: string;
  qty: number;
}

export interface OrderLineLike {
  menu_item_id: string | null;
  variant_id: string | null;
  quantity: number;
}

/**
 * What one unit of (menu item, variant) uses. A variant with recipe lines of
 * its own uses those INSTEAD of the item's base recipe (variant_id null) —
 * a Large latte is its own recipe, not "a Regular plus something".
 */
export function recipeFor(lines: RecipeLineLike[], menuItemId: string, variantId: string | null): RecipeLineLike[] {
  const forItem = lines.filter((l) => l.menu_item_id === menuItemId);
  if (variantId) {
    const own = forItem.filter((l) => l.variant_id === variantId);
    if (own.length > 0) return own;
  }
  return forItem.filter((l) => l.variant_id === null);
}

/** Total ingredient usage for an order's lines, per stock item. Lines with no
 * menu item (deleted since) or no recipe use nothing. */
export function orderUsage(orderLines: OrderLineLike[], recipeLines: RecipeLineLike[]): Map<string, number> {
  const usage = new Map<string, number>();
  for (const line of orderLines) {
    if (!line.menu_item_id) continue;
    const units = Number(line.quantity) || 0;
    if (units <= 0) continue;
    for (const r of recipeFor(recipeLines, line.menu_item_id, line.variant_id)) {
      usage.set(r.item_id, roundQty((usage.get(r.item_id) ?? 0) + Number(r.qty) * units));
    }
  }
  for (const [id, q] of usage) if (q <= 0) usage.delete(id);
  return usage;
}

export interface RecipeLineInput {
  variantId: string | null;
  itemId: string;
  qty: number;
}

/** A menu item's whole recipe as sent by the editor. Empty is allowed (it
 * clears the recipe). Each (size, ingredient) at most once. */
export function parseRecipeLines(
  raw: unknown,
  isId: (v: unknown) => v is string,
  variantIds: Set<string>,
): LinesResult<RecipeLineInput> {
  const arr = asArray(raw);
  if (!arr) return { ok: false, message: 'lines must be a list.' };
  if (arr.length > MAX_LINES) return { ok: false, message: `A recipe can have at most ${MAX_LINES} lines.` };
  const seen = new Set<string>();
  const lines: RecipeLineInput[] = [];
  for (const entry of arr) {
    const rawVariant = field(entry, 'variantId', 'variant_id');
    const variantId = rawVariant === null || rawVariant === undefined || rawVariant === '' ? null : rawVariant;
    if (variantId !== null && (!isId(variantId) || !variantIds.has(variantId))) {
      return { ok: false, message: 'That size does not belong to this menu item.' };
    }
    const itemId = field(entry, 'itemId', 'item_id');
    if (!isId(itemId)) return { ok: false, message: 'Every recipe line needs a stock item.' };
    const key = `${variantId ?? '*'}|${itemId}`;
    if (seen.has(key)) return { ok: false, message: 'An ingredient appears twice for the same size.' };
    seen.add(key);
    const qty = parseQty(field(entry, 'qty'));
    if (qty === null) return { ok: false, message: 'Every recipe quantity must be more than 0.' };
    lines.push({ variantId: variantId as string | null, itemId, qty });
  }
  return { ok: true, lines };
}

/** Turns a database error from one of the inventory functions into what the
 * person at the screen should read: the function's own 'inventory: …'
 * message, or null when it is anything else (a 500). */
export function inventoryErrorMessage(error: { message?: string } | null | undefined): string | null {
  const m = error?.message ?? '';
  const i = m.indexOf('inventory: ');
  if (i === -1) return null;
  const text = m.slice(i + 'inventory: '.length).trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}
