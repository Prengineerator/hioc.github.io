import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';

// Phase 7 · SUG-5 — the read-through cache (lib/suggest/profileStore.ts).
// Mocks Supabase; the maths itself (buildTasteProfile) is covered by
// tests/suggestProfile.test.ts.

const state: {
  existingRow: Record<string, unknown> | null;
  orders: Record<string, unknown>[];
  favorites: { menu_item_id: string }[];
  menuItems: { id: string; category: string }[];
  traits: Record<string, unknown>[];
  orFilterCalls: string[];
  ordersOrError: { code?: string; message?: string } | null;
  ordersTableHitCount: number;
  upsertCalls: Record<string, unknown>[];
  profileUpdateCalls: { user_id: string; computed_at: string }[];
} = {
  existingRow: null,
  orders: [],
  favorites: [],
  menuItems: [],
  traits: [],
  orFilterCalls: [],
  ordersOrError: null,
  ordersTableHitCount: 0,
  upsertCalls: [],
  profileUpdateCalls: [],
};

function ordersChain() {
  let usedOr = false;
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    or: (filter: string) => {
      usedOr = true;
      state.orFilterCalls.push(filter);
      return chain;
    },
    eq: () => chain,
    not: () => chain,
    order: () => chain,
    limit: () => {
      state.ordersTableHitCount++;
      if (usedOr && state.ordersOrError) {
        return Promise.resolve({ data: null, error: state.ordersOrError });
      }
      return Promise.resolve({ data: state.orders, error: null });
    },
  });
  return chain;
}

function profilesChain() {
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: state.existingRow, error: null }),
    update: (payload: { computed_at: string }) => ({
      eq: (col: string, val: string) => {
        if (col === 'user_id') state.profileUpdateCalls.push({ user_id: val, computed_at: payload.computed_at });
        return Promise.resolve({ error: null });
      },
    }),
    upsert: (payload: Record<string, unknown>) => {
      state.upsertCalls.push(payload);
      return Promise.resolve({ error: null });
    },
  });
  return chain;
}

function favoritesChain() {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.eq = () => Promise.resolve({ data: state.favorites, error: null });
  return chain;
}

function simpleInChain(table: string) {
  const chain: Record<string, unknown> = {};
  chain.select = () => chain;
  chain.in = () => Promise.resolve({ data: table === 'menu_items' ? state.menuItems : state.traits, error: null });
  return chain;
}

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'orders') return ordersChain();
      if (table === 'customer_taste_profiles') return profilesChain();
      if (table === 'favorites') return favoritesChain();
      if (table === 'menu_items' || table === 'menu_item_traits') return simpleInChain(table);
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

const { getOrBuildProfile, markProfileStale } = await import('@/lib/suggest/profileStore');

beforeEach(() => {
  state.existingRow = null;
  state.orders = [];
  state.favorites = [];
  state.menuItems = [];
  state.traits = [];
  state.orFilterCalls = [];
  state.ordersOrError = null;
  state.ordersTableHitCount = 0;
  state.upsertCalls = [];
  state.profileUpdateCalls = [];
});

describe('getOrBuildProfile', () => {
  it('orders linked only via customer_user_id count toward the profile (F4)', async () => {
    const createdAt = '2026-06-01T10:00:00Z';
    state.orders = [
      {
        status: 'completed',
        created_at: createdAt,
        total_inr: 200,
        subtotal_inr: 200,
        order_items: [{ menu_item_id: 'espresso', quantity: 2, voided: false }],
      },
    ];
    state.menuItems = [{ id: 'espresso', category: 'Coffee' }];
    state.traits = [
      { menu_item_id: 'espresso', temperature: 'hot', caffeine: 'high', is_coffee: true, sweetness: 0, body: 'light', kind: 'drink' },
    ];

    const { profile, optedOut } = await getOrBuildProfile('user-1', new Date('2026-06-10T00:00:00Z'));
    expect(optedOut).toBe(false);
    expect(profile?.topItems).toEqual([{ menu_item_id: 'espresso', count: 2, lastOrderedAt: createdAt }]);
    // The query really does ask for BOTH user_id and customer_user_id.
    expect(state.orFilterCalls.some((f) => f.includes('user_id.eq.user-1') && f.includes('customer_user_id.eq.user-1'))).toBe(
      true,
    );
  });

  it('opted_out short-circuits to profile: null, without reading orders at all', async () => {
    state.existingRow = {
      user_id: 'user-1',
      profile: { topItems: [] },
      order_count: 3,
      computed_at: new Date().toISOString(),
      source_order_at: null,
      opted_out: true,
    };
    const result = await getOrBuildProfile('user-1', new Date());
    expect(result).toEqual({ profile: null, optedOut: true });
    expect(state.ordersTableHitCount).toBe(0);
  });

  it('returns the cached profile unchanged when fresh (within TTL, no newer order)', async () => {
    const now = new Date('2026-06-10T12:00:00Z');
    const sourceOrderAt = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const cachedProfile = {
      topItems: [],
      categoryAffinity: {},
      traitLean: { icedShare: 0, meanSweetness: 0, caffeineShare: 0, foodAttachRate: 0 },
      ticket: { median: 0, p75: 0 },
      priceComfort: 'budget',
      orderingMood: 'routine',
      daypartHistogram: { morning: 0, afternoon: 0, evening: 0, late: 0 },
      favorites: [],
    };
    state.existingRow = {
      user_id: 'user-1',
      profile: cachedProfile,
      order_count: 1,
      computed_at: new Date(now.getTime() - 60 * 60 * 1000).toISOString(), // 1h old — within 24h TTL
      source_order_at: sourceOrderAt,
      opted_out: false,
    };
    // The newest order is exactly source_order_at — not newer.
    state.orders = [{ status: 'completed', created_at: sourceOrderAt, total_inr: 100, subtotal_inr: 100, order_items: [] }];

    const result = await getOrBuildProfile('user-1', now);
    expect(result).toEqual({ profile: cachedProfile, optedOut: false });
    expect(state.upsertCalls.length).toBe(0);
  });

  it('rebuilds when computed_at is older than the 24h TTL', async () => {
    const now = new Date('2026-06-10T12:00:00Z');
    state.existingRow = {
      user_id: 'user-1',
      profile: { topItems: [] },
      order_count: 0,
      computed_at: new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(), // 25h old
      source_order_at: null,
      opted_out: false,
    };
    state.orders = [];

    const result = await getOrBuildProfile('user-1', now);
    expect(result.optedOut).toBe(false);
    expect(state.upsertCalls.length).toBe(1);
    expect((state.upsertCalls[0] as { user_id: string }).user_id).toBe('user-1');
  });

  it('rebuilds when there is an order newer than source_order_at, even within the TTL', async () => {
    const now = new Date('2026-06-10T12:00:00Z');
    state.existingRow = {
      user_id: 'user-1',
      profile: { topItems: [] },
      order_count: 0,
      computed_at: now.toISOString(), // fresh by TTL
      source_order_at: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      opted_out: false,
    };
    state.orders = [{ status: 'completed', created_at: now.toISOString(), total_inr: 100, subtotal_inr: 100, order_items: [] }];

    await getOrBuildProfile('user-1', now);
    expect(state.upsertCalls.length).toBe(1);
  });

  it('degrades to user_id alone when customer_user_id is not deployed yet', async () => {
    state.ordersOrError = { code: '42703', message: 'column orders.customer_user_id does not exist' };
    state.orders = [];
    const result = await getOrBuildProfile('user-1', new Date());
    expect(result.optedOut).toBe(false);
    expect(result.profile?.topItems).toEqual([]);
  });
});

describe('markProfileStale', () => {
  it('is a no-op for a null/undefined userId', async () => {
    await markProfileStale(null);
    await markProfileStale(undefined);
    expect(state.profileUpdateCalls).toEqual([]);
  });

  it('sets computed_at to the epoch for the given user (best-effort)', async () => {
    await markProfileStale('user-1');
    expect(state.profileUpdateCalls).toEqual([{ user_id: 'user-1', computed_at: new Date(0).toISOString() }]);
  });
});
