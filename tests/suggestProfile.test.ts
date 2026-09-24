import { describe, expect, it } from 'vitest';
import {
  ICED_LEAN_HOT_THRESHOLD,
  ICED_LEAN_ICED_THRESHOLD,
  ORDERING_MOOD_SAVING_MULTIPLIER,
  ORDERING_MOOD_TREATING_MULTIPLIER,
  PRICE_COMFORT_BUDGET_MAX_INR,
  PRICE_COMFORT_MID_MAX_INR,
  buildTasteProfile,
  pickUsual,
  summarizeProfile,
  type TasteProfileOrder,
} from '@/lib/suggest/profile';
import { SUGGEST_LIMITS } from '@/lib/suggest/types';
import type { SuggestInputs } from '@/lib/suggest/types';
import { buildFixtureMenu, buildFixtureTraitsById } from './fixtures/suggestMenu';

const NOW = new Date('2026-09-24T12:00:00+05:30');

function order(over: Partial<TasteProfileOrder> = {}): TasteProfileOrder {
  return {
    status: 'completed',
    created_at: NOW.toISOString(),
    total_inr: 150,
    subtotal_inr: 150,
    items: [],
    ...over,
  };
}

function line(menuItemId: string, category: string, over: Partial<TasteProfileOrder['items'][number]> = {}) {
  return { menu_item_id: menuItemId, category, quantity: 1, voided: false, ...over };
}

function daysAgo(n: number): string {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function makeInputs(over: Partial<SuggestInputs> = {}): SuggestInputs {
  return {
    temperature: 'either',
    base: 'either',
    extras: [],
    needs: [],
    budget: 'any',
    mood: 'boost',
    note: '',
    ...over,
  };
}

describe('buildTasteProfile', () => {
  const traitsById = buildFixtureTraitsById();

  it('returns an empty-but-valid profile when there are no orders', () => {
    const profile = buildTasteProfile({ orders: [], favorites: [], traitsById, now: NOW });
    expect(profile.topItems).toEqual([]);
    expect(profile.categoryAffinity).toEqual({});
    expect(profile.orderingMood).toBe('routine');
  });

  it('ignores rejected and cancelled orders', () => {
    const orders = [
      order({ status: 'rejected', items: [line('espresso', 'Coffee')] }),
      order({ status: 'cancelled', items: [line('espresso', 'Coffee')] }),
      order({ status: 'completed', items: [line('cappuccino', 'Coffee')] }),
    ];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(profile.topItems.map((t) => t.menu_item_id)).toEqual(['cappuccino']);
  });

  it('ignores voided lines', () => {
    const orders = [
      order({
        items: [line('espresso', 'Coffee', { voided: true }), line('cappuccino', 'Coffee')],
      }),
    ];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(profile.topItems.map((t) => t.menu_item_id)).toEqual(['cappuccino']);
  });

  it('only counts orders within the 90-day window', () => {
    const orders = [
      order({ created_at: daysAgo(91), items: [line('espresso', 'Coffee')] }),
      order({ created_at: daysAgo(89), items: [line('cappuccino', 'Coffee')] }),
    ];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(profile.topItems.map((t) => t.menu_item_id)).toEqual(['cappuccino']);
  });

  it('caps at the newest profileMaxOrders orders', () => {
    const orders = Array.from({ length: SUGGEST_LIMITS.profileMaxOrders + 10 }, (_, i) =>
      order({ created_at: daysAgo(i), items: [line(`item-${i}`, 'Coffee')] }),
    );
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    const countedItems = new Set(profile.topItems.map((t) => t.menu_item_id));
    // Only the newest profileMaxOrders (days 0..49) should be represented.
    expect(countedItems.has('item-0')).toBe(true);
    expect(countedItems.has(`item-${SUGGEST_LIMITS.profileMaxOrders + 5}`)).toBe(false);
  });

  it('counts orders linked via customer_user_id the same as user_id (F4) — caller pre-resolves either into `orders`', () => {
    // buildTasteProfile itself is identity-agnostic (the caller already
    // resolved "orders where user_id = me OR customer_user_id = me" before
    // calling in, per §5.5/F4) — this just confirms every passed-in order
    // counts regardless of which identity it arrived on.
    const orders = [order({ items: [line('espresso', 'Coffee')] })];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(profile.topItems.map((t) => t.menu_item_id)).toEqual(['espresso']);
  });

  it('weights topItems and categoryAffinity by quantity', () => {
    const orders = [
      order({ items: [line('espresso', 'Coffee', { quantity: 3 }), line('belgian-waffle', 'Waffles', { quantity: 1 })] }),
    ];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(profile.topItems[0]).toMatchObject({ menu_item_id: 'espresso', count: 3 });
    expect(profile.categoryAffinity['Coffee']).toBeCloseTo(0.75, 5);
    expect(profile.categoryAffinity['Waffles']).toBeCloseTo(0.25, 5);
  });

  it('computes traitLean from the items it can classify via traitsById', () => {
    const orders = [
      order({
        items: [
          line('on-the-rocks', 'Iced Coffee'), // iced, caffeine high, sweetness 0
          line('cappuccino', 'Coffee'), // hot, caffeine medium, sweetness 1
        ],
      }),
    ];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(profile.traitLean.icedShare).toBeCloseTo(0.5, 5);
    expect(profile.traitLean.meanSweetness).toBeCloseTo(0.5, 5);
    expect(profile.traitLean.caffeineShare).toBe(1); // both drinks are caffeinated
  });

  it('computes median/p75 ticket from total_inr, falling back to subtotal_inr', () => {
    const orders = [
      order({ total_inr: 100, subtotal_inr: 90 }),
      order({ total_inr: null, subtotal_inr: 200 }), // falls back to subtotal
      order({ total_inr: 300, subtotal_inr: 280 }),
    ];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(profile.ticket.median).toBe(200);
  });

  it('priceComfort follows the exported cut points', () => {
    const cheap = buildTasteProfile({
      orders: [order({ total_inr: PRICE_COMFORT_BUDGET_MAX_INR - 1 })],
      favorites: [],
      traitsById,
      now: NOW,
    });
    expect(cheap.priceComfort).toBe('budget');

    const mid = buildTasteProfile({
      orders: [order({ total_inr: PRICE_COMFORT_MID_MAX_INR - 1 })],
      favorites: [],
      traitsById,
      now: NOW,
    });
    expect(mid.priceComfort).toBe('mid');

    const premium = buildTasteProfile({
      orders: [order({ total_inr: PRICE_COMFORT_MID_MAX_INR + 1 })],
      favorites: [],
      traitsById,
      now: NOW,
    });
    expect(premium.priceComfort).toBe('premium');
  });

  it('orderingMood is "treating" when the last 3 orders run well above the 90-day median', () => {
    // 4 older orders (the majority) anchor the 90-day median at 100; the
    // most-recent 3 run well above ORDERING_MOOD_TREATING_MULTIPLIER × that.
    const orders = [
      order({ created_at: daysAgo(80), total_inr: 100 }),
      order({ created_at: daysAgo(70), total_inr: 100 }),
      order({ created_at: daysAgo(60), total_inr: 100 }),
      order({ created_at: daysAgo(50), total_inr: 100 }),
      order({ created_at: daysAgo(3), total_inr: 200 }),
      order({ created_at: daysAgo(2), total_inr: 200 }),
      order({ created_at: daysAgo(1), total_inr: 200 }),
    ];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(profile.ticket.median).toBe(100);
    expect(200).toBeGreaterThanOrEqual(ORDERING_MOOD_TREATING_MULTIPLIER * profile.ticket.median);
    expect(profile.orderingMood).toBe('treating');
  });

  it('orderingMood is "saving" when the last 3 orders run well below the 90-day median', () => {
    // 4 older orders (the majority) anchor the 90-day median at 300; the
    // most-recent 3 run well below ORDERING_MOOD_SAVING_MULTIPLIER × that.
    const orders = [
      order({ created_at: daysAgo(80), total_inr: 300 }),
      order({ created_at: daysAgo(70), total_inr: 300 }),
      order({ created_at: daysAgo(60), total_inr: 300 }),
      order({ created_at: daysAgo(50), total_inr: 300 }),
      order({ created_at: daysAgo(3), total_inr: 150 }),
      order({ created_at: daysAgo(2), total_inr: 150 }),
      order({ created_at: daysAgo(1), total_inr: 150 }),
    ];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(profile.ticket.median).toBe(300);
    expect(150).toBeLessThanOrEqual(ORDERING_MOOD_SAVING_MULTIPLIER * profile.ticket.median);
    expect(profile.orderingMood).toBe('saving');
  });

  it('orderingMood is "explorer" when most lines are distinct items (and spend is steady)', () => {
    const orders = Array.from({ length: 10 }, (_, i) =>
      order({ created_at: daysAgo(i), total_inr: 150, items: [line(`unique-item-${i}`, 'Coffee')] }),
    );
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(profile.orderingMood).toBe('explorer');
  });

  it('orderingMood is "routine" otherwise', () => {
    const orders = Array.from({ length: 6 }, (_, i) =>
      order({ created_at: daysAgo(i), total_inr: 150, items: [line('espresso', 'Coffee')] }),
    );
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(profile.orderingMood).toBe('routine');
  });

  it('carries favorites through unchanged', () => {
    const profile = buildTasteProfile({
      orders: [order({ items: [line('espresso', 'Coffee')] })],
      favorites: ['cappuccino', 'belgian-waffle'],
      traitsById,
      now: NOW,
    });
    expect(profile.favorites).toEqual(['cappuccino', 'belgian-waffle']);
  });
});

describe('summarizeProfile', () => {
  const traitsById = buildFixtureTraitsById();

  it('never leaks more than the documented fields (S-3)', () => {
    const profile = buildTasteProfile({
      orders: [order({ items: [line('espresso', 'Coffee')] })],
      favorites: [],
      traitsById,
      now: NOW,
    });
    const summary = summarizeProfile(profile);
    expect(Object.keys(summary).sort()).toEqual(
      ['topCategories', 'icedLean', 'sweetLean', 'priceComfort', 'orderingMood', 'usualItemIds'].sort(),
    );
  });

  it('caps topCategories at 3 and usualItemIds at 5', () => {
    const orders = [
      order({
        items: [
          line('a', 'Coffee'),
          line('b', 'Iced Coffee'),
          line('c', 'Waffles'),
          line('d', 'Cheesecakes'),
          line('e', 'Cupcakes'),
        ],
      }),
      order({
        created_at: daysAgo(1),
        items: Array.from({ length: 6 }, (_, i) => line(`item-${i}`, 'Coffee')),
      }),
    ];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    const summary = summarizeProfile(profile);
    expect(summary.topCategories.length).toBeLessThanOrEqual(3);
    expect(summary.usualItemIds.length).toBeLessThanOrEqual(5);
  });

  it('buckets icedLean using the exported thresholds', () => {
    const iced = buildTasteProfile({
      orders: [order({ items: [line('on-the-rocks', 'Iced Coffee'), line('iced-latte', 'Iced Coffee')] })],
      favorites: [],
      traitsById,
      now: NOW,
    });
    expect(iced.traitLean.icedShare).toBeGreaterThanOrEqual(ICED_LEAN_ICED_THRESHOLD);
    expect(summarizeProfile(iced).icedLean).toBe('iced');

    const hot = buildTasteProfile({
      orders: [order({ items: [line('espresso', 'Coffee'), line('cappuccino', 'Coffee')] })],
      favorites: [],
      traitsById,
      now: NOW,
    });
    expect(hot.traitLean.icedShare).toBeLessThanOrEqual(ICED_LEAN_HOT_THRESHOLD);
    expect(summarizeProfile(hot).icedLean).toBe('hot');
  });
});

describe('pickUsual', () => {
  const traitsById = buildFixtureTraitsById();
  const items = buildFixtureMenu();

  it('is null when there is no profile (guest)', () => {
    expect(pickUsual(null, items, traitsById, makeInputs())).toBeNull();
  });

  it("is null when the profile has no order history", () => {
    const profile = buildTasteProfile({ orders: [], favorites: [], traitsById, now: NOW });
    expect(pickUsual(profile, items, traitsById, makeInputs())).toBeNull();
  });

  it('returns the most-ordered item when it clears today\'s hard constraints', () => {
    const orders = [
      order({ items: [line('espresso', 'Coffee', { quantity: 5 })] }),
      order({ created_at: daysAgo(1), items: [line('cappuccino', 'Coffee', { quantity: 1 })] }),
    ];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(pickUsual(profile, items, traitsById, makeInputs())).toBe('espresso');
  });

  it("falls through to the next most-ordered item when the top one fails today's filter", () => {
    const orders = [
      order({ items: [line('espresso', 'Coffee', { quantity: 5 })] }), // hot, caffeinated
      order({ created_at: daysAgo(1), items: [line('chai-latte', 'Hot Non-Coffee', { quantity: 3 })] }), // hot, caffeine low but not none
      order({ created_at: daysAgo(2), items: [line('berry-lemonade', 'Iced Non-Coffee', { quantity: 1 })] }), // iced, caffeine none
    ];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    // "No caffeine" rules out espresso and chai-latte; berry-lemonade clears it.
    expect(pickUsual(profile, items, traitsById, makeInputs({ needs: ['no_caffeine'] }))).toBe('berry-lemonade');
  });

  it('is null when nothing in the history clears today\'s filters', () => {
    const orders = [order({ items: [line('espresso', 'Coffee', { quantity: 5 })] })];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(pickUsual(profile, items, traitsById, makeInputs({ needs: ['no_caffeine'] }))).toBeNull();
  });

  it("never returns an unavailable item, even if it was the customer's usual", () => {
    const orders = [order({ items: [line('eighty-sixed', 'Coffee', { quantity: 5 })] })];
    const profile = buildTasteProfile({ orders, favorites: [], traitsById, now: NOW });
    expect(pickUsual(profile, items, traitsById, makeInputs())).toBeNull();
  });
});
