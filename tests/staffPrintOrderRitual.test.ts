import { beforeEach, describe, expect, it, vi } from 'vitest';

// HIOC Ritual (docs/COFFEE-PASS-SPEC.md §8) — getStaffPrintOrder for the receipt of
// a pass SALE: it loads the pass that sale issued (coffee_passes.order_id is
// unique) so the receipt can say "Valid till …", best-effort like every other
// lookup there. And CP-D13: buying a pass earns no Beanies, so nothing is
// projected onto its receipt. Mocks the receipt loader and the admin client.

const state: {
  order: Record<string, unknown> | null;
  pass: { data: unknown; error: unknown } | 'throw';
  passQueried: boolean;
  config: { points_per_inr: number } | null;
  balance: number | null;
} = { order: null, pass: { data: null, error: null }, passQueried: false, config: { points_per_inr: 1 }, balance: 100 };

vi.mock('@/lib/orders/getOrder', () => ({
  getOrderWithCoupon: () => Promise.resolve(state.order),
}));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        in: () => Promise.resolve({ data: [], error: null }),
        maybeSingle: () => {
          if (table === 'coffee_passes') {
            state.passQueried = true;
            if (state.pass === 'throw') throw new Error('boom');
            return Promise.resolve(state.pass);
          }
          return Promise.resolve({ data: null, error: null });
        },
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/loyalty/ledger', async () => {
  const actual = await vi.importActual<typeof import('@/lib/loyalty/ledger')>('@/lib/loyalty/ledger');
  return {
    ...actual,
    getLoyaltyConfig: () => Promise.resolve(state.config),
    getBalance: () => Promise.resolve(state.balance),
  };
});

const { getStaffPrintOrder } = await import('@/lib/orders/getStaffPrintOrder');

function sale(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'order-1',
    order_number: 1042,
    order_kind: 'coffee_pass',
    status: 'completed',
    payment_status: 'paid',
    total_inr: 788,
    subtotal_inr: 750,
    user_id: null,
    customer_user_id: 'user-1',
    created_by: null,
    coupon_code: null,
    items: [],
    ...overrides,
  };
}

beforeEach(() => {
  state.order = null;
  state.pass = { data: null, error: null };
  state.passQueried = false;
  state.config = { points_per_inr: 1 };
  state.balance = 100;
});

describe('getStaffPrintOrder — a HIOC Ritual sale', () => {
  it('loads the pass the sale issued, for the receipt’s "Valid till"', async () => {
    state.order = sale();
    state.pass = { data: { expires_at: '2026-10-04T18:30:00.000Z', drinks_total: 7 }, error: null };
    const result = await getStaffPrintOrder('order-1');
    expect(result?.pass_sale).toEqual({ expires_at: '2026-10-04T18:30:00.000Z', drinks_total: 7 });
  });

  it('is null while the sale is unpaid (no pass exists yet)', async () => {
    state.order = sale({ payment_status: 'unpaid', status: 'accepted' });
    state.pass = { data: null, error: null };
    expect((await getStaffPrintOrder('order-1'))?.pass_sale).toBeNull();
  });

  it('is null when the read fails or throws — the receipt still prints, without the line', async () => {
    state.order = sale();
    state.pass = { data: null, error: { message: 'relation "coffee_passes" does not exist' } };
    expect((await getStaffPrintOrder('order-1'))?.pass_sale).toBeNull();
    state.pass = 'throw';
    expect((await getStaffPrintOrder('order-1'))?.pass_sale).toBeNull();
  });

  it('ignores a pass with no expiry rather than printing a blank date', async () => {
    state.order = sale();
    state.pass = { data: { expires_at: null, drinks_total: 7 }, error: null };
    expect((await getStaffPrintOrder('order-1'))?.pass_sale).toBeNull();
  });

  it('projects no Beanies earned onto the sale’s receipt (CP-D13)', async () => {
    state.order = sale();
    state.pass = { data: { expires_at: '2026-10-04T18:30:00.000Z', drinks_total: 7 }, error: null };
    state.balance = 100;
    const result = await getStaffPrintOrder('order-1');
    expect(result?.points_earned).toBeNull();
    // Just the ledger balance: nothing projected on top.
    expect(result?.points_balance).toBe(100);
  });

  it('never even asks about a pass for an ordinary order', async () => {
    state.order = sale({ order_kind: 'menu' });
    const result = await getStaffPrintOrder('order-1');
    expect(state.passQueried).toBe(false);
    expect(result?.pass_sale).toBeNull();
  });

  it('a menu order still projects its Beanies, as before', async () => {
    state.order = sale({ order_kind: 'menu', status: 'accepted', total_inr: 250 });
    const result = await getStaffPrintOrder('order-1');
    expect(result?.points_earned).toBe(250);
  });
});
