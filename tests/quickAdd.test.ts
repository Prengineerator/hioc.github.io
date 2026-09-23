import { describe, expect, it } from 'vitest';
import {
  isSimpleItem,
  normalizeToken,
  parseQuickAddInput,
  resolveQuickAdd,
} from '@/lib/pos/quickAdd';
import { mergeRecent } from '@/lib/pos/recents';
import type { AddonGroup, MenuItem, MenuItemVariant } from '@/lib/types';

// Fixed clock so 86/availability is deterministic regardless of the real time.
const NOW = new Date('2026-07-25T06:30:00Z');

function variant(id: string): MenuItemVariant {
  return { id, menu_item_id: id, label: 'Regular', price_inr: 100, sort_order: 0 };
}

function group(id: string): AddonGroup {
  return {
    id,
    name: id,
    display_name: id,
    selection_type: 'single',
    min_select: 1,
    max_select: 1,
    sort_order: 0,
    options: [],
  };
}

function item(overrides: Partial<MenuItem> & { name: string }): MenuItem {
  const id = overrides.id ?? overrides.name;
  return {
    id,
    name: overrides.name,
    description: '',
    category: overrides.category ?? 'Coffee',
    parent_category: '',
    is_veg: true,
    is_available: overrides.is_available ?? true,
    sort_order: overrides.sort_order ?? 0,
    image_url: '',
    unavailable_until: overrides.unavailable_until ?? null,
    short_code: overrides.short_code ?? null,
    created_at: '',
    updated_at: '',
    variants: overrides.variants ?? [variant(`v-${id}`)],
    addon_groups: overrides.addon_groups ?? [],
  };
}

const opts = { now: NOW };

describe('normalizeToken', () => {
  it('strips diacritics, lowercases, collapses whitespace', () => {
    expect(normalizeToken('Crème')).toBe('creme');
    expect(normalizeToken('  Iced   Mocha ')).toBe('iced mocha');
    expect(normalizeToken('CAPPUCCINO')).toBe('cappuccino');
  });
});

describe('resolveQuickAdd', () => {
  it('ranks a name-prefix above a mere substring match', () => {
    const items = [item({ name: 'Escape Latte' }), item({ name: 'Cappuccino' })];
    const res = resolveQuickAdd('cap', items, opts);
    expect(res.map((c) => c.item.name)).toEqual(['Cappuccino', 'Escape Latte']);
    expect(res[0].kind).toBe('name-prefix');
    expect(res[1].kind).toBe('substring');
  });

  it('matches a word-boundary prefix', () => {
    const res = resolveQuickAdd('moc', [item({ name: 'Iced Mocha' })], opts);
    expect(res).toHaveLength(1);
    expect(res[0].kind).toBe('word-prefix');
  });

  it('matches a scattered subsequence as the fuzzy fallback', () => {
    const items = [item({ name: 'Choco Waffle' }), item({ name: 'Green Tea' })];
    const res = resolveQuickAdd('chw', items, opts);
    expect(res.map((c) => c.item.name)).toEqual(['Choco Waffle']);
    expect(res[0].kind).toBe('subsequence');
  });

  it('is diacritic-insensitive ("creme" -> "Crème …")', () => {
    const res = resolveQuickAdd('creme', [item({ name: 'Crème Latte' })], opts);
    expect(res).toHaveLength(1);
    expect(res[0].item.name).toBe('Crème Latte');
  });

  it('returns [] for an empty or whitespace term', () => {
    const items = [item({ name: 'Cappuccino' })];
    expect(resolveQuickAdd('', items, opts)).toEqual([]);
    expect(resolveQuickAdd('   ', items, opts)).toEqual([]);
  });

  it('sinks 86’d items below available ones in the same tier and flags them', () => {
    const items = [
      item({ id: 'b', name: 'Cappb', is_available: false }), // 86'd
      item({ id: 'a', name: 'Cappa' }), // available
    ];
    const res = resolveQuickAdd('capp', items, opts);
    expect(res.map((c) => c.item.name)).toEqual(['Cappa', 'Cappb']);
    expect(res[0].available).toBe(true);
    expect(res[1].available).toBe(false); // still listed, just marked unavailable
  });

  it('keeps a 86’d item in the results (available:false, not filtered out)', () => {
    const res = resolveQuickAdd('cap', [item({ name: 'Cappuccino', is_available: false })], opts);
    expect(res).toHaveLength(1);
    expect(res[0].available).toBe(false);
  });

  it('breaks exact ties deterministically by sort_order', () => {
    const items = [
      item({ id: 'hi', name: 'xy', sort_order: 20 }),
      item({ id: 'lo', name: 'xz', sort_order: 10 }),
    ];
    const res = resolveQuickAdd('x', items, opts);
    // same tier (name-prefix), same availability, same length -> lower sort_order first
    expect(res.map((c) => c.item.id)).toEqual(['lo', 'hi']);
  });

  it('respects the limit', () => {
    const items = Array.from({ length: 10 }, (_, i) => item({ id: `c${i}`, name: `Cap ${i}` }));
    expect(resolveQuickAdd('cap', items, { now: NOW, limit: 3 })).toHaveLength(3);
  });
});

describe('resolveQuickAdd — owner short codes (Phase 2 tiers)', () => {
  it('an exact code outranks a name-prefix match on a different item', () => {
    const items = [
      item({ id: 'latte', name: 'Latte', short_code: 'CAP' }), // exact code for "cap"
      item({ id: 'capp', name: 'Cappuccino' }), // name-prefix for "cap"
    ];
    const res = resolveQuickAdd('cap', items, opts);
    expect(res[0].item.id).toBe('latte');
    expect(res[0].kind).toBe('code');
  });

  it('matches a code prefix', () => {
    const res = resolveQuickAdd('ca', [item({ name: 'Latte', short_code: 'CAP' })], opts);
    expect(res[0].kind).toBe('code-prefix');
  });
});

describe('parseQuickAddInput', () => {
  it('parses the "N*" / "Nx" / "N " qty grammars', () => {
    expect(parseQuickAddInput('3*cap')).toEqual({ qty: 3, term: 'cap' });
    expect(parseQuickAddInput('3xcap')).toEqual({ qty: 3, term: 'cap' });
    expect(parseQuickAddInput('3 cap')).toEqual({ qty: 3, term: 'cap' });
    expect(parseQuickAddInput('3X cap')).toEqual({ qty: 3, term: 'cap' });
  });

  it('defaults to qty 1 with no prefix, and does not treat glued digits as qty', () => {
    expect(parseQuickAddInput('cap')).toEqual({ qty: 1, term: 'cap' });
    expect(parseQuickAddInput('3cap')).toEqual({ qty: 1, term: '3cap' });
    expect(parseQuickAddInput('  cap ')).toEqual({ qty: 1, term: 'cap' });
    expect(parseQuickAddInput('')).toEqual({ qty: 1, term: '' });
  });

  it('clamps qty to 1..99', () => {
    expect(parseQuickAddInput('0*cap')).toEqual({ qty: 1, term: 'cap' });
    expect(parseQuickAddInput('999*cap')).toEqual({ qty: 99, term: 'cap' });
  });
});

describe('isSimpleItem', () => {
  it('is simple for one variant and no addon groups', () => {
    expect(isSimpleItem(item({ name: 'Espresso' }))).toBe(true);
  });

  it('is not simple with multiple variants', () => {
    expect(
      isSimpleItem(item({ name: 'Latte', variants: [variant('a'), variant('b')] })),
    ).toBe(false);
  });

  it('is not simple with any addon group', () => {
    expect(isSimpleItem(item({ name: 'Latte', addon_groups: [group('sugar')] }))).toBe(false);
  });
});

describe('mergeRecent (recents ring buffer)', () => {
  it('adds a new id to the front', () => {
    expect(mergeRecent([], 'a')).toEqual(['a']);
    expect(mergeRecent(['a', 'b'], 'c')).toEqual(['c', 'a', 'b']);
  });

  it('de-duplicates by moving an existing id to the front', () => {
    expect(mergeRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
  });

  it('caps the length, dropping the oldest', () => {
    expect(mergeRecent(['a', 'b', 'c'], 'd', 3)).toEqual(['d', 'a', 'b']);
  });
});
