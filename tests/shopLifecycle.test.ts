import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shopOrder } from './helpers/shopFixture';
import type { ShopOrderRow } from '@/lib/shop/types';

// lib/shop/lifecycle.ts: expiry pass, delivery sweep, and the delivered /
// cancelled hooks. Supabase, Razorpay, Shiprocket and the ledger are mocked;
// the order table is a small stateful fake so "second run is a no-op" is real.

const NOW = new Date('2026-11-18T10:00:00.000Z');
const minsAgo = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();

const s = {
  orders: new Map<string, ShopOrderRow>(),
  attempts: {} as Record<string, { id: string; status: string; method?: string; amount: number }[] | null>,
  captured: [] as string[],
  reversed: [] as { id: string; reason: string }[],
  reversedIds: new Set<string>(),
  earned: [] as string[],
  deleted: [] as string[],
  rpcCalls: [] as string[],
  rpcFails: false,
  reverseFails: 0,
  srConfigured: true,
  srStates: {} as Record<string, { status: string | null } | 'error'>,
  srCalls: [] as string[],
};

vi.mock('@/lib/payments/gateway', () => ({
  fetchOrderPaymentAttempts: (id: string) => Promise.resolve(id in s.attempts ? s.attempts[id] : []),
}));
vi.mock('@/lib/shop/payments', () => ({
  captureShopPayment: (p: { gatewayOrderId: string }) => {
    s.captured.push(p.gatewayOrderId);
    return Promise.resolve({ handled: true });
  },
}));
vi.mock('@/lib/loyalty/ledger', () => ({
  earnForShopOrder: (id: string) => {
    if (s.earned.includes(id)) return Promise.resolve(0);
    s.earned.push(id);
    return Promise.resolve(8);
  },
  reverseForShopOrder: (id: string, reason: string) => {
    if (s.reverseFails > 0) {
      s.reverseFails--;
      return Promise.resolve(0); // failed: nothing recorded
    }
    if (s.reversedIds.has(id)) return Promise.resolve(0);
    s.reversedIds.add(id);
    s.reversed.push({ id, reason });
    return Promise.resolve(5);
  },
}));
vi.mock('@/lib/shop/shiprocket', () => ({
  isShiprocketConfigured: () => s.srConfigured,
  fetchShiprocketOrder: (id: string) => {
    s.srCalls.push(id);
    const st = s.srStates[id];
    if (!st || st === 'error') return Promise.resolve({ ok: false, error: 'boom' });
    return Promise.resolve({ ok: true, state: { status: st.status, awb: 'AWB1', courier: null, shipmentId: null, total: null } });
  },
}));
vi.mock('@/lib/shop/server', () => ({
  isMissingShopSchema: (e: { code?: string } | null) => e?.code === '42P01',
  toShopOrderRow: (r: unknown) => r,
  updateShopOrderIf: (_a: unknown, id: string, from: string[], patch: Record<string, unknown>) => {
    const o = s.orders.get(id);
    if (!o || !from.includes(o.status)) return Promise.resolve(null);
    const next = { ...o, ...patch } as ShopOrderRow;
    s.orders.set(id, next);
    return Promise.resolve(next);
  },
}));

// A query builder over the fake table: filters by status / created_at and resolves like supabase.
function makeAdmin(opts: { selectError?: { code: string } } = {}) {
  return {
    from: (table: string) => {
      const f: { status?: string; statuses?: string[]; since?: string; before?: string; del: boolean; delId?: string } = { del: false };
      const chain: Record<string, unknown> = {};
      const result = () => {
        if (opts.selectError) return { data: null, error: opts.selectError };
        const rows = [...s.orders.values()]
          .filter((o) => (f.status ? o.status === f.status : true))
          .filter((o) => (f.statuses ? f.statuses.includes(o.status) : true))
          .filter((o) => (f.since ? (o.created_at as string) >= f.since : true))
          .filter((o) => (f.before ? (o.created_at as string) < f.before : true))
          .filter((o) => (f.status === 'shipped' ? !!o.shiprocket_order_id : true))
          .sort((a, b) => String(a.shipped_at).localeCompare(String(b.shipped_at)));
        return { data: rows, error: null };
      };
      Object.assign(chain, {
        select: () => chain,
        not: () => chain,
        in: (_c: string, v: string[]) => {
          f.statuses = v;
          return chain;
        },
        gte: (_c: string, v: string) => {
          f.since = v;
          return chain;
        },
        order: () => chain,
        limit: (n: number) => {
          const r = result();
          return Promise.resolve({ data: r.data?.slice(0, n) ?? null, error: r.error });
        },
        eq: (col: string, v: string) => {
          if (col === 'status') f.status = v;
          if (col === 'shop_order_id') {
            s.deleted.push(`${table}:${v}`);
            return Promise.resolve({ error: null });
          }
          return chain;
        },
        lt: (_c: string, v: string) => {
          f.before = v;
          return Promise.resolve(result());
        },
        delete: () => chain,
      });
      return chain;
    },
    rpc: (fn: string, args: { p_shop_order_id: string }) => {
      s.rpcCalls.push(`${fn}:${args.p_shop_order_id}`);
      return Promise.resolve({ error: s.rpcFails ? { message: 'no fn' } : null });
    },
  } as never;
}

const lifecycle = await import('@/lib/shop/lifecycle');

function put(patch: Partial<ShopOrderRow> & { id: string }) {
  const o = { ...shopOrder(), status: 'payment_pending', razorpay_order_id: `rzp_${patch.id}`, razorpay_payment_id: null, created_at: minsAgo(45), ...patch } as ShopOrderRow;
  s.orders.set(o.id, o);
  return o;
}

beforeEach(() => {
  s.orders.clear();
  s.attempts = {};
  s.captured = [];
  s.reversed = [];
  s.reversedIds.clear();
  s.earned = [];
  s.deleted = [];
  s.rpcCalls = [];
  s.rpcFails = false;
  s.reverseFails = 0;
  s.srConfigured = true;
  s.srStates = {};
  s.srCalls = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('expireStaleShopOrders', () => {
  it('skips orders younger than 30 minutes', async () => {
    put({ id: 'young', created_at: minsAgo(10) });
    expect(await lifecycle.expireStaleShopOrders(makeAdmin(), NOW)).toEqual({ expired: 0, recovered: 0 });
    expect(s.orders.get('young')!.status).toBe('payment_pending');
  });

  it('recovers a captured payment instead of expiring', async () => {
    put({ id: 'a' });
    s.attempts.rzp_a = [{ id: 'pay_1', status: 'captured', amount: 84700 }];
    expect(await lifecycle.expireStaleShopOrders(makeAdmin(), NOW)).toEqual({ expired: 0, recovered: 1 });
    expect(s.captured).toEqual(['rzp_a']);
    expect(s.reversed).toEqual([]);
  });

  it('skips authorized and unreachable orders', async () => {
    put({ id: 'auth' });
    put({ id: 'down' });
    s.attempts.rzp_auth = [{ id: 'p', status: 'authorized', amount: 1 }];
    s.attempts.rzp_down = null;
    expect(await lifecycle.expireStaleShopOrders(makeAdmin(), NOW)).toEqual({ expired: 0, recovered: 0 });
    expect(s.orders.get('auth')!.status).toBe('payment_pending');
    expect(s.orders.get('down')!.status).toBe('payment_pending');
  });

  it('expires and reverses exactly once, never deleting; a second run is a no-op', async () => {
    put({ id: 'a' });
    put({ id: 'half', razorpay_order_id: null });
    s.attempts.rzp_a = [{ id: 'p', status: 'failed', amount: 1 }];
    const admin = makeAdmin();
    expect(await lifecycle.expireStaleShopOrders(admin, NOW)).toEqual({ expired: 2, recovered: 0 });
    expect(s.orders.get('a')).toMatchObject({ status: 'expired', cancel_reason: 'Payment not completed in time' });
    expect(s.orders.get('half')!.status).toBe('expired');
    expect(s.reversed.map((r) => r.id).sort()).toEqual(['a', 'half']);
    expect(s.reversed[0].reason).toBe('payment not completed');
    expect(await lifecycle.expireStaleShopOrders(admin, NOW)).toEqual({ expired: 0, recovered: 0 });
    expect(s.reversed).toHaveLength(2);
    expect(s.orders.size).toBe(2);
    expect(s.deleted).toEqual([]);
  });

  it('retries a failed reversal on the next run, only once', async () => {
    put({ id: 'a' });
    s.attempts.rzp_a = [{ id: 'p', status: 'failed', amount: 1 }];
    s.reverseFails = 2; // the expiry's own call and the same run's retry both fail (outage)
    const admin = makeAdmin();
    await lifecycle.expireStaleShopOrders(admin, NOW);
    expect(s.orders.get('a')!.status).toBe('expired');
    expect(s.reversed).toEqual([]);
    await lifecycle.expireStaleShopOrders(admin, NOW);
    expect(s.reversed).toEqual([{ id: 'a', reason: 'payment not completed' }]);
    await lifecycle.expireStaleShopOrders(admin, NOW);
    expect(s.reversed).toHaveLength(1);
  });

  it('retries the intro-claim release of a cancelled order', async () => {
    put({ id: 'c', status: 'cancelled', created_at: minsAgo(60) });
    s.reversedIds.add('c'); // Beanies already returned; only the claim release failed
    await lifecycle.expireStaleShopOrders(makeAdmin(), NOW);
    expect(s.rpcCalls).toEqual(['release_shop_intro_claim:c']);
    expect(s.reversed).toEqual([]);
  });

  it('never touches a paid order (paid after expiry) or one older than 14 days', async () => {
    put({ id: 'paid', status: 'paid', created_at: minsAgo(60) });
    put({ id: 'old', status: 'cancelled', created_at: minsAgo(15 * 24 * 60) });
    await lifecycle.expireStaleShopOrders(makeAdmin(), NOW);
    expect(s.reversed).toEqual([]);
    expect(s.rpcCalls).toEqual([]);
  });

  it('returns zeros when the shop table is missing', async () => {
    expect(await lifecycle.expireStaleShopOrders(makeAdmin({ selectError: { code: '42P01' } }), NOW)).toEqual({ expired: 0, recovered: 0 });
  });
});

describe('sweepDeliveredShopOrders', () => {
  const shipped = (id: string, shippedAt: string) => put({ id, status: 'shipped', shiprocket_order_id: `sr_${id}`, shipped_at: shippedAt, created_at: minsAgo(9999) });

  it('marks delivered and earns once', async () => {
    shipped('a', '2026-11-10T00:00:00Z');
    s.srStates.sr_a = { status: 'DELIVERED' };
    const admin = makeAdmin();
    expect(await lifecycle.sweepDeliveredShopOrders(admin)).toEqual({ checked: 1, delivered: 1 });
    expect(s.orders.get('a')!.status).toBe('delivered');
    expect(s.earned).toEqual(['a']);
    expect(await lifecycle.sweepDeliveredShopOrders(admin)).toEqual({ checked: 0, delivered: 0 });
    expect(s.earned).toEqual(['a']);
  });

  it('ignores RTO and cancelled statuses', async () => {
    shipped('a', '2026-11-10T00:00:00Z');
    shipped('b', '2026-11-11T00:00:00Z');
    s.srStates.sr_a = { status: 'RTO DELIVERED' };
    s.srStates.sr_b = { status: 'CANCELED' };
    expect(await lifecycle.sweepDeliveredShopOrders(makeAdmin())).toEqual({ checked: 2, delivered: 0 });
    expect(s.earned).toEqual([]);
  });

  it('continues after one Shiprocket error', async () => {
    shipped('a', '2026-11-10T00:00:00Z');
    shipped('b', '2026-11-11T00:00:00Z');
    s.srStates.sr_a = 'error';
    s.srStates.sr_b = { status: 'DELIVERED' };
    expect(await lifecycle.sweepDeliveredShopOrders(makeAdmin())).toEqual({ checked: 2, delivered: 1 });
    expect(s.earned).toEqual(['b']);
  });

  it('respects the limit, oldest shipped first', async () => {
    shipped('new', '2026-11-12T00:00:00Z');
    shipped('old', '2026-11-01T00:00:00Z');
    s.srStates.sr_old = { status: 'DELIVERED' };
    expect(await lifecycle.sweepDeliveredShopOrders(makeAdmin(), 1)).toEqual({ checked: 1, delivered: 1 });
    expect(s.srCalls).toEqual(['sr_old']);
  });

  it('does nothing when Shiprocket is not configured', async () => {
    shipped('a', '2026-11-10T00:00:00Z');
    s.srConfigured = false;
    expect(await lifecycle.sweepDeliveredShopOrders(makeAdmin())).toEqual({ checked: 0, delivered: 0 });
    expect(s.srCalls).toEqual([]);
  });
});

describe('onShopOrderDelivered / onShopOrderCancelled', () => {
  it('earns once', async () => {
    const o = shopOrder({ status: 'delivered' });
    expect(await lifecycle.onShopOrderDelivered(o)).toEqual({ earned: 8 });
    expect(await lifecycle.onShopOrderDelivered(o)).toEqual({ earned: 0 });
  });

  it('cancel reverses and releases the intro claim', async () => {
    const o = shopOrder({ status: 'cancelled' });
    expect(await lifecycle.onShopOrderCancelled(makeAdmin(), o)).toEqual({ beanies_returned: 5 });
    expect(s.reversed).toEqual([{ id: o.id, reason: 'order cancelled' }]);
    expect(s.rpcCalls).toEqual([`release_shop_intro_claim:${o.id}`]);
    expect(await lifecycle.onShopOrderCancelled(makeAdmin(), o)).toEqual({ beanies_returned: 0 });
    expect(s.reversed).toHaveLength(1);
  });

  it('falls back to deleting the claim row when the RPC is missing', async () => {
    s.rpcFails = true;
    const o = shopOrder({ status: 'cancelled' });
    await lifecycle.onShopOrderCancelled(makeAdmin(), o);
    expect(s.deleted).toEqual([`shop_intro_claims:${o.id}`]);
  });
});
