import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH /api/orders/[id]/payment and the SALE of a HIOC Ritual pass
// (docs/COFFEE-PASS-SPEC.md CP-D6, CP-D15): paying the sale is what issued the
// pass, so once it is 'paid' this route may re-record HOW it was paid (a
// corrected split, cash → UPI) but never move it off 'paid': the way back is a
// refund, which voids the pass first.

const state: {
  existing: Record<string, unknown> | null;
  orderPatch?: Record<string, unknown>;
  insertedParts: Record<string, unknown>[];
} = { existing: null, insertedParts: [] };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          if (table === 'orders') state.orderPatch = p;
          return chain;
        },
        insert: (rows: Record<string, unknown>[]) => {
          if (table === 'order_payments') state.insertedParts.push(...(Array.isArray(rows) ? rows : [rows]));
          return Promise.resolve({ error: null });
        },
        delete: () => chain,
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve(
            ctx.isUpdate
              ? { data: { ...state.existing, ...state.orderPatch }, error: null }
              : { data: state.existing, error: null },
          ),
        single: () => Promise.resolve({ data: { ...state.existing, order_items: [] }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve({ user: { id: 'staff-1' }, role: 'staff', via: 'session' }),
}));
vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification: vi.fn(() => Promise.resolve()) }));

const { PATCH } = await import('@/app/api/orders/[id]/payment/route');

const ORDER_ID = '8f14e45f-ceea-4e0a-9f2b-3c1a7b2d5e60';
const call = (body: Record<string, unknown>) =>
  PATCH(
    new Request('http://localhost/api/orders/x/payment', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id: ORDER_ID } },
  );

const passSale = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  order_kind: 'coffee_pass',
  payment_method: 'cash',
  payment_status: 'paid',
  total_inr: 788,
  subtotal_inr: 750,
  ...over,
});

const REFUSAL = 'A HIOC Ritual has been issued for this sale — refund it instead.';

beforeEach(() => {
  state.existing = passSale();
  state.orderPatch = undefined;
  state.insertedParts = [];
});

describe('PATCH /api/orders/[id]/payment — a paid HIOC Ritual sale', () => {
  it.each(['unpaid', 'payment_pending', 'refunded', 'partially_refunded'])(
    'refuses moving it from paid to %s with a 409 and writes nothing',
    async (status) => {
      const res = await call({ payment_method: 'cash', payment_status: status });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(REFUSAL);
      expect(state.orderPatch).toBeUndefined();
      expect(state.insertedParts).toHaveLength(0);
    },
  );

  it('still lets the tenders be re-recorded while it stays paid (cash → UPI)', async () => {
    const res = await call({ payment_method: 'upi' });
    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ payment_method: 'upi', payment_status: 'paid' });
  });

  it('still lets a split be corrected while it stays paid', async () => {
    const res = await call({
      parts: [
        { method: 'cash', amount_inr: 400 },
        { method: 'upi', amount_inr: 388 },
      ],
    });
    expect(res.status).toBe(200);
    expect(state.insertedParts).toHaveLength(2);
    expect(state.orderPatch).toMatchObject({ payment_status: 'paid' });
  });

  it('an UNPAID sale is settled as usual (this is how it is sold at the counter)', async () => {
    state.existing = passSale({ payment_status: 'unpaid', payment_method: null });
    const res = await call({ payment_method: 'cash' });
    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ payment_method: 'cash', payment_status: 'paid' });
  });
});

describe('PATCH /api/orders/[id]/payment — ordinary orders are unchanged', () => {
  it.each([
    ['a menu order', { order_kind: 'menu' }],
    ['an order from a database before the migration (no order_kind)', { order_kind: undefined }],
  ])('%s can still move off paid', async (_label, over) => {
    state.existing = passSale(over);
    const res = await call({ payment_method: 'cash', payment_status: 'unpaid' });
    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ payment_status: 'unpaid' });
  });
});
