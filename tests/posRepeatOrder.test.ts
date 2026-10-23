import { describe, expect, it } from 'vitest';

// POS-5 — the pure repeat-order → cart-lines mapper behind the "Last orders"
// modal's Repeat button (lib/pos/repeatOrder.ts). No mocks: it resolves a
// past order's items against an in-memory MenuItem[], exactly like the
// component does against the already-loaded menu grid.

import { mapLegacyBillItemsToCartLines, mapOrderItemsToCartLines } from '@/lib/pos/repeatOrder';
import type { CustomerOrderItemResponse, LegacyOrderItemResponse } from '@/lib/api/customerOrders';
import type { MenuItem } from '@/lib/types';

function menuItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: 'menu-1',
    name: 'Latte',
    description: '',
    category: 'beverages',
    parent_category: 'beverages',
    is_veg: true,
    is_available: true,
    sort_order: 0,
    image_url: '',
    unavailable_until: null,
    short_code: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    variants: [{ id: 'variant-1', menu_item_id: 'menu-1', label: 'Regular', price_inr: 100, sort_order: 0 }],
    addon_groups: [
      {
        id: 'group-1',
        name: 'milk',
        display_name: 'Milk',
        selection_type: 'single',
        min_select: 0,
        max_select: 1,
        sort_order: 0,
        options: [{ id: 'opt-1', addon_group_id: 'group-1', name: 'Oat', price_inr: 20, sort_order: 0 }],
      },
    ],
    ...overrides,
  };
}

function orderItem(overrides: Partial<CustomerOrderItemResponse> = {}): CustomerOrderItemResponse {
  return {
    id: 'item-1',
    menu_item_id: 'menu-1',
    variant_id: 'variant-1',
    name_snapshot: 'Latte',
    variant_label_snapshot: 'Regular',
    price_inr_snapshot: 120,
    quantity: 2,
    line_total_inr: 240,
    special_instructions: 'extra hot',
    voided: false,
    void_reason: '',
    voided_by: null,
    voided_at: null,
    addons: [
      {
        id: 'addon-1',
        order_item_id: 'item-1',
        addon_option_id: 'opt-1',
        group_name_snapshot: 'Milk',
        option_name_snapshot: 'Oat',
        price_inr_snapshot: 20,
      },
    ],
    ...overrides,
  };
}

describe('mapOrderItemsToCartLines — the happy path', () => {
  it('rebuilds a cart line at CURRENT prices, not the order\'s old snapshot', () => {
    const result = mapOrderItemsToCartLines([orderItem()], [menuItem()]);
    expect(result.skipped).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.lines).toEqual([
      {
        menuItemId: 'menu-1',
        variantId: 'variant-1',
        name: 'Latte',
        variantLabel: 'Regular',
        unitPriceInr: 120, // 100 (current variant price) + 20 (current addon price)
        addons: [{ optionId: 'opt-1', groupName: 'Milk', optionName: 'Oat', priceInr: 20 }],
        specialInstructions: 'extra hot',
        qty: 2,
      },
    ]);
  });

  it('picks up a CURRENT price even when it has changed since the order', () => {
    const menu = [menuItem({ variants: [{ id: 'variant-1', menu_item_id: 'menu-1', label: 'Regular', price_inr: 150, sort_order: 0 }] })];
    const result = mapOrderItemsToCartLines([orderItem()], menu);
    expect(result.lines[0].unitPriceInr).toBe(170); // 150 + 20, not the order's old 120
  });
});

describe('mapOrderItemsToCartLines — skipped whole lines', () => {
  it('skips a voided item silently (it was struck off the original order)', () => {
    const result = mapOrderItemsToCartLines([orderItem({ voided: true })], [menuItem()]);
    expect(result.lines).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it('skips an item no longer on the menu', () => {
    const result = mapOrderItemsToCartLines([orderItem({ menu_item_id: null })], [menuItem()]);
    expect(result.lines).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'Latte', reason: 'No longer on the menu' }]);
  });

  it('skips an item that is currently unavailable (86\'d)', () => {
    const menu = [menuItem({ is_available: false })];
    const result = mapOrderItemsToCartLines([orderItem()], menu);
    expect(result.skipped).toEqual([{ name: 'Latte', reason: 'Currently unavailable' }]);
  });

  it('skips an item snoozed until a future time', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const menu = [menuItem({ unavailable_until: future })];
    const result = mapOrderItemsToCartLines([orderItem()], menu);
    expect(result.skipped).toEqual([{ name: 'Latte', reason: 'Currently unavailable' }]);
  });

  it('skips a variant that is no longer offered', () => {
    const result = mapOrderItemsToCartLines([orderItem({ variant_id: 'gone' })], [menuItem()]);
    expect(result.skipped).toEqual([{ name: 'Latte', reason: 'This option is no longer offered' }]);
  });
});

describe('mapOrderItemsToCartLines — modified lines (addon dropped, item kept)', () => {
  it('keeps the line and drops just the missing addon, with a notice', () => {
    const menu = [menuItem({ addon_groups: [] })]; // the addon group is gone entirely
    const result = mapOrderItemsToCartLines([orderItem()], menu);
    expect(result.skipped).toEqual([]);
    expect(result.modified).toEqual([
      { name: 'Latte', reason: 'One or more add-ons are no longer available and were dropped' },
    ]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].addons).toEqual([]);
    expect(result.lines[0].unitPriceInr).toBe(100); // just the variant, no addon
  });
});

describe('mapOrderItemsToCartLines — mixed order', () => {
  it('processes several items independently: one kept, one skipped', () => {
    const menu = [menuItem()];
    const items = [
      orderItem({ id: 'a', menu_item_id: 'menu-1' }),
      orderItem({ id: 'b', menu_item_id: 'gone', name_snapshot: 'Discontinued Cake' }),
    ];
    const result = mapOrderItemsToCartLines(items, menu);
    expect(result.lines).toHaveLength(1);
    // A menu_item_id that no longer resolves against the current menu at all
    // (deleted item) reads the same as an 86'd one — both mean "can't add
    // this right now", which is the only distinction Repeat needs to make.
    expect(result.skipped).toEqual([{ name: 'Discontinued Cake', reason: 'Currently unavailable' }]);
  });

  it('returns empty lines/skipped/modified for an empty order', () => {
    expect(mapOrderItemsToCartLines([], [menuItem()])).toEqual({ lines: [], skipped: [], modified: [], needsChoice: [] });
  });
});

// A required add-on group linked after the order was placed (e.g. "Ice Level"
// on every iced drink): the old line can't answer it, and the quote refuses a
// line that doesn't — so it goes to the add-ons popup instead of the cart.
const iceLevel = {
  id: 'group-ice',
  name: 'ice',
  display_name: 'Ice Level',
  selection_type: 'single' as const,
  min_select: 1,
  max_select: 1,
  sort_order: 1,
  options: [{ id: 'opt-normal-ice', addon_group_id: 'group-ice', name: 'Normal Ice', price_inr: 0, sort_order: 0 }],
};

describe('mapOrderItemsToCartLines — a required choice the old order never made', () => {
  it('sends the line to the popup, seeded with its old size, add-ons, note and qty', () => {
    const latte = menuItem();
    const item = { ...latte, addon_groups: [...latte.addon_groups, iceLevel] };
    const result = mapOrderItemsToCartLines([orderItem()], [item]);
    expect(result.lines).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.needsChoice).toEqual([
      {
        item,
        variantId: 'variant-1',
        qty: 2,
        selection: { 'group-1': ['opt-1'] },
        specialInstructions: 'extra hot',
        weightGrams: null,
      },
    ]);
  });

  it('still adds the line straight away when the old order answered every required group', () => {
    const latte = menuItem();
    const item = { ...latte, addon_groups: [...latte.addon_groups, iceLevel] };
    const answered = orderItem({
      addons: [
        ...orderItem().addons,
        {
          id: 'addon-2',
          order_item_id: 'item-1',
          addon_option_id: 'opt-normal-ice',
          group_name_snapshot: 'Ice Level',
          option_name_snapshot: 'Normal Ice',
          price_inr_snapshot: 0,
        },
      ],
    });
    const result = mapOrderItemsToCartLines([answered], [item]);
    expect(result.needsChoice).toEqual([]);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].addons.map((a) => a.optionName)).toEqual(['Oat', 'Normal Ice']);
  });
});

// Petpooja history — the sibling mapper for a legacy bill's items
// (lib/legacy/history.ts's `source: 'petpooja'` entries). Same
// current-menu resolution as above, minus quantity/add-ons/price snapshots,
// which the Petpooja export never had. Invented data only (SPEC.md PII rule).

function legacyItem(overrides: Partial<LegacyOrderItemResponse> = {}): LegacyOrderItemResponse {
  return {
    name_snapshot: 'Latte',
    variant_label_snapshot: 'Regular',
    menu_item_id: 'menu-1',
    variant_id: 'variant-1',
    quantity: null,
    ...overrides,
  };
}

describe('mapLegacyBillItemsToCartLines', () => {
  it('adds a matched item (menu_item_id + variant_id both present) at qty 1, current price', () => {
    const result = mapLegacyBillItemsToCartLines([legacyItem()], [menuItem()]);
    expect(result.skipped).toEqual([]);
    expect(result.modified).toEqual([]);
    expect(result.lines).toEqual([
      {
        menuItemId: 'menu-1',
        variantId: 'variant-1',
        name: 'Latte',
        variantLabel: 'Regular',
        unitPriceInr: 100, // the variant's CURRENT price — no old snapshot to trust
        gstExempt: false,
        addons: [],
        specialInstructions: '',
        qty: 1,
      },
    ]);
  });

  it('skips an item never matched to a menu item at all (no menu_item_id)', () => {
    const result = mapLegacyBillItemsToCartLines([legacyItem({ menu_item_id: null })], [menuItem()]);
    expect(result.lines).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'Latte', reason: 'Not matched to a menu item' }]);
  });

  it('skips an item that is currently unavailable (86\'d)', () => {
    const menu = [menuItem({ is_available: false })];
    const result = mapLegacyBillItemsToCartLines([legacyItem()], menu);
    expect(result.skipped).toEqual([{ name: 'Latte', reason: 'Currently unavailable' }]);
  });

  it('skips an item that no longer exists on the current menu', () => {
    const result = mapLegacyBillItemsToCartLines([legacyItem({ menu_item_id: 'gone' })], [menuItem()]);
    expect(result.skipped).toEqual([{ name: 'Latte', reason: 'Currently unavailable' }]);
  });

  it('skips a recorded variant_id that is no longer offered', () => {
    const result = mapLegacyBillItemsToCartLines([legacyItem({ variant_id: 'gone' })], [menuItem()]);
    expect(result.skipped).toEqual([{ name: 'Latte', reason: 'This option is no longer offered' }]);
  });

  it('uses the sole variant when variant_id is null and the item currently has exactly one', () => {
    const result = mapLegacyBillItemsToCartLines([legacyItem({ variant_id: null })], [menuItem()]);
    expect(result.skipped).toEqual([]);
    expect(result.lines).toEqual([
      {
        menuItemId: 'menu-1',
        variantId: 'variant-1',
        name: 'Latte',
        variantLabel: 'Regular',
        unitPriceInr: 100,
        gstExempt: false,
        addons: [],
        specialInstructions: '',
        qty: 1,
      },
    ]);
  });

  it('skips (never guesses) when variant_id is null and the item currently has more than one variant', () => {
    const menu = [
      menuItem({
        variants: [
          { id: 'variant-1', menu_item_id: 'menu-1', label: 'Regular', price_inr: 100, sort_order: 0 },
          { id: 'variant-2', menu_item_id: 'menu-1', label: 'Large', price_inr: 140, sort_order: 1 },
        ],
      }),
    ];
    const result = mapLegacyBillItemsToCartLines([legacyItem({ variant_id: null })], menu);
    expect(result.lines).toEqual([]);
    expect(result.skipped).toEqual([{ name: 'Latte', reason: 'This option is no longer offered' }]);
  });

  it('never adds addons and always reports empty modified — Petpooja items have neither', () => {
    const result = mapLegacyBillItemsToCartLines([legacyItem()], [menuItem()]);
    expect(result.lines[0].addons).toEqual([]);
    expect(result.modified).toEqual([]);
  });

  it('processes several legacy items independently: one kept, one skipped', () => {
    const items = [
      legacyItem({ name_snapshot: 'Latte', menu_item_id: 'menu-1', variant_id: 'variant-1' }),
      legacyItem({ name_snapshot: 'Discontinued Cake', menu_item_id: null }),
    ];
    const result = mapLegacyBillItemsToCartLines(items, [menuItem()]);
    expect(result.lines).toHaveLength(1);
    expect(result.skipped).toEqual([{ name: 'Discontinued Cake', reason: 'Not matched to a menu item' }]);
  });

  it('returns empty lines/skipped/modified for an empty bill', () => {
    expect(mapLegacyBillItemsToCartLines([], [menuItem()])).toEqual({ lines: [], skipped: [], modified: [], needsChoice: [] });
  });

  it('sends an item with a required add-on group to the popup — a Petpooja bill never recorded add-ons', () => {
    const item = menuItem({ addon_groups: [iceLevel] });
    const result = mapLegacyBillItemsToCartLines([legacyItem()], [item]);
    expect(result.lines).toEqual([]);
    expect(result.needsChoice).toEqual([
      { item, variantId: 'variant-1', qty: 1, selection: {}, specialInstructions: '', weightGrams: null },
    ]);
  });
});
