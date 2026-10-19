import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CsvTable, CsvValue } from '@/lib/reports/csv';
import type { ExportOrder, OrderDataset } from '@/lib/reports/exports/types';
import {
  beaniesCustomerIds,
  beaniesCustomers,
  beaniesLedger,
  beaniesMetrics,
  beaniesSummary,
  campaignMetrics,
  campaignPerformance,
  DEFAULT_LOYALTY_RATES,
  passesAsOf,
  programmeHighlights,
  ritualMetrics,
  ritualPasses,
  ritualRedemptions,
  ritualReferences,
  ritualSummary,
  type BeaniesInput,
  type BeaniesMetrics,
  type BeaniesOrder,
  type CampaignRecord,
  type LedgerRow,
  type LoyaltyCustomer,
  type RitualAdjustment,
  type RitualInput,
  type RitualOrder,
  type RitualPass,
  type RitualRedemption,
} from '@/lib/reports/exports/loyaltyReports';

// The flags are read when loyaltyReportsServer loads (the registry) and again by
// loadProgrammeInsights, so they are a mutable stand-in here. The order dataset
// has its own tests (exportsOrderData*.test.ts): the loaders get a canned one.
const flagState = vi.hoisted(() => ({ coffeePass: true, marketing: true }));
vi.mock('@/lib/flags', () => ({ flags: flagState }));
const datasetFor = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('@/lib/reports/exports/orderDataServer', () => ({
  loadOrderDataset: vi.fn(async () => datasetFor.current),
}));

import { loadOrderDataset } from '@/lib/reports/exports/orderDataServer';
import { LOYALTY_REPORTS, loadProgrammeInsights } from '@/lib/reports/exports/loyaltyReportsServer';

// Pure builders on hand-built rows (the shape the server loaders return), then
// the registry's loaders over a small in-memory fake database (at the end of
// the file). The period is October 2026 in IST: 2026-09-30T18:30Z up to
// 2026-10-31T18:30Z. "Now" is 2 Nov 2026, 12:00 IST.

const FROM = '2026-10-01';
const TO = '2026-10-31';
const NOW = new Date('2026-11-02T06:30:00Z');

/** The cell in `row` under the column whose header is `header`. */
function cell(t: CsvTable, row: number, header: string): CsvValue {
  const i = t.columns.indexOf(header);
  if (i < 0) throw new Error(`no column ${header}`);
  return t.rows[row][i];
}

/** The index of the row whose first cell is `first` (e.g. 'TOTAL'). */
function rowNamed(t: CsvTable, first: string): number {
  return t.rows.findIndex((r) => r[0] === first);
}

/** The Value of the summary row whose Metric is `metric`. */
function metric(t: CsvTable, name: string): CsvValue {
  const i = rowNamed(t, name);
  if (i < 0) throw new Error(`no metric ${name}`);
  return t.rows[i][1];
}

// ═════════════════════════════════════════════════════════════════════════════
// Beanies
// ═════════════════════════════════════════════════════════════════════════════

function tx(id: string, user: string, type: string, points: number, at: string, order: string | null = null, note = ''): LedgerRow {
  return { id, user_id: user, order_id: order, type, points, note, created_at: at };
}

const LEDGER: LedgerRow[] = [
  // Before the period.
  tx('l01', 'u1', 'earn', 50, '2026-09-20T10:00:00Z', 'o1', 'Earned on order #HIOC-001001'),
  tx('l11', 'u5', 'earn', 12, '2026-09-01T10:00:00Z', 'o11'),
  tx('l12', 'u6', 'earn', 10, '2026-09-02T10:00:00Z', 'o12'),
  tx('l13', 'u6', 'redeem', -10, '2026-09-03T10:00:00Z', 'o13'),
  // In the period.
  tx('l02', 'u1', 'earn', 30, '2026-10-05T05:00:00Z', 'o2', 'Earned on order #HIOC-001002'), // 10:30 IST
  tx('l03', 'u1', 'redeem', -20, '2026-10-10T06:00:00Z', 'o3', 'Redeemed for ₹20 discount on order #HIOC-001003'),
  tx('l04', 'u2', 'earn', 40, '2026-10-12T07:00:00Z', 'o4'),
  tx('l05', 'u2', 'reverse', -40, '2026-10-13T07:00:00Z', 'o4', 'Reversed — order refunded/cancelled'),
  tx('l07', 'u3', 'adjust', 5, '2026-10-15T10:00:00Z', null, 'Goodwill'),
  tx('l06', 'u1', 'expire', -10, '2026-10-20T00:30:00Z', null, 'Expired — Beanies older than 30 days'), // 06:00 IST
  tx('l10', 'u4', 'earn', 15, '2026-10-30T06:00:00Z', 'o7'),
  // After the period.
  tx('l09', 'u3', 'earn', 60, '2026-10-31T19:00:00Z', 'o6'), // 00:30 IST on 1 Nov
  tx('l08', 'u1', 'earn', 25, '2026-11-01T05:00:00Z', 'o5'),
];

const order = (id: string, totalInr: number, beaniesDiscountInr = 0, valid = true): BeaniesOrder => ({
  id,
  valid,
  totalInr,
  beaniesDiscountInr,
});

const BEANIES_ORDERS: BeaniesOrder[] = [
  order('o2', 300), // earned
  order('o3', 180, 20), // redeemed 20
  order('o9', 120, 30), // redeemed 30
  order('o4', 250, 0, false), // cancelled: earned, then reversed
  order('o5', 500), // earned (after the period)
  order('o7', 100), // earned
  order('o8', 220), // nothing
];

const CUSTOMERS = new Map<string, LoyaltyCustomer>([
  ['u1', { name: 'Asha Verma', phone: '+919876543210' }],
  ['u2', { name: 'Ravi Kumar', phone: '+919812345678' }],
  ['u3', { name: 'Meera Joshi', phone: '9811122233' }],
  ['u5', { name: 'Esha Rao', phone: '' }],
  ['u6', { name: 'Old Timer', phone: '+919800000006' }],
]);

const INVOICES = new Map<string, string>([
  ['o2', 'HIOC-001002'],
  ['o3', 'HIOC-001003'],
  ['o4', 'HIOC-001004'],
  ['o7', 'HIOC-001007'],
]);

function beaniesInput(patch: Partial<BeaniesInput> = {}): BeaniesInput {
  return {
    from: FROM,
    to: TO,
    now: NOW,
    ledger: LEDGER,
    rates: { inrPerPoint: 1, expiryDays: 30 },
    orders: BEANIES_ORDERS,
    customers: CUSTOMERS,
    invoiceNos: INVOICES,
    ...patch,
  };
}

describe('beaniesMetrics', () => {
  const m = beaniesMetrics(beaniesInput());

  it('adds up the ledger rows of the period by type', () => {
    expect(m.earnedPoints).toBe(85); // 30 + 40 + 15
    expect(m.earnedCustomers).toBe(3);
    expect(m.redeemedPoints).toBe(20);
    expect(m.redeemedCustomers).toBe(1);
    expect(m.expiredPoints).toBe(10);
    expect(m.reversalPoints).toBe(-40);
    expect(m.adjustmentPoints).toBe(5);
    // Earned − redeemed − expired + reversals + adjustments, and the plain sum of the period's rows.
    expect(m.netChangePoints).toBe(20);
    expect(m.earnedPoints - m.redeemedPoints - m.expiredPoints + m.reversalPoints + m.adjustmentPoints).toBe(20);
    expect(m.activeMembers).toBe(3); // u1, u2, u4: u3 only had an adjustment
  });

  it('values what the bills gave away from the bills, and compares average bills with and without', () => {
    expect(m.discountGivenInr).toBe(50);
    expect(m.validBills).toBe(6); // the cancelled one is out
    expect(m.billsWithRedemption).toBe(2);
    expect(m.avgBillWithRedemptionInr).toBe(150); // (180 + 120) / 2
    expect(m.avgBillWithoutRedemptionInr).toBe(280); // (300 + 500 + 100 + 220) / 4
  });

  it('counts revenue only from valid bills that earned and were not reversed', () => {
    // o2, o5 and o7 earned; o4 earned but was cancelled and reversed; o9 and o8 never earned.
    expect(m.billsThatEarned).toBe(3);
    expect(m.revenueFromEarningBillsInr).toBe(900);
  });

  it('measures the balance at the END of the period, not today', () => {
    // u1 50 (the 25 earned on 1 Nov is later), u3 5 (the 60 earned at 00:30 IST on 1 Nov is later),
    // u4 15, u5 12; u2 is back to 0 and u6 spent everything.
    expect(m.outstandingPoints).toBe(82);
    expect(m.holders).toBe(4);
    expect(m.outstandingValueInr).toBe(82);
  });

  it('values the outstanding Beanies at the rupee rate in the config', () => {
    const half = beaniesMetrics(beaniesInput({ rates: { inrPerPoint: 0.5, expiryDays: 30 } }));
    expect(half.outstandingPoints).toBe(82);
    expect(half.outstandingValueInr).toBe(41);
  });

  it('finds the Beanies expiring soon as of now, with the FIFO rule the expiry job uses', () => {
    // 7 days ahead (credits older than 10 Oct, less everything spent): u1 80 − 30 = 50, u5 12.
    expect(m.expiring7).toEqual({ points: 62, valueInr: 62, customers: 2 });
    // 30 days ahead: u1 105 − 30 = 75, u3 65, u4 15, u5 12; u2 spent all of his.
    expect(m.expiring30).toEqual({ points: 167, valueInr: 167, customers: 4 });
  });

  it('reports no expiring Beanies when they never expire', () => {
    const never = beaniesMetrics(beaniesInput({ rates: { inrPerPoint: 1, expiryDays: 0 } }));
    expect(never.expiring7.points).toBe(0);
    expect(never.expiring30.customers).toBe(0);
  });

  it('is all zeros and blanks on no data', () => {
    const e = beaniesMetrics(beaniesInput({ ledger: [], orders: [] }));
    expect(e.earnedPoints).toBe(0);
    expect(e.netChangePoints).toBe(0);
    expect(e.outstandingPoints).toBe(0);
    expect(e.holders).toBe(0);
    expect(e.validBills).toBe(0);
    expect(e.avgBillWithRedemptionInr).toBeNull();
    expect(e.avgBillWithoutRedemptionInr).toBeNull();
    expect(e.expiring7).toEqual({ points: 0, valueInr: 0, customers: 0 });
  });

  it('holds a customer at zero rather than letting a negative ledger offset other balances', () => {
    const odd = beaniesMetrics(
      beaniesInput({
        ledger: [tx('a', 'x', 'earn', 10, '2026-10-02T05:00:00Z'), tx('b', 'y', 'adjust', -30, '2026-10-02T06:00:00Z')],
        orders: [],
      }),
    );
    expect(odd.outstandingPoints).toBe(10);
    expect(odd.holders).toBe(1);
  });

  it('names exactly the customers a sheet needs: activity in the period or a balance at its end', () => {
    expect(beaniesCustomerIds(LEDGER, FROM, TO).sort()).toEqual(['u1', 'u2', 'u3', 'u4', 'u5']);
  });
});

describe('beaniesSummary', () => {
  const t = beaniesSummary(beaniesInput());

  it('is Metric, Value, Note rows', () => {
    expect(t.columns).toEqual(['Metric', 'Value', 'Note']);
    for (const r of t.rows) expect(r).toHaveLength(3);
  });

  it('carries every figure the owner asked for', () => {
    expect(metric(t, 'Beanies earned (points)')).toBe(85);
    expect(metric(t, 'Customers who earned')).toBe(3);
    expect(metric(t, 'Beanies redeemed (points)')).toBe(20);
    expect(metric(t, 'Customers who redeemed')).toBe(1);
    expect(metric(t, 'Beanies discount given (INR)')).toBe(50);
    expect(metric(t, 'Bills with a Beanies redemption')).toBe(2);
    expect(metric(t, 'Average bill with a redemption (INR)')).toBe(150);
    expect(metric(t, 'Average bill without a redemption (INR)')).toBe(280);
    expect(metric(t, 'Beanies expired (points)')).toBe(10);
    expect(metric(t, 'Net reversals (points)')).toBe(-40);
    expect(metric(t, 'Net change in Beanies (points)')).toBe(20);
    expect(metric(t, 'Outstanding Beanies at period end (points)')).toBe(82);
    expect(metric(t, 'Outstanding Beanies at period end (INR)')).toBe(82);
    expect(metric(t, 'Customers holding Beanies at period end')).toBe(4);
    expect(metric(t, 'Beanies expiring in the next 7 days (points)')).toBe(62);
    expect(metric(t, 'Beanies expiring in the next 7 days (INR)')).toBe(62);
    expect(metric(t, 'Beanies expiring in the next 30 days (points)')).toBe(167);
    expect(metric(t, 'Members active in the period')).toBe(3);
    expect(metric(t, 'Revenue from bills that earned Beanies (INR)')).toBe(900);
  });

  it('says in the notes that the expiring figures are as of today and the balance is at the period end', () => {
    const expiring = t.rows[rowNamed(t, 'Beanies expiring in the next 7 days (points)')][2] as string;
    expect(expiring).toContain('2026-11-02');
    expect(expiring).toContain('not the period end');
    const outstanding = t.rows[rowNamed(t, 'Outstanding Beanies at period end (points)')][2] as string;
    expect(outstanding).toContain('2026-10-31');
  });

  it('says the Beanies never expire when expiry is off', () => {
    const never = beaniesSummary(beaniesInput({ rates: { inrPerPoint: 1, expiryDays: 0 } }));
    expect(never.rows[rowNamed(never, 'Beanies expired (points)')][2]).toBe('Beanies never expire.');
    expect(never.rows[rowNamed(never, 'Beanies expiring in the next 7 days (points)')][2]).toBe('Beanies never expire.');
  });

  it('leaves the bill averages blank when no bill used Beanies, and still totals everything else', () => {
    const e = beaniesSummary(beaniesInput({ ledger: [], orders: [order('x', 100)] }));
    expect(metric(e, 'Average bill with a redemption (INR)')).toBe('');
    expect(metric(e, 'Average bill without a redemption (INR)')).toBe(100);
    expect(metric(e, 'Beanies earned (points)')).toBe(0);
    expect(metric(e, 'Outstanding Beanies at period end (INR)')).toBe(0);
  });

  it('defaults to ₹1 per Beanie and 30 days when the config row cannot be found', () => {
    expect(DEFAULT_LOYALTY_RATES).toEqual({ inrPerPoint: 1, expiryDays: 30 });
  });
});

describe('beaniesLedger', () => {
  const t = beaniesLedger(beaniesInput());
  const body = t.rows.filter((r) => /^\d{4}-/.test(String(r[0])));

  it('lists the rows of the period oldest first, in IST', () => {
    expect(t.columns).toEqual(['Date', 'Time', 'Customer', 'Phone', 'Type', 'Points', 'Invoice no', 'Note']);
    expect(body.map((r) => r[5])).toEqual([30, -20, 40, -40, 5, -10, 15]);
    expect(body[0].slice(0, 5)).toEqual(['2026-10-05', '10:30', 'Asha Verma', '••••••3210', 'Earned']);
    expect(body[5].slice(0, 5)).toEqual(['2026-10-20', '06:00', 'Asha Verma', '••••••3210', 'Expired']);
  });

  it('masks every phone to its last four digits, whatever form it was stored in', () => {
    expect(cell(t, 4, 'Phone')).toBe('••••••2233'); // stored as bare ten digits
    expect(t.rows.flat().some((v) => typeof v === 'string' && v.includes('9876543210'))).toBe(false);
  });

  it('shows the printed invoice number for a row that points at a bill, blank for expiries and unknown bills', () => {
    expect(cell(t, 0, 'Invoice no')).toBe('HIOC-001002');
    expect(cell(t, 3, 'Type')).toBe('Reversed');
    expect(cell(t, 3, 'Invoice no')).toBe('HIOC-001004');
    expect(cell(t, 5, 'Invoice no')).toBe('');
    expect(cell(t, 6, 'Customer')).toBe(''); // u4 has no profile
    expect(cell(t, 6, 'Phone')).toBe('');
  });

  it('ends with the net and its split by sign, leaving out rows outside the period', () => {
    const i = rowNamed(t, 'TOTAL');
    expect(cell(t, i, 'Points')).toBe(20);
    expect(cell(t, rowNamed(t, 'of which added (+)'), 'Points')).toBe(90);
    expect(cell(t, rowNamed(t, 'of which taken off (−)'), 'Points')).toBe(-70);
    expect(body).toHaveLength(7);
  });

  it('has just the total rows on an empty ledger', () => {
    const e = beaniesLedger(beaniesInput({ ledger: [] }));
    expect(e.rows.map((r) => r[0])).toEqual(['TOTAL', 'of which added (+)', 'of which taken off (−)']);
    expect(cell(e, 0, 'Points')).toBe(0);
  });
});

describe('beaniesCustomers', () => {
  const t = beaniesCustomers(beaniesInput());

  it('lists customers with activity in the period or a balance at its end, biggest balance first', () => {
    expect(t.columns).toEqual([
      'Customer',
      'Phone',
      'Earned',
      'Redeemed',
      'Expired',
      'Reversed',
      'Balance at period end',
      'Last activity',
    ]);
    // u1 50, u4 15, u5 12 (no activity this month, still holds), u3 5, u2 0 (active, nothing left); u6 is out.
    expect(t.rows.slice(0, -1).map((r) => r[0])).toEqual(['Asha Verma', '', 'Esha Rao', 'Meera Joshi', 'Ravi Kumar']);
    expect(t.rows.slice(0, -1).map((r) => r[6])).toEqual([50, 15, 12, 5, 0]);
  });

  it('splits the period into earned, redeemed, expired and reversed, with redeemed and expired as positive numbers', () => {
    expect(t.rows[0].slice(2, 8)).toEqual([30, 20, 10, 0, 50, '2026-10-20']);
    expect(t.rows[4].slice(2, 8)).toEqual([40, 0, 0, -40, 0, '2026-10-13']);
  });

  it('dates the last activity up to the end of the period only', () => {
    // u1 earned again on 1 Nov, after the period; the sheet stops at the period end.
    expect(cell(t, 0, 'Last activity')).toBe('2026-10-20');
    // u5 did nothing in October: its last row is from September.
    expect(cell(t, 2, 'Last activity')).toBe('2026-09-01');
  });

  it('totals the columns, and the balance total matches the summary', () => {
    const i = rowNamed(t, 'TOTAL');
    expect(cell(t, i, 'Earned')).toBe(85);
    expect(cell(t, i, 'Balance at period end')).toBe(82);
    expect(cell(t, i, 'Balance at period end')).toBe(metric(beaniesSummary(beaniesInput()), 'Outstanding Beanies at period end (points)'));
  });

  it('is only the TOTAL row on an empty ledger', () => {
    const e = beaniesCustomers(beaniesInput({ ledger: [] }));
    expect(e.rows).toHaveLength(1);
    expect(cell(e, 0, 'Balance at period end')).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// HIOC Ritual
// ═════════════════════════════════════════════════════════════════════════════

const WEEKLY = 'Weekly Ritual';
const MONTHLY = 'Monthly Ritual';

function pass(patch: Partial<RitualPass> & Pick<RitualPass, 'id' | 'user_id' | 'created_at' | 'expires_at'>): RitualPass {
  return {
    plan_name: WEEKLY,
    drinks_total: 7,
    drinks_remaining: 7,
    drinks_used: 0,
    price_inr: 750,
    status: 'active',
    order_id: null,
    drink_label: 'Cappuccino · Large',
    ...patch,
  };
}

function cup(
  id: string,
  passId: string,
  at: string,
  drinks: number,
  coveredInr: number,
  orderId: string,
  reversedAt: string | null = null,
): RitualRedemption & { id: string } {
  return { id, pass_id: passId, order_id: orderId, drinks, covered_inr: coveredInr, created_at: at, reversed_at: reversedAt };
}

const PASSES: RitualPass[] = [
  // Used up on 8 Oct; its holder bought pB two days later.
  pass({ id: 'pA', user_id: 'ua', order_id: 'sA', created_at: '2026-10-03T05:00:00Z', expires_at: '2026-10-09T18:30:00Z', drinks_remaining: 0, drinks_used: 7 }),
  // Refunded unused on 6 Oct.
  pass({ id: 'pD', user_id: 'ud', order_id: 'sD', created_at: '2026-10-05T05:00:00Z', expires_at: '2026-10-11T18:30:00Z', status: 'refunded' }),
  // Three cups used, then it ran out of time on 16 Oct with 4 left (breakage).
  pass({ id: 'pB', user_id: 'ua', order_id: 'sB', created_at: '2026-10-10T06:00:00Z', expires_at: '2026-10-16T18:30:00Z', drinks_remaining: 4, drinks_used: 3 }),
  // Still live: 2 cups used by 31 Oct, a third on 1 Nov.
  pass({ id: 'pC', user_id: 'uc', order_id: 'sC', plan_name: MONTHLY, price_inr: 900, created_at: '2026-10-20T05:00:00Z', expires_at: '2026-11-19T18:30:00Z', drinks_remaining: 4, drinks_used: 3 }),
  // Bought in September, expired 4 Oct with every cup unused.
  pass({ id: 'pE', user_id: 'ue', order_id: 'sE', created_at: '2026-09-28T05:00:00Z', expires_at: '2026-10-04T18:30:00Z' }),
  // Bought after the period.
  pass({ id: 'pF', user_id: 'uf', order_id: 'sF', created_at: '2026-11-01T05:00:00Z', expires_at: '2026-11-07T18:30:00Z' }),
];

const REDEMPTIONS: RitualRedemption[] = [
  cup('r1', 'pA', '2026-10-03T08:00:00Z', 1, 150, 'oR1'),
  cup('r2', 'pA', '2026-10-04T08:00:00Z', 2, 300, 'oR2'),
  cup('r3', 'pA', '2026-10-06T08:00:00Z', 2, 300, 'oR3'),
  cup('r4', 'pA', '2026-10-08T08:00:00Z', 2, 300, 'oR4'),
  cup('r5', 'pB', '2026-10-11T08:00:00Z', 1, 150, 'oR5'),
  cup('r6', 'pB', '2026-10-13T08:00:00Z', 2, 300, 'oR6'),
  cup('r7', 'pB', '2026-10-14T08:00:00Z', 1, 150, 'oR7', '2026-10-14T09:00:00Z'), // the bill was cancelled
  cup('r8', 'pC', '2026-10-22T08:00:00Z', 1, 150, 'oR8'),
  cup('r9', 'pC', '2026-10-25T08:00:00Z', 1, 150, 'oR9'),
  cup('r10', 'pC', '2026-11-01T08:00:00Z', 1, 150, 'oR10'), // after the period
];

const ADJUSTMENTS: RitualAdjustment[] = [
  { pass_id: 'pD', kind: 'void', days: null, drinks: null, created_at: '2026-10-06T05:00:00Z' },
];

const HOLDERS = new Map<string, LoyaltyCustomer>([
  ['ua', { name: 'Asha Verma', phone: '+919876543210' }],
  ['uc', { name: 'Meera Joshi', phone: '+919811122233' }],
  ['ud', { name: 'Dev Patel', phone: '+919822233344' }],
  ['ue', { name: 'Esha Rao', phone: '' }],
]);

const RITUAL_ORDERS = new Map<string, RitualOrder>([
  ['sA', { invoiceNo: 'HIOC-002001', totalInr: 750, valid: true }],
  ['sB', { invoiceNo: 'HIOC-002010', totalInr: 750, valid: true }],
  ['sC', { invoiceNo: 'HIOC-002020', totalInr: 900, valid: true }],
  ['sD', { invoiceNo: 'HIOC-002005', totalInr: 750, valid: true }],
  ['oR1', { invoiceNo: 'HIOC-002101', totalInr: 200, valid: true }],
  ['oR2', { invoiceNo: 'HIOC-002102', totalInr: 150, valid: true }],
  ['oR3', { invoiceNo: 'HIOC-002103', totalInr: 0, valid: true }],
  ['oR4', { invoiceNo: 'HIOC-002104', totalInr: 120, valid: true }],
  ['oR5', { invoiceNo: 'HIOC-002105', totalInr: 80, valid: true }],
  ['oR6', { invoiceNo: 'HIOC-002106', totalInr: 50, valid: true }],
  ['oR7', { invoiceNo: 'HIOC-002107', totalInr: 90, valid: false }],
  ['oR8', { invoiceNo: 'HIOC-002108', totalInr: 100, valid: true }],
  ['oR9', { invoiceNo: 'HIOC-002109', totalInr: 60, valid: true }],
]);

function ritualInput(patch: Partial<RitualInput> = {}): RitualInput {
  return {
    from: FROM,
    to: TO,
    now: NOW,
    passes: PASSES,
    redemptions: REDEMPTIONS,
    adjustments: ADJUSTMENTS,
    holders: HOLDERS,
    orders: RITUAL_ORDERS,
    ...patch,
  };
}

describe('ritualMetrics', () => {
  const m = ritualMetrics(ritualInput());

  it('reuses the owner summary for what was sold, refunded and served', () => {
    expect(m.soldCount).toBe(3); // pA, pB, pC: the refunded one and the other months' are not sold in October
    expect(m.soldInr).toBe(2400);
    expect(m.soldByPlan).toEqual([
      { plan_name: WEEKLY, count: 2, inr: 1500 },
      { plan_name: MONTHLY, count: 1, inr: 900 },
    ]);
    expect(m.refundedCount).toBe(1);
    expect(m.refundedInr).toBe(750);
    // 7 + 3 + 2 cups: the reversed cup and the one served on 1 Nov are not October's.
    expect(m.cupsServed).toBe(12);
    expect(m.coveredInr).toBe(1800);
  });

  it('counts breakage on every pass that expired in the period with cups left', () => {
    // pB: 4 cups at ₹750 / 7; pE: 7 cups at ₹750 / 7, sold in September but expired in October.
    expect(m.breakageCups).toBe(11);
    expect(m.breakageInr).toBe(1179);
  });

  it('counts buyers, repeat buyers and renewals', () => {
    expect(m.uniqueBuyers).toBe(2); // ua and uc
    expect(m.repeatBuyers).toBe(1); // ua has two passes
    expect(m.renewals).toBe(1); // pB, bought two days after pA was used up
  });

  it('rates renewals over the passes that ended in the period and whose window has closed', () => {
    // Ended in October: pA (used up 8 Oct, renewed), pB (expired 16 Oct), pD (refunded 6 Oct), pE (expired 4 Oct).
    // pC is still live. Each window closed before 2 Nov.
    expect(m.endedPasses).toBe(4);
    expect(m.renewedPasses).toBe(1);
    expect(m.renewalRatePct).toBe(25);
  });

  it('leaves out of the renewal rate a pass whose 14 days are not over yet', () => {
    // On 20 Oct only pD (refunded 6 Oct) and pE (expired 4 Oct) have had their 14 days; pA (used up 8 Oct)
    // and pB (expired 16 Oct) have not, so they are not yet counted as renewed or not.
    const early = ritualMetrics(ritualInput({ now: new Date('2026-10-20T06:30:00Z') }));
    expect(early.endedPasses).toBe(2);
    expect(early.renewedPasses).toBe(0);
    expect(early.renewalRatePct).toBe(0);
  });

  it('measures the days from sale to first cup in IST calendar days, over passes that were used', () => {
    // pA same day, pB next day, pC two days; the refunded pass never was used.
    expect(m.passesWithCup).toBe(3);
    expect(m.avgDaysToFirstCup).toBe(1);
  });

  it('measures visits per holder and the extra spend on Ritual bills, not counting reversed cups', () => {
    expect(m.holdersServed).toBe(2); // ua, uc
    expect(m.ritualBills).toBe(8); // oR1–oR6, oR8, oR9
    expect(m.visitsPerHolder).toBe(4);
    expect(m.extraSpendInr).toBe(760);
  });

  it('rebuilds the liability at the END of the period, not today', () => {
    // At 31 Oct: pC has 5 cups left (the third was served on 1 Nov) at ₹900 / 7; everything else is
    // used up, expired, refunded or not yet bought.
    expect(m.cupsOutstandingAtEnd).toBe(5);
    expect(m.liabilityAtEndInr).toBe(643);
    // Today: pC 4 cups, and pF bought on 1 Nov, 7 cups.
    expect(m.cupsOutstandingToday).toBe(11);
    expect(m.liabilityTodayInr).toBe(1264); // 4 × 900/7 + 750
  });

  it('is all zeros and blanks on no passes', () => {
    const e = ritualMetrics(ritualInput({ passes: [], redemptions: [], adjustments: [] }));
    expect(e.soldCount).toBe(0);
    expect(e.cupsServed).toBe(0);
    expect(e.uniqueBuyers).toBe(0);
    expect(e.renewalRatePct).toBeNull();
    expect(e.avgDaysToFirstCup).toBeNull();
    expect(e.visitsPerHolder).toBeNull();
    expect(e.liabilityAtEndInr).toBe(0);
    expect(e.liabilityTodayInr).toBe(0);
    expect(e.breakageInr).toBe(0);
  });

  it('does not count a bill that is no longer valid in the extra spend', () => {
    const cancelled = ritualMetrics(
      ritualInput({
        orders: new Map(RITUAL_ORDERS).set('oR1', { invoiceNo: 'HIOC-002101', totalInr: 200, valid: false }),
      }),
    );
    expect(cancelled.extraSpendInr).toBe(560);
  });
});

describe('passesAsOf', () => {
  const base = (patch: Partial<RitualPass> = {}) =>
    pass({ id: 'p', user_id: 'u', created_at: '2026-10-01T05:00:00Z', expires_at: '2026-10-08T18:30:00Z', ...patch });
  const at = (iso: string) => Date.parse(iso);

  it('leaves out passes bought after the instant', () => {
    expect(passesAsOf([base()], [], [], at('2026-10-01T00:00:00Z'))).toEqual([]);
    expect(passesAsOf([base()], [], [], at('2026-10-02T00:00:00Z'))).toHaveLength(1);
  });

  it('gives back cups redeemed after the instant, and cups reversed after it', () => {
    const reds = [
      cup('a', 'p', '2026-10-03T05:00:00Z', 2, 300, 'o1'),
      cup('b', 'p', '2026-10-06T05:00:00Z', 1, 150, 'o2'),
      cup('c', 'p', '2026-10-04T05:00:00Z', 1, 150, 'o3', '2026-10-07T05:00:00Z'),
    ];
    const left = (iso: string) => passesAsOf([base({ drinks_remaining: 4 })], reds, [], at(iso))[0].drinks_remaining;
    expect(left('2026-10-02T00:00:00Z')).toBe(7);
    expect(left('2026-10-05T00:00:00Z')).toBe(4); // a and c used, c not yet reversed
    expect(left('2026-10-06T12:00:00Z')).toBe(3); // a, b and c
    expect(left('2026-10-08T00:00:00Z')).toBe(4); // c reversed on the 7th
  });

  it('adds credits given before the instant and takes back an extension made after it', () => {
    const adj: RitualAdjustment[] = [
      { pass_id: 'p', kind: 'credit', days: null, drinks: 2, created_at: '2026-10-04T05:00:00Z' },
      { pass_id: 'p', kind: 'extend', days: 3, created_at: '2026-10-06T05:00:00Z', drinks: null },
    ];
    // Today the pass runs to 11 Oct (8 Oct + 3 days).
    const today = base({ expires_at: '2026-10-11T18:30:00Z' });
    const early = passesAsOf([today], [], adj, at('2026-10-05T00:00:00Z'))[0];
    expect(early.drinks_remaining).toBe(9);
    expect(early.expires_at).toBe('2026-10-08T18:30:00.000Z');
    const late = passesAsOf([today], [], adj, at('2026-10-09T00:00:00Z'))[0];
    expect(late.expires_at).toBe('2026-10-11T18:30:00.000Z');
  });

  it('treats a refunded pass as live until the refund date, and as void throughout when nothing dates it', () => {
    const refunded = base({ status: 'refunded' });
    const void1: RitualAdjustment[] = [{ pass_id: 'p', kind: 'void', days: null, drinks: null, created_at: '2026-10-04T05:00:00Z' }];
    expect(passesAsOf([refunded], [], void1, at('2026-10-03T00:00:00Z'))[0].status).toBe('active');
    expect(passesAsOf([refunded], [], void1, at('2026-10-05T00:00:00Z'))[0].status).toBe('refunded');
    expect(passesAsOf([refunded], [], [], at('2026-10-03T00:00:00Z'))[0].status).toBe('refunded');
  });

  it('treats a pass whose refund was undone as live again', () => {
    const undone: RitualAdjustment[] = [
      { pass_id: 'p', kind: 'void', days: null, drinks: null, created_at: '2026-10-04T05:00:00Z' },
      { pass_id: 'p', kind: 'unvoid', days: null, drinks: null, created_at: '2026-10-04T06:00:00Z' },
    ];
    expect(passesAsOf([base()], [], undone, at('2026-10-05T00:00:00Z'))[0].status).toBe('active');
    expect(passesAsOf([base()], [], undone.slice(0, 1), at('2026-10-05T00:00:00Z'))[0].status).toBe('void');
  });

  it('rebuilds today’s cups left exactly, so a rebuild at now matches the view', () => {
    const rebuilt = passesAsOf(PASSES, REDEMPTIONS, ADJUSTMENTS, NOW.getTime());
    expect(rebuilt.map((p) => p.drinks_remaining)).toEqual(PASSES.map((p) => p.drinks_remaining));
    expect(rebuilt.map((p) => p.status)).toEqual(PASSES.map((p) => p.status));
  });
});

describe('ritual renewals', () => {
  const user = 'uz';
  const sold = (id: string, createdAt: string, expiresAt: string, patch: Partial<RitualPass> = {}) =>
    pass({ id, user_id: user, created_at: createdAt, expires_at: expiresAt, ...patch });

  it('counts a new pass bought within 14 days of the last one ending, not 15', () => {
    const used = (id: string, at: string) => cup(`r-${id}`, id, at, 7, 1050, `o-${id}`);
    const first = sold('q1', '2026-10-01T05:00:00Z', '2026-10-08T18:30:00Z', { drinks_remaining: 0, drinks_used: 7 });
    const redemptions = [used('q1', '2026-10-05T05:00:00Z')]; // ended 5 Oct 05:00Z
    const within = sold('q2', '2026-10-19T05:00:00Z', '2026-10-25T18:30:00Z'); // 14 days later
    const late = sold('q3', '2026-10-19T05:00:01Z', '2026-10-25T18:30:00Z'); // one second past
    const m = (second: RitualPass) =>
      ritualMetrics(ritualInput({ passes: [first, second], redemptions, adjustments: [], now: new Date('2026-12-01T00:00:00Z') }));
    expect(m(within).renewals).toBe(1);
    expect(m(late).renewals).toBe(0);
  });

  it('counts a refunded pass as ended on its refund date', () => {
    const first = sold('q1', '2026-10-01T05:00:00Z', '2026-10-08T18:30:00Z', { status: 'refunded' });
    const second = sold('q2', '2026-10-04T05:00:00Z', '2026-10-10T18:30:00Z');
    const adj: RitualAdjustment[] = [{ pass_id: 'q1', kind: 'void', days: null, drinks: null, created_at: '2026-10-02T05:00:00Z' }];
    const m = ritualMetrics(ritualInput({ passes: [first, second], redemptions: [], adjustments: adj, now: new Date('2026-12-01T00:00:00Z') }));
    expect(m.renewals).toBe(1);
    expect(m.endedPasses).toBe(2); // the refunded one, and the second which expired on 10 Oct
    expect(m.renewedPasses).toBe(1);
  });

  it('does not count a second pass bought while the first is still live as a renewal', () => {
    const first = sold('q1', '2026-10-01T05:00:00Z', '2026-10-31T18:30:00Z');
    const second = sold('q2', '2026-10-05T05:00:00Z', '2026-10-11T18:30:00Z');
    const m = ritualMetrics(ritualInput({ passes: [first, second], redemptions: [], adjustments: [] }));
    expect(m.renewals).toBe(0);
    expect(m.repeatBuyers).toBe(1);
  });
});

describe('ritualSummary', () => {
  const t = ritualSummary(ritualInput());

  it('is Metric, Value, Note rows', () => {
    expect(t.columns).toEqual(['Metric', 'Value', 'Note']);
    for (const r of t.rows) expect(r).toHaveLength(3);
  });

  it('carries the owner summary figures and the extra ones', () => {
    expect(metric(t, 'Rituals sold')).toBe(3);
    expect(metric(t, 'Ritual sales (INR)')).toBe(2400);
    expect(metric(t, `Sold: ${WEEKLY}`)).toBe(2);
    expect(metric(t, `Sold: ${MONTHLY}`)).toBe(1);
    expect(metric(t, 'Rituals refunded')).toBe(1);
    expect(metric(t, 'Customers who bought a Ritual')).toBe(2);
    expect(metric(t, 'Repeat buyers')).toBe(1);
    expect(metric(t, 'Renewals')).toBe(1);
    expect(metric(t, 'Renewal rate (%)')).toBe(25);
    expect(metric(t, 'Average days from sale to first cup')).toBe(1);
    expect(metric(t, 'Cups served')).toBe(12);
    expect(metric(t, 'Menu value of cups served (INR)')).toBe(1800);
    expect(metric(t, 'Visits per holder')).toBe(4);
    expect(metric(t, 'Extra spend on Ritual bills (INR)')).toBe(760);
    expect(metric(t, 'Cups still to serve at period end')).toBe(5);
    expect(metric(t, 'Liability at period end (INR)')).toBe(643);
    expect(metric(t, 'Liability today (INR)')).toBe(1264);
    expect(metric(t, 'Cups expired unused')).toBe(11);
    expect(metric(t, 'Breakage (INR)')).toBe(1179);
  });

  it('leaves the ratios blank with nothing to divide by', () => {
    const e = ritualSummary(ritualInput({ passes: [], redemptions: [], adjustments: [] }));
    expect(metric(e, 'Rituals sold')).toBe(0);
    expect(metric(e, 'Renewal rate (%)')).toBe('');
    expect(metric(e, 'Average days from sale to first cup')).toBe('');
    expect(metric(e, 'Visits per holder')).toBe('');
    expect(metric(e, 'Liability at period end (INR)')).toBe(0);
  });
});

describe('ritualPasses', () => {
  const t = ritualPasses(ritualInput());

  it('lists the passes sold in the range, oldest first, with the buyer masked', () => {
    expect(t.columns).toEqual([
      'Sold on',
      'Invoice no',
      'Customer',
      'Phone',
      'Plan',
      'Drink',
      'Cups',
      'Price (INR)',
      'Expires',
      'Cups used (to date)',
      'Cups left',
      'State',
      'Refunded on',
    ]);
    expect(t.rows.slice(0, -1).map((r) => r[1])).toEqual(['HIOC-002001', 'HIOC-002005', 'HIOC-002010', 'HIOC-002020']);
    expect(cell(t, 0, 'Customer')).toBe('Asha Verma');
    expect(cell(t, 0, 'Phone')).toBe('••••••3210');
    expect(cell(t, 0, 'Drink')).toBe('Cappuccino · Large');
    expect(cell(t, 3, 'Plan')).toBe(MONTHLY);
  });

  it('shows the last day a pass works, and its state today', () => {
    // pA runs to the end of 9 Oct IST (expires_at is the instant 10 Oct starts).
    expect(cell(t, 0, 'Expires')).toBe('2026-10-09');
    // Like the view, a pass past its expiry reads Expired even when every cup was used.
    expect(t.rows.slice(0, -1).map((r) => r[11])).toEqual(['Expired', 'Refunded', 'Expired', 'Active']);
    const earlier = ritualPasses(ritualInput({ now: new Date('2026-10-08T12:00:00Z') }));
    expect(earlier.rows.slice(0, -1).map((r) => r[11])).toEqual(['Used up', 'Refunded', 'Active', 'Active']);
    expect(cell(t, 0, 'Cups used (to date)')).toBe(7);
    expect(cell(t, 2, 'Cups left')).toBe(4);
  });

  it('dates a refund and keeps refunded passes out of the TOTAL', () => {
    expect(cell(t, 1, 'Refunded on')).toBe('2026-10-06');
    expect(cell(t, 0, 'Refunded on')).toBe('');
    const i = rowNamed(t, 'TOTAL');
    expect(cell(t, i, 'Cups')).toBe(21);
    expect(cell(t, i, 'Price (INR)')).toBe(2400);
    expect(cell(t, i, 'Cups used (to date)')).toBe(13);
    expect(cell(t, i, 'Cups left')).toBe(8);
    expect(cell(t, i, 'State')).toBe('Refunded and void passes not counted');
  });

  it('is only the TOTAL row, zeros, when nothing was sold', () => {
    const e = ritualPasses(ritualInput({ passes: [], redemptions: [], adjustments: [] }));
    expect(e.rows).toHaveLength(1);
    expect(cell(e, 0, 'Price (INR)')).toBe(0);
  });
});

describe('ritualRedemptions', () => {
  const t = ritualRedemptions(ritualInput());

  it('lists every cup served in the range, reversed ones flagged', () => {
    expect(t.columns).toEqual(['Date', 'Invoice no', 'Customer', 'Plan', 'Cups', 'Covered (INR)', 'Bill total (INR)', 'Reversed']);
    const body = t.rows.slice(0, -1);
    expect(body).toHaveLength(9); // the 1 Nov cup is outside October
    expect(body[0]).toEqual(['2026-10-03', 'HIOC-002101', 'Asha Verma', WEEKLY, 1, 150, 200, 'No']);
    const reversed = body.find((r) => r[1] === 'HIOC-002107');
    expect(reversed?.[7]).toBe('Yes');
  });

  it('totals cups and covered rupees without the reversed cup', () => {
    const i = rowNamed(t, 'TOTAL');
    expect(cell(t, i, 'Cups')).toBe(12);
    expect(cell(t, i, 'Covered (INR)')).toBe(1800);
    expect(cell(t, i, 'Reversed')).toBe('Reversed cups not counted');
    expect(cell(t, i, 'Bill total (INR)')).toBe('');
  });

  it('is only the TOTAL row on no redemptions', () => {
    const e = ritualRedemptions(ritualInput({ redemptions: [] }));
    expect(e.rows).toHaveLength(1);
    expect(cell(e, 0, 'Cups')).toBe(0);
  });

  it('names the people and bills a sheet needs, within the range only', () => {
    const refs = ritualReferences({ from: FROM, to: TO, passes: PASSES, redemptions: REDEMPTIONS });
    expect(refs.userIds.sort()).toEqual(['ua', 'uc', 'ud']);
    expect(refs.orderIds).toContain('sA');
    expect(refs.orderIds).toContain('oR9');
    expect(refs.orderIds).not.toContain('oR10');
    expect(refs.orderIds).not.toContain('sF');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Marketing campaigns
// ═════════════════════════════════════════════════════════════════════════════

function campaign(patch: Partial<CampaignRecord> & Pick<CampaignRecord, 'name'>): CampaignRecord {
  return {
    kind: 'Manual campaign',
    offer: '',
    startedAt: '2026-10-05T05:00:00Z',
    sent: 0,
    delivered: 0,
    read: 0,
    clicked: 0,
    conversions: 0,
    revenueInr: 0,
    treatedConverted: 0,
    holdoutN: 0,
    holdoutConverted: 0,
    costInr: 0,
    couponDiscountInr: 0,
    ...patch,
  };
}

const CAMPAIGNS: CampaignRecord[] = [
  campaign({
    name: 'Diwali treat',
    startedAt: '2026-10-12T05:00:00Z',
    sent: 50,
    delivered: 40,
    read: 20,
    clicked: 5,
    conversions: 5,
    revenueInr: 1000,
    treatedConverted: 5,
    holdoutN: 10, // too small for a lift
    holdoutConverted: 1,
    costInr: 51,
    couponDiscountInr: 100,
  }),
  campaign({
    name: 'Win-back · stage 1 (we miss you)',
    kind: 'Win-back · stage 1 (we miss you)',
    offer: '10% off',
    sent: 100,
    delivered: 90,
    read: 60,
    clicked: 20,
    conversions: 12,
    revenueInr: 3600,
    treatedConverted: 12,
    holdoutN: 25,
    holdoutConverted: 2,
    costInr: 102.4,
    couponDiscountInr: 360,
  }),
  campaign({ name: 'Quiet one', startedAt: '2026-10-20T05:00:00Z' }),
];

describe('campaignPerformance', () => {
  const t = campaignPerformance(CAMPAIGNS);

  it('has one row per campaign in the order they started, plus a TOTAL', () => {
    expect(t.columns).toEqual([
      'Campaign',
      'Kind',
      'Offer',
      'Started',
      'Sent',
      'Delivered',
      'Read',
      'Clicked',
      'Conversions',
      'Conversion %',
      'Revenue (INR)',
      'Holdout conversion %',
      'Lift (pp)',
      'Cost (INR)',
      'Coupon discount given (INR)',
    ]);
    expect(t.rows.map((r) => r[0])).toEqual(['Win-back · stage 1 (we miss you)', 'Diwali treat', 'Quiet one', 'TOTAL']);
    expect(cell(t, 0, 'Started')).toBe('2026-10-05');
    expect(cell(t, 0, 'Offer')).toBe('10% off');
  });

  it('computes the conversion rate and the lift against the holdout', () => {
    expect(cell(t, 0, 'Conversion %')).toBe(12);
    expect(cell(t, 0, 'Holdout conversion %')).toBe(8);
    expect(cell(t, 0, 'Lift (pp)')).toBe(4); // 12% − 8%
    expect(cell(t, 0, 'Cost (INR)')).toBe(102.4);
  });

  it('withholds the lift until the holdout is big enough, and blanks ratios with nothing to divide by', () => {
    expect(cell(t, 1, 'Holdout conversion %')).toBe(10);
    expect(cell(t, 1, 'Lift (pp)')).toBe('');
    expect(cell(t, 2, 'Conversion %')).toBe('');
    expect(cell(t, 2, 'Holdout conversion %')).toBe('');
    expect(cell(t, 2, 'Lift (pp)')).toBe('');
  });

  it('totals the additive columns and the overall conversion rate', () => {
    const i = rowNamed(t, 'TOTAL');
    expect(cell(t, i, 'Sent')).toBe(150);
    expect(cell(t, i, 'Conversions')).toBe(17);
    expect(cell(t, i, 'Conversion %')).toBe(11.3);
    expect(cell(t, i, 'Revenue (INR)')).toBe(4600);
    expect(cell(t, i, 'Cost (INR)')).toBe(153.4);
    expect(cell(t, i, 'Coupon discount given (INR)')).toBe(460);
    expect(cell(t, i, 'Lift (pp)')).toBe('');
  });

  it('is an empty sheet, just the header, with no campaigns', () => {
    const e = campaignPerformance([]);
    expect(e.columns).toHaveLength(15);
    expect(e.rows).toEqual([]);
  });

  it('exposes the same figures for the Insights page', () => {
    const m = campaignMetrics(CAMPAIGNS);
    expect(m.campaigns[0].liftPp).toBe(4);
    expect(m.totals.conversions).toBe(17);
    expect(m.totals.sent).toBe(150);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Highlights
// ═════════════════════════════════════════════════════════════════════════════

const emptyBeanies = beaniesMetrics(beaniesInput({ ledger: [], orders: [] }));
const fullBeanies = beaniesMetrics(beaniesInput());
const fullRitual = ritualMetrics(ritualInput());
const fullCampaigns = campaignMetrics(CAMPAIGNS);

describe('programmeHighlights', () => {
  it('says nothing at all on empty data or with the optional sections off', () => {
    expect(programmeHighlights({ beanies: emptyBeanies, ritual: null, campaigns: null })).toEqual([]);
    const emptyRitual = ritualMetrics(ritualInput({ passes: [], redemptions: [], adjustments: [] }));
    expect(programmeHighlights({ beanies: emptyBeanies, ritual: emptyRitual, campaigns: campaignMetrics([]) })).toEqual([]);
  });

  it('compares the average bill with and without a Beanies redemption', () => {
    const lines = programmeHighlights({ beanies: fullBeanies, ritual: null, campaigns: null });
    expect(lines[0]).toBe('Bills where customers redeemed Beanies averaged ₹150 vs ₹280 without.');
  });

  it('names the outstanding liability with its customers', () => {
    const lines = programmeHighlights({ beanies: fullBeanies, ritual: null, campaigns: null });
    expect(lines).toContain(
      '₹82 of Beanies (4 customers) is outstanding at the end of the period — your liability if all are redeemed.',
    );
  });

  it('suggests a reminder for the Beanies expiring in the next 7 days', () => {
    const lines = programmeHighlights({ beanies: fullBeanies, ritual: null, campaigns: null });
    expect(lines).toContain(
      '62 Beanies (₹62) held by 2 customers expire in the next 7 days — a reminder could bring them back.',
    );
  });

  it('reads naturally for a single Beanie', () => {
    const one = { ...fullBeanies, expiring7: { points: 1, valueInr: 1, customers: 1 } };
    expect(programmeHighlights({ beanies: one, ritual: null, campaigns: null })).toContain(
      '1 Beanie (₹1) held by 1 customer expires in the next 7 days — a reminder could bring them back.',
    );
  });

  it('skips a sentence whose figure is zero, or whose denominator is', () => {
    const none = programmeHighlights({
      beanies: { ...fullBeanies, billsWithRedemption: 0, avgBillWithRedemptionInr: null, outstandingPoints: 0, holders: 0, expiring7: { points: 0, valueInr: 0, customers: 0 }, discountGivenInr: 0 },
      ritual: null,
      campaigns: null,
    });
    expect(none).toEqual([]);
    const noWithout = programmeHighlights({
      beanies: { ...fullBeanies, avgBillWithoutRedemptionInr: null },
      ritual: null,
      campaigns: null,
    });
    expect(noWithout.some((l) => l.startsWith('Bills where customers redeemed'))).toBe(false);
  });

  it('says how often Ritual holders came in and how many renewed', () => {
    const lines = programmeHighlights({ beanies: emptyBeanies, ritual: fullRitual, campaigns: null });
    expect(lines).toContain('Ritual holders came in 4 times on average; 25% of Ritual passes that ended were renewed within 14 days.');
  });

  it('says only the half of the Ritual sentence it has numbers for', () => {
    const visitsOnly = programmeHighlights({ beanies: emptyBeanies, ritual: { ...fullRitual, renewalRatePct: null }, campaigns: null });
    expect(visitsOnly).toContain('Ritual holders came in 4 times on average.');
    const renewOnly = programmeHighlights({ beanies: emptyBeanies, ritual: { ...fullRitual, visitsPerHolder: null }, campaigns: null });
    expect(renewOnly).toContain('25% of Ritual passes that ended were renewed within 14 days.');
    const once = programmeHighlights({ beanies: emptyBeanies, ritual: { ...fullRitual, visitsPerHolder: 1, renewalRatePct: null }, campaigns: null });
    expect(once).toContain('Ritual holders came in 1 time on average.');
  });

  it('reports the Ritual liability and breakage when there are any', () => {
    const lines = programmeHighlights({ beanies: emptyBeanies, ritual: fullRitual, campaigns: null });
    expect(lines).toContain('₹643 of Ritual cups (5 cups) are still owed to customers at the end of the period.');
    expect(lines).toContain('₹1,179 of Ritual cups (11 cups) expired unused in the period.');
  });

  it('picks the campaign that brought back the most revenue, with its lift when positive', () => {
    const lines = programmeHighlights({ beanies: emptyBeanies, ritual: null, campaigns: fullCampaigns });
    expect(lines).toEqual(['“Win-back · stage 1 (we miss you)” brought back 12 customers worth ₹3,600 for ₹102 of messages, 4 points more than the holdout.']);
  });

  it('says nothing about a campaign that sent nothing or brought nobody back', () => {
    const quiet = campaignMetrics([campaign({ name: 'Quiet one' }), campaign({ name: 'Sent, no returns', sent: 30 })]);
    expect(programmeHighlights({ beanies: emptyBeanies, ritual: null, campaigns: quiet })).toEqual([]);
  });

  it('returns at most six sentences, the most useful first', () => {
    const lines = programmeHighlights({ beanies: fullBeanies, ritual: fullRitual, campaigns: fullCampaigns });
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('Bills where customers redeemed Beanies');
    expect(lines[1]).toContain('is outstanding');
    expect(lines[2]).toContain('expire in the next 7 days');
    expect(lines[3]).toContain('Ritual holders came in');
    expect(lines[4]).toContain('brought back');
    expect(lines[5]).toContain('still owed');
  });

  it('formats rupees with Indian digit grouping', () => {
    const big: BeaniesMetrics = { ...fullBeanies, outstandingPoints: 1234567, outstandingValueInr: 1234567, holders: 3 };
    const lines = programmeHighlights({ beanies: big, ritual: null, campaigns: null });
    expect(lines.some((l) => l.startsWith('₹12,34,567 of Beanies (3 customers)'))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The registry's loaders, over an in-memory fake database
// ═════════════════════════════════════════════════════════════════════════════

type Row = Record<string, unknown>;
type QueryError = { code: string; message: string };

/** Columns each table has in the fake; a select naming one that is not here fails the way PostgREST does (42703). */
const SCHEMA: Record<string, string[]> = {
  loyalty_transactions: ['id', 'user_id', 'order_id', 'type', 'points', 'note', 'created_at'],
  loyalty_config: ['id', 'is_singleton', 'inr_per_point', 'points_expiry_days'],
  profiles: ['id', 'name', 'phone'],
  orders: ['id', 'order_number', 'total_inr', 'status'],
  v_coffee_pass_balances: [
    'id', 'user_id', 'plan_name', 'drinks_total', 'drinks_remaining', 'drinks_used', 'price_inr', 'status',
    'expires_at', 'created_at', 'order_id', 'drink_label',
  ],
  coffee_pass_redemptions: ['id', 'pass_id', 'order_id', 'drinks', 'covered_inr', 'created_at', 'reversed_at'],
  coffee_pass_adjustments: ['id', 'pass_id', 'kind', 'days', 'drinks', 'created_at'],
  coupons: ['id', 'campaign_id'],
  coupon_redemptions: ['id', 'coupon_id', 'order_id', 'discount_inr'],
};

interface FakeOptions {
  /** Tables that do not exist (every query answers 42P01). */
  missing?: string[];
  /** Columns a table lacks. */
  lacking?: Record<string, string[]>;
  /** Tables whose every query fails with a real error. */
  broken?: string[];
}

class FakeQuery implements PromiseLike<{ data: unknown; error: QueryError | null }> {
  private preds: ((r: Row) => boolean)[] = [];
  private cols: string[] | null = null;
  private error: QueryError | null = null;
  private orders: string[] = [];
  private span: [number, number] | null = null;
  private single = false;

  constructor(
    private readonly table: string,
    private readonly rows: Row[],
    private readonly schema: string[] | undefined,
    error: QueryError | null,
  ) {
    this.error = error;
  }

  select(list: string) {
    if (list.trim() !== '*') {
      this.cols = list.split(',').map((c) => c.trim());
      const bad = this.schema ? this.cols.find((c) => !this.schema?.includes(c)) : undefined;
      if (bad && !this.error) this.error = { code: '42703', message: `column "${bad}" does not exist` };
    }
    return this;
  }
  eq(c: string, v: unknown) {
    this.preds.push((r) => r[c] === v);
    return this;
  }
  in(c: string, vals: unknown[]) {
    this.preds.push((r) => vals.includes(r[c]));
    return this;
  }
  gte(c: string, v: string) {
    this.preds.push((r) => typeof r[c] === 'string' && Date.parse(r[c] as string) >= Date.parse(v));
    return this;
  }
  lt(c: string, v: string) {
    this.preds.push((r) => typeof r[c] === 'string' && Date.parse(r[c] as string) < Date.parse(v));
    return this;
  }
  not(c: string) {
    this.preds.push((r) => r[c] !== null && r[c] !== undefined);
    return this;
  }
  order(c: string) {
    this.orders.push(c);
    return this;
  }
  range(from: number, to: number) {
    this.span = [from, to];
    return this;
  }
  maybeSingle() {
    this.single = true;
    return this;
  }

  private run(): { data: unknown; error: QueryError | null } {
    if (this.error) return { data: null, error: this.error };
    let rows = this.rows.filter((r) => this.preds.every((p) => p(r)));
    if (this.orders.length > 0) {
      const keys = this.orders;
      rows = [...rows].sort((a, b) => {
        for (const k of keys) {
          const c = String(a[k] ?? '').localeCompare(String(b[k] ?? ''));
          if (c !== 0) return c;
        }
        return 0;
      });
    }
    if (this.span) rows = rows.slice(this.span[0], this.span[1] + 1);
    const cols = this.cols;
    const out = cols ? rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c] ?? null]))) : rows;
    return { data: this.single ? (out[0] ?? null) : out, error: null };
  }

  then<T1 = { data: unknown; error: QueryError | null }, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: QueryError | null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

function fakeDb(tables: Record<string, Row[]>, opts: FakeOptions = {}): { admin: SupabaseClient; reads: string[] } {
  const reads: string[] = [];
  const db = {
    from: (table: string) => {
      reads.push(table);
      let error: QueryError | null = null;
      if (opts.missing?.includes(table)) error = { code: '42P01', message: `relation "${table}" does not exist` };
      else if (opts.broken?.includes(table)) error = { code: 'XX000', message: `${table} exploded` };
      const lacking = opts.lacking?.[table] ?? [];
      const schema = SCHEMA[table]?.filter((c) => !lacking.includes(c));
      return new FakeQuery(table, tables[table] ?? [], schema, error);
    },
  };
  return { admin: db as unknown as SupabaseClient, reads };
}

const PROFILES: Row[] = [
  { id: 'u1', name: 'Asha Verma', phone: '+919876543210' },
  { id: 'u2', name: 'Ravi Kumar', phone: '+919812345678' },
  { id: 'u3', name: 'Meera Joshi', phone: '9811122233' },
  { id: 'u5', name: 'Esha Rao', phone: '' },
  { id: 'ua', name: 'Asha Verma', phone: '+919876543210' },
  { id: 'uc', name: 'Meera Joshi', phone: '+919811122233' },
  { id: 'ud', name: 'Dev Patel', phone: '+919822233344' },
];

function orderRow(id: string, n: number, total: number, status = 'completed'): Row {
  return { id, order_number: n, total_inr: total, status };
}

const ORDER_ROWS: Row[] = [
  orderRow('o2', 1002, 300),
  orderRow('o3', 1003, 180),
  orderRow('o4', 1004, 250, 'cancelled'),
  orderRow('o7', 1007, 100),
  orderRow('sA', 2001, 750),
  orderRow('sB', 2010, 750),
  orderRow('sC', 2020, 900),
  orderRow('sD', 2005, 750),
  orderRow('oR1', 2101, 200),
  orderRow('oR2', 2102, 150),
  orderRow('oR3', 2103, 0),
  orderRow('oR4', 2104, 120),
  orderRow('oR5', 2105, 80),
  orderRow('oR6', 2106, 50),
  orderRow('oR7', 2107, 90, 'cancelled'),
  orderRow('oR8', 2108, 100),
  orderRow('oR9', 2109, 60),
];

const ritualTables = (): Record<string, Row[]> => ({
  v_coffee_pass_balances: PASSES.map((p) => ({ ...p })),
  coffee_pass_redemptions: REDEMPTIONS.map((r) => ({ ...r })),
  coffee_pass_adjustments: ADJUSTMENTS.map((a) => ({ ...a })),
});

const BASE_TABLES = (): Record<string, Row[]> => ({
  loyalty_transactions: LEDGER.map((r) => ({ ...r })),
  loyalty_config: [{ id: 'c', is_singleton: true, inr_per_point: 1, points_expiry_days: 30 }],
  profiles: PROFILES,
  orders: ORDER_ROWS,
  ...ritualTables(),
});

/** Marketing: one win-back campaign that ran in October, an old one, a draft, and one running now. */
const marketingTables = (): Record<string, Row[]> => ({
  marketing_campaigns: [
    {
      id: 'cm1', kind: 'playbook', playbook_key: 'winback_1', name: 'Win-back Oct', status: 'completed',
      offer: { type: 'percent', percent: 10, cap_inr: 0, min_order_inr: 0, validity_days: 7 },
      started_at: '2026-10-05T05:00:00Z', completed_at: '2026-10-06T05:00:00Z', created_at: '2026-10-04T05:00:00Z',
    },
    {
      id: 'cm2', kind: 'manual', playbook_key: null, name: 'September promo', status: 'completed',
      offer: { type: 'none' },
      started_at: '2026-09-10T05:00:00Z', completed_at: '2026-09-11T05:00:00Z', created_at: '2026-09-09T05:00:00Z',
    },
    {
      id: 'cm3', kind: 'manual', playbook_key: null, name: 'Draft', status: 'draft',
      offer: { type: 'none' }, started_at: null, completed_at: null, created_at: '2026-10-08T05:00:00Z',
    },
    {
      id: 'cm4', kind: 'manual', playbook_key: null, name: 'Running now', status: 'sending',
      offer: { type: 'flat', amount_inr: 30, min_order_inr: 0, validity_days: 5 },
      started_at: '2026-10-28T05:00:00Z', completed_at: null, created_at: '2026-10-27T05:00:00Z',
    },
  ],
  marketing_recipients: [
    // cm1: 3 sent (2 delivered, 1 read), 2 of them came back, plus a holdout of 2 with 0 returns.
    { id: 'm1', campaign_id: 'cm1', arm: 'treatment', status: 'read', clicked_at: '2026-10-05T06:00:00Z', converted_at: '2026-10-07T05:00:00Z', conversion_revenue_inr: 400, cost_inr: 1.02, sent_at: '2026-10-05T05:00:00Z' },
    { id: 'm2', campaign_id: 'cm1', arm: 'treatment', status: 'delivered', clicked_at: null, converted_at: '2026-10-08T05:00:00Z', conversion_revenue_inr: 250, cost_inr: 1.02, sent_at: '2026-10-05T05:00:00Z' },
    { id: 'm3', campaign_id: 'cm1', arm: 'treatment', status: 'sent', clicked_at: null, converted_at: null, conversion_revenue_inr: 0, cost_inr: 1.02, sent_at: '2026-10-05T05:00:00Z' },
    { id: 'm4', campaign_id: 'cm1', arm: 'holdout', status: 'holdout', clicked_at: null, converted_at: null, conversion_revenue_inr: 0, cost_inr: 0, sent_at: null },
    { id: 'm5', campaign_id: 'cm1', arm: 'holdout', status: 'holdout', clicked_at: null, converted_at: null, conversion_revenue_inr: 0, cost_inr: 0, sent_at: null },
    { id: 'm6', campaign_id: 'cm4', arm: 'treatment', status: 'sent', clicked_at: null, converted_at: null, conversion_revenue_inr: 0, cost_inr: 1.02, sent_at: '2026-10-28T05:00:00Z' },
  ],
  coupons: [
    { id: 'k1', campaign_id: 'cm1' },
    { id: 'k2', campaign_id: 'cm1' },
    { id: 'k3', campaign_id: 'cm4' },
  ],
  coupon_redemptions: [
    { id: 'x1', coupon_id: 'k1', order_id: 'o2', discount_inr: 30 },
    { id: 'x2', coupon_id: 'k2', order_id: 'o3', discount_inr: 25 },
    // Redeemed on a bill that was cancelled afterwards: redemptions are not reversed, so it is dropped here.
    { id: 'x3', coupon_id: 'k2', order_id: 'o4', discount_inr: 99 },
  ],
});

const DATASET: OrderDataset = {
  from: FROM,
  to: TO,
  gstRatePercent: 5,
  gstInclusive: false,
  orders: BEANIES_ORDERS as unknown as ExportOrder[],
  refunds: [],
};

function reportFor(key: string) {
  const def = LOYALTY_REPORTS.find((r) => r.key === key);
  if (!def) throw new Error(`no report ${key}`);
  return def;
}

describe('LOYALTY_REPORTS', () => {
  beforeEach(() => {
    flagState.coffeePass = true;
    flagState.marketing = true;
    datasetFor.current = DATASET;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function keysWith(coffeePass: boolean, marketing: boolean): Promise<string[]> {
    flagState.coffeePass = coffeePass;
    flagState.marketing = marketing;
    vi.resetModules();
    const mod = await import('@/lib/reports/exports/loyaltyReportsServer');
    expect(mod.LOYALTY_REPORTS.every((r) => r.group === 'loyalty')).toBe(true);
    return mod.LOYALTY_REPORTS.map((r) => r.key);
  }

  it('registers the Beanies sheets always, the Ritual sheets with the coffee-pass flag and the campaign sheet with the marketing flag', async () => {
    const beanies = ['beanies-summary', 'beanies-ledger', 'beanies-customers'];
    const ritual = ['ritual-summary', 'ritual-passes', 'ritual-redemptions'];
    expect(await keysWith(false, false)).toEqual(beanies);
    expect(await keysWith(true, false)).toEqual([...beanies, ...ritual]);
    expect(await keysWith(false, true)).toEqual([...beanies, 'campaign-performance']);
    expect(await keysWith(true, true)).toEqual([...beanies, ...ritual, 'campaign-performance']);
  });

  it('describes every sheet in a sentence', () => {
    for (const r of LOYALTY_REPORTS) {
      expect(r.title.length).toBeGreaterThan(3);
      expect(r.description.endsWith('.')).toBe(true);
    }
  });

  it('builds the Beanies ledger with names, masked phones and invoice numbers', async () => {
    const { admin } = fakeDb(BASE_TABLES());
    const t = await reportFor('beanies-ledger').load(admin, FROM, TO);
    const body = t.rows.filter((r) => /^\d{4}-/.test(String(r[0])));
    expect(body).toHaveLength(7);
    expect(body[0].slice(0, 8)).toEqual([
      '2026-10-05',
      '10:30',
      'Asha Verma',
      '••••••3210',
      'Earned',
      30,
      'HIOC-001002',
      'Earned on order #HIOC-001002',
    ]);
    expect(body[3][6]).toBe('HIOC-001004');
    expect(cell(t, rowNamed(t, 'TOTAL'), 'Points')).toBe(20);
  });

  it('builds Beanies by customer, naming only the people it lists', async () => {
    const { admin } = fakeDb(BASE_TABLES());
    const t = await reportFor('beanies-customers').load(admin, FROM, TO);
    expect(t.rows.slice(0, 3).map((r) => [r[0], r[6]])).toEqual([
      ['Asha Verma', 50],
      ['', 15], // u4 has no profile row
      ['Esha Rao', 12],
    ]);
    expect(cell(t, rowNamed(t, 'TOTAL'), 'Balance at period end')).toBe(82);
  });

  it('builds the Beanies summary from the ledger, the config and the dataset', async () => {
    const { admin } = fakeDb(BASE_TABLES());
    const t = await reportFor('beanies-summary').load(admin, FROM, TO);
    expect(vi.mocked(loadOrderDataset)).toHaveBeenCalledWith(admin, FROM, TO);
    expect(metric(t, 'Beanies earned (points)')).toBe(85);
    expect(metric(t, 'Beanies discount given (INR)')).toBe(50);
    expect(metric(t, 'Outstanding Beanies at period end (INR)')).toBe(82);
    expect(metric(t, 'Beanies expiring in the next 7 days (points)')).toBe(62);
  });

  it('reads the rupee rate and the expiry days from loyalty_config', async () => {
    const tables = BASE_TABLES();
    tables.loyalty_config = [{ id: 'c', is_singleton: true, inr_per_point: 0.5, points_expiry_days: 0 }];
    const t = await reportFor('beanies-summary').load(fakeDb(tables).admin, FROM, TO);
    expect(metric(t, 'Outstanding Beanies at period end (INR)')).toBe(41);
    expect(metric(t, 'Beanies expiring in the next 7 days (points)')).toBe(0);
  });

  it('falls back to the default rates when there is no config row, and to empty sheets without a ledger table', async () => {
    const tables = BASE_TABLES();
    tables.loyalty_config = [];
    const t = await reportFor('beanies-summary').load(fakeDb(tables).admin, FROM, TO);
    expect(metric(t, 'Outstanding Beanies at period end (INR)')).toBe(82);

    const bare = fakeDb(BASE_TABLES(), { missing: ['loyalty_transactions', 'loyalty_config'] }).admin;
    const summary = await reportFor('beanies-summary').load(bare, FROM, TO);
    expect(metric(summary, 'Beanies earned (points)')).toBe(0);
    const ledger = await reportFor('beanies-ledger').load(bare, FROM, TO);
    expect(ledger.rows.map((r) => r[0])).toEqual(['TOTAL', 'of which added (+)', 'of which taken off (−)']);
  });

  it('throws on a real read error instead of printing a wrong sheet', async () => {
    const { admin } = fakeDb(BASE_TABLES(), { broken: ['loyalty_transactions'] });
    await expect(reportFor('beanies-ledger').load(admin, FROM, TO)).rejects.toThrow(/exploded/);
  });

  it('builds the Ritual sheets from the pass view, the redemptions and the adjustments', async () => {
    const { admin } = fakeDb(BASE_TABLES());
    const summary = await reportFor('ritual-summary').load(admin, FROM, TO);
    expect(metric(summary, 'Rituals sold')).toBe(3);
    expect(metric(summary, 'Liability at period end (INR)')).toBe(643);
    expect(metric(summary, 'Renewal rate (%)')).toBe(25);

    const passes = await reportFor('ritual-passes').load(admin, FROM, TO);
    expect(passes.rows.slice(0, -1).map((r) => [r[1], r[2], r[11]])).toEqual([
      ['HIOC-002001', 'Asha Verma', 'Expired'],
      ['HIOC-002005', 'Dev Patel', 'Refunded'],
      ['HIOC-002010', 'Asha Verma', 'Expired'],
      ['HIOC-002020', 'Meera Joshi', 'Active'],
    ]);
    expect(cell(passes, 1, 'Refunded on')).toBe('2026-10-06');

    const cups = await reportFor('ritual-redemptions').load(admin, FROM, TO);
    expect(cell(cups, rowNamed(cups, 'TOTAL'), 'Cups')).toBe(12);
    expect(cups.rows.find((r) => r[1] === 'HIOC-002107')?.[7]).toBe('Yes');
  });

  it('reads the passes without the drink label on a database that predates it', async () => {
    const { admin } = fakeDb(BASE_TABLES(), { lacking: { v_coffee_pass_balances: ['drink_label'] } });
    const passes = await reportFor('ritual-passes').load(admin, FROM, TO);
    expect(passes.rows).toHaveLength(5);
    expect(cell(passes, 0, 'Drink')).toBe('');
    expect(cell(passes, 0, 'Plan')).toBe(WEEKLY);
  });

  it('gives header-only Ritual sheets when the pass tables are not there', async () => {
    const { admin } = fakeDb(BASE_TABLES(), {
      missing: ['v_coffee_pass_balances', 'coffee_pass_redemptions', 'coffee_pass_adjustments'],
    });
    for (const key of ['ritual-summary', 'ritual-passes', 'ritual-redemptions']) {
      const t = await reportFor(key).load(admin, FROM, TO);
      expect(t.columns.length).toBeGreaterThan(2);
      expect(t.rows).toEqual([]);
    }
  });

  it('builds the campaign sheet: campaigns that ran in the range, results folded from the recipients, coupon discount on valid bills', async () => {
    const { admin } = fakeDb({ ...BASE_TABLES(), ...marketingTables() });
    const t = await reportFor('campaign-performance').load(admin, FROM, TO);
    // The September campaign finished before the range and the draft never started; 'Running now' has.
    expect(t.rows.map((r) => r[0])).toEqual(['Win-back Oct', 'Running now', 'TOTAL']);
    expect(cell(t, 0, 'Kind')).toBe('Win-back · stage 1 (we miss you)');
    expect(cell(t, 0, 'Offer')).toBe('10% off');
    expect(cell(t, 0, 'Started')).toBe('2026-10-05');
    expect(cell(t, 0, 'Sent')).toBe(3);
    expect(cell(t, 0, 'Delivered')).toBe(2);
    expect(cell(t, 0, 'Read')).toBe(1);
    expect(cell(t, 0, 'Clicked')).toBe(1);
    expect(cell(t, 0, 'Conversions')).toBe(2);
    expect(cell(t, 0, 'Conversion %')).toBe(66.7);
    expect(cell(t, 0, 'Revenue (INR)')).toBe(650);
    expect(cell(t, 0, 'Cost (INR)')).toBe(3.06);
    // 30 + 25: the 99 on the cancelled bill is not counted.
    expect(cell(t, 0, 'Coupon discount given (INR)')).toBe(55);
    // Two holdout recipients: below the 20 needed for a lift.
    expect(cell(t, 0, 'Lift (pp)')).toBe('');
    expect(cell(t, 1, 'Kind')).toBe('Manual campaign');
    expect(cell(t, 1, 'Offer')).toBe('₹30 off');
    expect(cell(t, 1, 'Coupon discount given (INR)')).toBe(0);
  });

  it('gives an empty campaign sheet when the marketing tables are not there', async () => {
    const { admin } = fakeDb(BASE_TABLES(), { missing: ['marketing_campaigns'] });
    const t = await reportFor('campaign-performance').load(admin, FROM, TO);
    expect(t.columns).toHaveLength(15);
    expect(t.rows).toEqual([]);
  });

  it('still lists the campaigns when coupons have no campaign column yet', async () => {
    const { admin } = fakeDb({ ...BASE_TABLES(), ...marketingTables() }, { lacking: { coupons: ['campaign_id'] } });
    const t = await reportFor('campaign-performance').load(admin, FROM, TO);
    expect(cell(t, 0, 'Sent')).toBe(3);
    expect(cell(t, 0, 'Coupon discount given (INR)')).toBe(0);
  });
});

describe('loadProgrammeInsights', () => {
  beforeEach(() => {
    flagState.coffeePass = true;
    flagState.marketing = true;
    datasetFor.current = DATASET;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns all three sections and highlights when both features are on', async () => {
    const { admin } = fakeDb({ ...BASE_TABLES(), ...marketingTables() });
    const p = await loadProgrammeInsights(admin, FROM, TO);
    expect(p.range).toEqual({ from: FROM, to: TO });
    expect(p.beanies.outstandingPoints).toBe(82);
    expect(p.beanies.billsWithRedemption).toBe(2);
    expect(p.ritual?.soldCount).toBe(3);
    expect(p.ritual?.liabilityAtEndInr).toBe(643);
    expect(p.campaigns?.campaigns.map((c) => c.name)).toEqual(['Win-back Oct', 'Running now']);
    expect(p.problems).toEqual({});
    expect(p.highlights.length).toBeGreaterThan(0);
    expect(p.highlights.length).toBeLessThanOrEqual(6);
    expect(p.highlights[0]).toBe('Bills where customers redeemed Beanies averaged ₹150 vs ₹280 without.');
  });

  it('has null Ritual and campaign sections, and reads none of their tables, while the flags are off', async () => {
    flagState.coffeePass = false;
    flagState.marketing = false;
    const { admin, reads } = fakeDb({ ...BASE_TABLES(), ...marketingTables() });
    const p = await loadProgrammeInsights(admin, FROM, TO);
    expect(p.ritual).toBeNull();
    expect(p.campaigns).toBeNull();
    expect(p.problems).toEqual({});
    expect(p.beanies.earnedPoints).toBe(85);
    expect(reads.some((t) => t.startsWith('coffee_pass') || t.startsWith('v_coffee') || t.startsWith('marketing'))).toBe(false);
    expect(p.highlights.every((l) => !l.includes('Ritual') && !l.includes('brought back'))).toBe(true);
  });

  it('has null sections when the features are on but their tables are not there', async () => {
    const { admin } = fakeDb(BASE_TABLES(), {
      missing: ['v_coffee_pass_balances', 'coffee_pass_redemptions', 'coffee_pass_adjustments', 'marketing_campaigns'],
    });
    const p = await loadProgrammeInsights(admin, FROM, TO);
    expect(p.ritual).toBeNull();
    expect(p.campaigns).toBeNull();
    expect(p.problems).toEqual({});
  });

  it('keeps the other sections and says which one failed when a switched-on section errors', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { admin } = fakeDb({ ...BASE_TABLES(), ...marketingTables() }, { broken: ['coffee_pass_redemptions'] });
    const p = await loadProgrammeInsights(admin, FROM, TO);
    expect(p.ritual).toBeNull();
    expect(p.problems).toEqual({ ritual: 'Could not load the HIOC Ritual numbers.' });
    expect(p.campaigns).not.toBeNull();
    expect(p.beanies.earnedPoints).toBe(85);
    spy.mockRestore();
  });

  it('throws when the Beanies section itself cannot be read', async () => {
    const { admin } = fakeDb(BASE_TABLES(), { broken: ['loyalty_transactions'] });
    await expect(loadProgrammeInsights(admin, FROM, TO)).rejects.toThrow(/exploded/);
  });

  it('works on a database with no loyalty activity at all', async () => {
    datasetFor.current = { ...DATASET, orders: [] };
    const { admin } = fakeDb({ loyalty_transactions: [], loyalty_config: [], profiles: [] });
    flagState.coffeePass = false;
    flagState.marketing = false;
    const p = await loadProgrammeInsights(admin, FROM, TO);
    expect(p.beanies.outstandingPoints).toBe(0);
    expect(p.highlights).toEqual([]);
  });
});
