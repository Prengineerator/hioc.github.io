import { describe, expect, it } from 'vitest';
import {
  basePriceInr,
  formatPerKg,
  formatWeight,
  isValidWeightGrams,
  lineSizeLabel,
  lineSizeSuffix,
  parseWeightInput,
  repeatWeight,
  weightPriceInr,
} from '@/lib/menu/weight';
import { parseItems, resolveOrderLines, type IncomingOrderItem, type ResolvedLine } from '@/lib/orders/lines';
import { computeCartKey } from '@/lib/cart/cartKey';
import { quickAddLine } from '@/lib/cart/pairingAdd';
import { isSimpleItem } from '@/lib/pos/quickAdd';
import { needsCustomizeModal } from '@/components/suggest/addonHint';
import { orderUsage } from '@/lib/inventory/rules';
import { passLinesFor } from '@/lib/orders/passPricing';
import { mapLegacyBillItemsToCartLines, mapOrderItemsToCartLines } from '@/lib/pos/repeatOrder';
import type { CustomerOrderItemResponse, LegacyOrderItemResponse } from '@/lib/api/customerOrders';
import type { MenuItem } from '@/lib/types';

// Sell by weight (supabase/2026-10-sell-by-weight.sql): beans priced per kg and
// sold by the gram. The price a customer is shown and the price the server
// charges both come from lib/menu/weight.ts, so it is pinned here first, then
// every place that turns a weighed line into money, stock or a cart line.

const MENU_ID = '11111111-1111-4111-8111-111111111111';
const WHOLE_ID = '22222222-2222-4222-8222-222222222222';
const GROUND_ID = '33333333-3333-4333-8333-333333333333';
const GRIND_GROUP_ID = '44444444-4444-4444-8444-444444444444';
const FINE_ID = '55555555-5555-4555-8555-555555555555';
const LATTE_ID = '66666666-6666-4666-8666-666666666666';
const LATTE_VARIANT_ID = '77777777-7777-4777-8777-777777777777';

function beans(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: MENU_ID,
    name: 'House Blend',
    description: '',
    category: 'Coffee Beans',
    parent_category: '',
    is_veg: true,
    is_available: true,
    sort_order: 0,
    image_url: '',
    unavailable_until: null,
    short_code: null,
    sold_by_weight: true,
    created_at: '',
    updated_at: '',
    variants: [
      { id: WHOLE_ID, menu_item_id: MENU_ID, label: 'Whole beans', price_inr: 2400, sort_order: 0 },
      { id: GROUND_ID, menu_item_id: MENU_ID, label: 'Ground', price_inr: 2500, sort_order: 10 },
    ],
    addon_groups: [
      {
        id: GRIND_GROUP_ID,
        name: 'Grind',
        display_name: 'Grind',
        selection_type: 'single',
        min_select: 0,
        max_select: 1,
        sort_order: 0,
        options: [{ id: FINE_ID, addon_group_id: GRIND_GROUP_ID, name: 'Espresso fine', price_inr: 20, sort_order: 0 }],
      },
    ],
    ...overrides,
  };
}

function latte(): MenuItem {
  return {
    ...beans(),
    id: LATTE_ID,
    name: 'Latte',
    category: 'Coffee',
    sold_by_weight: undefined,
    variants: [{ id: LATTE_VARIANT_ID, menu_item_id: LATTE_ID, label: 'Regular', price_inr: 200, sort_order: 0 }],
    addon_groups: [],
  };
}

function line(overrides: Partial<IncomingOrderItem> = {}): IncomingOrderItem {
  return {
    menu_item_id: MENU_ID,
    variant_id: WHOLE_ID,
    quantity: 1,
    addon_option_ids: [],
    special_instructions: '',
    weight_grams: 250,
    ...overrides,
  };
}

describe('weight helpers', () => {
  it('prices a weight from the per-kg price, rounded to the rupee', () => {
    expect(weightPriceInr(2400, 250)).toBe(600);
    expect(weightPriceInr(2400, 100)).toBe(240);
    expect(weightPriceInr(2400, 1000)).toBe(2400);
    expect(weightPriceInr(2400, 333)).toBe(799); // 799.2
    expect(weightPriceInr(2004, 125)).toBe(251); // 250.5 rounds up
  });

  it('uses the variant price as-is for a line with no weight', () => {
    expect(basePriceInr(200, null)).toBe(200);
    expect(basePriceInr(200, undefined)).toBe(200);
    expect(basePriceInr(2400, 250)).toBe(600);
  });

  it('formats weights in grams, and whole kilos as kilos', () => {
    expect(formatWeight(250)).toBe('250 g');
    expect(formatWeight(1000)).toBe('1 kg');
    expect(formatWeight(2000)).toBe('2 kg');
    expect(formatWeight(1500)).toBe('1500 g');
    expect(formatPerKg(2400)).toBe('₹2400/kg');
  });

  it('accepts only whole grams within range', () => {
    expect(isValidWeightGrams(10)).toBe(true);
    expect(isValidWeightGrams(10_000)).toBe(true);
    expect(isValidWeightGrams(9)).toBe(false);
    expect(isValidWeightGrams(10_001)).toBe(false);
    expect(isValidWeightGrams(250.5)).toBe(false);
    expect(isValidWeightGrams('250')).toBe(false);
    expect(parseWeightInput(' 250 ')).toBe(250);
    expect(parseWeightInput('9')).toBeNull();
    expect(parseWeightInput('25.5')).toBeNull();
    expect(parseWeightInput('')).toBeNull();
    expect(parseWeightInput('abc')).toBeNull();
  });

  it('labels a weighed line by its weight, keeping a meaningful variant label', () => {
    expect(lineSizeLabel('Large')).toBe('Large');
    expect(lineSizeLabel('Regular', null)).toBe('Regular');
    expect(lineSizeLabel('Regular', 250)).toBe('250 g');
    expect(lineSizeLabel('', 1000)).toBe('1 kg');
    expect(lineSizeLabel('Ground', 250)).toBe('Ground · 250 g');
    expect(lineSizeSuffix('', null)).toBe('');
    expect(lineSizeSuffix('Large')).toBe(' (Large)');
    expect(lineSizeSuffix('Regular', 500)).toBe(' (500 g)');
  });
});

describe('parseItems weight_grams', () => {
  const base = { menu_item_id: MENU_ID, variant_id: WHOLE_ID, quantity: 1 };

  it('carries a valid weight and leaves it off when absent or null', () => {
    const parsed = parseItems([{ ...base, weight_grams: 250 }, base, { ...base, weight_grams: null }]);
    if (typeof parsed === 'string') throw new Error(parsed);
    expect(parsed[0].weight_grams).toBe(250);
    expect('weight_grams' in parsed[1]).toBe(false);
    expect('weight_grams' in parsed[2]).toBe(false);
  });

  it('refuses a weight that is not whole grams in range', () => {
    for (const weight_grams of [0, 5, 250.5, 20_000, '250']) {
      expect(parseItems([{ ...base, weight_grams }])).toMatch(/items\[0\]\.weight_grams/);
    }
  });
});

describe('resolveOrderLines for sold-by-weight items', () => {
  const menu = new Map([
    [MENU_ID, beans()],
    [LATTE_ID, latte()],
  ]);

  it('prices a weighed line from its grams at the variant per-kg price, add-ons per bag', () => {
    const result = resolveOrderLines(
      [
        line({ quantity: 2 }),
        line({ variant_id: GROUND_ID, weight_grams: 500, addon_option_ids: [FINE_ID] }),
      ],
      menu,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.lines[0]).toMatchObject({
      variant_label_snapshot: 'Whole beans',
      weight_grams: 250,
      price_inr_snapshot: 600,
      quantity: 2,
      line_total_inr: 1200,
    });
    // 500 g at ₹2500/kg = ₹1250, + ₹20 grind.
    expect(result.lines[1]).toMatchObject({ weight_grams: 500, price_inr_snapshot: 1270, line_total_inr: 1270 });
    expect(result.subtotalInr).toBe(2470);
    expect(result.taxableSubtotalInr).toBe(2470);
  });

  it('refuses a weighed item with no weight', () => {
    const result = resolveOrderLines([line({ weight_grams: undefined })], menu);
    expect(result).toEqual({ ok: false, error: '"House Blend" is sold by weight — choose how many grams' });
  });

  it('refuses a weight on an item sold by the unit (a cart from before the switch)', () => {
    const result = resolveOrderLines(
      [line({ menu_item_id: LATTE_ID, variant_id: LATTE_VARIANT_ID, weight_grams: 250 })],
      menu,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no longer sold by weight/);
  });

  it('leaves a by-the-unit line exactly as it was, with no weight_grams key', () => {
    const result = resolveOrderLines(
      [line({ menu_item_id: LATTE_ID, variant_id: LATTE_VARIANT_ID, weight_grams: undefined, quantity: 3 })],
      menu,
    );
    if (!result.ok) throw new Error(result.error);
    expect('weight_grams' in result.lines[0]).toBe(false);
    expect(result.lines[0]).toMatchObject({ price_inr_snapshot: 200, line_total_inr: 600 });
  });
});

describe('cart and one-tap rules', () => {
  it('keeps different weights of the same beans on separate cart lines', () => {
    const k250 = computeCartKey(MENU_ID, WHOLE_ID, [], '', 250);
    const k500 = computeCartKey(MENU_ID, WHOLE_ID, [], '', 500);
    expect(k250).not.toBe(k500);
    expect(computeCartKey(MENU_ID, WHOLE_ID, [], '', 250)).toBe(k250);
    // Unchanged for every by-the-unit line, so saved carts keep merging.
    expect(computeCartKey(MENU_ID, WHOLE_ID, [], '')).toBe(`${MENU_ID}::${WHOLE_ID}::::`);
    expect(computeCartKey(MENU_ID, WHOLE_ID, [], '', null)).toBe(`${MENU_ID}::${WHOLE_ID}::::`);
  });

  it('never one-taps a weighed item: the grams are always asked for', () => {
    const single = beans({ variants: [beans().variants[0]], addon_groups: [] });
    expect(quickAddLine(single, 'anchor')).toBeNull();
    expect(isSimpleItem(single)).toBe(false);
    expect(needsCustomizeModal(single, { flavourAddon: undefined })).toBe(true);
    // The same item sold by the unit still takes the one-tap paths.
    const unit = { ...single, sold_by_weight: false };
    expect(quickAddLine(unit, 'anchor')).not.toBeNull();
    expect(isSimpleItem(unit)).toBe(true);
    expect(needsCustomizeModal(unit, { flavourAddon: undefined })).toBe(false);
  });
});

describe('stock and pass rules', () => {
  it('takes a weighed line off stock as recipe-per-gram × grams × bags, add-ons per bag', () => {
    const usage = orderUsage(
      [
        { menu_item_id: MENU_ID, variant_label: 'Whole beans', quantity: 2, weight_grams: 250, addon_option_ids: [FINE_ID] },
        { menu_item_id: LATTE_ID, variant_label: 'Regular', quantity: 1 },
      ],
      [
        { menu_item_id: MENU_ID, size_label: '', item_id: 'beans-stock', qty: 1 },
        { menu_item_id: LATTE_ID, size_label: '', item_id: 'beans-stock', qty: 18 },
      ],
      [{ addon_option_id: FINE_ID, item_id: 'valve-bag', qty: 1 }],
    );
    expect(usage.get('beans-stock')).toBe(518); // 2 × 250 g + one 18 g latte shot
    expect(usage.get('valve-bag')).toBe(2);
  });

  it('never lets a pass cup pay for a weighed line', () => {
    const resolved = resolveOrderLines([line()], new Map([[MENU_ID, beans()]]));
    if (!resolved.ok) throw new Error(resolved.error);
    const [passLine] = passLinesFor(resolved.lines as ResolvedLine[], ['k'], new Set([MENU_ID]));
    expect(passLine.eligible).toBe(false);
  });
});

describe('repeating a past order', () => {
  function pastLine(overrides: Partial<CustomerOrderItemResponse> = {}): CustomerOrderItemResponse {
    return {
      id: 'item-1',
      menu_item_id: MENU_ID,
      variant_id: WHOLE_ID,
      name_snapshot: 'House Blend',
      variant_label_snapshot: 'Whole beans',
      price_inr_snapshot: 550,
      quantity: 2,
      line_total_inr: 1100,
      special_instructions: '',
      weight_grams: 250,
      voided: false,
      void_reason: '',
      voided_by: null,
      voided_at: null,
      addons: [],
      ...overrides,
    };
  }

  it('keeps the bag size, at today’s per-kg price', () => {
    const { lines, skipped } = mapOrderItemsToCartLines([pastLine()], [beans()]);
    expect(skipped).toEqual([]);
    expect(lines[0]).toMatchObject({ weightGrams: 250, unitPriceInr: 600, qty: 2 });
  });

  it('skips a line whose item changed how it is sold, either way', () => {
    expect(mapOrderItemsToCartLines([pastLine({ weight_grams: null })], [beans()]).skipped).toEqual([
      { name: 'House Blend', reason: 'Now sold by weight — add it from the menu' },
    ]);
    expect(
      mapOrderItemsToCartLines([pastLine()], [beans({ sold_by_weight: false })]).skipped[0]?.reason,
    ).toBe('No longer sold by weight — add it from the menu');
    expect(repeatWeight({ sold_by_weight: false }, null)).toEqual({ ok: true, weightGrams: null });
  });

  it('skips a weighed item on a Petpooja bill, which never recorded grams', () => {
    const legacy: LegacyOrderItemResponse = {
      name_snapshot: 'House Blend',
      variant_label_snapshot: 'Whole beans',
      menu_item_id: MENU_ID,
      variant_id: WHOLE_ID,
      quantity: null,
    };
    const { lines, skipped } = mapLegacyBillItemsToCartLines([legacy], [beans()]);
    expect(lines).toEqual([]);
    expect(skipped[0]?.reason).toBe('Sold by weight — add it from the menu');
  });
});
