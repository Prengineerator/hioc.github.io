import { beforeEach, describe, expect, it, vi } from 'vitest';

// earnForOrder (lib/loyalty/ledger.ts): a bill with a spend offer on it ("spend
// ₹1099, get the Instant Coffee jar at ₹49") earns no Beanies — that offer
// can't be combined with them. Every other completed, paid order earns as before.

const state: {
  order: Record<string, unknown>;
  offerFields: Record<string, unknown> | null;
  offerError: { code?: string; message?: string } | null;
  inserted: Record<string, unknown>[];
} = { order: {}, offerFields: null, offerError: null, inserted: [] };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      let cols = '';
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: (c: string) => {
          cols = c;
          return chain;
        },
        eq: () => chain,
        maybeSingle: () => {
          if (table === 'orders') {
            return Promise.resolve(
              cols.includes('offer_name')
                ? { data: state.offerFields, error: state.offerError }
                : { data: state.order, error: null },
            );
          }
          if (table === 'loyalty_transactions') return Promise.resolve({ data: null, error: null }); // not earned yet
          if (table === 'loyalty_config') return Promise.resolve({ data: { points_per_inr: 0.1, is_active: true }, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        upsert: () => Promise.resolve({ error: null }),
        insert: (row: Record<string, unknown>) => {
          if (table === 'loyalty_transactions') state.inserted.push(row);
          return Promise.resolve({ error: null });
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      });
      return chain;
    },
  }),
}));

const { earnForOrder } = await import('@/lib/loyalty/ledger');

beforeEach(() => {
  state.order = {
    user_id: null,
    customer_user_id: 'cust-1',
    status: 'completed',
    payment_status: 'paid',
    total_inr: 1200,
    subtotal_inr: 1148,
    order_number: 77,
  };
  state.offerFields = null;
  state.offerError = null;
  state.inserted = [];
});

describe('earnForOrder and the ₹49 jar', () => {
  it('a bill with the spend offer on it earns no Beanies', async () => {
    state.offerFields = { offer_name: 'Instant Coffee at ₹49', offer_discount_inr: 350 };
    await earnForOrder('order-1');
    expect(state.inserted).toEqual([]);
  });

  it('a bill with no offer, or only the 1/2/3-jar offer, earns as before', async () => {
    state.offerFields = { offer_name: null, offer_discount_inr: 299 };
    await earnForOrder('order-1');
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({ user_id: 'cust-1', order_id: 'order-1', type: 'earn' });
  });

  it('a database without the offer columns earns as before', async () => {
    state.offerError = { code: '42703', message: 'column orders.offer_name does not exist' };
    await earnForOrder('order-1');
    expect(state.inserted).toHaveLength(1);
  });
});
