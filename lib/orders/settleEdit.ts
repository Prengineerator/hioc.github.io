// Editing an unpaid order on the Settle screen, before it is settled.
//
// The customer at the counter says "we only had one latte, not two" or "take
// the brownie off". With the owner's say-so (permission `settle_edit_order`,
// seeded at manager by supabase/2026-10-settle-edit-order.sql; the owner can
// open it to staff on Team → Permissions), the cashier lowers a quantity or
// removes a line right there instead of hunting the order down on Orders.
//
// Edits only ever LOWER the bill. Anything more goes through "Add items" (the
// running-tab add, TAB-1), which prints the kitchen a ticket for exactly what
// was added — raising a quantity in place would leave the kitchen with no
// ticket for the extra cup.
//
// Pure (no server-only, no DB): the amend route validates with it and the
// Settle sheet uses the same rules to decide what to offer.

import { isUuid } from '@/lib/api/constants';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import type { OrderStatus } from '@/lib/types';

/**
 * The states in which an unpaid order can still be edited — the amend route's
 * OPEN_STATUSES. A 'received' order hasn't been accepted yet; a 'completed'
 * one has had its stock drawn (lib/inventory/server.ts), so changing what it
 * contains would leave the stock wrong.
 */
export const SETTLE_EDIT_STATUSES: OrderStatus[] = ['accepted', 'preparing', 'ready'];

/** Why the bill is being lowered — the void reasons (POS-4). 'Other' → free text. */
export const EDIT_REASONS = ['Wrong item', 'Customer changed mind', 'Kitchen error', 'Other'] as const;

/** Most lines one edit may touch — far above any real bill, a bound on the request. */
export const MAX_EDIT_CHANGES = 50;

/** Longest reason an edit may carry — it is stored on every audit row and on each removed line. */
export const MAX_EDIT_REASON_LENGTH = 200;

/** One requested change: the line's new quantity, 0 = remove the line. */
export interface SettleEditChange {
  item_id: string;
  quantity: number;
}

/** What the rules need from an order. */
export interface SettleEditOrder {
  status: OrderStatus;
  payment_status: string;
  /** 'coffee_pass' for a HIOC Ritual sale; absent = a menu order. */
  order_kind?: string | null;
}

/** What the rules need from one of its lines. */
export interface SettleEditLine {
  id: string;
  voided: boolean;
  quantity: number;
  /** The price of ONE unit, add-ons (and a sold-by-weight line's weight) included. */
  price_inr_snapshot: number;
  line_total_inr: number;
  /** Units of the line a HIOC Ritual cup paid for; absent = 0. */
  pass_drinks?: number;
}

/** A validated change, ready to write. */
export interface PlannedEdit {
  item_id: string;
  from_quantity: number;
  to_quantity: number;
  from_line_total_inr: number;
  /** For a removed line, unchanged: a voided line keeps its snapshot and leaves the totals. */
  to_line_total_inr: number;
  remove: boolean;
}

export type SettleEditPlan =
  | { ok: true; changes: PlannedEdit[] }
  | { ok: false; status: 400 | 404 | 409; error: string };

/**
 * Why this order can't be edited right now, or null when it can. The order's
 * state only — whether this person may edit is the permission's business.
 */
export function settleEditBlockReason(order: SettleEditOrder): string | null {
  if (order.order_kind === 'coffee_pass') return `A ${PASS_PROGRAM_NAME} sale can't be changed — cancel it instead.`;
  if (order.payment_status === 'paid') return 'This bill is already paid.';
  if (SETTLE_EDIT_STATUSES.includes(order.status)) return null;
  if (order.status === 'received') return 'Accept this order on Orders before changing it.';
  if (order.status === 'completed') return 'A completed order can’t be changed — its stock has already been used.';
  return 'This order can no longer be changed.';
}

/** Whether one line may be reduced in place (not only removed). */
export function canReduceLine(line: Pick<SettleEditLine, 'voided' | 'quantity' | 'pass_drinks'>): boolean {
  // A cup paid for part of the line: which units were the cup's is not
  // recorded, so the line is removed whole (its cups go back) or left alone.
  return !line.voided && line.quantity > 1 && (line.pass_drinks ?? 0) === 0;
}

/**
 * Validates a requested edit against the order's lines and works out what to
 * write. Quantities only go down (0 removes the line); unchanged lines are
 * dropped; the order must keep at least one line.
 */
export function planSettleEdit(lines: SettleEditLine[], rawChanges: unknown): SettleEditPlan {
  if (!Array.isArray(rawChanges) || rawChanges.length === 0) {
    return { ok: false, status: 400, error: 'changes must be a non-empty array' };
  }
  if (rawChanges.length > MAX_EDIT_CHANGES) {
    return { ok: false, status: 400, error: `At most ${MAX_EDIT_CHANGES} changes at a time` };
  }

  const seen = new Set<string>();
  const changes: PlannedEdit[] = [];
  for (const [i, raw] of rawChanges.entries()) {
    const change = raw as Partial<SettleEditChange> | null;
    if (!change || typeof change !== 'object' || !isUuid(change.item_id)) {
      return { ok: false, status: 400, error: `changes[${i}].item_id must be a valid uuid` };
    }
    const quantity = change.quantity;
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 0) {
      return { ok: false, status: 400, error: `changes[${i}].quantity must be a whole number, 0 or more` };
    }
    if (seen.has(change.item_id)) {
      return { ok: false, status: 400, error: 'Each line may appear only once' };
    }
    seen.add(change.item_id);

    const line = lines.find((l) => l.id === change.item_id);
    if (!line) return { ok: false, status: 404, error: 'That item is not a line on this order' };
    if (line.voided) return { ok: false, status: 409, error: 'That line has already been removed.' };
    if (quantity === line.quantity) continue;
    if (quantity > line.quantity) {
      return { ok: false, status: 409, error: 'To add more, use Add items — the kitchen gets a ticket for them.' };
    }
    if (quantity > 0 && !canReduceLine(line)) {
      return {
        ok: false,
        status: 409,
        error: `A line paid with a ${PASS_PROGRAM_NAME} cup can only be removed whole.`,
      };
    }

    const remove = quantity === 0;
    changes.push({
      item_id: line.id,
      from_quantity: line.quantity,
      to_quantity: quantity,
      from_line_total_inr: line.line_total_inr,
      to_line_total_inr: remove ? line.line_total_inr : line.price_inr_snapshot * quantity,
      remove,
    });
  }

  if (changes.length === 0) return { ok: false, status: 400, error: 'Nothing to change.' };

  const removed = new Set(changes.filter((c) => c.remove).map((c) => c.item_id));
  if (!lines.some((l) => !l.voided && !removed.has(l.id))) {
    return { ok: false, status: 409, error: 'That would empty the order — cancel the order instead.' };
  }

  return { ok: true, changes };
}

/** What an edit takes off the bill before tax and packaging (for the sheet's preview). */
export function editReductionInr(changes: PlannedEdit[]): number {
  return changes.reduce(
    (sum, c) => sum + (c.remove ? c.from_line_total_inr : c.from_line_total_inr - c.to_line_total_inr),
    0,
  );
}
