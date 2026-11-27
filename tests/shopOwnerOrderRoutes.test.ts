import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shopOrder } from './helpers/shopFixture';
import type { ShopOrderRow } from '@/lib/shop/types';

// Owner shop order routes: mark_delivered earns Beanies; cancel refunds the
// money paid (total_inr), returns/reverses Beanies, and a second cancel is 409.

const ID = '7d0c3f0e-1b2a-4c5d-8e9f-0a1b2c3d4e5f';
const s = {
  order: null as ShopOrderRow | null,
  earned: [] as string[],
  reversed: new Set<string>(),
  refunds: [] as { paymentId: string; amount: number }[],
  srStatus: 'DELIVERED' as string,
};

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve({ id: 'owner' }) }));
vi.mock('@/lib/api/background', () => ({ runAfterResponse: () => {} }));
vi.mock('@/lib/shop/emails', () => ({
  sendShopShippedEmail: () => Promise.resolve(),
  sendShopCancelledEmail: () => Promise.resolve(),
}));
vi.mock('@/lib/payments/gateway', () => ({
  createGatewayRefund: (paymentId: string, amount: number) => {
    s.refunds.push({ paymentId, amount });
    return Promise.resolve({ id: 'rfnd_1' });
  },
}));
vi.mock('@/lib/shop/shiprocket', () => ({
  cancelShiprocketOrder: () => Promise.resolve({ ok: true }),
  fetchShiprocketOrder: () =>
    Promise.resolve({ ok: true, state: { status: s.srStatus, awb: 'AWB1', courier: 'Delhivery', shipmentId: null, total: null } }),
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  earnForShopOrder: (id: string) => {
    if (s.earned.includes(id)) return Promise.resolve(0);
    s.earned.push(id);
    return Promise.resolve(8);
  },
  reverseForShopOrder: (id: string) => {
    if (s.reversed.has(id)) return Promise.resolve(0);
    s.reversed.add(id);
    return Promise.resolve(12);
  },
}));
vi.mock('@/lib/shop/payments', () => ({ captureShopPayment: () => Promise.resolve({ handled: false }) }));
vi.mock('@/lib/shop/server', () => ({
  isMissingShopSchema: () => false,
  toShopOrderRow: (r: unknown) => r,
  getShopOrder: () => Promise.resolve({ ok: true, order: s.order }),
  saveShiprocketTotal: (_a: unknown, o: ShopOrderRow) => Promise.resolve(o),
  updateShopOrderIf: (_a: unknown, _id: string, from: string[], patch: Record<string, unknown>) => {
    if (!s.order || !from.includes(s.order.status)) return Promise.resolve(null);
    s.order = { ...s.order, ...patch } as ShopOrderRow;
    return Promise.resolve(s.order);
  },
}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => {
    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      update: (patch: Record<string, unknown>) => {
        // The refund claim: only matches while refund_id is unset.
        (chain as { _claim?: boolean })._claim = 'refund_id' in patch && patch.refund_id === 'pending';
        return chain;
      },
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      select: () => chain,
      maybeSingle: () => {
        if (s.order && !s.order.refund_id && (chain as { _claim?: boolean })._claim) {
          s.order = { ...s.order, refund_id: 'pending' };
          return Promise.resolve({ data: { id: ID }, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    });
    return { from: () => chain, rpc: () => Promise.resolve({ error: null }) };
  },
}));

const { PATCH } = await import('@/app/api/owner/shop/orders/[id]/route');
const { POST: cancel } = await import('@/app/api/owner/shop/orders/[id]/cancel/route');

const { POST: refresh } = await import('@/app/api/owner/shop/orders/[id]/refresh/route');

const params = { params: { id: ID } };
const req = (body: unknown) => new Request('http://localhost/x', { method: 'POST', body: JSON.stringify(body) });

beforeEach(() => {
  s.order = null;
  s.earned = [];
  s.reversed = new Set();
  s.refunds = [];
  s.srStatus = 'DELIVERED';
});

describe('PATCH mark_delivered', () => {
  it('earns Beanies once and responds with them', async () => {
    s.order = shopOrder({ id: ID, status: 'shipped' });
    const res = await PATCH(req({ action: 'mark_delivered' }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order.status).toBe('delivered');
    expect(body.earned).toBe(8);
    expect(s.earned).toEqual([ID]);
    // A double click finds a delivered order: refused, nothing earned twice.
    expect((await PATCH(req({ action: 'mark_delivered' }), params)).status).toBe(409);
    expect(s.earned).toEqual([ID]);
  });
});

describe('POST cancel', () => {
  it('refunds total_inr, returns Beanies and reverses an earned order', async () => {
    s.order = shopOrder({ id: ID, status: 'delivered', total_inr: 700, beanies_redeemed: 100, beanies_discount_inr: 100 });
    const res = await cancel(req({ reason: 'customer asked' }), params);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.order.status).toBe('cancelled');
    expect(body.beanies_returned).toBe(12);
    expect(s.refunds).toEqual([{ paymentId: 'pay_P1', amount: 700 }]);
    expect(s.reversed.has(ID)).toBe(true);
  });

  it('a second cancel is refused with 409 and reverses nothing more', async () => {
    s.order = shopOrder({ id: ID, status: 'paid' });
    expect((await cancel(req({}), params)).status).toBe(200);
    expect((await cancel(req({}), params)).status).toBe(409);
    expect(s.refunds).toHaveLength(1);
  });
});

describe('POST refresh', () => {
  it('a shipped order Shiprocket reports DELIVERED is delivered and earns once', async () => {
    s.order = shopOrder({ id: ID, status: 'shipped', shiprocket_order_id: 'sr_1' });
    const res = await refresh(req({}), params);
    expect(res.status).toBe(200);
    expect((await res.json()).order.status).toBe('delivered');
    expect(s.earned).toEqual([ID]);
    // A second refresh finds a delivered order: no status move, no second earn.
    await refresh(req({}), params);
    expect(s.earned).toEqual([ID]);
  });

  it('a sent_to_shiprocket order reported DELIVERED goes straight to delivered and earns', async () => {
    s.order = shopOrder({ id: ID, status: 'sent_to_shiprocket', shiprocket_order_id: 'sr_1' });
    expect((await refresh(req({}), params)).status).toBe(200);
    expect(s.order!.status).toBe('delivered');
    expect(s.earned).toEqual([ID]);
  });

  it('RTO DELIVERED leaves the order alone and earns nothing', async () => {
    s.srStatus = 'RTO DELIVERED';
    s.order = shopOrder({ id: ID, status: 'shipped', shiprocket_order_id: 'sr_1' });
    expect((await refresh(req({}), params)).status).toBe(200);
    expect(s.order!.status).toBe('shipped');
    expect(s.earned).toEqual([]);
  });
});
