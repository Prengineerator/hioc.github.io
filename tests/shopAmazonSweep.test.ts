import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shopOrder } from './helpers/shopFixture';
import type { ShopOrderRow } from '@/lib/shop/types';

// The nightly delivery sweep checks shipped Amazon orders too, each carrier on
// its own: Amazon is swept when only Amazon is configured, and vice versa.

const s = {
  srConfigured: false,
  amazonConfigured: true,
  srRows: [] as ShopOrderRow[],
  amazonRows: [] as ShopOrderRow[],
  amazonStatus: {} as Record<string, string | 'error'>,
  srCalls: [] as string[],
  amazonCalls: [] as string[],
  earned: [] as string[],
  saved: [] as { id: string; patch: Record<string, unknown> }[],
};

vi.mock('@/lib/payments/gateway', () => ({}));
vi.mock('@/lib/shop/payments', () => ({}));
vi.mock('@/lib/shop/paymentLinkRecovery', () => ({}));
vi.mock('@/lib/loyalty/ledger', () => ({
  earnForShopOrder: (id: string) => {
    s.earned.push(id);
    return Promise.resolve(8);
  },
}));
vi.mock('@/lib/shop/shiprocket', () => ({
  isShiprocketConfigured: () => s.srConfigured,
  fetchShiprocketOrder: (id: string) => {
    s.srCalls.push(id);
    return Promise.resolve({ ok: true, state: { status: 'DELIVERED', awb: 'AWB1', courier: null, shipmentId: null, total: null } });
  },
}));
vi.mock('@/lib/shop/amazonShipping', () => ({
  hasAmazonCredentials: () => s.amazonConfigured,
  getAmazonTracking: (awb: string) => {
    s.amazonCalls.push(awb);
    const st = s.amazonStatus[awb];
    if (!st || st === 'error') return Promise.resolve({ ok: false, error: 'boom' });
    return Promise.resolve({ ok: true, tracking: { trackingId: awb, status: st, promisedDeliveryDate: null, events: [] } });
  },
}));
vi.mock('@/lib/shop/server', () => ({
  isMissingShopSchema: () => false,
  toShopOrderRow: (r: unknown) => r,
  updateShopOrderIf: (_a: unknown, id: string, from: string[], patch: Record<string, unknown>) => {
    const o = [...s.srRows, ...s.amazonRows].find((r) => r.id === id);
    if (!o || !from.includes(o.status)) return Promise.resolve(null);
    s.saved.push({ id, patch });
    return Promise.resolve({ ...o, ...patch });
  },
}));

const lifecycle = await import('@/lib/shop/lifecycle');

function admin(opts: { amazonError?: { code: string } } = {}) {
  return {
    from: () => {
      let amazon = false;
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: (col: string) => {
          if (col === 'carrier') amazon = true;
          return chain;
        },
        not: () => chain,
        order: () => chain,
        limit: () =>
          Promise.resolve(amazon ? (opts.amazonError ? { data: null, error: opts.amazonError } : { data: s.amazonRows, error: null }) : { data: s.srRows, error: null }),
      });
      return chain;
    },
  } as never;
}

const amazonOrder = (id: string, awb: string) => shopOrder({ id, status: 'shipped', carrier: 'amazon', amazon_shipment_id: `S-${id}`, awb_code: awb });

beforeEach(() => {
  s.srConfigured = false;
  s.amazonConfigured = true;
  s.srRows = [];
  s.amazonRows = [];
  s.amazonStatus = {};
  s.srCalls = [];
  s.amazonCalls = [];
  s.earned = [];
  s.saved = [];
});

describe('sweepDeliveredShopOrders with Amazon', () => {
  it('moves a delivered Amazon order to delivered and earns Beanies, leaving in-transit and failed ones', async () => {
    s.amazonRows = [amazonOrder('a', 'TA'), amazonOrder('b', 'TB'), amazonOrder('c', 'TC')];
    s.amazonStatus = { TA: 'Delivered', TB: 'InTransit', TC: 'error' };
    expect(await lifecycle.sweepDeliveredShopOrders(admin())).toEqual({ checked: 3, delivered: 1 });
    expect(s.earned).toEqual(['a']);
    expect(s.saved).toHaveLength(1);
    expect(s.saved[0].patch).toMatchObject({ status: 'delivered', amazon_status: 'Delivered' });
  });

  it('sweeps Amazon even when Shiprocket is not configured, and Shiprocket when Amazon is not', async () => {
    s.amazonRows = [amazonOrder('a', 'TA')];
    s.amazonStatus = { TA: 'Delivered' };
    expect(await lifecycle.sweepDeliveredShopOrders(admin())).toEqual({ checked: 1, delivered: 1 });
    expect(s.srCalls).toEqual([]);

    s.earned = [];
    s.amazonCalls = [];
    s.amazonConfigured = false;
    s.srConfigured = true;
    s.srRows = [shopOrder({ id: 'sr', status: 'shipped', shiprocket_order_id: 'sr_1' })];
    expect(await lifecycle.sweepDeliveredShopOrders(admin())).toEqual({ checked: 1, delivered: 1 });
    expect(s.amazonCalls).toEqual([]);
    expect(s.earned).toEqual(['sr']);
  });

  it('counts both carriers together', async () => {
    s.srConfigured = true;
    s.srRows = [shopOrder({ id: 'sr', status: 'shipped', shiprocket_order_id: 'sr_1' })];
    s.amazonRows = [amazonOrder('a', 'TA')];
    s.amazonStatus = { TA: 'Delivered' };
    expect(await lifecycle.sweepDeliveredShopOrders(admin())).toEqual({ checked: 2, delivered: 2 });
  });

  it('does nothing for Amazon before the database file is applied', async () => {
    s.amazonRows = [amazonOrder('a', 'TA')];
    expect(await lifecycle.sweepDeliveredShopOrders(admin({ amazonError: { code: '42703' } }))).toEqual({ checked: 0, delivered: 0 });
    expect(s.amazonCalls).toEqual([]);
  });
});
