import { describe, expect, it } from 'vitest';
import { summarisePairingEvents, type PairingEventSlice } from '@/lib/suggest/pairingStats';

// COFFEY-ADDONS-PAIRINGS-SPEC §4.4 — the owner "Checkout pairings" arithmetic:
// distinct shown viewers, row-count added/ordered, revenue from ordered rows,
// the add rate, and the top-five pairs. Pure, so no Supabase is needed.

function row(partial: Partial<PairingEventSlice> & Pick<PairingEventSlice, 'event'>): PairingEventSlice {
  return { menu_item_id: null, anchor_item_id: null, value_inr: null, anon_id: null, user_id: null, ...partial };
}

const names = new Map<string, string>([
  ['latte', 'Latte'],
  ['americano', 'Americano'],
  ['mocha', 'Mocha'],
  ['brownie', 'Brownie'],
  ['cake', 'Cake'],
  ['cookie', 'Cookie'],
  ['muffin', 'Muffin'],
]);

describe('summarisePairingEvents: empty input', () => {
  it('returns zeros, a null add rate and no pairs', () => {
    expect(summarisePairingEvents([], new Map())).toEqual({
      shown: 0,
      added: 0,
      ordered: 0,
      addRate: null,
      revenueInr: 0,
      topPairs: [],
    });
  });
});

describe('summarisePairingEvents: shown is distinct (viewer, item)', () => {
  it('counts one viewer seeing the same item several times once', () => {
    const rows = [
      row({ event: 'shown', anon_id: 'a1', menu_item_id: 'brownie', anchor_item_id: 'latte' }),
      row({ event: 'shown', anon_id: 'a1', menu_item_id: 'brownie', anchor_item_id: 'latte' }),
      row({ event: 'shown', anon_id: 'a1', menu_item_id: 'brownie', anchor_item_id: 'latte' }),
    ];
    expect(summarisePairingEvents(rows, names).shown).toBe(1);
  });

  it('counts two viewers of the same item separately', () => {
    const rows = [
      row({ event: 'shown', anon_id: 'a1', menu_item_id: 'brownie', anchor_item_id: 'latte' }),
      row({ event: 'shown', anon_id: 'a2', menu_item_id: 'brownie', anchor_item_id: 'latte' }),
    ];
    expect(summarisePairingEvents(rows, names).shown).toBe(2);
  });

  it('counts one viewer of two items as two', () => {
    const rows = [
      row({ event: 'shown', anon_id: 'a1', menu_item_id: 'brownie', anchor_item_id: 'latte' }),
      row({ event: 'shown', anon_id: 'a1', menu_item_id: 'cookie', anchor_item_id: 'latte' }),
    ];
    expect(summarisePairingEvents(rows, names).shown).toBe(2);
  });

  it('keys the viewer on user_id before anon_id', () => {
    const rows = [
      row({ event: 'shown', user_id: 'u1', anon_id: 'a1', menu_item_id: 'brownie' }),
      row({ event: 'shown', user_id: 'u1', anon_id: 'a2', menu_item_id: 'brownie' }),
    ];
    expect(summarisePairingEvents(rows, names).shown).toBe(1);
  });

  it('puts rows with neither id into one shared anon viewer', () => {
    const rows = [
      row({ event: 'shown', menu_item_id: 'brownie' }),
      row({ event: 'shown', menu_item_id: 'brownie' }),
      row({ event: 'shown', menu_item_id: 'cookie' }),
    ];
    expect(summarisePairingEvents(rows, names).shown).toBe(2);
  });

  it('does not count shown rows as adds', () => {
    const rows = [row({ event: 'shown', anon_id: 'a1', menu_item_id: 'brownie', anchor_item_id: 'latte' })];
    const stats = summarisePairingEvents(rows, names);
    expect(stats.added).toBe(0);
    expect(stats.ordered).toBe(0);
    expect(stats.topPairs).toEqual([]);
  });
});

describe('summarisePairingEvents: added and ordered are row counts', () => {
  it('counts every added row, including repeats by the same viewer', () => {
    const rows = [
      row({ event: 'added', anon_id: 'a1', menu_item_id: 'brownie', anchor_item_id: 'latte' }),
      row({ event: 'added', anon_id: 'a1', menu_item_id: 'brownie', anchor_item_id: 'latte' }),
      row({ event: 'added', anon_id: 'a2', menu_item_id: 'cookie', anchor_item_id: 'latte' }),
    ];
    const stats = summarisePairingEvents(rows, names);
    expect(stats.added).toBe(3);
    expect(stats.ordered).toBe(0);
  });
});

describe('summarisePairingEvents: add rate', () => {
  it('is added ÷ distinct shown', () => {
    const rows = [
      row({ event: 'shown', anon_id: 'a1', menu_item_id: 'brownie' }),
      row({ event: 'shown', anon_id: 'a2', menu_item_id: 'brownie' }),
      row({ event: 'shown', anon_id: 'a3', menu_item_id: 'brownie' }),
      row({ event: 'shown', anon_id: 'a4', menu_item_id: 'brownie' }),
      row({ event: 'added', anon_id: 'a1', menu_item_id: 'brownie', anchor_item_id: 'latte' }),
      row({ event: 'added', anon_id: 'a2', menu_item_id: 'brownie', anchor_item_id: 'latte' }),
      row({ event: 'added', anon_id: 'a3', menu_item_id: 'brownie', anchor_item_id: 'latte' }),
    ];
    expect(summarisePairingEvents(rows, names).addRate).toBe(0.75);
  });

  it('is null when nothing was shown, even if rows were added', () => {
    const rows = [row({ event: 'added', anon_id: 'a1', menu_item_id: 'brownie', anchor_item_id: 'latte' })];
    expect(summarisePairingEvents(rows, names).addRate).toBeNull();
  });
});

describe('summarisePairingEvents: revenue', () => {
  it('sums value_inr on ordered rows only, treating null as 0', () => {
    const rows = [
      row({ event: 'ordered', anchor_item_id: 'latte', menu_item_id: 'brownie', value_inr: 120 }),
      row({ event: 'ordered', anchor_item_id: 'latte', menu_item_id: 'cookie', value_inr: 80 }),
      row({ event: 'ordered', anchor_item_id: 'latte', menu_item_id: 'cake', value_inr: null }),
      row({ event: 'added', anchor_item_id: 'latte', menu_item_id: 'muffin', value_inr: 999 }),
    ];
    const stats = summarisePairingEvents(rows, names);
    expect(stats.revenueInr).toBe(200);
    expect(stats.ordered).toBe(3);
  });

  it('is 0 when there are no ordered rows', () => {
    expect(summarisePairingEvents([row({ event: 'added', anchor_item_id: 'latte', menu_item_id: 'brownie' })], names).revenueInr).toBe(0);
  });
});

describe('summarisePairingEvents: top pairs', () => {
  it('orders by added, then ordered, then anchor and item names', () => {
    const rows = [
      // Latte → Brownie: 2 added, 0 ordered
      row({ event: 'added', anchor_item_id: 'latte', menu_item_id: 'brownie', anon_id: 'a1' }),
      row({ event: 'added', anchor_item_id: 'latte', menu_item_id: 'brownie', anon_id: 'a2' }),
      // Latte → Cake: 2 added, 0 ordered (ties Brownie, so the name decides)
      row({ event: 'added', anchor_item_id: 'latte', menu_item_id: 'cake', anon_id: 'a1' }),
      row({ event: 'added', anchor_item_id: 'latte', menu_item_id: 'cake', anon_id: 'a2' }),
      // Americano → Cookie: 2 added, 1 ordered (ties on added, wins on ordered)
      row({ event: 'added', anchor_item_id: 'americano', menu_item_id: 'cookie', anon_id: 'a1' }),
      row({ event: 'added', anchor_item_id: 'americano', menu_item_id: 'cookie', anon_id: 'a2' }),
      row({ event: 'ordered', anchor_item_id: 'americano', menu_item_id: 'cookie', value_inr: 90 }),
      // Mocha → Muffin: 3 added (most added, comes first)
      row({ event: 'added', anchor_item_id: 'mocha', menu_item_id: 'muffin', anon_id: 'a1' }),
      row({ event: 'added', anchor_item_id: 'mocha', menu_item_id: 'muffin', anon_id: 'a2' }),
      row({ event: 'added', anchor_item_id: 'mocha', menu_item_id: 'muffin', anon_id: 'a3' }),
    ];
    const pairs = summarisePairingEvents(rows, names).topPairs.map((p) => `${p.anchorName} → ${p.name}`);
    expect(pairs).toEqual(['Mocha → Muffin', 'Americano → Cookie', 'Latte → Brownie', 'Latte → Cake']);
  });

  it('keeps the five highest pairs and drops the rest', () => {
    // Six suggested items behind Latte, with 1 to 6 adds each: the sixth (1 add) is cut.
    const items = ['brownie', 'cake', 'cookie', 'muffin', 'mocha', 'americano'];
    const rows = items.flatMap((item, i) =>
      Array.from({ length: i + 1 }, (_, n) => row({ event: 'added', anchor_item_id: 'latte', menu_item_id: item, anon_id: `a${n}` })),
    );
    const stats = summarisePairingEvents(rows, names);
    expect(stats.topPairs).toHaveLength(5);
    expect(stats.topPairs.map((p) => p.added)).toEqual([6, 5, 4, 3, 2]);
    expect(stats.topPairs.map((p) => p.name)).not.toContain('Brownie');
    expect(stats.added).toBe(21);
  });

  it('shows a name the menu no longer has as "Removed item"', () => {
    const rows = [
      row({ event: 'added', anchor_item_id: 'gone-anchor', menu_item_id: 'brownie', anon_id: 'a1' }),
      row({ event: 'added', anchor_item_id: 'latte', menu_item_id: 'gone-item', anon_id: 'a1' }),
    ];
    const pairs = summarisePairingEvents(rows, names).topPairs;
    expect(pairs.find((p) => p.anchorItemId === 'gone-anchor')).toMatchObject({ anchorName: 'Removed item', name: 'Brownie' });
    expect(pairs.find((p) => p.menuItemId === 'gone-item')).toMatchObject({ anchorName: 'Latte', name: 'Removed item' });
  });

  it('lists a pair that only has ordered rows, with zero adds', () => {
    const rows = [row({ event: 'ordered', anchor_item_id: 'latte', menu_item_id: 'brownie', value_inr: 120 })];
    expect(summarisePairingEvents(rows, names).topPairs).toEqual([
      { anchorItemId: 'latte', anchorName: 'Latte', menuItemId: 'brownie', name: 'Brownie', added: 0, ordered: 1 },
    ]);
  });

  it('leaves out rows with a null anchor or item from the pair list but still counts them', () => {
    const rows = [row({ event: 'added', anchor_item_id: null, menu_item_id: 'brownie', anon_id: 'a1' })];
    const stats = summarisePairingEvents(rows, names);
    expect(stats.added).toBe(1);
    expect(stats.topPairs).toEqual([]);
  });
});
