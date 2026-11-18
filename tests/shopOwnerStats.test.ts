import { describe, expect, it } from 'vitest';
import { allocateProportionally, shopLineStats, type StatsOrder } from '@/lib/shop/ownerStats';
import type { ShopLine } from '@/lib/shop/types';

const jar = (qty: number, total: number, legacy = true): ShopLine => ({
  product_id: 'classic',
  name: 'Classic',
  sku: 'C',
  unit_price_inr: total / qty,
  quantity: qty,
  line_total_inr: total,
  ...(legacy ? {} : { line: 'instant' as const }),
});
const blend = (qty: number, total: number): ShopLine => ({
  product_id: 'home-blend-500',
  name: 'Blend',
  sku: 'HB',
  unit_price_inr: total / qty,
  quantity: qty,
  line_total_inr: total,
  line: 'home_blend',
});
const order = (o: Partial<StatsOrder> & Pick<StatsOrder, 'lines' | 'total_inr'>): StatsOrder => ({
  status: 'paid',
  refunded_inr: null,
  shipping_inr: 0,
  ...o,
});

describe('shopLineStats', () => {
  it('is all zeros for no orders', () => {
    expect(shopLineStats([])).toEqual({
      instant: { units: 0, revenue_inr: 0 },
      home_blend: { units: 0, revenue_inr: 0 },
      total: { orders: 0, units: 0, revenue_inr: 0 },
    });
  });

  it('splits a mixed order by line and leaves shipping out', () => {
    const s = shopLineStats([
      order({
        lines: [jar(2, 600, false), blend(1, 400)],
        total_inr: 1049,
        shipping_inr: 49,
      }),
    ]);
    expect(s.instant).toEqual({ units: 2, revenue_inr: 600 });
    expect(s.home_blend).toEqual({ units: 1, revenue_inr: 400 });
    expect(s.total).toEqual({ orders: 1, units: 3, revenue_inr: 1000 });
  });

  it('shares a discounted order in proportion to the line totals', () => {
    // 1000 of goods, 100 off: goods after discounts 900, split 600:400.
    const s = shopLineStats([order({ lines: [jar(2, 600), blend(1, 400)], total_inr: 900 })]);
    expect(s.instant.revenue_inr).toBe(540);
    expect(s.home_blend.revenue_inr).toBe(360);
  });

  it('leaves out cancelled, unpaid and expired orders', () => {
    const lines = [jar(1, 300)];
    const s = shopLineStats([
      order({ lines, total_inr: 300, status: 'cancelled', refunded_inr: 300 }),
      order({ lines, total_inr: 300, status: 'payment_pending' }),
      order({ lines, total_inr: 300, status: 'expired' }),
      order({ lines, total_inr: 300, status: 'delivered' }),
    ]);
    expect(s.total).toEqual({ orders: 1, units: 1, revenue_inr: 300 });
  });

  it('nets a partial refund off revenue and ignores a full one', () => {
    const lines = [jar(1, 300), blend(1, 300)];
    const partial = shopLineStats([order({ lines, total_inr: 600, refunded_inr: 200 })]);
    expect(partial.total.revenue_inr).toBe(400);
    expect(partial.instant.revenue_inr + partial.home_blend.revenue_inr).toBe(400);
    const full = shopLineStats([order({ lines, total_inr: 600, refunded_inr: 600 })]);
    expect(full.total).toEqual({ orders: 0, units: 0, revenue_inr: 0 });
  });

  it('counts legacy v1 lines (no line field) as instant', () => {
    const s = shopLineStats([order({ lines: [jar(3, 900)], total_inr: 900 })]);
    expect(s.instant).toEqual({ units: 3, revenue_inr: 900 });
    expect(s.home_blend.units).toBe(0);
  });
});

describe('allocateProportionally', () => {
  it('always adds up to the goods total', () => {
    for (const [amount, weights] of [
      [100, [1, 1, 1]],
      [999, [333, 333, 334]],
      [7, [600, 400]],
      [0, [5, 5]],
      [50, [0, 0]],
    ] as [number, number[]][]) {
      const shares = allocateProportionally(amount, weights);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(shares.every((x) => Number.isInteger(x) && x >= 0)).toBe(true);
    }
  });

  it('keeps the order total across awkward splits', () => {
    const s = shopLineStats([
      order({
        lines: [jar(1, 333), blend(1, 333), jar(1, 334)],
        total_inr: 997,
      }),
    ]);
    expect(s.total.revenue_inr).toBe(997);
  });
});
