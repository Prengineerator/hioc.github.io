import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KOT_ROUTING,
  FULL_ORDER_TITLE,
  OTHER_ITEMS_TITLE,
  normalizeKotRouting,
  readKotRouting,
  splitKotItems,
  type KotRouting,
} from '@/lib/print/kotRouting';

// KOT counters — the rules that decide which counter's slip each line prints
// on. A line on the wrong slip is a drink nobody makes, so every branch of the
// split and of the save-time validation is pinned here.

const routing = (counters: KotRouting['counters'], full_copy = false): KotRouting => ({ counters, full_copy });

describe('normalizeKotRouting', () => {
  it('accepts a valid setup, trimming names and categories', () => {
    const r = normalizeKotRouting({
      counters: [{ name: '  Coffee Bar ', categories: [' Coffee ', 'Iced Coffee'] }],
      full_copy: true,
    });
    expect(r).toEqual({ ok: true, routing: routing([{ name: 'Coffee Bar', categories: ['Coffee', 'Iced Coffee'] }], true) });
  });

  it('defaults full_copy to false and allows no counters', () => {
    expect(normalizeKotRouting({ counters: [] })).toEqual({ ok: true, routing: DEFAULT_KOT_ROUTING });
  });

  it('drops blank categories and a category repeated on the same counter', () => {
    const r = normalizeKotRouting({ counters: [{ name: 'Bar', categories: ['Coffee', '', 'coffee', '  '] }] });
    expect(r).toEqual({ ok: true, routing: routing([{ name: 'Bar', categories: ['Coffee'] }]) });
  });

  it('refuses a category on two counters', () => {
    const r = normalizeKotRouting({
      counters: [
        { name: 'Bar', categories: ['Coffee'] },
        { name: 'Kitchen', categories: ['coffee'] },
      ],
    });
    expect(r).toEqual({ ok: false, error: '"coffee" is on both "Bar" and "Kitchen"' });
  });

  it('refuses blank and duplicate counter names', () => {
    expect(normalizeKotRouting({ counters: [{ name: '  ', categories: [] }] }).ok).toBe(false);
    expect(
      normalizeKotRouting({
        counters: [
          { name: 'Bar', categories: [] },
          { name: 'bar', categories: [] },
        ],
      }).ok,
    ).toBe(false);
  });

  it('refuses too many counters, over-long names and bad types', () => {
    const many = Array.from({ length: 13 }, (_, i) => ({ name: `C${i}`, categories: [] }));
    expect(normalizeKotRouting({ counters: many }).ok).toBe(false);
    expect(normalizeKotRouting({ counters: [{ name: 'x'.repeat(41), categories: [] }] }).ok).toBe(false);
    expect(normalizeKotRouting({ counters: 'Bar' }).ok).toBe(false);
    expect(normalizeKotRouting({ counters: [], full_copy: 'yes' }).ok).toBe(false);
    expect(normalizeKotRouting({ counters: [{ name: 'Bar', categories: [1] }] }).ok).toBe(false);
    expect(normalizeKotRouting(null).ok).toBe(false);
  });
});

describe('readKotRouting', () => {
  it('falls back to the single classic KOT for anything unreadable', () => {
    expect(readKotRouting(undefined)).toEqual(DEFAULT_KOT_ROUTING);
    expect(readKotRouting({ counters: 'nope' })).toEqual(DEFAULT_KOT_ROUTING);
  });

  it('reads a stored setup', () => {
    const stored = { counters: [{ name: 'Bar', categories: ['Coffee'] }], full_copy: true };
    expect(readKotRouting(stored)).toEqual(stored);
  });
});

describe('splitKotItems', () => {
  const line = (id: string, menu_item_id: string | null, voided = false) => ({ id, menu_item_id, voided });
  const categories = { latte: 'Coffee', iced: 'Iced Coffee', waffle: 'Stick Waffles', sandwich: 'Eatery' };
  const setup = routing([
    { name: 'Coffee Bar', categories: ['Coffee', 'Iced Coffee'] },
    { name: 'Waffle Counter', categories: ['Stick Waffles'] },
    { name: 'Kitchen', categories: ['Eatery'] },
  ]);

  it('with no counters, prints the one untitled KOT with every line', () => {
    const items = [line('1', 'latte'), line('2', 'waffle')];
    expect(splitKotItems(items, categories, DEFAULT_KOT_ROUTING)).toEqual([{ title: null, kind: 'full', items }]);
  });

  it('puts each line on its counter, in the configured counter order, skipping empty counters', () => {
    const items = [line('1', 'waffle'), line('2', 'latte'), line('3', 'iced')];
    const slips = splitKotItems(items, categories, setup);
    expect(slips.map((s) => [s.title, s.items.map((i) => i.id)])).toEqual([
      ['Coffee Bar', ['2', '3']],
      ['Waffle Counter', ['1']],
    ]);
  });

  it('matches categories case-insensitively', () => {
    const slips = splitKotItems([line('1', 'latte')], { latte: 'coffee' }, setup);
    expect(slips[0].title).toBe('Coffee Bar');
  });

  it('never drops a line: unmapped, unknown and menu-less lines go on the Other items slip', () => {
    const items = [line('1', 'latte'), line('2', 'cake'), line('3', null)];
    const slips = splitKotItems(items, { ...categories, cake: 'Cup Cakes' }, setup);
    expect(slips.map((s) => [s.title, s.kind, s.items.map((i) => i.id)])).toEqual([
      ['Coffee Bar', 'counter', ['1']],
      [OTHER_ITEMS_TITLE, 'other', ['2', '3']],
    ]);
  });

  it('keeps voided lines on their counter so a reprint shows the cancellation', () => {
    const slips = splitKotItems([line('1', 'waffle', true)], categories, setup);
    expect(slips).toEqual([{ title: 'Waffle Counter', kind: 'counter', items: [line('1', 'waffle', true)] }]);
  });

  it('adds the full slip last, with every line, when full_copy is on', () => {
    const items = [line('1', 'latte'), line('2', 'sandwich')];
    const slips = splitKotItems(items, categories, { ...setup, full_copy: true });
    expect(slips.map((s) => s.title)).toEqual(['Coffee Bar', 'Kitchen', FULL_ORDER_TITLE]);
    expect(slips[2].items).toEqual(items);
  });

  it('still prints an (empty) ticket for an order with no lines', () => {
    expect(splitKotItems([], categories, setup)).toEqual([{ title: null, kind: 'full', items: [] }]);
  });
});
