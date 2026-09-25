import { beforeEach, describe, expect, it, vi } from 'vitest';

// POS-5 — GET /api/customers/orders, the "Last orders" list behind the POS
// modal. Same gate/rate-limit discipline as lookup (tests/
// customersLookupRoute.test.ts); this focuses on the beneficiary match (an
// account widens the filter past the bare phone) and the one-query item
// shaping (order_items → items, order_item_addons → addons).

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  customer: { userId: string; name: string } | null;
  rateLimitKeys: string[];
  rows: Record<string, unknown>[];
  orFilters: string[];
  selects: string[];
} = { actor: null, customer: null, rateLimitKeys: [], rows: [], orFilters: [], selects: [] };

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
      expect(table).toBe('orders');
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

beforeEach(() => {
  state.actor = null;
  state.customer = null;
  state.rateLimitKeys = [];
  state.rows = [];
  state.orFilters = [];
  state.selects = [];
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
});
