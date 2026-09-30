import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH /api/orders/[id]/payment and the SALE of a HIOC Ritual pass
// (docs/COFFEE-PASS-SPEC.md CP-D6, CP-D15): paying the sale is what issued the
// pass, so once it is 'paid' this route may re-record HOW it was paid (a
// corrected split, cash → UPI) but never move it off 'paid': the way back is a
// refund, which voids the pass first. The same route also never sets a refund
// state on ANY order (only the refund route does), and never settles a Ritual
// sale short: the pass is issued in full, so the sale is paid in full.

const state: {
  existing: Record<string, unknown> | null;
  role: string;
  orderPatch?: Record<string, unknown>;
  insertedParts: Record<string, unknown>[];
} = { existing: null, role: 'staff', insertedParts: [] };

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
  getCounterActor: () => Promise.resolve({ user: { id: 'staff-1' }, role: state.role, via: 'session' }),
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
  state.role = 'staff';
  state.orderPatch = undefined;
  state.insertedParts = [];
});

describe('PATCH /api/orders/[id]/payment — a paid HIOC Ritual sale', () => {
  // The refund states are not on this list any more: this route refuses them
  // outright, for every order (see the 'refund states' block below).
  it.each(['unpaid', 'payment_pending'])(
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

const REFUND_REFUSAL = 'Refunds go through the refund screen.';

describe('PATCH /api/orders/[id]/payment — refund states are never set from here', () => {
  it.each([
    ['a paid HIOC Ritual sale', passSale()],
    ['an unpaid HIOC Ritual sale', passSale({ payment_status: 'unpaid', payment_method: null })],
    ['a paid menu order', passSale({ order_kind: 'menu' })],
    ['an unpaid menu order', passSale({ order_kind: 'menu', payment_status: 'unpaid', payment_method: null })],
    ['an order from a database before the migration', passSale({ order_kind: undefined })],
  ])('%s: refunded and partially_refunded are 400s and nothing is written', async (_label, existing) => {
    for (const status of ['refunded', 'partially_refunded']) {
      state.existing = existing;
      const res = await call({ payment_method: 'cash', payment_status: status });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(REFUND_REFUSAL);
      expect(state.orderPatch).toBeUndefined();
      expect(state.insertedParts).toHaveLength(0);
    }
  });

  it('is refused before the rest of the body is read: with parts, or with no payment_method at all', async () => {
    for (const body of [
      { parts: [{ method: 'cash', amount_inr: 788 }], payment_status: 'refunded' },
      { payment_status: 'partially_refunded' },
    ]) {
      const res = await call(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(REFUND_REFUSAL);
    }
    expect(state.orderPatch).toBeUndefined();
    expect(state.insertedParts).toHaveLength(0);
  });

  it('a manager and the owner get the same answer: the route is not where a refund is decided', async () => {
    for (const role of ['manager', 'owner']) {
      state.role = role;
      const res = await call({ payment_method: 'cash', payment_status: 'refunded' });
      expect(res.status).toBe(400);
    }
    expect(state.orderPatch).toBeUndefined();
  });

  it('still accepts the three states it is for (unpaid / payment_pending / paid)', async () => {
    state.existing = passSale({ order_kind: 'menu', payment_status: 'unpaid', payment_method: null });
    for (const status of ['payment_pending', 'paid', 'unpaid']) {
      state.orderPatch = undefined;
      const res = await call({ payment_method: 'upi', payment_status: status });
      expect(res.status).toBe(200);
      expect(state.orderPatch).toMatchObject({ payment_status: status });
    }
  });

  it('an unknown status is still an ordinary 400, and the message no longer lists the refund states', async () => {
    const res = await call({ payment_method: 'cash', payment_status: 'settled' });
    expect(res.status).toBe(400);
    const { error } = (await res.json()) as { error: string };
    expect(error).toBe('payment_status must be one of: unpaid, payment_pending, paid');
  });
});

const SHORT_REFUSAL = "A HIOC Ritual can't be settled short — take the full amount or cancel the sale.";

describe('PATCH /api/orders/[id]/payment — a HIOC Ritual sale is never settled short', () => {
  beforeEach(() => {
    state.existing = passSale({ payment_status: 'unpaid', payment_method: null });
  });

  // ₹788 sale, ₹20 short: the till gets ₹768.
  const shortBody = (shortInr: number) => ({
    parts: [{ method: 'cash', amount_inr: 788 - shortInr }],
    adjustment: { short_inr: shortInr, reason: 'Rounded off' },
  });

  it.each([
    ['staff', 20],
    ['staff', 50],
    ['manager', 20],
    ['manager', 300],
    ['owner', 788],
  ])('%s settling ₹%i short: 409, and nothing is recorded', async (role, shortInr) => {
    state.role = role;
    const res = await call(shortBody(shortInr));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(SHORT_REFUSAL);
    expect(state.orderPatch).toBeUndefined();
    expect(state.insertedParts).toHaveLength(0);
  });

  it('answers 409, not the manager 403, when staff try a big shortfall: no one can approve it', async () => {
    state.role = 'staff';
    const res = await call(shortBody(200));
    expect(res.status).toBe(409);
  });

  it('a tip is extra money and is still allowed', async () => {
    const res = await call({
      parts: [{ method: 'cash', amount_inr: 808 }],
      adjustment: { tip_inr: 20, reason: 'Kept the change' },
    });
    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ payment_status: 'paid', tip_inr: 20, settle_discount_inr: 0 });
  });

  it('settling the full amount (split tenders) is unchanged', async () => {
    const res = await call({
      parts: [
        { method: 'cash', amount_inr: 400 },
        { method: 'upi', amount_inr: 388 },
      ],
    });
    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ payment_status: 'paid' });
  });

  it('a zero short is no shortfall', async () => {
    const res = await call({
      parts: [{ method: 'cash', amount_inr: 788 }],
      adjustment: { short_inr: 0, tip_inr: 0, reason: '' },
    });
    expect(res.status).toBe(200);
  });

  it('a menu order can still be settled short (this is a Ritual rule only)', async () => {
    state.existing = passSale({ order_kind: 'menu', payment_status: 'unpaid', payment_method: null });
    const res = await call(shortBody(20));
    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ payment_status: 'paid', settle_discount_inr: 20 });
  });

  it('a database before the migration (no order_kind) reads as a menu order and is unchanged', async () => {
    state.existing = passSale({ order_kind: undefined, payment_status: 'unpaid', payment_method: null });
    const res = await call(shortBody(20));
    expect(res.status).toBe(200);
  });
});
