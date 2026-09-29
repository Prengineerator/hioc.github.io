import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH /api/orders/[id]/payment — the booking / transaction ID on a dining-app
// tender (Swiggy Dineout, Zomato District). The counter must record it on every
// app settle, it is stored normalised on the tender row, and the same booking
// can't be settled on a second live bill.

const state: {
  existing: Record<string, unknown> | null;
  updated: Record<string, unknown> | null;
  insertedParts: Record<string, unknown>[];
  orderPatch?: Record<string, unknown>;
  sameRef: { order_id: string; method: string; reference: string }[];
  refError: { message: string } | null;
  clashOrders: { id: string; order_number: number; status: string; payment_status: string }[];
  refQueried: unknown[] | null;
} = {
  existing: null,
  updated: null,
  insertedParts: [],
  sameRef: [],
  refError: null,
  clashOrders: [],
  refQueried: null,
};

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { isUpdate: false, inCol: '' };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          if (table === 'orders') state.orderPatch = p;
          return chain;
        },
        insert: (rows: Record<string, unknown>[]) => {
          if (table === 'order_payments') state.insertedParts.push(...rows);
          return Promise.resolve({ error: null });
        },
        delete: () => chain,
        eq: () => chain,
        neq: () => chain,
        in: (col: string, vals: unknown[]) => {
          ctx.inCol = col;
          if (table === 'order_payments' && col === 'reference') state.refQueried = vals;
          return chain;
        },
        maybeSingle: () =>
          Promise.resolve(ctx.isUpdate ? { data: state.updated, error: null } : { data: state.existing, error: null }),
        single: () => Promise.resolve({ data: null, error: null }),
        then: (resolve: (v: unknown) => void) => {
          if (table === 'order_payments' && ctx.inCol === 'reference') {
            return resolve({ data: state.refError ? null : state.sameRef, error: state.refError });
          }
          if (table === 'orders' && ctx.inCol === 'id') return resolve({ data: state.clashOrders, error: null });
          return resolve({ data: null, error: null });
        },
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve({ user: { id: 'staff-1' }, role: 'staff', via: 'session' }),
}));
vi.mock('@/lib/notifications/engine', () => ({
  sendBillNotification: () => Promise.resolve({ email: false, whatsapp: false }),
}));

import { PATCH } from '@/app/api/orders/[id]/payment/route';

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

beforeEach(() => {
  state.existing = { payment_method: null, payment_status: 'unpaid', total_inr: 840, subtotal_inr: 800 };
  state.updated = { id: ORDER_ID, payment_method: 'swiggy_dineout', payment_status: 'paid' };
  state.insertedParts = [];
  state.orderPatch = undefined;
  state.sameRef = [];
  state.refError = null;
  state.clashOrders = [];
  state.refQueried = null;
});

describe('booking ID on a dining-app settle', () => {
  it('refuses a single-method app settle without the ID, before touching the order', async () => {
    const res = await call({ payment_method: 'swiggy_dineout' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/booking \/ transaction id/i);
    expect(state.orderPatch).toBeUndefined();
  });

  it('refuses an app part in a split without the ID', async () => {
    const res = await call({
      parts: [
        { method: 'zomato_district', amount_inr: 700 },
        { method: 'cash', amount_inr: 140 },
      ],
    });
    expect(res.status).toBe(400);
    expect(state.orderPatch).toBeUndefined();
  });

  it('stores a single-method app settle as one tender for the whole bill, ID normalised', async () => {
    const res = await call({ payment_method: 'swiggy_dineout', reference: ' sd 4471 9920 ' });
    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ payment_method: 'swiggy_dineout', payment_status: 'paid' });
    expect(state.insertedParts).toEqual([
      expect.objectContaining({ method: 'swiggy_dineout', amount_inr: 840, reference: 'SD44719920' }),
    ]);
    expect(state.refQueried).toEqual(['SD44719920']);
  });

  it('puts the ID only on the app part of a split — the cash row carries no reference key', async () => {
    const res = await call({
      parts: [
        { method: 'zomato_district', amount_inr: 700, reference: 'ZD-1001' },
        { method: 'cash', amount_inr: 140, reference: 'ignored' },
      ],
    });
    expect(res.status).toBe(200);
    expect(state.insertedParts[0]).toMatchObject({ method: 'zomato_district', reference: 'ZD-1001' });
    expect(state.insertedParts[1]).not.toHaveProperty('reference');
  });

  it('never queries for IDs, or sends the column, on a settle with no app tender', async () => {
    const res = await call({ parts: [{ method: 'cash', amount_inr: 840 }] });
    expect(res.status).toBe(200);
    expect(state.refQueried).toBeNull();
    expect(state.insertedParts[0]).not.toHaveProperty('reference');
  });

  it('refuses an ID already on another live order, naming that order', async () => {
    state.sameRef = [{ order_id: 'other', method: 'swiggy_dineout', reference: 'SD1234' }];
    state.clashOrders = [{ id: 'other', order_number: 1042, status: 'completed', payment_status: 'paid' }];
    const res = await call({ payment_method: 'swiggy_dineout', reference: 'sd1234' });
    expect(res.status).toBe(409);
    const { error } = await res.json();
    expect(error).toContain('SD1234');
    expect(error).toContain('1042');
    expect(state.orderPatch).toBeUndefined();
  });

  it('allows an ID whose earlier order was cancelled or fully refunded', async () => {
    state.sameRef = [
      { order_id: 'dead-1', method: 'swiggy_dineout', reference: 'SD1234' },
      { order_id: 'dead-2', method: 'swiggy_dineout', reference: 'SD1234' },
    ];
    state.clashOrders = [
      { id: 'dead-1', order_number: 1, status: 'cancelled', payment_status: 'paid' },
      { id: 'dead-2', order_number: 2, status: 'completed', payment_status: 'refunded' },
    ];
    const res = await call({ payment_method: 'swiggy_dineout', reference: 'SD1234' });
    expect(res.status).toBe(200);
  });

  it('allows the same number on the OTHER app — the IDs are per platform', async () => {
    state.sameRef = [{ order_id: 'other', method: 'zomato_district', reference: 'SD1234' }];
    state.clashOrders = [{ id: 'other', order_number: 7, status: 'completed', payment_status: 'paid' }];
    const res = await call({ payment_method: 'swiggy_dineout', reference: 'SD1234' });
    expect(res.status).toBe(200);
  });

  it('fails closed when the ID check itself fails', async () => {
    state.refError = { message: 'column order_payments.reference does not exist' };
    const res = await call({ payment_method: 'zomato_district', reference: 'ZD9999' });
    expect(res.status).toBe(500);
    expect(state.orderPatch).toBeUndefined();
  });
});
