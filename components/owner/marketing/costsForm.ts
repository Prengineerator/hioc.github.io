// Product-cost table logic (spec §7.6): what the owner typed vs what is saved,
// which rows changed, and the numbers shown beside each box.
//
// The table is edited in place and saved in bulk, so "what changed" has to be
// exact: sending every row on every save would rewrite hundreds of costs (and
// their updated_at) to save one, and sending a blank would delete a cost the
// owner never touched. `diffCosts` therefore compares only the rows the owner
// actually edited, against the saved value.
//
// Pure: unit-tested in tests/marketingDashboardCosts.test.ts.

import {
  COSTS_PUT_MAX_ROWS,
  COST_BOUNDS,
  MIN_COST_COVERAGE_PCT,
  type CostInput,
  type CostRow,
  type FreeItemCandidate,
} from '@/lib/marketing/types';
import { typedNumber } from './drafts';

/** Above this share of the price, an item's cost is worth a second look (spec §7.6). */
export const HIGH_FOOD_COST_PCT = 50;
/** The best free-item offers shown under the table. */
export const FREE_ITEM_TOP_N = 5;

/** What the owner has typed, by variant. A variant with no entry has not been touched. */
export type CostDrafts = Record<string, string>;

/** 100 × cost ÷ price; null when there is no cost or the price is 0. */
export function foodCostPct(price: number, cost: number | null): number | null {
  if (cost === null || !Number.isFinite(cost) || !(price > 0)) return null;
  return (cost / price) * 100;
}

export function isHighFoodCost(pct: number | null): boolean {
  return pct !== null && pct > HIGH_FOOD_COST_PCT;
}

/** price − cost; null when there is no cost. */
export function marginInr(price: number, cost: number | null): number | null {
  return cost === null || !Number.isFinite(cost) ? null : price - cost;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * One cost box. '' clears the cost (null), a number is ₹ 0–100000 to 2 decimals.
 * The error sentence is what shows under the box.
 */
export function parseCostInput(raw: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = raw.replace(/[₹,\s]/g, '');
  if (t === '') return { ok: true, value: null };
  // A strict pattern first: Number() would accept '0x10' and '1e3' as costs.
  if (!/^-?(\d+\.?\d*|\.\d+)$/.test(t)) return { ok: false, error: 'Enter a number, like 45 or 12.50.' };
  const n = typedNumber(t);
  if (!Number.isFinite(n)) return { ok: false, error: 'Enter a number, like 45 or 12.50.' };
  if (n < COST_BOUNDS.min || n > COST_BOUNDS.max) {
    return { ok: false, error: `Cost must be between ₹${COST_BOUNDS.min} and ₹${COST_BOUNDS.max.toLocaleString('en-IN')}.` };
  }
  return { ok: true, value: round2(n) };
}

/** What the box shows: the typed text if the row was edited, else the saved cost. */
export function boxValue(row: CostRow, drafts: CostDrafts): string {
  if (Object.prototype.hasOwnProperty.call(drafts, row.variant_id)) return drafts[row.variant_id];
  return row.cost_inr === null ? '' : String(row.cost_inr);
}

/** The cost as it would be if saved now: the parsed draft, else the saved value. Invalid text counts as "no live cost". */
export function liveCost(row: CostRow, drafts: CostDrafts): number | null {
  if (!Object.prototype.hasOwnProperty.call(drafts, row.variant_id)) return row.cost_inr;
  const p = parseCostInput(drafts[row.variant_id]);
  return p.ok ? p.value : null;
}

const sameCost = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.005);

export interface CostsDiff {
  /** Only rows whose value really changed. Ready for PUT (chunk with chunkCosts). */
  changes: CostInput[];
  /** variant_id → the sentence for a box that can't be saved. */
  invalid: Record<string, string>;
}

export function diffCosts(rows: readonly CostRow[], drafts: CostDrafts): CostsDiff {
  const changes: CostInput[] = [];
  const invalid: Record<string, string> = {};
  for (const row of rows) {
    if (!Object.prototype.hasOwnProperty.call(drafts, row.variant_id)) continue;
    const p = parseCostInput(drafts[row.variant_id]);
    if (!p.ok) {
      invalid[row.variant_id] = p.error;
      continue;
    }
    if (sameCost(p.value, row.cost_inr)) continue;
    changes.push({ variant_id: row.variant_id, cost_inr: p.value });
  }
  return { changes, invalid };
}

/** True for a row whose box differs from the saved cost (used for the "edited" marker). */
export function isRowDirty(row: CostRow, drafts: CostDrafts): boolean {
  if (!Object.prototype.hasOwnProperty.call(drafts, row.variant_id)) return false;
  const p = parseCostInput(drafts[row.variant_id]);
  return !p.ok || !sameCost(p.value, row.cost_inr);
}

/** PUT accepts at most 500 rows; a big menu saves in several requests. */
export function chunkCosts(costs: readonly CostInput[], size: number = COSTS_PUT_MAX_ROWS): CostInput[][] {
  const out: CostInput[][] = [];
  for (let i = 0; i < costs.length; i += size) out.push(costs.slice(i, i + size));
  return out;
}

/**
 * Rows grouped by category, categories in the order the server listed them (that
 * is the menu's own order), items A→Z then cheapest size first within each.
 * DataTable draws a header row whenever the category changes, which needs the
 * rows to already be contiguous.
 */
export function sortCostRows(rows: readonly CostRow[]): CostRow[] {
  const order = new Map<string, number>();
  for (const r of rows) if (!order.has(r.category)) order.set(r.category, order.size);
  return [...rows].sort(
    (a, b) =>
      (order.get(a.category) ?? 0) - (order.get(b.category) ?? 0) ||
      a.item_name.localeCompare(b.item_name) ||
      a.price_inr - b.price_inr ||
      a.variant_label.localeCompare(b.variant_label),
  );
}

/** Rows still missing a cost, biggest sellers first — where entering a cost improves the forecasts most. */
export function missingCostRows(rows: readonly CostRow[]): CostRow[] {
  return rows.filter((r) => r.cost_inr === null).sort((a, b) => b.revenue_90d_inr - a.revenue_90d_inr);
}

export type CoverageLevel = 'good' | 'low' | 'none';

/** Below 50% the agent flags campaigns "product costs missing" (MIN_COST_COVERAGE_PCT). */
export function coverageLevel(pct: number): CoverageLevel {
  if (!(pct > 0)) return 'none';
  return pct < MIN_COST_COVERAGE_PCT ? 'low' : 'good';
}

export function topFreeItems(ranking: readonly FreeItemCandidate[], n: number = FREE_ITEM_TOP_N): FreeItemCandidate[] {
  return ranking.slice(0, n);
}

/** The variant as the owner reads it: "Regular" is the default size and needs no label of its own. */
export function variantDisplay(label: string): string {
  return label && label.trim() ? label : 'Regular';
}
