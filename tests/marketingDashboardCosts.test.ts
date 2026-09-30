import { describe, expect, it } from 'vitest';
import {
  HIGH_FOOD_COST_PCT,
  boxValue,
  chunkCosts,
  coverageLevel,
  diffCosts,
  foodCostPct,
  isHighFoodCost,
  isRowDirty,
  liveCost,
  marginInr,
  missingCostRows,
  parseCostInput,
  sortCostRows,
  topFreeItems,
  variantDisplay,
} from '@/components/owner/marketing/costsForm';
import { parseCostsPut } from '@/lib/marketing/parse';
import { COSTS_PUT_MAX_ROWS, type CostRow, type FreeItemCandidate } from '@/lib/marketing/types';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const row = (n: number, over: Partial<CostRow> = {}): CostRow => ({
  variant_id: uuid(n),
  item_id: uuid(1000 + n),
  category: 'Coffee',
  item_name: `Item ${n}`,
  variant_label: 'Regular',
  price_inr: 200,
  cost_inr: null,
  food_cost_pct: null,
  margin_inr: null,
  is_available: true,
  revenue_90d_inr: 0,
  ...over,
});

describe('food cost and margin', () => {
  it('computes food-cost % of the price and what you keep', () => {
    expect(foodCostPct(180, 45)).toBe(25);
    expect(foodCostPct(0, 10)).toBeNull();
    expect(foodCostPct(100, null)).toBeNull();
    expect(marginInr(180, 45)).toBe(135);
    expect(marginInr(180, null)).toBeNull();
  });

  it('highlights only above 50% (spec §7.6)', () => {
    expect(HIGH_FOOD_COST_PCT).toBe(50);
    expect(isHighFoodCost(50)).toBe(false);
    expect(isHighFoodCost(50.1)).toBe(true);
    expect(isHighFoodCost(null)).toBe(false);
  });
});

describe('one cost box', () => {
  it('reads blank as "no cost" and numbers as rupees', () => {
    expect(parseCostInput('')).toEqual({ ok: true, value: null });
    expect(parseCostInput('   ')).toEqual({ ok: true, value: null });
    expect(parseCostInput('45')).toEqual({ ok: true, value: 45 });
    expect(parseCostInput('12.5')).toEqual({ ok: true, value: 12.5 });
    expect(parseCostInput('₹1,200')).toEqual({ ok: true, value: 1200 });
    expect(parseCostInput('0')).toEqual({ ok: true, value: 0 });
    expect(parseCostInput('12.999')).toEqual({ ok: true, value: 13 });
    expect(parseCostInput('100000')).toEqual({ ok: true, value: 100000 });
  });

  it('rejects what is not a plain amount, with a sentence the owner can act on', () => {
    for (const bad of ['abc', '1e3', '0x10', '12.5.3', '--5']) {
      const r = parseCostInput(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('Enter a number');
    }
    const negative = parseCostInput('-5');
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.error).toContain('between');
    expect(parseCostInput('100001').ok).toBe(false);
  });
});

describe('dirty tracking', () => {
  it('shows the saved cost until the row is edited, then what was typed', () => {
    const r = row(1, { cost_inr: 45 });
    expect(boxValue(r, {})).toBe('45');
    expect(boxValue(row(2), {})).toBe('');
    expect(boxValue(r, { [r.variant_id]: '4' })).toBe('4');
    expect(boxValue(r, { [r.variant_id]: '' })).toBe('');
  });

  it('uses the live cost for the food-cost column, and none for text that is not a cost yet', () => {
    const r = row(1, { cost_inr: 45 });
    expect(liveCost(r, {})).toBe(45);
    expect(liveCost(r, { [r.variant_id]: '50' })).toBe(50);
    expect(liveCost(r, { [r.variant_id]: '' })).toBeNull();
    expect(liveCost(r, { [r.variant_id]: 'x' })).toBeNull();
  });

  it('marks a row edited only when the value really differs from what is saved', () => {
    const r = row(1, { cost_inr: 45 });
    expect(isRowDirty(r, {})).toBe(false);
    expect(isRowDirty(r, { [r.variant_id]: '45' })).toBe(false);
    expect(isRowDirty(r, { [r.variant_id]: '45.00' })).toBe(false);
    expect(isRowDirty(r, { [r.variant_id]: '46' })).toBe(true);
    expect(isRowDirty(r, { [r.variant_id]: '' })).toBe(true); // clearing a saved cost is a change
    expect(isRowDirty(row(2), { [uuid(2)]: '' })).toBe(false); // blank over nothing is not
    expect(isRowDirty(r, { [r.variant_id]: 'oops' })).toBe(true);
  });

  it('sends only the rows that changed, and blanks delete', () => {
    const a = row(1); // no cost saved
    const b = row(2, { cost_inr: 45 });
    const c = row(3, { cost_inr: 30 });
    const d = row(4, { cost_inr: 10 }); // never touched
    const { changes, invalid } = diffCosts([a, b, c, d], {
      [a.variant_id]: '12',
      [b.variant_id]: '45.00', // same as saved → skipped
      [c.variant_id]: '', // clears the saved cost → delete
    });
    expect(invalid).toEqual({});
    expect(changes).toEqual([
      { variant_id: a.variant_id, cost_inr: 12 },
      { variant_id: c.variant_id, cost_inr: null },
    ]);
  });

  it('reports bad boxes by variant and leaves them out of the changes', () => {
    const a = row(1);
    const b = row(2);
    const { changes, invalid } = diffCosts([a, b], { [a.variant_id]: 'abc', [b.variant_id]: '20' });
    expect(Object.keys(invalid)).toEqual([a.variant_id]);
    expect(changes).toEqual([{ variant_id: b.variant_id, cost_inr: 20 }]);
  });

  it('ignores drafts for variants that are no longer in the list', () => {
    expect(diffCosts([row(1)], { [uuid(99)]: '5' })).toEqual({ changes: [], invalid: {} });
  });

  it('produces a body the shared PUT parser accepts', () => {
    const a = row(1);
    const { changes } = diffCosts([a], { [a.variant_id]: '12.5' });
    expect(parseCostsPut({ costs: changes }).ok).toBe(true);
  });
});

describe('saving a big menu', () => {
  it('splits into requests of at most 500 rows', () => {
    const costs = Array.from({ length: 1101 }, (_, i) => ({ variant_id: uuid(i + 1), cost_inr: 1 }));
    const chunks = chunkCosts(costs);
    expect(COSTS_PUT_MAX_ROWS).toBe(500);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 101]);
    expect(chunks.flat()).toEqual(costs);
    expect(chunkCosts([])).toEqual([]);
  });
});

describe('table order and helpers', () => {
  it('groups by category in the server order, then item A→Z, then cheapest size', () => {
    const rows = [
      row(1, { category: 'Coffee', item_name: 'Latte', price_inr: 200 }),
      row(2, { category: 'Waffles', item_name: 'Almond Honey', price_inr: 150 }),
      row(3, { category: 'Coffee', item_name: 'Americano', price_inr: 120 }),
      row(4, { category: 'Coffee', item_name: 'Latte', price_inr: 160, variant_label: 'Small' }),
    ];
    expect(sortCostRows(rows).map((r) => r.variant_id)).toEqual([uuid(3), uuid(4), uuid(1), uuid(2)]);
    // does not mutate its input
    expect(rows[0].variant_id).toBe(uuid(1));
  });

  it('lists missing costs biggest sellers first', () => {
    const rows = [
      row(1, { revenue_90d_inr: 100 }),
      row(2, { cost_inr: 20, revenue_90d_inr: 9999 }),
      row(3, { revenue_90d_inr: 5000 }),
    ];
    expect(missingCostRows(rows).map((r) => r.variant_id)).toEqual([uuid(3), uuid(1)]);
  });

  it('judges coverage against the 50% guardrail line', () => {
    expect(coverageLevel(0)).toBe('none');
    expect(coverageLevel(30)).toBe('low');
    expect(coverageLevel(49.9)).toBe('low');
    expect(coverageLevel(50)).toBe('good');
    expect(coverageLevel(100)).toBe('good');
  });

  it('shows the top 5 free-item offers only', () => {
    const ranking = Array.from({ length: 8 }, (_, i) => ({ variant_id: uuid(i) }) as FreeItemCandidate);
    expect(topFreeItems(ranking)).toHaveLength(5);
    expect(topFreeItems(ranking, 2)).toHaveLength(2);
  });

  it('names the default size', () => {
    expect(variantDisplay('')).toBe('Regular');
    expect(variantDisplay('Large')).toBe('Large');
  });
});
