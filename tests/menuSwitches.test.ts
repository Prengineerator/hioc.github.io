import { describe, expect, it } from 'vitest';
import {
  applyMenuSwitches,
  isCategoryHidden,
  isHiddenSize,
  parseHiddenCategories,
  parseHiddenSizes,
  isSizeOffEverywhere,
  sizeLabels,
  switchesFromSettings,
  toggleSizeEntry,
  withoutHiddenSizes,
  withoutOffAddons,
} from '@/lib/menu/menuSwitches';
import { resolveOrderLines } from '@/lib/orders/lines';
import type { AddonGroup, MenuItem } from '@/lib/types';

function group(id: string, min: number, options: { id: string; price: number; on?: boolean }[]): AddonGroup {
  return {
    id,
    name: id,
    display_name: id,
    selection_type: 'single',
    min_select: min,
    max_select: 1,
    sort_order: 0,
    options: options.map((o, i) => ({
      id: o.id,
      addon_group_id: id,
      name: o.id,
      price_inr: o.price,
      sort_order: i,
      ...(o.on === false ? { is_available: false } : {}),
    })),
  } as AddonGroup;
}

function latte(groups: AddonGroup[] = [], sizes = ['Large', 'Extra Large']): MenuItem {
  return {
    id: 'latte',
    name: 'Latte',
    description: '',
    category: 'Coffee',
    parent_category: 'Hot',
    is_veg: true,
    is_available: true,
    sort_order: 0,
    image_url: '',
    unavailable_until: null,
    short_code: null,
    created_at: '',
    updated_at: '',
    variants: sizes.map((label, i) => ({
      id: `v-${label}`,
      menu_item_id: 'latte',
      label,
      price_inr: 200 + i * 40,
      sort_order: i,
    })),
    addon_groups: groups,
  } as MenuItem;
}

describe('sizes', () => {
  it('matches size names case-insensitively', () => {
    expect(isHiddenSize(' extra large ', ['Extra Large'])).toBe(true);
    expect(isHiddenSize('Large', ['Extra Large'])).toBe(false);
  });

  it('removes a hidden size but never an item’s only sizes', () => {
    expect(withoutHiddenSizes(latte(), ['Extra Large']).variants.map((v) => v.label)).toEqual(['Large']);
    const onlyXl = latte([], ['Extra Large']);
    expect(withoutHiddenSizes(onlyXl, ['Extra Large'])).toBe(onlyXl);
  });

  it('lists every size name, most used first, with the categories that have it', () => {
    const iced = { ...latte([], ['Large']), category: 'Iced Coffee' };
    expect(sizeLabels([latte(), iced])).toEqual([
      {
        label: 'Large',
        count: 2,
        categories: [
          { slug: 'Coffee', count: 1 },
          { slug: 'Iced Coffee', count: 1 },
        ],
      },
      { label: 'Extra Large', count: 1, categories: [{ slug: 'Coffee', count: 1 }] },
    ]);
  });

  it('validates the setting', () => {
    expect(parseHiddenSizes(['Extra Large', 'extra large', ' L '])).toEqual(['Extra Large', 'L']);
    expect(parseHiddenSizes(['Extra Large|Iced Coffee', 'Extra Large'], ['Iced Coffee'])).toEqual([
      'Extra Large|Iced Coffee',
      'Extra Large',
    ]);
    expect(parseHiddenSizes(['Extra Large|Nope'], ['Iced Coffee'])).toBeNull();
    expect(parseHiddenSizes('Extra Large')).toBeNull();
    expect(parseHiddenSizes([''])).toBeNull();
  });

  it('switches a size off in one category only (cold, not hot)', () => {
    const hidden = ['Extra Large|Iced Coffee'];
    const iced = { ...latte(), category: 'Iced Coffee' };
    expect(withoutHiddenSizes(iced, hidden).variants.map((v) => v.label)).toEqual(['Large']);
    expect(withoutHiddenSizes(latte(), hidden).variants.map((v) => v.label)).toEqual(['Large', 'Extra Large']);
    expect(isHiddenSize('Extra Large', hidden, 'Coffee')).toBe(false);
    expect(isSizeOffEverywhere('Extra Large', hidden)).toBe(false);
  });

  it('toggles size switches everywhere and per category', () => {
    let hidden = toggleSizeEntry([], 'Extra Large', 'Iced Coffee', false);
    hidden = toggleSizeEntry(hidden, 'Extra Large', 'Cold Brews', false);
    expect(hidden).toEqual(['Extra Large|Iced Coffee', 'Extra Large|Cold Brews']);
    expect(toggleSizeEntry(hidden, 'Extra Large', 'Iced Coffee', true)).toEqual(['Extra Large|Cold Brews']);
    const everywhere = toggleSizeEntry(hidden, 'Extra Large', null, false);
    expect(isSizeOffEverywhere('Extra Large', everywhere)).toBe(true);
    // Back on everywhere clears the per-category switches too.
    expect(toggleSizeEntry(everywhere, 'Extra Large', null, true)).toEqual([]);
  });
});

describe('add-ons', () => {
  it('drops switched-off options, and a group left with none', () => {
    const item = latte([
      group('milk', 0, [{ id: 'oat', price: 40, on: false }, { id: 'soy', price: 40 }]),
      group('ice', 1, [{ id: 'no-ice', price: 0, on: false }]),
    ]);
    const shown = withoutOffAddons(item);
    expect(shown.addon_groups.map((g) => g.id)).toEqual(['milk']);
    expect(shown.addon_groups[0].options.map((o) => o.id)).toEqual(['soy']);
  });

  it('leaves an item with nothing off untouched', () => {
    const item = latte([group('milk', 0, [{ id: 'oat', price: 40 }])]);
    expect(withoutOffAddons(item)).toBe(item);
  });
});

describe('categories', () => {
  it('knows a hidden category and validates the setting against real categories', () => {
    expect(isCategoryHidden('Coffee', ['Coffee'])).toBe(true);
    expect(isCategoryHidden('Coffee', [])).toBe(false);
    expect(parseHiddenCategories(['Coffee', 'Coffee'], ['Coffee', 'Sundae'])).toEqual(['Coffee']);
    expect(parseHiddenCategories(['Nope'], ['Coffee'])).toBeNull();
  });
});

describe('orders refuse what is switched off', () => {
  const settings = { hidden_categories: [] as string[], hidden_variant_labels: ['Extra Large'] };
  const line = (variant: string, addons: string[] = []) => ({
    menu_item_id: 'latte',
    variant_id: `v-${variant}`,
    quantity: 1,
    addon_option_ids: addons,
    special_instructions: '',
  });

  it('refuses a size switched off in its category only', () => {
    const cold = new Map([['latte', { ...latte(), category: 'Iced Coffee' }]]);
    const hot = new Map([['latte', latte()]]);
    const switches = { hiddenSizes: ['Extra Large|Iced Coffee'] };
    expect(resolveOrderLines([line('Extra Large')], cold, switches).ok).toBe(false);
    expect(resolveOrderLines([line('Extra Large')], hot, switches).ok).toBe(true);
  });

  it('refuses a hidden size and accepts the others', () => {
    const menu = new Map([['latte', latte()]]);
    const off = resolveOrderLines([line('Extra Large')], menu, switchesFromSettings(settings));
    expect(off).toEqual({ ok: false, error: '"Latte" in Extra Large isn\'t available right now' });
    expect(resolveOrderLines([line('Large')], menu, switchesFromSettings(settings)).ok).toBe(true);
  });

  it('refuses an item in a hidden category', () => {
    const menu = new Map([['latte', latte()]]);
    const res = resolveOrderLines([line('Large')], menu, { hiddenCategories: ['Coffee'] });
    expect(res).toEqual({ ok: false, error: '"Latte" isn\'t available right now' });
  });

  it('refuses an add-on that is off, by name', () => {
    const menu = new Map([['latte', latte([group('milk', 0, [{ id: 'oat', price: 40, on: false }, { id: 'soy', price: 40 }])])]]);
    expect(resolveOrderLines([line('Large', ['oat'])], menu, {})).toEqual({
      ok: false,
      error: "oat isn't available right now",
    });
    expect(resolveOrderLines([line('Large', ['soy'])], menu, {}).ok).toBe(true);
  });

  it('does not demand a choice from a required group whose options are all off', () => {
    const menu = new Map([['latte', latte([group('ice', 1, [{ id: 'no-ice', price: 0, on: false }])])]]);
    expect(resolveOrderLines([line('Large')], menu, {}).ok).toBe(true);
  });

  it('changes nothing with no switches', () => {
    expect(applyMenuSwitches(latte(), {}).variants).toHaveLength(2);
  });
});
