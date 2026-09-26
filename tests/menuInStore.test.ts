import { describe, expect, it } from 'vitest';
import { firstInStoreOnlyItem, isInStoreOnly, isInStoreOnlyCategory } from '@/lib/menu/inStore';
import { CUSTOMER_MENU_CATEGORIES, MENU_CATEGORIES } from '@/lib/constants';

// In-store-only items (water bottles…) must never reach a customer menu or an
// online order. The rule is flag OR in-store category, so a forgotten tick box
// can't leak an item.

describe('isInStoreOnly', () => {
  it('is true for a flagged item in any category', () => {
    expect(isInStoreOnly({ in_store_only: true, category: 'Coffee' })).toBe(true);
  });

  it('is true for any item in an in-store category, flagged or not (or read before the migration)', () => {
    expect(isInStoreOnly({ in_store_only: false, category: 'In-store' })).toBe(true);
    expect(isInStoreOnly({ category: 'In-store' })).toBe(true);
  });

  it('is false for a normal item', () => {
    expect(isInStoreOnly({ in_store_only: false, category: 'Coffee' })).toBe(false);
    expect(isInStoreOnly({ in_store_only: null, category: 'Coffee' })).toBe(false);
  });
});

describe('categories', () => {
  it('In-store is an in-store category the customer menus leave out', () => {
    expect(isInStoreOnlyCategory('In-store')).toBe(true);
    expect(isInStoreOnlyCategory('Coffee')).toBe(false);
    expect(MENU_CATEGORIES.map((c) => c.slug)).toContain('In-store');
    expect(CUSTOMER_MENU_CATEGORIES.map((c) => c.slug)).not.toContain('In-store');
    expect(CUSTOMER_MENU_CATEGORIES).toHaveLength(MENU_CATEGORIES.length - 1);
  });
});

describe('firstInStoreOnlyItem', () => {
  const menu = new Map([
    ['latte', { name: 'Latte', category: 'Coffee', in_store_only: false }],
    ['water', { name: 'Water Bottle', category: 'In-store', in_store_only: true }],
  ]);

  it('finds the in-store item among the lines', () => {
    expect(firstInStoreOnlyItem([{ menu_item_id: 'latte' }, { menu_item_id: 'water' }], menu)?.name).toBe('Water Bottle');
  });

  it('is null when every line may be ordered online (unknown ids are left to line validation)', () => {
    expect(firstInStoreOnlyItem([{ menu_item_id: 'latte' }, { menu_item_id: 'gone' }], menu)).toBeNull();
  });
});
