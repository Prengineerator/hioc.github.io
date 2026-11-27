import { describe, expect, it } from 'vitest';
import {
  buildStrategy,
  classifyCampaigns,
  kpiStatus,
  KPI,
  STRATEGY_TARGETS,
  type StrategyDeductionRow,
  type StrategyOrderRow,
} from '@/lib/online-settlements/strategy';

// The Zomato scorecard math (lib/online-settlements/strategy.ts).

function order(o: Partial<StrategyOrderRow> & { order_id: string; day: string }): StrategyOrderRow {
  const { day, ...rest } = o;
  const menu = Number(rest.menu_sales_inr ?? 0);
  const discount = Number(rest.discount_inr ?? 0);
  return {
    platform: 'zomato',
    ordered_at: `${day}T06:00:00+00:00`, // 11:30 IST, the same day
    status: 'delivered',
    offer: '',
    menu_sales_inr: 0,
    packaging_inr: 0,
    discount_inr: 0,
    gst_from_customer_inr: 0,
    net_order_value_inr: menu - discount,
    commission_inr: 0,
    payment_fee_inr: 0,
    gst_on_fees_inr: 0,
    tcs_inr: 0,
    tds_inr: 0,
    payout_inr: 0,
    customer_ref: null,
    ...rest,
  };
}

function ad(d: Partial<StrategyDeductionRow> & { ref: string; amount_inr: number }): StrategyDeductionRow {
  return {
    platform: 'zomato',
    kind: 'ads',
    label: 'ADS',
    period_text: '',
    settlement_status: 'settled',
    period_start: null,
    period_end: null,
    report_period_end: null,
    ...d,
  };
}

// Current window 26 Oct – 22 Nov 2026 (asOf 22 Nov), previous 28 Sep – 25 Oct.
const ASOF = '2026-11-22';
const orders: StrategyOrderRow[] = [
  // c1 first ordered in August: a regular, not a new customer in the window.
  order({ order_id: 'H', day: '2026-08-01', customer_ref: 'c1', menu_sales_inr: 100, payout_inr: 50 }),
  order({ order_id: 'I', day: '2026-10-05', customer_ref: 'c7', menu_sales_inr: 200, payout_inr: 100 }),
  order({
    order_id: 'A', day: '2026-11-03', customer_ref: 'c1', menu_sales_inr: 150, offer: 'SmartPromos TAKEOFF70ON129', discount_inr: 70,
    payout_inr: 60, packaging_inr: 10, commission_inr: 20, payment_fee_inr: 3, gst_on_fees_inr: 4, tcs_inr: 1, tds_inr: 1,
  }),
  order({ order_id: 'B', day: '2026-11-10', customer_ref: 'c2', menu_sales_inr: 350, offer: 'SmartPromos GETOFF120ON199', discount_inr: 120, payout_inr: 200 }),
  order({ order_id: 'C', day: '2026-11-10', customer_ref: 'c3', menu_sales_inr: 500, offer: 'SmartPromos GETOFF180ON449', discount_inr: 180, payout_inr: 300 }),
  order({ order_id: 'D', day: '2026-11-17', customer_ref: 'c4', menu_sales_inr: 600, offer: 'SmartPromos GETOFF200ON599', discount_inr: 200, payout_inr: 380 }),
  order({ order_id: 'E', day: '2026-11-17', customer_ref: 'c5', menu_sales_inr: 400, offer: 'SAVEBITE70', discount_inr: 70, payout_inr: 300 }),
  order({ order_id: 'F', day: '2026-11-18', customer_ref: 'c6', menu_sales_inr: 300, offer: '', payout_inr: 250 }),
  // A cancelled order: its payout counts in the bank figures, nothing else does.
  order({ order_id: 'G', day: '2026-11-18', status: 'cancelled', menu_sales_inr: 999, payout_inr: -50 }),
];
const WINDOW = { period_start: '2026-10-26', period_end: '2026-11-22' };
const deductions: StrategyDeductionRow[] = [
  ad({ ref: 'FIXED1', amount_inr: 118, ...WINDOW }), // 100 + 18% GST: a fixed-budget pack
  ad({ ref: 'GROW1', amount_inr: 59.5, ...WINDOW }), // 50.42 before GST: moves with sales
];

const build = (o = orders, d = deductions) => buildStrategy({ orders: o, deductions: d, asOf: ASOF });
const kpi = (r: ReturnType<typeof build>, key: string) => r.kpis.find((k) => k.key === key)!;

describe('classifyCampaigns', () => {
  it('calls whole-rupee-before-GST bills fixed and the rest sales-linked', () => {
    const rows = [1425.44, 488.52, 99.12, 689.12, 2716.25, 2162.87, 1937.27, 604.73].map((amount_inr, i) => ad({ ref: `R${i}`, amount_inr }));
    const c = classifyCampaigns(rows);
    expect([0, 1, 2, 3].map((i) => c.get(`R${i}`))).toEqual(['fixed_ads', 'fixed_ads', 'fixed_ads', 'fixed_ads']);
    expect([4, 5, 6, 7].map((i) => c.get(`R${i}`))).toEqual(['sales_linked', 'sales_linked', 'sales_linked', 'sales_linked']);
  });

  it('judges a campaign by all of its bills', () => {
    const c = classifyCampaigns([
      ...[1425.44, 1425.44, 198.24].map((amount_inr) => ad({ ref: 'PACK', amount_inr })),
      ...[340.85, 1388.97, 1937.27].map((amount_inr) => ad({ ref: 'GROW', amount_inr })),
    ]);
    expect(c.get('PACK')).toBe('fixed_ads');
    expect(c.get('GROW')).toBe('sales_linked');
  });

  it('leaves bills with no campaign id out of the map and ignores other kinds', () => {
    const c = classifyCampaigns([ad({ ref: '', amount_inr: 340.85 }), ad({ ref: 'X', kind: 'other', amount_inr: 340.85 })]);
    expect(c.size).toBe(0);
  });

  it('treats a bill with no id as its own campaign in the weekly split', () => {
    const r = buildStrategy({
      orders: [order({ order_id: 'a', day: '2026-11-10', menu_sales_inr: 300, payout_inr: 200 })],
      deductions: [
        ad({ ref: '', amount_inr: 118, period_start: '2026-11-09', period_end: '2026-11-15' }),
        ad({ ref: '', amount_inr: 340.85, period_start: '2026-11-09', period_end: '2026-11-15' }),
      ],
      asOf: '2026-11-15',
    });
    const w = r.weeks.find((x) => x.start === '2026-11-09')!;
    expect(w.fixedAds).toBe(118);
    expect(w.salesLinked).toBe(340.85);
  });
});

describe('window', () => {
  it('ends on the latest delivered order day (IST) and ignores later cancelled ones', () => {
    const r = buildStrategy({
      orders: [
        order({ order_id: 'a', day: '2026-11-20', menu_sales_inr: 100 }),
        order({ order_id: 'late', day: '2026-11-21', status: 'cancelled' }),
        { ...order({ order_id: 'night', day: '2026-11-21', menu_sales_inr: 100 }), ordered_at: '2026-11-21T20:00:00+00:00' }, // 01:30 IST on the 22nd
      ],
      deductions: [],
    });
    expect(r.end).toBe('2026-11-22');
    expect(r.current).toEqual({ from: '2026-10-26', to: '2026-11-22' });
    expect(r.previous).toEqual({ from: '2026-09-28', to: '2026-10-25' });
  });

  it('uses asOf when given', () => {
    const r = buildStrategy({ orders, deductions: [], asOf: '2026-11-10' });
    expect(r.current).toEqual({ from: '2026-10-14', to: '2026-11-10' });
    expect(kpi(r, 'ordersPerDay').current).toBeCloseTo(3 / 28, 6); // A and B in the 28 days to 10 Nov
  });

  it('is empty with no delivered Zomato orders', () => {
    for (const o of [[], [order({ order_id: 'x', day: ASOF, status: 'cancelled' })], [{ ...order({ order_id: 's', day: ASOF }), platform: 'swiggy' as const }]]) {
      const r = buildStrategy({ orders: o, deductions: [] });
      expect(r.hasData).toBe(false);
      expect(r.kpis).toEqual([]);
      expect(r.actions).toEqual([]);
    }
  });
});

describe('KPIs', () => {
  const r = build();

  it('computes the current window', () => {
    expect(r.hasData).toBe(true);
    expect(kpi(r, 'ordersPerDay').current).toBeCloseTo(6 / 28, 6);
    expect(kpi(r, 'lowMinDealShare').current).toBeCloseTo(1 / 6, 6); // only the ON129 order
    expect(kpi(r, 'under200Share').current).toBeCloseTo(1 / 6, 6); // only the ₹150 bill
    expect(kpi(r, 'avgBill').current).toBeCloseTo(2300 / 6, 6);
    expect(kpi(r, 'discountShare').current).toBeCloseTo(640 / 2300, 6);
    expect(kpi(r, 'marketingShare').current).toBeCloseTo(177.5 / 2300, 6);
    expect(kpi(r, 'newCustomersPerWeek').current).toBeCloseTo(5 / 4, 6); // c2–c6; c1 was already a customer
    // payout 60+200+300+380+300+250 and −50 on the cancelled order, less 177.5 of marketing
    expect(kpi(r, 'bankPerOrder').current).toBeCloseTo(1262.5 / 6, 6);
    expect(kpi(r, 'bankPerDay').current).toBeCloseTo(1262.5 / 28, 6);
  });

  it('computes the previous window', () => {
    expect(kpi(r, 'ordersPerDay').previous).toBeCloseTo(1 / 28, 6);
    expect(kpi(r, 'avgBill').previous).toBe(200);
    expect(kpi(r, 'under200Share').previous).toBe(0); // ₹200 is not under ₹200
    expect(kpi(r, 'discountShare').previous).toBe(0);
    expect(kpi(r, 'marketingShare').previous).toBe(0);
    expect(kpi(r, 'newCustomersPerWeek').previous).toBeCloseTo(1 / 4, 6);
    expect(kpi(r, 'bankPerOrder').previous).toBe(100);
  });

  it('carries the targets and directions', () => {
    expect(KPI.map((k) => k.key)).toEqual(Object.keys(STRATEGY_TARGETS));
    expect(kpi(r, 'marketingShare')).toMatchObject({ direction: 'max', target: 0.065, unit: 'percent' });
    expect(kpi(r, 'bankPerDay')).toMatchObject({ direction: 'min', target: 2700, unit: 'inr' });
    expect(kpi(r, 'discountShare').status).toBe('off');
    expect(kpi(r, 'lowMinDealShare').status).toBe('met');
  });

  it('has no ratios when the window has no delivered orders', () => {
    const lonely = buildStrategy({ orders: [orders[0]], deductions: [], asOf: ASOF }); // only the August order
    expect(kpi(lonely, 'avgBill')).toMatchObject({ current: null, status: 'off' });
    expect(kpi(lonely, 'bankPerOrder').current).toBeNull();
    expect(kpi(lonely, 'ordersPerDay').current).toBe(0);
  });
});

describe('kpiStatus', () => {
  const min = { direction: 'min' as const, target: 100 };
  const max = { direction: 'max' as const, target: 0.2 };

  it('at-least targets: met, close within 5%, else off', () => {
    expect(kpiStatus(min, 100)).toBe('met');
    expect(kpiStatus(min, 120)).toBe('met');
    expect(kpiStatus(min, 95)).toBe('close');
    expect(kpiStatus(min, 99.9)).toBe('close');
    expect(kpiStatus(min, 94.9)).toBe('off');
  });

  it('at-most targets: met, close within 5%, else off', () => {
    expect(kpiStatus(max, 0.2)).toBe('met');
    expect(kpiStatus(max, 0.1)).toBe('met');
    expect(kpiStatus(max, 0.21)).toBe('close');
    expect(kpiStatus(max, 0.2101)).toBe('off');
  });

  it('is off with no value', () => {
    expect(kpiStatus(min, null)).toBe('off');
    expect(kpiStatus(max, null)).toBe('off');
  });
});

describe('average order anatomy', () => {
  const a = build().anatomy!;

  it('gives rupees per delivered order', () => {
    expect(a.menu).toBeCloseTo(2300 / 6, 6);
    expect(a.packaging).toBeCloseTo(10 / 6, 6);
    expect(a.discount).toBeCloseTo(640 / 6, 6);
    expect(a.platformFees).toBeCloseTo(27 / 6, 6);
    expect(a.taxWithheld).toBeCloseTo(2 / 6, 6);
    expect(a.marketingSalesLinked).toBeCloseTo(59.5 / 6, 6);
    expect(a.marketingFixed).toBeCloseTo(118 / 6, 6);
    expect(a.inBank).toBeCloseTo(1262.5 / 6, 6);
  });

  it('adds up to what reaches the bank', () => {
    const parts = a.menu + a.packaging - a.discount - a.platformFees - a.taxWithheld - a.marketingSalesLinked - a.marketingFixed + a.other;
    expect(parts).toBeCloseTo(a.inBank, 9);
  });
});

describe('offer ladder', () => {
  const ladder = build().ladder;

  it('keeps the tiers in a fixed order', () => {
    expect(ladder.map((t) => t.label)).toEqual([
      'No offer',
      'Minimum order under ₹199',
      '₹199–348',
      '₹349–498',
      '₹499 and up',
      'Other offer codes',
    ]);
  });

  it('puts each offer in its tier', () => {
    expect(ladder.map((t) => t.orders)).toEqual([1, 1, 1, 1, 1, 1]); // '', ON129, ON199, ON449, ON599, SAVEBITE70
    const by = (k: string) => ladder.find((t) => t.key === k)!;
    expect(by('none')).toMatchObject({ avgBill: 300, discountShare: 0, payoutPerOrder: 250 });
    expect(by('under199').share).toBeCloseTo(1 / 6, 6);
    expect(by('t199')).toMatchObject({ avgBill: 350, payoutPerOrder: 200 });
    expect(by('t199').discountShare).toBeCloseTo(120 / 350, 6);
    expect(by('t349').payoutPerOrder).toBe(300);
    expect(by('t499').payoutPerOrder).toBe(380);
    expect(by('other')).toMatchObject({ avgBill: 400, payoutPerOrder: 300 });
  });

  it('shows an empty tier as dashes', () => {
    const l = buildStrategy({ orders: [order({ order_id: 'a', day: ASOF, menu_sales_inr: 300 })], deductions: [] }).ladder;
    expect(l[2]).toMatchObject({ orders: 0, share: 0, avgBill: null, discountShare: null, payoutPerOrder: null });
  });
});

describe('new customers', () => {
  it('does not count a customer whose first order is before the window', () => {
    const r = buildStrategy({
      orders: [
        order({ order_id: '1', day: '2026-01-10', customer_ref: 'old', menu_sales_inr: 300 }),
        order({ order_id: '2', day: '2026-11-10', customer_ref: 'old', menu_sales_inr: 300 }),
        order({ order_id: '3', day: '2026-11-10', customer_ref: 'fresh', menu_sales_inr: 300 }),
        order({ order_id: '4', day: '2026-11-12', customer_ref: 'fresh', menu_sales_inr: 300 }),
        order({ order_id: '5', day: '2026-11-12', customer_ref: null, menu_sales_inr: 300 }),
      ],
      deductions: [],
      asOf: ASOF,
    });
    expect(kpi(r, 'newCustomersPerWeek').current).toBeCloseTo(1 / 4, 6);
  });

  it('counts only delivered orders as a first order', () => {
    const r = buildStrategy({
      orders: [
        order({ order_id: '1', day: '2026-11-01', customer_ref: 'x', status: 'cancelled' }),
        order({ order_id: '2', day: '2026-11-10', customer_ref: 'x', menu_sales_inr: 300 }),
      ],
      deductions: [],
      asOf: ASOF,
    });
    expect(r.weeks.find((w) => w.start === '2026-11-09')!.newCustomers).toBe(1);
    expect(r.weeks.find((w) => w.start === '2026-10-26')!.newCustomers).toBe(0);
  });
});

describe('marketing fee by week', () => {
  const r = build();

  it('lists the last 8 Monday–Sunday weeks, ending with the week holding the end day', () => {
    expect(r.weeks).toHaveLength(8);
    expect(r.weeks[0].start).toBe('2026-09-28');
    expect(r.weeks[7].start).toBe('2026-11-16');
    expect(r.weeks[7].label).toBe('16 Nov – 22 Nov');
  });

  it('spreads each bill over its days and splits it by class', () => {
    const w = r.weeks[7]; // 7 of the bills' 28 days
    expect(w.fee).toBeCloseTo(44.38, 2);
    expect(w.salesLinked).toBeCloseTo(14.88, 2);
    expect(w.fixedAds).toBe(29.5);
    expect(r.weeks[6].fee).toBeCloseTo(44.38, 2);
    expect(r.weeks[4].fee).toBeCloseTo(44.38, 2); // 26 Oct – 1 Nov
    expect(r.weeks[3].fee).toBe(0); // before the bills
  });

  it('works out net sales, the effective rate, orders and new customers', () => {
    const w = r.weeks[7]; // D, E, F: net 400 + 330 + 300
    expect(w.netSales).toBe(1030);
    expect(w.effectiveRate).toBeCloseTo(14.875 / 1.18 / 1030, 6);
    expect(w.orders).toBe(3);
    expect(w.newCustomers).toBe(3);
    expect(r.weeks[6]).toMatchObject({ netSales: 550, orders: 2, newCustomers: 2 });
    expect(r.weeks[5]).toMatchObject({ netSales: 80, orders: 1, newCustomers: 0 }); // c1 is a regular
    expect(r.weeks[1].effectiveRate).toBe(0); // sales but no sales-linked fee
    expect(r.weeks[0].effectiveRate).toBeNull(); // no sales at all
  });

  it('notes a full week with orders and no fee, but not a week with no orders', () => {
    expect(r.billingNotes).toEqual(['No marketing fee billed for 5 Oct – 11 Oct']);
  });

  it('notes a one-day sales-linked bill that is too big for that day', () => {
    const withBills = build(orders, [
      ...deductions,
      ad({ ref: 'ONEDAY', amount_inr: 600, period_start: '2026-11-10', period_end: '2026-11-10' }), // 508.47 before GST vs 550 net sales that day
      ad({ ref: 'SMALL', amount_inr: 50, period_start: '2026-11-17', period_end: '2026-11-17' }), // 42.37 vs 700
      ad({ ref: 'PACK1', amount_inr: 1180, period_start: '2026-11-03', period_end: '2026-11-03' }), // fixed budget: not a sales-linked bill
    ]);
    expect(withBills.billingNotes).toContain(
      'Bill dated 10 Nov 2026 is labelled as one day but is ₹600: confirm with Zomato which days it covers',
    );
    expect(withBills.billingNotes.filter((x) => x.startsWith('Bill dated'))).toHaveLength(1);
  });
});

describe('actions', () => {
  it('lists what is off, in priority order, from the numbers', () => {
    const r = buildStrategy({
      orders: [
        order({ order_id: 'a', day: '2026-11-10', customer_ref: 'a', menu_sales_inr: 150, offer: 'SmartPromos TAKEOFF70ON129', discount_inr: 70, payout_inr: 100 }),
        order({ order_id: 'b', day: '2026-11-11', customer_ref: 'b', menu_sales_inr: 250, payout_inr: 250 }),
      ],
      deductions: [ad({ ref: 'G', amount_inr: 340.85, period_start: '2026-10-26', period_end: '2026-11-22' })],
      asOf: ASOF,
    });
    expect(r.actions.map((a) => a.key)).toEqual(['lowMinDeals', 'avgBill', 'marketing']);
    const low = r.actions[0].detail;
    expect(low).toContain('50.0%');
    expect(low).toContain('₹100 an order, against ₹250');
    expect(low).toContain('raise the SmartPromos minimum order to ₹199');
    const mkt = r.actions[2].detail;
    expect(mkt).toContain('₹341'); // the fee
    expect(mkt).toContain('₹170 per new customer'); // 340.85 over 2 new customers
    expect(r.actions.length).toBeLessThanOrEqual(5);
  });

  it('says all targets are met when they are', () => {
    // 490 delivered orders over the 28 days (17.5 a day), each from a new customer, no offer, ₹400 bills.
    const many = Array.from({ length: 490 }, (_, i) =>
      order({
        order_id: `o${i}`,
        day: new Date(Date.parse('2026-10-26T00:00:00Z') + (i % 28) * 86400000).toISOString().slice(0, 10),
        customer_ref: `c${i}`,
        menu_sales_inr: 400,
        discount_inr: 40,
        payout_inr: 250,
      }),
    );
    const r = buildStrategy({ orders: many, deductions: [ad({ ref: 'P', amount_inr: 118, ...WINDOW })], asOf: ASOF });
    expect(r.kpis.map((k) => k.status)).toEqual(Array(9).fill('met'));
    expect(r.billingNotes).toEqual([]);
    expect(r.actions).toEqual([expect.objectContaining({ key: 'allMet', title: 'All targets met' })]);
  });

  it('adds the billing notes', () => {
    const r = build();
    expect(r.actions.at(-1)).toMatchObject({ key: 'billing' });
    expect(r.actions.at(-1)!.detail).toContain('No marketing fee billed for 5 Oct – 11 Oct');
  });
});
