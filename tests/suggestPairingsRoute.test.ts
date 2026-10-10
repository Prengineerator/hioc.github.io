import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Coffey checkout pairings (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §4.2, §4.3):
// POST /api/suggest/pairings, POST /api/suggest/pairings/events, and the
// co-order loader in lib/suggest/serverData.ts.

const AMERICANO = '11111111-1111-4111-8111-111111111111';
const BROWNIE = '22222222-2222-4222-8222-222222222222';
const SANDWICH = '33333333-3333-4333-8333-333333333333';
const LATTE = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';

interface OrderRow {
  order_items: { menu_item_id: string | null; voided: boolean | null }[];
}

interface ChainCall {
  table: string;
  method: string;
  args: unknown[];
}

const state: {
  flag: boolean;
  rateLimitOk: boolean;
  rateLimitCalls: unknown[][];
  sessionUser: { id: string } | null;
  authThrows: boolean;
  menuRows: Record<string, unknown>[];
  traitsRows: Record<string, unknown>[];
  menuError: { message: string } | null;
  orderRows: OrderRow[];
  ordersError: { message: string } | null;
  fromThrows: boolean;
  pairingInserts: Record<string, unknown>[][];
  pairingInsertError: { message: string } | null;
  pairingInsertThrows: boolean;
  calls: ChainCall[];
} = {
  flag: true,
  rateLimitOk: true,
  rateLimitCalls: [],
  sessionUser: null,
  authThrows: false,
  menuRows: [],
  traitsRows: [],
  menuError: null,
  orderRows: [],
  ordersError: null,
  fromThrows: false,
  pairingInserts: [],
  pairingInsertError: null,
  pairingInsertThrows: false,
  calls: [],
};

vi.mock('@/lib/flags', () => ({
  flags: {
    get checkoutPairings() {
      return state.flag;
    },
  },
}));

vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => {
    if (state.authThrows) return Promise.reject(new Error('auth down'));
    return Promise.resolve(state.sessionUser);
  },
}));

vi.mock('@/lib/api/rateLimit', () => ({
  clientIp: () => '203.0.113.9',
  rateLimitOk: (...args: unknown[]) => {
    state.rateLimitCalls.push(args);
    return Promise.resolve(state.rateLimitOk);
  },
}));

function chainFor(table: string) {
  const chain: Record<string, unknown> = {};
  let range: [number, number] | null = null;
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      state.calls.push({ table, method, args });
      if (method === 'range') range = [args[0] as number, args[1] as number];
      return chain;
    };
  Object.assign(chain, {
    select: record('select'),
    eq: record('eq'),
    not: record('not'),
    gte: record('gte'),
    in: record('in'),
    order: record('order'),
    limit: record('limit'),
    range: record('range'),
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
      if (table === 'pairing_events') {
        if (state.pairingInsertThrows) throw new Error('insert exploded');
        state.pairingInserts.push(Array.isArray(payload) ? payload : [payload]);
        return Promise.resolve({ error: state.pairingInsertError });
      }
      return Promise.resolve({ error: null });
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let result: { data: unknown; error: unknown };
      if (table === 'menu_items') {
        result = state.menuError ? { data: null, error: state.menuError } : { data: state.menuRows, error: null };
      } else if (table === 'menu_item_traits') {
        result = { data: state.traitsRows, error: null };
      } else if (table === 'orders') {
        result = state.ordersError
          ? { data: null, error: state.ordersError }
          : { data: range ? state.orderRows.slice(range[0], range[1] + 1) : state.orderRows, error: null };
      } else {
        result = { data: [], error: null };
      }
      return Promise.resolve(result).then(resolve, reject);
    },
  });
  return chain;
}

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      if (state.fromThrows) throw new Error('database unreachable');
      return chainFor(table);
    },
  }),
}));

function menuRow(id: string, name: string, priceInr: number, category: string) {
  return {
    id,
    name,
    description: '',
    category,
    parent_category: 'Menu',
    is_veg: true,
    is_available: true,
    sort_order: 0,
    image_url: '',
    unavailable_until: null,
    short_code: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    menu_item_variants: [{ id: `${id}-var`, menu_item_id: id, label: 'Regular', price_inr: priceInr, sort_order: 0 }],
    menu_item_addon_groups: [],
  };
}

function traitsRow(menu_item_id: string, extra: Record<string, unknown> = {}) {
  return {
    menu_item_id,
    temperature: 'hot',
    caffeine: 'low',
    is_coffee: false,
    sweetness: 0,
    body: 'light',
    kind: 'drink',
    moods: ['cosy'],
    dayparts: ['morning', 'afternoon', 'evening', 'late'],
    flavor_notes: [],
    source: 'owner',
    confirmed: true,
    updated_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

// The pairing ranker's own behaviour is pinned by tests/suggestPairings.test.ts;
// this menu just has to give an Americano a clear pair of picks: a sweet dessert
// (complement 1, plus the bold-coffee/sweet-dessert contrast) and a savoury bite
// (complement 0.8), both from categories of their own.
function seedMenu() {
  state.menuRows = [
    menuRow(AMERICANO, 'Americano', 80, 'Coffee'),
    menuRow(BROWNIE, 'Fudge Brownie', 120, 'Desserts'),
    menuRow(SANDWICH, 'Veg Sandwich', 150, 'Food'),
    menuRow(LATTE, 'Latte', 140, 'Coffee'),
  ];
  state.traitsRows = [
    traitsRow(AMERICANO, { caffeine: 'high', is_coffee: true }),
    traitsRow(BROWNIE, { kind: 'dessert', sweetness: 3, temperature: 'ambient', caffeine: 'none' }),
    traitsRow(SANDWICH, { kind: 'food', temperature: 'ambient', caffeine: 'none' }),
    traitsRow(LATTE, { caffeine: 'medium', is_coffee: true, sweetness: 1 }),
  ];
}

// serverData keeps module-level caches (60 s menu, 10 min co-orders). A fresh
// module registry per test means each test sees its own menu and history.
async function freshModules() {
  vi.resetModules();
  const pairings = await import('@/app/api/suggest/pairings/route');
  const events = await import('@/app/api/suggest/pairings/events/route');
  const serverData = await import('@/lib/suggest/serverData');
  return { pairings, events, serverData };
}

function jsonRequest(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  state.flag = true;
  state.rateLimitOk = true;
  state.rateLimitCalls = [];
  state.sessionUser = null;
  state.authThrows = false;
  state.menuError = null;
  state.orderRows = [];
  state.ordersError = null;
  state.fromThrows = false;
  state.pairingInserts = [];
  state.pairingInsertError = null;
  state.pairingInsertThrows = false;
  state.calls = [];
  seedMenu();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// POST /api/suggest/pairings
// ---------------------------------------------------------------------------

describe('POST /api/suggest/pairings', () => {
  const post = async (body: unknown) => {
    const { pairings } = await freshModules();
    return pairings.POST(jsonRequest('http://t/api/suggest/pairings', body));
  };

  it('404s when the flag is off, before touching anything', async () => {
    state.flag = false;
    const res = await post({ itemIds: [AMERICANO] });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(state.calls).toEqual([]);
    expect(state.rateLimitCalls).toEqual([]);
  });

  it('400s on a body that is not a JSON object', async () => {
    for (const body of ['not json', '[]', '"x"', 'null']) {
      const res = await post(body);
      expect(res.status, body).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    }
  });

  it('400s on a malformed itemIds', async () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`);
    for (const body of [
      {},
      { itemIds: AMERICANO },
      { itemIds: null },
      { itemIds: ['not-a-uuid'] },
      { itemIds: [AMERICANO, 5] },
      { itemIds: tooMany },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    }
    expect(state.calls).toEqual([]); // nothing was loaded for a bad request
  });

  it('429s when the IP is over its limit — keyed per IP, 60 per 10 minutes', async () => {
    state.rateLimitOk = false;
    const res = await post({ itemIds: [AMERICANO] });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(state.rateLimitCalls).toHaveLength(1);
    const [key, max, windowSecs] = state.rateLimitCalls[0];
    expect(String(key)).toContain('203.0.113.9');
    expect(max).toBe(60);
    expect(windowSecs).toBe(600);
  });

  it('answers { picks, items } for a cart: picks ranked, items are their menu rows in pick order', async () => {
    const res = await post({ itemIds: [AMERICANO] });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(Object.keys(data).sort()).toEqual(['items', 'picks']);

    expect(data.picks.map((p: { menuItemId: string }) => p.menuItemId)).toEqual([BROWNIE, SANDWICH]);
    for (const pick of data.picks) {
      expect(pick.anchorItemId).toBe(AMERICANO);
      expect(pick.reason).toContain('Americano');
      expect(pick.reason.length).toBeLessThanOrEqual(90);
      expect(typeof pick.score).toBe('number');
    }

    // The menu rows, shaped like /api/menu items, in the same order as the picks.
    expect(data.items.map((i: { id: string }) => i.id)).toEqual([BROWNIE, SANDWICH]);
    expect(data.items[0]).toMatchObject({ name: 'Fudge Brownie', category: 'Desserts' });
    expect(data.items[0].variants).toEqual([
      expect.objectContaining({ id: `${BROWNIE}-var`, label: 'Regular', price_inr: 120 }),
    ]);
    expect(Array.isArray(data.items[0].addon_groups)).toBe(true);
  });

  it('never suggests something already in the cart, and takes ids de-duplicated', async () => {
    const res = await post({ itemIds: [AMERICANO, BROWNIE, AMERICANO] });
    expect(res.status).toBe(200);
    const data = await res.json();
    const ids = data.picks.map((p: { menuItemId: string }) => p.menuItemId);
    expect(ids).not.toContain(AMERICANO);
    expect(ids).not.toContain(BROWNIE);
  });

  it('makes no model call — it is deterministic and local', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const res = await post({ itemIds: [AMERICANO] });
      expect(res.status).toBe(200);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('an empty cart (or unknown ids) answers 200 with no picks', async () => {
    for (const itemIds of [[], [OTHER]]) {
      const res = await post({ itemIds });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ picks: [], items: [] });
    }
  });

  it('a failing menu load answers 200 with no picks, never a 500', async () => {
    state.menuError = { message: 'boom' };
    const res = await post({ itemIds: [AMERICANO] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ picks: [], items: [] });
  });

  it('an unexpected throw answers 200 with no picks, and logs it', async () => {
    state.fromThrows = true;
    const res = await post({ itemIds: [AMERICANO] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ picks: [], items: [] });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('a failing order-history load costs only the co-order term: the picks still come', async () => {
    state.ordersError = { message: 'orders unavailable' };
    const res = await post({ itemIds: [AMERICANO] });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.picks.map((p: { menuItemId: string }) => p.menuItemId)).toEqual([BROWNIE, SANDWICH]);
  });

  it('order history that pairs the two lifts the reason to "Often ordered with"', async () => {
    // Three joint orders is the minimum pattern (PAIRING_LIMITS.minCoOrders).
    state.orderRows = [
      ...Array.from({ length: 4 }, () => ({
        order_items: [
          { menu_item_id: AMERICANO, voided: false },
          { menu_item_id: SANDWICH, voided: false },
        ],
      })),
      ...Array.from({ length: 4 }, () => ({ order_items: [{ menu_item_id: LATTE, voided: false }] })),
    ];
    const res = await post({ itemIds: [AMERICANO] });
    const data = await res.json();
    const sandwich = data.picks.find((p: { menuItemId: string }) => p.menuItemId === SANDWICH);
    expect(sandwich.reason).toBe('Often ordered with your Americano.');
  });
});

// ---------------------------------------------------------------------------
// loadCoOrderStats (lib/suggest/serverData.ts)
// ---------------------------------------------------------------------------

describe('loadCoOrderStats', () => {
  async function load() {
    const { serverData } = await freshModules();
    const { createAdminSupabaseClient } = await import('@/lib/supabase-server');
    return { loadCoOrderStats: serverData.loadCoOrderStats, admin: createAdminSupabaseClient() };
  }
  const ordersCalls = (method: string) => state.calls.filter((c) => c.table === 'orders' && c.method === method);

  it('groups order lines per order, skipping voided lines and lines with no item', async () => {
    state.orderRows = [
      {
        order_items: [
          { menu_item_id: AMERICANO, voided: false },
          { menu_item_id: BROWNIE, voided: false },
          { menu_item_id: SANDWICH, voided: true }, // voided: never counted
          { menu_item_id: null, voided: false }, // a free-text line
        ],
      },
      { order_items: [{ menu_item_id: AMERICANO, voided: false }, { menu_item_id: AMERICANO, voided: false }] },
      { order_items: [{ menu_item_id: SANDWICH, voided: true }] }, // nothing left: not an order
    ];
    const { loadCoOrderStats, admin } = await load();
    const stats = await loadCoOrderStats(admin);

    expect(stats.orders).toBe(2);
    expect(stats.itemOrders.get(AMERICANO)).toBe(2); // two lines in one order count once
    expect(stats.itemOrders.get(BROWNIE)).toBe(1);
    expect(stats.itemOrders.has(SANDWICH)).toBe(false);
    expect(stats.pairs.size).toBe(1);
  });

  it('reads the last 90 days of non-rejected, non-cancelled orders, newest first', async () => {
    const before = Date.now();
    const { loadCoOrderStats, admin } = await load();
    await loadCoOrderStats(admin);

    const [gte] = ordersCalls('gte');
    expect(gte.args[0]).toBe('created_at');
    const since = new Date(gte.args[1] as string).getTime();
    expect(since).toBeGreaterThanOrEqual(before - 90 * 86_400_000 - 5_000);
    expect(since).toBeLessThanOrEqual(Date.now() - 90 * 86_400_000 + 5_000);

    expect(ordersCalls('not')[0].args).toEqual(['status', 'in', '("rejected","cancelled")']);
    expect(ordersCalls('order')[0].args).toEqual(['created_at', { ascending: false }]);
  });

  it('stays within 5000 orders by paging 1000 at a time', async () => {
    state.orderRows = Array.from({ length: 7000 }, () => ({
      order_items: [{ menu_item_id: AMERICANO, voided: false }],
    }));
    const { loadCoOrderStats, admin } = await load();
    const stats = await loadCoOrderStats(admin);

    expect(stats.orders).toBe(5000);
    expect(ordersCalls('range').map((c) => c.args)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
      [3000, 3999],
      [4000, 4999],
    ]);
  });

  it('stops at a short page', async () => {
    state.orderRows = Array.from({ length: 1200 }, () => ({
      order_items: [{ menu_item_id: AMERICANO, voided: false }],
    }));
    const { loadCoOrderStats, admin } = await load();
    const stats = await loadCoOrderStats(admin);

    expect(stats.orders).toBe(1200);
    expect(ordersCalls('range').map((c) => c.args)).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
  });

  it('is cached for 10 minutes, then loads again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      state.orderRows = [{ order_items: [{ menu_item_id: AMERICANO, voided: false }] }];
      const { loadCoOrderStats, admin } = await load();

      const first = await loadCoOrderStats(admin);
      const queries = () => ordersCalls('range').length;
      expect(queries()).toBe(1);

      vi.setSystemTime(Date.now() + 9 * 60_000);
      expect(await loadCoOrderStats(admin)).toBe(first);
      expect(queries()).toBe(1);

      vi.setSystemTime(Date.now() + 2 * 60_000); // 11 minutes in
      await loadCoOrderStats(admin);
      expect(queries()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('callers that arrive together share one load', async () => {
    state.orderRows = [{ order_items: [{ menu_item_id: AMERICANO, voided: false }] }];
    const { loadCoOrderStats, admin } = await load();
    const [a, b, c] = await Promise.all([loadCoOrderStats(admin), loadCoOrderStats(admin), loadCoOrderStats(admin)]);
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(ordersCalls('range')).toHaveLength(1);
  });

  it('on an error it logs and answers empty stats', async () => {
    state.ordersError = { message: 'boom' };
    const { loadCoOrderStats, admin } = await load();
    const stats = await loadCoOrderStats(admin);
    expect(stats.orders).toBe(0);
    expect(stats.itemOrders.size).toBe(0);
    expect(stats.pairs.size).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('on a throw it also answers empty stats', async () => {
    state.fromThrows = true;
    const { loadCoOrderStats, admin } = await load();
    const stats = await loadCoOrderStats(admin);
    expect(stats.orders).toBe(0);
    expect(errorSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// POST /api/suggest/pairings/events
// ---------------------------------------------------------------------------

describe('POST /api/suggest/pairings/events', () => {
  const post = async (body: unknown) => {
    const { events } = await freshModules();
    return events.POST(jsonRequest('http://t/api/suggest/pairings/events', body));
  };
  const shown = { event: 'shown', menuItemId: BROWNIE, anchorItemId: AMERICANO };
  const added = { event: 'added', menuItemId: SANDWICH, anchorItemId: AMERICANO };

  it('404s when the flag is off, and writes nothing', async () => {
    state.flag = false;
    const res = await post({ events: [shown] });
    expect(res.status).toBe(404);
    expect(state.pairingInserts).toEqual([]);
  });

  it('accepts only the browser whitelist: "ordered" and unknown events are 400', async () => {
    for (const event of ['ordered', 'bogus', '']) {
      const res = await post({ events: [{ ...shown, event }] });
      expect(res.status, event).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    }
    expect(state.pairingInserts).toEqual([]);
  });

  it('400s on a malformed body', async () => {
    for (const body of [
      'not json',
      {},
      { events: [] },
      { events: [shown, shown, shown, shown] }, // 4 > eventsPerRequest
      { events: [{ ...shown, menuItemId: 'nope' }] },
      { events: [{ ...shown, anchorItemId: 'nope' }] },
      { events: [{ event: 'shown', menuItemId: BROWNIE }] },
      { anonId: 'a'.repeat(65), events: [shown] },
      { anonId: 12, events: [shown] },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(state.pairingInserts).toEqual([]);
  });

  it('429s when the IP is over its limit', async () => {
    state.rateLimitOk = false;
    const res = await post({ events: [shown] });
    expect(res.status).toBe(429);
    expect(state.pairingInserts).toEqual([]);
    expect(String(state.rateLimitCalls[0][0])).toContain('203.0.113.9');
  });

  it('inserts the events in one batch and answers 204', async () => {
    const res = await post({ anonId: 'anon-42', events: [shown, added] });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(state.pairingInserts).toEqual([
      [
        { anon_id: 'anon-42', user_id: null, event: 'shown', menu_item_id: BROWNIE, anchor_item_id: AMERICANO },
        { anon_id: 'anon-42', user_id: null, event: 'added', menu_item_id: SANDWICH, anchor_item_id: AMERICANO },
      ],
    ]);
  });

  it('takes user_id from the session', async () => {
    state.sessionUser = { id: 'user-from-session' };
    const res = await post({ events: [shown] });
    expect(res.status).toBe(204);
    expect(state.pairingInserts[0][0]).toMatchObject({ user_id: 'user-from-session', anon_id: null });
  });

  it('never takes user_id from the body — signed in or not', async () => {
    const forged = {
      user_id: 'forged-user',
      userId: 'forged-user',
      events: [{ ...shown, user_id: 'forged-user', userId: 'forged-user' }],
    };

    let res = await post(forged);
    expect(res.status).toBe(204);
    expect(state.pairingInserts[0][0].user_id).toBeNull();

    state.pairingInserts = [];
    state.sessionUser = { id: 'real-user' };
    res = await post(forged);
    expect(res.status).toBe(204);
    expect(state.pairingInserts[0][0].user_id).toBe('real-user');
  });

  it('a failed session lookup just means anonymous', async () => {
    state.authThrows = true;
    const res = await post({ events: [shown] });
    expect(res.status).toBe(204);
    expect(state.pairingInserts[0][0].user_id).toBeNull();
  });

  it('answers 204 even when the insert errors (the table may not exist yet)', async () => {
    state.pairingInsertError = { message: 'relation "pairing_events" does not exist' };
    const res = await post({ events: [shown] });
    expect(res.status).toBe(204);
    expect(errorSpy).toHaveBeenCalled();
  });

  it('answers 204 even when the insert throws', async () => {
    state.pairingInsertThrows = true;
    const res = await post({ events: [shown] });
    expect(res.status).toBe(204);
    expect(errorSpy).toHaveBeenCalled();
  });
});
