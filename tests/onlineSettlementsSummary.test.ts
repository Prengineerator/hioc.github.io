import { describe, expect, it } from 'vitest';
import {
  bucketLabel,
  buildOnlineSummary,
  istDay,
  rangeCovering,
  resolveRange,
  spreadDeduction,
  weekStart,
  type DeductionRow,
  type OrderRow,
} from '@/lib/online-settlements/summary';

// The money math behind Owner → Online orders (lib/online-settlements/summary.ts).

function row(o: Partial<OrderRow> & { order_id: string; ordered_at: string }): OrderRow {
  return {
    platform: 'zomato',
    status: 'delivered',
    offer: '',
    cancel_reason: '',
    cancel_stage: '',
    menu_sales_inr: 0,
    discount_inr: 0,
    commission_inr: 0,
    payment_fee_inr: 0,
    gst_on_fees_inr: 0,
    tcs_inr: 0,
    tds_inr: 0,
    payout_inr: 0,
    unsettled_inr: 0,
    settlement_status: 'settled',
    settlement_date: null,
    utr: '',
    customer_ref: null,
    ...o,
  };
}

describe('dates', () => {
  it('takes the IST day of a UTC timestamp', () => {
    expect(istDay('2026-04-01T05:35:31+00:00')).toBe('2026-04-01');
    expect(istDay('2026-03-31T19:00:00+00:00')).toBe('2026-04-01'); // 00:30 IST
  });

  it('starts weeks on Monday and labels them', () => {
    expect(weekStart('2026-10-22')).toBe('2026-10-19'); // a Thursday
    expect(weekStart('2026-10-19')).toBe('2026-10-19');
    expect(weekStart('2026-10-25')).toBe('2026-10-19'); // Sunday belongs to the week before
    expect(bucketLabel('2026-10-19', 'week')).toBe('19 Oct – 25 Oct');
    expect(bucketLabel('2026-09', 'month')).toBe('Sep 2026');
  });

  it('resolves the page periods from today', () => {
    expect(resolveRange('4w', '2026-10-22')).toEqual({ from: '2026-09-28', to: '2026-10-22', group: 'week' });
    expect(resolveRange('6m', '2026-10-22')).toEqual({ from: '2026-05-01', to: '2026-10-22', group: 'month' });
    expect(resolveRange('12m', '2026-01-15')).toEqual({ from: '2025-02-01', to: '2026-01-15', group: 'month' });
  });

  it('opens on 12 weeks, or the shortest longer period that reaches every platform\'s latest order', () => {
    // 12 weeks back from Thu 22 Oct 2026 starts Mon 3 Aug; 6 months, 1 May; 12 months, 1 Nov 2025
    expect(rangeCovering([], '2026-10-22')).toBe('12w');
    expect(rangeCovering(['2026-10-21'], '2026-10-22')).toBe('12w'); // never shorter than the default
    expect(rangeCovering(['2026-10-17', '2026-08-03'], '2026-10-22')).toBe('12w');
    expect(rangeCovering(['2026-10-17', '2026-08-02'], '2026-10-22')).toBe('6m');
    // the reported case: Swiggy this month, Zomato only May uploaded so far
    expect(rangeCovering(['2026-10-17', '2026-05-31'], '2026-10-22')).toBe('6m');
    expect(rangeCovering(['2026-04-30'], '2026-10-22')).toBe('12m');
    expect(rangeCovering(['2024-01-01'], '2026-10-22')).toBe('12m'); // nothing reaches: the longest there is
  });

  it('spreads an ad bill evenly over its dates, clipped to the period', () => {
    const ad: DeductionRow = { platform: 'zomato', kind: 'ads', amount_inr: 500, period_start: '2026-09-28', period_end: '2026-10-02', report_period_end: null };
    const days = spreadDeduction(ad, '2026-10-01', '2026-10-31');
    expect([...days.keys()]).toEqual(['2026-10-01', '2026-10-02']);
    expect(days.get('2026-10-01')).toBe(100);
    // no readable dates: lands on the report's last day
    const undated = spreadDeduction({ ...ad, period_start: null, period_end: null, report_period_end: '2026-10-05' }, '2026-10-01', '2026-10-31');
    expect([...undated.entries()]).toEqual([['2026-10-05', 500]]);
  });
});

describe('buildOnlineSummary', () => {
  const orders: OrderRow[] = [
    row({ order_id: '1', ordered_at: '2026-10-05T06:00:00+00:00', menu_sales_inr: 300, discount_inr: 90, commission_inr: 52.5, payment_fee_inr: 4, gst_on_fees_inr: 10.17, tds_inr: 1, payout_inr: 150, utr: 'U1', settlement_date: '2026-10-08', offer: 'SmartPromos GETOFF120ON199', customer_ref: 'c1' }),
    row({ order_id: '2', ordered_at: '2026-10-06T06:00:00+00:00', menu_sales_inr: '200', discount_inr: '0', commission_inr: '50', payout_inr: '140', utr: 'U1', settlement_date: '2026-10-08', customer_ref: 'c1' }),
    row({ order_id: '3', ordered_at: '2026-10-13T06:00:00+00:00', menu_sales_inr: 400, discount_inr: 100, commission_inr: 75, payout_inr: 200, unsettled_inr: 200, settlement_status: 'pending', customer_ref: 'c2' }),
    row({ order_id: '4', ordered_at: '2026-10-14T06:00:00+00:00', status: 'timed_out', menu_sales_inr: 350, payout_inr: -87.5, cancel_reason: 'Not accepted ON time' }),
    row({ order_id: '5', ordered_at: '2026-10-14T07:00:00+00:00', platform: 'swiggy', menu_sales_inr: 500, payout_inr: 300 }),
    row({ order_id: '6', ordered_at: '2026-09-20T06:00:00+00:00', menu_sales_inr: 999, payout_inr: 999 }), // outside the period
  ];
  const deductions: DeductionRow[] = [
    { platform: 'zomato', kind: 'ads', amount_inr: 140, period_start: '2026-10-05', period_end: '2026-10-11', report_period_end: '2026-10-11' },
    { platform: 'zomato', kind: 'hyperpure', amount_inr: 5000, period_start: '2026-10-05', period_end: '2026-10-05', report_period_end: '2026-10-11' },
  ];

  it('totals delivered sales, fees, every-status payout and ads; in your bank is payout minus ads', () => {
    const s = buildOnlineSummary({ orders, deductions, from: '2026-10-05', to: '2026-10-18', group: 'week', platform: 'zomato' });
    expect(s.totals).toMatchObject({
      orders: 3,
      notDelivered: 1,
      menuSales: 900,
      discount: 190,
      fees: 191.67,
      tcsTds: 1,
      payout: 402.5, // 150 + 140 + 200 − 87.5 penalty
      ads: 140, // Hyperpure is not ads
      inBank: 262.5,
      unsettled: 200,
      customers: 2,
    });
    expect(s.totals.keptPer100).toBeCloseTo(29.17, 2);
    expect(s.totals.avgBill).toBe(300);
    expect(s.platforms).toEqual(['zomato']);
  });

  it('groups by week, newest first, each week carrying its own share of ads', () => {
    const s = buildOnlineSummary({ orders, deductions, from: '2026-10-05', to: '2026-10-18', group: 'week', platform: 'zomato' });
    expect(s.buckets.map((b) => b.key)).toEqual(['2026-10-12', '2026-10-05']);
    const [w2, w1] = s.buckets;
    expect(w1.all).toMatchObject({ orders: 2, menuSales: 500, payout: 290, ads: 140, inBank: 150 });
    expect(w2.all).toMatchObject({ orders: 1, notDelivered: 1, payout: 112.5, ads: 0 });
  });

  it('splits platforms and lists transfers, offers and problem orders', () => {
    const s = buildOnlineSummary({ orders, deductions, from: '2026-10-05', to: '2026-10-18', group: 'month', platform: 'all' });
    expect(s.platforms).toEqual(['swiggy', 'zomato']);
    expect(s.byPlatform.swiggy).toMatchObject({ orders: 1, menuSales: 500, payout: 300, ads: 0 });
    expect(s.buckets).toHaveLength(1);
    expect(s.transfers).toEqual([{ platform: 'zomato', utr: 'U1', settlementDate: '2026-10-08', orders: 2, payout: 290 }]);
    expect(s.offers[0]).toMatchObject({ offer: 'No offer', orders: 2 });
    expect(s.offers.find((o) => o.offer === 'SmartPromos GETOFF120ON199')).toMatchObject({ orders: 1, discountShare: 0.3, payoutShare: 0.5 });
    expect(s.problems).toEqual([expect.objectContaining({ orderId: '4', status: 'timed_out', payout: -87.5, reason: 'Not accepted ON time' })]);
  });
});
