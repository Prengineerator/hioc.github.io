import { beforeEach, describe, expect, it, vi } from 'vitest';

// POS-5 — GET /api/customers/orders, the "Last orders" list behind the POS
// modal. Same gate/rate-limit discipline as lookup (tests/
// customersLookupRoute.test.ts); this focuses on the beneficiary match (an
// account widens the filter past the bare phone) and the one-query item
// shaping (order_items → items, order_item_addons → addons).
//
// Petpooja history (lib/legacy/history.ts) — `legacyRows` defaults to [], so
// every pre-existing test below still merges in nothing and is unaffected;
// the dedicated `describe` block near the bottom exercises the merge/sort/
// cap with legacy bills mixed in. Invented data only (SPEC.md PII rule).

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  customer: { userId: string; name: string } | null;
  rateLimitKeys: string[];
  rows: Record<string, unknown>[];
  orFilters: string[];
  selects: string[];
  // legacy_orders rows (with embedded legacy_order_items) matching this phone.
  legacyRows: Record<string, unknown>[];
} = { actor: null, customer: null, rateLimitKeys: [], rows: [], orFilters: [], selects: [], legacyRows: [] };

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk: (key: string) => {
    state.rateLimitKeys.push(key);
    return Promise.resolve(true);
  },
}));
vi.mock('@/lib/loyalty/customerLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/loyalty/customerLink')>();
  return {
    ...actual,
    findVerifiedCustomerByPhone: () => Promise.resolve(state.customer),
  };
});
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'orders') {
        const chain = {
          select: (cols: string) => {
            state.selects.push(cols);
            return chain;
          },
          or: (filter: string) => {
            state.orFilters.push(filter);
            return chain;
          },
          order: () => chain,
          limit: () => Promise.resolve({ data: state.rows, error: null }),
        };
        return chain;
      }
      if (table === 'legacy_orders') {
        // lib/legacy/history.ts's latestLegacyBillsForPhone: select().eq(phone).order().limit(n).
        const chain = {
          select: (_cols: string) => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => Promise.resolve({ data: state.legacyRows, error: null }),
        };
        return chain;
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

const { GET } = await import('@/app/api/customers/orders/route');

function req(phone: string) {
  return new Request(`https://hioc.in/api/customers/orders?phone=${phone}`);
}

function orderRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'order-1',
    order_number: 1042,
    order_type: 'takeaway',
    status: 'completed',
    payment_status: 'paid',
    total_inr: 220,
    subtotal_inr: 200,
    created_at: '2026-09-20T10:00:00Z',
    table_label: '',
    order_items: [
      {
        id: 'item-1',
        order_id: 'order-1',
        menu_item_id: 'menu-1',
        variant_id: 'variant-1',
        name_snapshot: 'Latte',
        variant_label_snapshot: 'Regular',
        price_inr_snapshot: 100,
        quantity: 2,
        line_total_inr: 220,
        special_instructions: '',
        voided: false,
        void_reason: '',
        voided_by: null,
        voided_at: null,
        order_item_addons: [
          {
            id: 'addon-1',
            order_item_id: 'item-1',
            addon_option_id: 'opt-1',
            group_name_snapshot: 'Milk',
            option_name_snapshot: 'Oat',
            price_inr_snapshot: 20,
          },
        ],
      },
    ],
    ...overrides,
  };
}

function legacyOrderRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'legacy-order-1',
    bill_no: '4021',
    ordered_at: '2026-09-18T10:00:00Z',
    total_inr: 180,
    legacy_order_items: [
      { position: 0, item_name: 'Choco Chip Cupcake', variant_label: '', menu_item_id: 'menu-2', variant_id: null },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  state.actor = null;
  state.customer = null;
  state.rateLimitKeys = [];
  state.rows = [];
  state.orFilters = [];
  state.selects = [];
  state.legacyRows = [];
});

describe('GET /api/customers/orders', () => {
  it('401s with no session and no operator', async () => {
    const res = await GET(req('9876543210'));
    expect(res.status).toBe(401);
  });

  it('400s a malformed phone before touching the database', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    const res = await GET(req('123'));
    expect(res.status).toBe(400);
    expect(state.orFilters).toEqual([]);
  });

  it('is rate-limited under the same discipline as lookup', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    await GET(req('9876543210'));
    expect(state.rateLimitKeys[0]).toBe('customer-orders:staff-1');
  });

  it('matches by phone alone when no account is linked', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.customer = null;
    state.rows = [orderRow()];
    await GET(req('9876543210'));
    expect(state.orFilters[0]).toBe('customer_phone.in.("+919876543210","9876543210")');
  });

  it('widens the match to the linked account\'s customer_user_id/user_id (VAL-2 beneficiary rule)', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.customer = { userId: 'cust-1', name: 'Priya' };
    state.rows = [orderRow()];
    await GET(req('9876543210'));
    expect(state.orFilters[0]).toBe(
      'customer_phone.in.("+919876543210","9876543210"),customer_user_id.eq.cust-1,user_id.eq.cust-1',
    );
  });

  it('selects order_items(*, order_item_addons(*)) in the same query — no N+1', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.rows = [orderRow()];
    await GET(req('9876543210'));
    expect(state.selects[0]).toContain('order_items(*, order_item_addons(*))');
  });

  it('shapes order_items → items and order_item_addons → addons, dropping the FKs', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.rows = [orderRow()];
    const res = await GET(req('9876543210'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.orders).toHaveLength(1);
    const order = body.orders[0];
    expect(order.order_items).toBeUndefined();
    expect(order.items).toHaveLength(1);
    const item = order.items[0];
    expect(item.order_id).toBeUndefined();
    expect(item.order_item_addons).toBeUndefined();
    expect(item.addons).toEqual([
      {
        id: 'addon-1',
        order_item_id: 'item-1',
        addon_option_id: 'opt-1',
        group_name_snapshot: 'Milk',
        option_name_snapshot: 'Oat',
        price_inr_snapshot: 20,
      },
    ]);
  });

  it('returns an empty list rather than an error when nothing matches', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.rows = [];
    const res = await GET(req('9876543210'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ orders: [] });
  });

  it('tags every hioc order source: \'hioc\' — existing fields stay exactly as they were', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.rows = [orderRow()];
    const res = await GET(req('9876543210'));
    const body = await res.json();
    expect(body.orders[0].source).toBe('hioc');
    expect(body.orders[0].order_number).toBe(1042);
  });

  describe('Petpooja history — merging legacy bills into the list', () => {
    it('merges a legacy bill in as source: \'petpooja\', newest first alongside hioc orders', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      state.rows = [orderRow({ created_at: '2026-09-10T10:00:00Z' })]; // older
      state.legacyRows = [legacyOrderRow({ ordered_at: '2026-09-18T10:00:00Z' })]; // newer
      const res = await GET(req('9876543210'));
      const body = await res.json();
      expect(body.orders).toHaveLength(2);
      expect(body.orders[0]).toMatchObject({ source: 'petpooja', bill_no: '4021' });
      expect(body.orders[1]).toMatchObject({ source: 'hioc', order_number: 1042 });
    });

    it('shapes a legacy bill\'s items with name/variant snapshots, ids, and quantity: null — no prices, no addons', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      state.rows = [];
      state.legacyRows = [
        legacyOrderRow({
          legacy_order_items: [
            {
              position: 0,
              item_name: "Hioc's Signature Creme",
              variant_label: 'Extra Large',
              menu_item_id: 'menu-9',
              variant_id: 'variant-9',
            },
          ],
        }),
      ];
      const res = await GET(req('9876543210'));
      const body = await res.json();
      expect(body.orders[0]).toEqual({
        source: 'petpooja',
        id: 'legacy-order-1',
        bill_no: '4021',
        created_at: '2026-09-18T10:00:00Z',
        total_inr: 180,
        items: [
          {
            name_snapshot: "Hioc's Signature Creme",
            variant_label_snapshot: 'Extra Large',
            menu_item_id: 'menu-9',
            variant_id: 'variant-9',
            quantity: null,
          },
        ],
      });
    });

    it('sorts legacy_order_items by position before shaping them', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      state.legacyRows = [
        legacyOrderRow({
          legacy_order_items: [
            { position: 1, item_name: 'Second', variant_label: '', menu_item_id: null, variant_id: null },
            { position: 0, item_name: 'First', variant_label: '', menu_item_id: null, variant_id: null },
          ],
        }),
      ];
      const res = await GET(req('9876543210'));
      const body = await res.json();
      expect(body.orders[0].items.map((i: { name_snapshot: string }) => i.name_snapshot)).toEqual([
        'First',
        'Second',
      ]);
    });

    it('caps the merged list at 10 total, keeping only the newest across both sources', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      // 6 hioc orders, oldest to newest within the batch (Sep 1..6).
      state.rows = Array.from({ length: 6 }, (_, i) =>
        orderRow({ id: `order-${i}`, created_at: `2026-09-0${i + 1}T10:00:00Z` }),
      );
      // 6 legacy bills, newer than all of the above (Sep 10..15).
      state.legacyRows = Array.from({ length: 6 }, (_, i) =>
        legacyOrderRow({ id: `legacy-${i}`, bill_no: `${4000 + i}`, ordered_at: `2026-09-${10 + i}T10:00:00Z` }),
      );
      const res = await GET(req('9876543210'));
      const body = await res.json();
      expect(body.orders).toHaveLength(10);
      // All 6 legacy bills (the newest 6) plus the newest 4 of the 6 hioc orders.
      expect(body.orders.filter((o: { source: string }) => o.source === 'petpooja')).toHaveLength(6);
      expect(body.orders.filter((o: { source: string }) => o.source === 'hioc')).toHaveLength(4);
      // Strictly newest-first across the merged, capped list.
      const timestamps = body.orders.map((o: { created_at: string }) => new Date(o.created_at).getTime());
      expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
    });

    it('still returns the plain hioc list when there is no legacy history for this phone', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
      state.rows = [orderRow()];
      state.legacyRows = [];
      const res = await GET(req('9876543210'));
      const body = await res.json();
      expect(body.orders).toHaveLength(1);
      expect(body.orders[0].source).toBe('hioc');
    });
  });
});
