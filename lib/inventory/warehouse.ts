// Warehouse rules (docs/WAREHOUSE-SPEC.md): everything about the warehouse
// that is a decision rather than a database write — who may count a return
// in and who settles a difference, how lines and the delivery person are
// validated, which settlements fit a line, what is in transit, and what is
// waiting on the owner.
//
// Pure (no Supabase, no clock unless one is passed in) so the API routes and
// both screens (the owner's Warehouse page, the staff Stock screen) apply the
// same rules, and each is unit-tested. The atomic writes are the functions in
// supabase/2026-11-warehouse.sql; the request rules shared with the store
// room (assign, dispatch = pick, count-in at the POS, cancel) are in
// lib/inventory/rules.ts, route-aware.

import {
  expiryState,
  isIsoDate,
  isWarehouseRoute,
  MAX_LINES,
  parseQty,
  roundQty,
  type ReceivableItem,
  type RequestActor,
  type StockRequestStatus,
  type StockRoute,
  type Verdict,
} from '@/lib/inventory/rules';
import { normalizeIndianMobileHonouringPlus } from '@/lib/phone';

const OK: Verdict = { ok: true };

export function isOwnerRole(role: string): boolean {
  return role === 'owner';
}

// ── Who may do what on the warehouse side ───────────────────────────────────

export interface TransferFacts {
  route: StockRoute;
  status: StockRequestStatus;
  hasDiscrepancy: boolean;
  resolvedAt: string | null;
}

/** Count a return in at the warehouse: the owner (it is the owner's stock). */
export function canReceiveReturn(req: TransferFacts, actor: Pick<RequestActor, 'role'>): Verdict {
  if (!isOwnerRole(actor.role)) return { ok: false, status: 403, message: 'Only the owner counts stock in at the warehouse.' };
  if (req.route !== 'to_warehouse') return { ok: false, status: 409, message: 'This is not a return to the warehouse.' };
  if (req.status !== 'picked') {
    return { ok: false, status: 409, message: req.status === 'received' ? 'This return has already been counted in.' : `This return is ${req.status}.` };
  }
  return OK;
}

/** Settle a transfer that arrived different from what was sent: the owner. */
export function canResolve(req: TransferFacts, actor: Pick<RequestActor, 'role'>): Verdict {
  if (!isOwnerRole(actor.role)) return { ok: false, status: 403, message: 'Only the owner settles a difference.' };
  if (!isWarehouseRoute(req.route)) return { ok: false, status: 409, message: 'Only warehouse transfers are settled here.' };
  if (req.status !== 'received') return { ok: false, status: 409, message: 'It has to be counted in before it can be settled.' };
  if (!req.hasDiscrepancy) return { ok: false, status: 409, message: 'It arrived as it was sent — there is nothing to settle.' };
  if (req.resolvedAt) return { ok: false, status: 409, message: 'This transfer is already settled.' };
  return OK;
}

/** Waiting to be settled: received different, not settled yet. */
export function needsSettling(req: TransferFacts): boolean {
  return isWarehouseRoute(req.route) && req.status === 'received' && req.hasDiscrepancy && !req.resolvedAt;
}

// ── Settlements ─────────────────────────────────────────────────────────────

export const RESOLUTIONS = ['lost', 'back_to_origin', 'origin_sent_extra', 'accepted'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export function isResolution(value: unknown): value is Resolution {
  return typeof value === 'string' && (RESOLUTIONS as readonly string[]).includes(value);
}

/** Sent minus arrived: > 0 arrived short, < 0 arrived over, 0 matched. */
export function lineDifference(line: { qtyPicked: number | null; qtyReceived: number | null }): number {
  return roundQty((Number(line.qtyPicked) || 0) - (Number(line.qtyReceived) || 0));
}

/** The settlements that fit a line: short → lost or back where it came from;
 * over → taken off where it came from, or accepted as it is. */
export function resolutionOptions(difference: number): Resolution[] {
  if (difference > 0) return ['lost', 'back_to_origin'];
  if (difference < 0) return ['origin_sent_extra', 'accepted'];
  return [];
}

/** How a settlement reads, for the transfer's direction. */
export function resolutionLabel(resolution: Resolution, route: StockRoute): string {
  const origin = route === 'to_warehouse' ? 'the store' : 'the warehouse';
  switch (resolution) {
    case 'lost':
      return 'Lost or damaged on the way';
    case 'back_to_origin':
      return route === 'to_warehouse' ? 'It never left — back on the store shelf' : 'It never left — back in the warehouse';
    case 'origin_sent_extra':
      return `${origin === 'the store' ? 'The store' : 'The warehouse'} sent more than it recorded — take it off ${origin}`;
    case 'accepted':
      return `Accept it — leave ${origin} as it is`;
  }
}

export interface MismatchedLine {
  itemId: string;
  itemName: string;
  difference: number;
}

/**
 * The owner's answer for each line that arrived different: every mismatched
 * line exactly once, nothing else, each with a settlement that fits it.
 */
export function parseResolveLines(
  raw: unknown,
  mismatched: MismatchedLine[],
): { ok: true; lines: { itemId: string; resolution: Resolution }[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: 'Settle every line that arrived different.' };
  const byId = new Map(mismatched.map((m) => [m.itemId, m]));
  const seen = new Set<string>();
  const lines: { itemId: string; resolution: Resolution }[] = [];
  for (const entry of raw) {
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const itemId = e.itemId ?? e.item_id;
    const line = typeof itemId === 'string' ? byId.get(itemId) : undefined;
    if (!line || seen.has(line.itemId)) return { ok: false, message: 'Settle every line that arrived different, and only those.' };
    seen.add(line.itemId);
    const resolution = e.resolution;
    if (!isResolution(resolution) || !resolutionOptions(line.difference).includes(resolution)) {
      return {
        ok: false,
        message: line.difference > 0
          ? `${line.itemName} arrived short: say whether it was lost or never left.`
          : `${line.itemName} arrived over: say whether to take it off where it came from or accept it.`,
      };
    }
    lines.push({ itemId: line.itemId, resolution });
  }
  if (seen.size !== byId.size) return { ok: false, message: 'Settle every line that arrived different.' };
  return { ok: true, lines };
}

// ── The delivery person ─────────────────────────────────────────────────────

export const MAX_DELIVERER_NAME = 60;

export type Deliverer =
  | { kind: 'member'; userId: string }
  | { kind: 'outside'; name: string; phone: string };

/**
 * Who carries a warehouse transfer: `assigneeId` (a team member), or
 * `deliverer: { name, phone? }` — someone without a login, e.g. a driver.
 * Exactly one. A phone, when given, must be an Indian mobile; it is stored as
 * +91XXXXXXXXXX so it can be dialled from the screen.
 */
export function parseDeliverer(
  body: Record<string, unknown>,
  isId: (v: unknown) => v is string,
): { ok: true; deliverer: Deliverer } | { ok: false; message: string } {
  const hasMember = body.assigneeId !== undefined && body.assigneeId !== null && body.assigneeId !== '';
  const hasOutside = body.deliverer !== undefined && body.deliverer !== null;
  if (hasMember === hasOutside) return { ok: false, message: 'Choose who delivers it: a team member, or someone else by name.' };
  if (hasMember) {
    if (!isId(body.assigneeId)) return { ok: false, message: 'Choose who delivers it.' };
    return { ok: true, deliverer: { kind: 'member', userId: body.assigneeId } };
  }
  const d = typeof body.deliverer === 'object' ? (body.deliverer as Record<string, unknown>) : {};
  const name = typeof d.name === 'string' ? d.name.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 2) return { ok: false, message: 'Enter the delivery person’s name.' };
  if (name.length > MAX_DELIVERER_NAME) return { ok: false, message: `Keep the name under ${MAX_DELIVERER_NAME} characters.` };
  const rawPhone = typeof d.phone === 'string' ? d.phone.trim() : '';
  let phone = '';
  if (rawPhone) {
    const n = normalizeIndianMobileHonouringPlus(rawPhone);
    if (!n) return { ok: false, message: 'That phone number is not a valid Indian mobile.' };
    phone = `+91${n}`;
  }
  return { ok: true, deliverer: { kind: 'outside', name, phone } };
}

// ── Lines ───────────────────────────────────────────────────────────────────

export interface PurchaseLineInput {
  itemId: string;
  qty: number;
  expiryDate: string | null;
}

/**
 * Stock bought into the warehouse. Each line is a batch, so the same item may
 * appear twice (two expiry dates). Quantities > 0; a perishable needs an
 * expiry date, which can't already be past — expired stock isn't bought in.
 */
export function parsePurchaseLines(
  raw: unknown,
  items: Map<string, ReceivableItem>,
  today: string,
): { ok: true; lines: PurchaseLineInput[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, message: 'Add at least one item.' };
  if (raw.length > MAX_LINES) return { ok: false, message: `At most ${MAX_LINES} lines at a time.` };
  const lines: PurchaseLineInput[] = [];
  for (const entry of raw) {
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const itemId = e.itemId ?? e.item_id;
    const item = typeof itemId === 'string' ? items.get(itemId) : undefined;
    if (typeof itemId !== 'string' || !item) return { ok: false, message: 'Every line needs a stock item that is still stocked.' };
    const qty = parseQty(e.qty);
    if (qty === null) return { ok: false, message: `Enter how much ${item.name} came in.` };
    const rawExpiry = e.expiryDate ?? e.expiry_date;
    let expiryDate: string | null = null;
    if (rawExpiry !== undefined && rawExpiry !== null && rawExpiry !== '') {
      if (!isIsoDate(rawExpiry)) return { ok: false, message: `The expiry date for ${item.name} is not a valid date.` };
      expiryDate = rawExpiry;
    }
    if (item.tracks_expiry && !expiryDate) return { ok: false, message: `Enter the expiry date for ${item.name}.` };
    if (expiryDate && expiryState(expiryDate, today) === 'expired') {
      return { ok: false, message: `${item.name} is already past its expiry date — don’t take it in.` };
    }
    lines.push({ itemId, qty, expiryDate });
  }
  return { ok: true, lines };
}

// ── In transit ──────────────────────────────────────────────────────────────

/** The parts of a request (StockRequestView) the transit views read. */
export interface TransferLike {
  id: string;
  number: number;
  route: StockRoute;
  status: StockRequestStatus;
  pickedAt: string | null;
  receivedAt: string | null;
  hasDiscrepancy: boolean;
  resolvedAt: string | null;
  deliveredBy: string;
  lines: {
    itemId: string;
    itemName: string;
    unit: string;
    qtyPicked: number | null;
    qtyReceived: number | null;
    dispatchExpiry: string | null;
  }[];
}

export interface TransitLine {
  requestId: string;
  number: number;
  route: 'from_warehouse' | 'to_warehouse';
  itemId: string;
  itemName: string;
  unit: string;
  qty: number;
  deliveredBy: string;
  dispatchedAt: string | null;
  dispatchExpiry: string | null;
}

/** Everything on the road right now, line by line, oldest dispatch first. */
export function transitLines(transfers: TransferLike[]): TransitLine[] {
  const out: TransitLine[] = [];
  for (const t of transfers) {
    if (!isWarehouseRoute(t.route) || t.status !== 'picked') continue;
    for (const l of t.lines) {
      const qty = roundQty(Number(l.qtyPicked) || 0);
      if (qty <= 0) continue;
      out.push({
        requestId: t.id,
        number: t.number,
        route: t.route,
        itemId: l.itemId,
        itemName: l.itemName,
        unit: l.unit,
        qty,
        deliveredBy: t.deliveredBy,
        dispatchedAt: t.pickedAt,
        dispatchExpiry: l.dispatchExpiry,
      });
    }
  }
  return out.sort((a, b) => (a.dispatchedAt ?? '').localeCompare(b.dispatchedAt ?? '') || a.number - b.number || a.itemName.localeCompare(b.itemName));
}

export interface UnmatchedLine {
  requestId: string;
  number: number;
  route: 'from_warehouse' | 'to_warehouse';
  itemId: string;
  itemName: string;
  unit: string;
  sent: number;
  arrived: number;
  /** sent − arrived: > 0 short, < 0 over. */
  difference: number;
  receivedAt: string | null;
  deliveredBy: string;
}

/** Lines that arrived different and are not settled yet. */
export function unmatchedLines(transfers: TransferLike[]): UnmatchedLine[] {
  const out: UnmatchedLine[] = [];
  for (const t of transfers) {
    if (!needsSettling(t) || !isWarehouseRoute(t.route)) continue;
    for (const l of t.lines) {
      const difference = lineDifference(l);
      if (difference === 0) continue;
      out.push({
        requestId: t.id,
        number: t.number,
        route: t.route,
        itemId: l.itemId,
        itemName: l.itemName,
        unit: l.unit,
        sent: roundQty(Number(l.qtyPicked) || 0),
        arrived: roundQty(Number(l.qtyReceived) || 0),
        difference,
        receivedAt: t.receivedAt,
        deliveredBy: t.deliveredBy,
      });
    }
  }
  return out.sort((a, b) => (a.receivedAt ?? '').localeCompare(b.receivedAt ?? '') || a.number - b.number);
}

/** Per stock item: how much is on the road to the store and to the warehouse. */
export function transitByItem(transfers: TransferLike[]): Map<string, { toStore: number; toWarehouse: number }> {
  const map = new Map<string, { toStore: number; toWarehouse: number }>();
  for (const l of transitLines(transfers)) {
    const t = map.get(l.itemId) ?? { toStore: 0, toWarehouse: 0 };
    if (l.route === 'from_warehouse') t.toStore = roundQty(t.toStore + l.qty);
    else t.toWarehouse = roundQty(t.toWarehouse + l.qty);
    map.set(l.itemId, t);
  }
  return map;
}

// ── Waiting on the owner ────────────────────────────────────────────────────

export interface OwnerWaiting {
  /** Requests from the store that nobody has been chosen to deliver. */
  toAssign: number;
  /** Delivery person chosen; the warehouse hasn't recorded what it sent. */
  toDispatch: number;
  /** Returns on the road to the warehouse, to count in. */
  toReceive: number;
  /** Arrived different, not settled. */
  toSettle: number;
  total: number;
}

/** What is waiting on the owner — the Warehouse badge in the owner header. */
export function ownerWaiting(transfers: Pick<TransferLike, 'route' | 'status' | 'hasDiscrepancy' | 'resolvedAt'>[]): OwnerWaiting {
  let toAssign = 0;
  let toDispatch = 0;
  let toReceive = 0;
  let toSettle = 0;
  for (const t of transfers) {
    if (t.route === 'from_warehouse' && t.status === 'requested') toAssign += 1;
    else if (t.route === 'from_warehouse' && t.status === 'assigned') toDispatch += 1;
    else if (t.route === 'to_warehouse' && t.status === 'picked') toReceive += 1;
    else if (needsSettling(t)) toSettle += 1;
  }
  return { toAssign, toDispatch, toReceive, toSettle, total: toAssign + toDispatch + toReceive + toSettle };
}

// ── The warehouse sheet ─────────────────────────────────────────────────────

/** "Low" in the warehouse means time to buy: at or below its own par level. */
export function warehouseLow(onHand: number, parLevel: number): boolean {
  const par = Number(parLevel) || 0;
  return par > 0 && roundQty(onHand) <= par;
}

/** The parts of a sheet row (lib/inventory/warehouseServer.ts WarehouseSheetRow) the CSV reads. */
export interface SheetRowLike {
  name: string;
  unit: string;
  category: string;
  isActive: boolean;
  warehouse: {
    onHand: number;
    parLevel: number;
    low: boolean;
    countNeeded: boolean;
    shortfall: number;
    expiredQty: number;
    soonQty: number;
    nextExpiry: string | null;
  };
  storeOnHand: number;
  inTransit: { toStore: number; toWarehouse: number };
  awaitingDispatch: number;
}

/** The stock sheet as a table, for the CSV download (lib/reports/csv.ts toCsv). */
export function warehouseSheetTable(rows: SheetRowLike[]): { columns: string[]; rows: (string | number)[][] } {
  const sorted = [...rows].sort((a, b) => (a.category || 'Other').localeCompare(b.category || 'Other') || a.name.localeCompare(b.name));
  return {
    columns: [
      'Category',
      'Item',
      'Unit',
      'Warehouse on hand',
      'Warehouse low at',
      'Status',
      'Expired',
      'Expiring soon',
      'Next expiry',
      'On the way to the store',
      'On the way to the warehouse',
      'Store on hand',
      'Asked for, not yet sent',
    ],
    rows: sorted.map((r) => {
      const status = [
        !r.isActive ? 'Retired' : '',
        r.warehouse.countNeeded ? `Count needed (${roundQty(r.warehouse.shortfall)} unrecorded)` : '',
        r.warehouse.low ? 'Low — buy' : '',
      ]
        .filter(Boolean)
        .join('; ');
      return [
        r.category || 'Other',
        r.name,
        r.unit,
        r.warehouse.onHand,
        r.warehouse.parLevel,
        status || 'OK',
        r.warehouse.expiredQty,
        r.warehouse.soonQty,
        r.warehouse.nextExpiry ?? '',
        r.inTransit.toStore,
        r.inTransit.toWarehouse,
        r.storeOnHand,
        roundQty(r.awaitingDispatch),
      ];
    }),
  };
}
