import { beforeEach, describe, expect, it, vi } from 'vitest';

// Coffey checkout pairings (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §1.2, §4.3): the
// cart side. The repo's vitest environment is node-only (no DOM, no renderer), so
// this covers the pure rules directly — quickAddLine, the pairing_lines payload —
// and drives CartProvider's addItem through a minimal in-memory stand-in for
// React's hooks, which is enough to pin the one-shot pending-anchor hint.

// ---------------------------------------------------------------------------
// A tiny hooks stand-in: state lives in slots, a "render" is calling
// CartProvider() again, effects never run. Only this file sees it.
// ---------------------------------------------------------------------------

const hooks = vi.hoisted(() => ({ slots: [] as unknown[], next: 0 }));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const i = hooks.next++;
      if (!(i in hooks.slots)) hooks.slots[i] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      const set = (value: unknown) => {
        hooks.slots[i] = typeof value === 'function' ? (value as (prev: unknown) => unknown)(hooks.slots[i]) : value;
      };
      return [hooks.slots[i], set];
    },
    useRef: (initial: unknown) => {
      const i = hooks.next++;
      if (!(i in hooks.slots)) hooks.slots[i] = { current: initial };
      return hooks.slots[i];
    },
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
    useEffect: () => {},
  };
});

import { CartProvider, type CartItem } from '@/lib/cart/CartContext';
import { minVariantPriceInr, quickAddLine } from '@/lib/cart/pairingAdd';
import { collectPairingLines, collectSuggestionSessionIds } from '@/lib/cart/suggestionIds';
import { parsePairingLines } from '@/lib/suggest/attribution';
import { PAIRING_LIMITS } from '@/lib/suggest/types';
import type { AddonGroup, AddonOption, MenuItem, MenuItemVariant } from '@/lib/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ANCHOR = 'anchor-item';

function variant(id: string, label: string, price_inr: number): MenuItemVariant {
  return { id, menu_item_id: 'item', label, price_inr, sort_order: 0 };
}

function option(id: string, name: string, price_inr: number, extra: Partial<AddonOption> = {}): AddonOption {
  return { id, addon_group_id: 'g', name, price_inr, sort_order: 0, ...extra };
}

function group(id: string, over: Partial<AddonGroup> & { options: AddonOption[] }): AddonGroup {
  return {
    id,
    name: id,
    display_name: `Group ${id}`,
    selection_type: 'single',
    min_select: 0,
    max_select: 1,
    sort_order: 0,
    ...over,
  };
}

function item(over: Partial<MenuItem> = {}): MenuItem {
  return {
    id: 'brownie',
    name: 'Fudge Brownie',
    description: '',
    category: 'Desserts',
    parent_category: 'Menu',
    is_veg: true,
    is_available: true,
    sort_order: 0,
    image_url: '',
    unavailable_until: null,
    short_code: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    variants: [variant('brownie-reg', 'Regular', 120)],
    addon_groups: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// quickAddLine
// ---------------------------------------------------------------------------

describe('quickAddLine', () => {
  it('a single variant and no add-on groups adds in one tap, carrying the anchor', () => {
    expect(quickAddLine(item(), ANCHOR)).toEqual({
      menuItemId: 'brownie',
      variantId: 'brownie-reg',
      name: 'Fudge Brownie',
      variantLabel: 'Regular',
      unitPriceInr: 120,
      gstExempt: false,
      addons: [],
      specialInstructions: '',
      pairingAnchorId: ANCHOR,
    });
  });

  it('carries the GST-exempt flag like every other add path', () => {
    expect(quickAddLine(item({ gst_exempt: true }), ANCHOR)?.gstExempt).toBe(true);
    expect(quickAddLine(item({ gst_exempt: false }), ANCHOR)?.gstExempt).toBe(false);
  });

  it('is null when there is more than one size, or none', () => {
    const sizes = item({ variants: [variant('s', 'Small', 100), variant('l', 'Large', 140)] });
    expect(quickAddLine(sizes, ANCHOR)).toBeNull();
    expect(quickAddLine(item({ variants: [] }), ANCHOR)).toBeNull();
  });

  it('a required group whose default is free is answered with that default', () => {
    const sugar = group('sugar', {
      min_select: 1,
      options: [option('sugar-stevia', 'Stevia', 10), option('sugar-normal', 'Normal', 0), option('sugar-none', 'No Sugar', 0)],
    });
    const line = quickAddLine(item({ addon_groups: [sugar] }), ANCHOR);
    expect(line).not.toBeNull();
    expect(line?.addons).toEqual([
      { optionId: 'sugar-normal', groupName: 'Group sugar', optionName: 'Normal', priceInr: 0 },
    ]);
    expect(line?.unitPriceInr).toBe(120); // nothing quietly added to the bill
  });

  it('every required group counts, multi-select ones too', () => {
    const sugar = group('sugar', { min_select: 1, options: [option('normal', 'Normal', 0)] });
    const toppings = group('top', {
      selection_type: 'multi',
      min_select: 2,
      max_select: 3,
      options: [option('t1', 'Sprinkles', 0), option('t2', 'Chips', 0), option('t3', 'Nuts', 0)],
    });
    const line = quickAddLine(item({ addon_groups: [sugar, toppings] }), ANCHOR);
    expect(line?.addons.map((a) => a.optionId)).toEqual(['normal', 't1', 't2']);
  });

  it('is null when a required group would default to a paid option', () => {
    const syrup = group('syrup', { min_select: 1, options: [option('v', 'Vanilla', 35), option('c', 'Caramel', 35)] });
    expect(quickAddLine(item({ addon_groups: [syrup] }), ANCHOR)).toBeNull();
  });

  it('is null when ANY required group has a paid default, however free the others are', () => {
    const sugar = group('sugar', { min_select: 1, options: [option('normal', 'Normal', 0)] });
    const syrup = group('syrup', { min_select: 1, options: [option('v', 'Vanilla', 35)] });
    expect(quickAddLine(item({ addon_groups: [sugar, syrup] }), ANCHOR)).toBeNull();
  });

  it('a multi-select group that needs a paid option to reach its minimum is null', () => {
    const sides = group('sides', {
      selection_type: 'multi',
      min_select: 2,
      max_select: 2,
      options: [option('a', 'Fries', 0), option('b', 'Salad', 40)],
    });
    expect(quickAddLine(item({ addon_groups: [sides] }), ANCHOR)).toBeNull();
  });

  it('optional groups are left empty, free options and paid ones alike', () => {
    const optional = group('extras', {
      min_select: 0,
      options: [option('free', 'Extra napkin', 0), option('paid', 'Whipped cream', 30)],
    });
    const line = quickAddLine(item({ addon_groups: [optional] }), ANCHOR);
    expect(line?.addons).toEqual([]);
    expect(line?.unitPriceInr).toBe(120);
  });

  it('a required group that cannot be answered by default is null (no options, or all switched off)', () => {
    expect(quickAddLine(item({ addon_groups: [group('empty', { min_select: 1, options: [] })] }), ANCHOR)).toBeNull();

    const off = group('off', { min_select: 1, options: [option('x', 'Normal', 0, { is_available: false })] });
    expect(quickAddLine(item({ addon_groups: [off] }), ANCHOR)).toBeNull();
  });

  it('does not touch the menu item it was given', () => {
    const source = item({ addon_groups: [group('sugar', { min_select: 1, options: [option('normal', 'Normal', 0)] })] });
    const before = JSON.stringify(source);
    quickAddLine(source, ANCHOR);
    expect(JSON.stringify(source)).toBe(before);
  });
});

describe('minVariantPriceInr', () => {
  it('is the cheapest size', () => {
    expect(minVariantPriceInr(item({ variants: [variant('l', 'Large', 140), variant('s', 'Small', 100)] }))).toBe(100);
    expect(minVariantPriceInr(item())).toBe(120);
  });

  it('is null when there is no size to price', () => {
    expect(minVariantPriceInr(item({ variants: [] }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The pairing_lines payload
// ---------------------------------------------------------------------------

describe('collectPairingLines', () => {
  const line = (menuItemId: string, pairingAnchorId?: string) => ({ menuItemId, pairingAnchorId });

  it('is undefined when no cart line carries an anchor, so the field disappears from the body', () => {
    expect(collectPairingLines([])).toBeUndefined();
    expect(collectPairingLines([line('a'), line('b', undefined), line('c', '')])).toBeUndefined();
    expect(JSON.stringify({ items: [], ...(collectPairingLines([line('a')]) ? { pairing_lines: 1 } : {}) })).not.toContain(
      'pairing_lines',
    );
  });

  it('maps lines with an anchor to { menu_item_id, anchor_item_id }, in cart order', () => {
    expect(collectPairingLines([line('a'), line('b', 'x'), line('c', 'y')])).toEqual([
      { menu_item_id: 'b', anchor_item_id: 'x' },
      { menu_item_id: 'c', anchor_item_id: 'y' },
    ]);
  });

  it('is de-duplicated by item — the first line wins — so an item is attributed once', () => {
    expect(collectPairingLines([line('b', 'x'), line('c', 'y'), line('b', 'z'), line('b', 'x')])).toEqual([
      { menu_item_id: 'b', anchor_item_id: 'x' },
      { menu_item_id: 'c', anchor_item_id: 'y' },
    ]);
  });

  it('is capped at orderLinesMax (5) by default, and at a caller-supplied max', () => {
    expect(PAIRING_LIMITS.orderLinesMax).toBe(5);
    const many = Array.from({ length: 8 }, (_, i) => line(`item-${i}`, 'anchor'));
    expect(collectPairingLines(many)).toHaveLength(5);
    expect(collectPairingLines(many)?.map((l) => l.menu_item_id)).toEqual(['item-0', 'item-1', 'item-2', 'item-3', 'item-4']);
    expect(collectPairingLines(many, 2)).toHaveLength(2);
    expect(collectPairingLines(many, 0)).toBeUndefined();
  });

  it('is independent of the suggestion-session ids on the same lines', () => {
    const lines = [
      { menuItemId: 'a', suggestionSessionId: 's1', pairingAnchorId: undefined },
      { menuItemId: 'b', suggestionSessionId: undefined, pairingAnchorId: 'x' },
    ];
    expect(collectSuggestionSessionIds(lines)).toEqual(['s1']);
    expect(collectPairingLines(lines)).toEqual([{ menu_item_id: 'b', anchor_item_id: 'x' }]);
  });

  it('what the cart sends is exactly what the order route keeps', () => {
    const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const sent = collectPairingLines(
      Array.from({ length: 7 }, (_, i) => ({ menuItemId: uuid(i + 1), pairingAnchorId: uuid(100) })),
    );
    expect(parsePairingLines(JSON.parse(JSON.stringify(sent)))).toEqual(sent);
  });
});

// ---------------------------------------------------------------------------
// CartContext: pairingAnchorId and the one-shot pending hint
// (mirrors setPendingSuggestionSessionId)
// ---------------------------------------------------------------------------

describe('CartProvider pairing anchor', () => {
  type CartValue = {
    items: CartItem[];
    addItem: (line: Omit<CartItem, 'qty' | 'key'>, qty?: number) => void;
    setPendingPairingAnchorId: (id: string | null) => void;
    setPendingSuggestionSessionId: (id: string | null) => void;
  };

  /** One "render" of the provider: the context value it would hand its children. */
  function cart(): CartValue {
    hooks.next = 0;
    const element = CartProvider({ children: null }) as unknown as { props: { value: CartValue } };
    return element.props.value;
  }

  const line = (menuItemId: string, extra: Partial<Omit<CartItem, 'qty' | 'key'>> = {}): Omit<CartItem, 'qty' | 'key'> => ({
    menuItemId,
    variantId: `${menuItemId}-var`,
    name: menuItemId,
    variantLabel: 'Regular',
    unitPriceInr: 100,
    addons: [],
    specialInstructions: '',
    ...extra,
  });

  beforeEach(() => {
    hooks.slots = [];
    hooks.next = 0;
  });

  it('a line added with no hint has no anchor, and old lines (no field at all) are fine', () => {
    cart().addItem(line('a'));
    const [only] = cart().items;
    expect(only.pairingAnchorId).toBeUndefined();
    expect(only.qty).toBe(1);
  });

  it('an explicit pairingAnchorId on the line is kept', () => {
    cart().addItem(line('a', { pairingAnchorId: 'anchor-1' }));
    expect(cart().items[0].pairingAnchorId).toBe('anchor-1');
  });

  it('the pending hint rides on the very next addItem…', () => {
    cart().setPendingPairingAnchorId('anchor-1');
    cart().addItem(line('a'));
    expect(cart().items[0].pairingAnchorId).toBe('anchor-1');
  });

  it('…and is consumed by it, so it can never leak onto a later line', () => {
    cart().setPendingPairingAnchorId('anchor-1');
    cart().addItem(line('a'));
    cart().addItem(line('b'));
    const items = cart().items;
    expect(items.map((i) => i.pairingAnchorId)).toEqual(['anchor-1', undefined]);
  });

  it('an explicit field wins over the hint, and the hint is consumed either way', () => {
    cart().setPendingPairingAnchorId('from-hint');
    cart().addItem(line('a', { pairingAnchorId: 'explicit' }));
    cart().addItem(line('b'));
    expect(cart().items.map((i) => i.pairingAnchorId)).toEqual(['explicit', undefined]);
  });

  it('clearing the hint (the modal closed without adding) means the next line has none', () => {
    cart().setPendingPairingAnchorId('anchor-1');
    cart().setPendingPairingAnchorId(null);
    cart().addItem(line('a'));
    expect(cart().items[0].pairingAnchorId).toBeUndefined();
  });

  it('a later hint replaces an unconsumed earlier one', () => {
    cart().setPendingPairingAnchorId('first');
    cart().setPendingPairingAnchorId('second');
    cart().addItem(line('a'));
    expect(cart().items[0].pairingAnchorId).toBe('second');
  });

  it('merging into an existing line keeps the anchor that line already has', () => {
    cart().addItem(line('a', { pairingAnchorId: 'anchor-1' }));
    cart().setPendingPairingAnchorId('anchor-2');
    cart().addItem(line('a'));
    const items = cart().items;
    expect(items).toHaveLength(1);
    expect(items[0].qty).toBe(2);
    expect(items[0].pairingAnchorId).toBe('anchor-1');
    // …and the hint was consumed, not left waiting for the next add.
    cart().addItem(line('b'));
    expect(cart().items[1].pairingAnchorId).toBeUndefined();
  });

  it('merging into a line with no anchor takes the new one, the way the suggestion session id does', () => {
    cart().addItem(line('a'));
    cart().addItem(line('a', { pairingAnchorId: 'anchor-1' }));
    expect(cart().items[0].pairingAnchorId).toBe('anchor-1');
  });

  it('the pairing hint and the suggestion-session hint are independent', () => {
    cart().setPendingPairingAnchorId('anchor-1');
    cart().setPendingSuggestionSessionId('session-1');
    cart().addItem(line('a'));
    cart().addItem(line('b'));
    expect(cart().items.map((i) => [i.pairingAnchorId, i.suggestionSessionId])).toEqual([
      ['anchor-1', 'session-1'],
      [undefined, undefined],
    ]);
  });
});
