import { describe, expect, it } from 'vitest';
import {
  buildReport,
  closingCountRows,
  closingDayOf,
  datesBetween,
  istDateOf,
  parseRange,
  rangeBounds,
  reportCsv,
  type ReportInput,
} from '@/lib/reports/reconcile';

// The owner reconciliation report (lib/reports/reconcile.ts): sales on the day
// an order was placed, money on the day it was received (the cash day's own
// rules), per IST day, with a CSV for the accountant.

const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  from: '2026-09-27',
  to: '2026-09-28',
  orders: [],
  parts: [],
  paidOrders: [],
  ordersWithParts: new Set(),
  refunds: [],
  movements: [],
  cashDays: [],
  ...over,
});

describe('dates', () => {
  it('buckets by the IST day, not the UTC one', () => {
    expect(istDateOf('2026-09-27T18:29:00Z')).toBe('2026-09-27'); // 23:59 IST
    expect(istDateOf('2026-09-27T18:30:00Z')).toBe('2026-09-28'); // 00:00 IST
  });

  it('lists every day in the range and bounds it in UTC', () => {
    expect(datesBetween('2026-09-29', '2026-10-02')).toEqual(['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02']);
    expect(rangeBounds('2026-09-27', '2026-09-28')).toEqual({
      startIso: '2026-09-26T18:30:00.000Z',
      endIso: '2026-09-28T18:30:00.000Z',
    });
  });

  it('validates the range', () => {
    const today = '2026-09-29';
    expect(parseRange(undefined, undefined, today)).toEqual({ ok: true, from: today, to: today });
    expect(parseRange('2026-09-01', undefined, today)).toEqual({ ok: true, from: '2026-09-01', to: '2026-09-01' });
    expect(parseRange('2026-09-10', '2026-09-01', today).ok).toBe(false);
    expect(parseRange('2026-09-01', '2026-09-30', today).ok).toBe(false); // future
    expect(parseRange('2026-02-30', '2026-03-01', today).ok).toBe(false);
    expect(parseRange('2026-01-01', '2026-09-01', today).ok).toBe(false); // too long
  });
});

describe('buildReport', () => {
  it('counts sales on the day placed, leaving cancelled out and unpaid flagged', () => {
    const r = buildReport(
      base({
        orders: [
          { id: 'a', created_at: '2026-09-27T05:00:00Z', status: 'completed', payment_status: 'paid', total_inr: 300, subtotal_inr: 280, tax_inr: 20, discount_inr: 0, settle_discount_inr: 10 },
          { id: 'b', created_at: '2026-09-27T06:00:00Z', status: 'ready', payment_status: 'unpaid', total_inr: 150, subtotal_inr: 150, tax_inr: 0, discount_inr: 0 },
          { id: 'c', created_at: '2026-09-27T07:00:00Z', status: 'cancelled', payment_status: 'unpaid', total_inr: 999, subtotal_inr: 999, tax_inr: 0, discount_inr: 0 },
        ],
      }),
    );
    const d = r.days[0];
    expect(d).toMatchObject({ date: '2026-09-27', orders: 2, cancelled: 1, grossSalesInr: 450, taxInr: 20, settleDiscountInr: 10, netSalesInr: 440, unpaidOrders: 1, unpaidInr: 150 });
    expect(r.days[1].orders).toBe(0);
  });

  it('counts money on the day received, by method — split parts by their own time', () => {
    const r = buildReport(
      base({
        parts: [
          { order_id: 's', method: 'cash', amount_inr: 100, created_at: '2026-09-27T10:00:00Z' },
          { order_id: 's', method: 'upi', amount_inr: 200, created_at: '2026-09-27T10:01:00Z' },
        ],
        paidOrders: [
          { id: 's', payment_method: 'upi', total_inr: 300, subtotal_inr: 300, paid_at: '2026-09-27T10:01:00Z' }, // has parts → skipped
          { id: 'x', payment_method: 'card', total_inr: 250, subtotal_inr: 250, paid_at: '2026-09-28T04:00:00Z', tip_inr: 20 },
          { id: 'y', payment_method: 'online', total_inr: 180, subtotal_inr: 180, paid_at: '2026-09-28T19:00:00Z' }, // 29th IST: outside
        ],
        ordersWithParts: new Set(['s']),
      }),
    );
    expect(r.days[0].received).toEqual({ cash: 100, upi: 200, card: 0, online: 0, swiggy_dineout: 0, zomato_district: 0 });
    expect(r.days[1].received).toEqual({ cash: 0, upi: 0, card: 250, online: 0, swiggy_dineout: 0, zomato_district: 0 });
    expect(r.days[1].tipsInr).toBe(20);
    expect(r.totals.receivedTotalInr).toBe(550);
  });

  it('takes refunds off on the day processed; a legacy refund with no method was cash', () => {
    const r = buildReport(
      base({
        paidOrders: [{ id: 'x', payment_method: 'cash', total_inr: 500, subtotal_inr: 500, paid_at: '2026-09-27T05:00:00Z' }],
        refunds: [
          { amount_inr: 100, method: null, processed_at: '2026-09-27T06:00:00Z' },
          { amount_inr: 50, method: 'upi', processed_at: '2026-09-28T06:00:00Z' },
        ],
      }),
    );
    expect(r.days[0].refunds.cash).toBe(100);
    expect(r.days[0].netReceivedInr).toBe(400);
    expect(r.days[1].refunds.upi).toBe(50);
    expect(r.totals.netReceivedInr).toBe(350);
  });

  it('carries cash movements and each day’s drawer close, totalling over/short for closed days only', () => {
    const r = buildReport(
      base({
        movements: [
          { direction: 'out', amount_inr: 2000, created_at: '2026-09-27T12:00:00Z' },
          { direction: 'in', amount_inr: 500, created_at: '2026-09-28T03:00:00Z' },
        ],
        cashDays: [
          { business_date: '2026-09-27', status: 'closed', opening_total_inr: 1000, cash_sales_inr: 4000, expected_cash_inr: 3000, counted_total_inr: 2950, over_short_inr: -50 },
          { business_date: '2026-09-28', status: 'open', opening_total_inr: 1000, cash_sales_inr: null, expected_cash_inr: 0, counted_total_inr: 0, over_short_inr: 0 },
        ],
      }),
    );
    expect(r.days[0]).toMatchObject({ cashOutInr: 2000, cashInInr: 0 });
    expect(r.days[0].cashDays[0]?.over_short_inr).toBe(-50);
    expect(r.totals).toMatchObject({ cashInInr: 500, cashOutInr: 2000, cashDaysClosed: 1, overShortInr: -50 });
  });

  it('counts expensesInr only for categorised cash-outs, as a subset of cashOutInr', () => {
    const r = buildReport(
      base({
        movements: [
          { direction: 'out', amount_inr: 2000, created_at: '2026-09-27T12:00:00Z' }, // plain manager cash out
          { direction: 'out', amount_inr: 80, created_at: '2026-09-27T13:00:00Z', category: 'ice' },
          { direction: 'out', amount_inr: 120, created_at: '2026-09-27T14:00:00Z', category: 'milk_dairy' },
          { direction: 'out', amount_inr: 40, created_at: '2026-09-28T04:00:00Z', category: null },
          { direction: 'in', amount_inr: 500, created_at: '2026-09-28T03:00:00Z', category: 'ice' }, // never a real row (check constraint), still not an expense
        ],
      }),
    );
    expect(r.days[0]).toMatchObject({ cashOutInr: 2200, expensesInr: 200, cashInInr: 0 });
    expect(r.days[1]).toMatchObject({ cashOutInr: 40, expensesInr: 0, cashInInr: 500 });
    expect(r.totals).toMatchObject({ cashOutInr: 2240, expensesInr: 200, cashInInr: 500 });
  });

  it('leaves voided (undone) expenses out of cash out and expenses, and keeps pending ones', () => {
    const r = buildReport(
      base({
        movements: [
          { direction: 'out', amount_inr: 2000, created_at: '2026-09-27T12:00:00Z', voided_at: null }, // plain manager cash out
          { direction: 'out', amount_inr: 80, created_at: '2026-09-27T13:00:00Z', category: 'ice', voided_at: null }, // pending
          { direction: 'out', amount_inr: 300, created_at: '2026-09-27T14:00:00Z', category: 'milk_dairy', voided_at: '2026-09-27T14:05:00Z' }, // undone
        ],
      }),
    );
    expect(r.days[0]).toMatchObject({ cashOutInr: 2080, expensesInr: 80 });
    expect(r.totals).toMatchObject({ cashOutInr: 2080, expensesInr: 80 });
  });

  it('leaves a close’s handover out of cash out — it is the cash day’s handover, not money spent', () => {
    const r = buildReport(
      base({
        movements: [
          { direction: 'out', amount_inr: 300, created_at: '2026-09-27T12:00:00Z', reason: 'Bought ice' },
          { direction: 'out', amount_inr: 9900, created_at: '2026-09-27T19:46:00Z', reason: 'Day close handover (2026-09-27): cash taken out to owner/bank' },
        ],
      }),
    );
    expect(r.days[1]).toMatchObject({ cashOutInr: 0 }); // the handover landed after midnight IST
    expect(r.days[0]).toMatchObject({ cashOutInr: 300 });
    expect(r.totals.cashOutInr).toBe(300);
  });

  it('keeps every cash day of a date and adds up the closed ones for the drawer', () => {
    const r = buildReport(
      base({
        cashDays: [
          // Out of order on purpose: a date's cash days are kept oldest first.
          { id: 'b', business_date: '2026-09-27', status: 'closed', opened_at: '2026-09-27T12:00:00Z', closed_at: '2026-09-27T19:00:00Z', opening_total_inr: 1500, cash_sales_inr: 3000, cash_sales_count: 6, cash_refunds_inr: 0, cash_in_inr: 0, cash_out_inr: 0, expected_cash_inr: 4500, counted_total_inr: 4480, over_short_inr: -20, handover_inr: 2480, float_left_total_inr: 2000 },
          { id: 'a', business_date: '2026-09-27', status: 'closed', opened_at: '2026-09-27T04:00:00Z', closed_at: '2026-09-27T09:00:00Z', opening_total_inr: 1000, cash_sales_inr: 1000, cash_sales_count: 2, cash_refunds_inr: 100, cash_in_inr: 50, cash_out_inr: 80, expenses_inr: 80, expected_cash_inr: 1870, counted_total_inr: 1880, over_short_inr: 10, handover_inr: 380, float_left_total_inr: 1500 },
          { id: 'c', business_date: '2026-09-28', status: 'open', opened_at: '2026-09-28T09:00:00Z', opening_total_inr: 2000, cash_sales_inr: null, expected_cash_inr: 0, counted_total_inr: 0, over_short_inr: 0 },
        ],
      }),
    );
    expect(r.days[0].cashDays.map((c) => c.id)).toEqual(['a', 'b']);
    expect(r.days[1].cashDays.map((c) => c.id)).toEqual(['c']);
    expect(closingDayOf(r.days[0])?.id).toBe('b'); // the store's closing count is the last close
    expect(closingDayOf(r.days[1])).toBeNull();
    expect(r.totals).toMatchObject({ cashDaysClosed: 2, overShortInr: -10 });
    expect(r.drawer).toEqual({
      days: 3,
      closed: 2,
      open: 1,
      cashSalesInr: 4000,
      cashSalesCount: 8,
      cashRefundsInr: 100,
      cashInInr: 50,
      cashOutInr: 80,
      expensesInr: 80,
      overShortInr: -10,
      handoverInr: 2860,
      floatLeftInr: 2000,
    });
  });

  it('lays out a closing count by denomination with what stayed as the float', () => {
    expect(
      closingCountRows({
        closing_denoms: { '500': 4, '200': 0, '100': 3, '10': 2, '2000': 9 }, // an unknown note never counts
        float_left_denoms: { '500': 1, '100': 5 }, // more than counted is capped
      }),
    ).toEqual([
      { key: '500', label: '₹500', count: 4, amountInr: 2000, floatLeft: 1, takenOut: 3 },
      { key: '100', label: '₹100', count: 3, amountInr: 300, floatLeft: 3, takenOut: 0 },
      { key: '10', label: '₹10', count: 2, amountInr: 20, floatLeft: 0, takenOut: 2 },
    ]);
    // Coins counted before 2026-09 were one lump amount.
    expect(closingCountRows({ closing_denoms: { coins: 37 }, float_left_denoms: null })).toEqual([
      { key: 'coins', label: 'Coins (₹)', count: 37, amountInr: 37, floatLeft: 0, takenOut: 37 },
    ]);
    expect(closingCountRows({ closing_denoms: {}, float_left_denoms: {} })).toEqual([]);
  });

  it('puts each date’s drawer and its closing count by denomination in the CSV', () => {
    const r = buildReport(
      base({
        cashDays: [
          { business_date: '2026-09-27', status: 'closed', opened_at: '2026-09-27T09:00:00Z', opening_total_inr: 2000, cash_sales_inr: 5000, expected_cash_inr: 7000, counted_total_inr: 6950, over_short_inr: -50, closing_denoms: { '500': 13, '200': 1, '100': 2, '50': 1 }, handover_inr: 4950, float_left_total_inr: 2000 },
        ],
      }),
    );
    const [header, day1, day2, total] = reportCsv(r).trim().split('\n').map((l) => l.split(','));
    const col = (row: string[], h: string) => row[header.indexOf(h)];
    expect(col(day1, 'Cash day')).toBe('closed');
    expect(col(day1, 'Drawer opening float (INR)')).toBe('2000');
    expect(col(day1, 'Drawer cash sales (INR)')).toBe('5000');
    expect(col(day1, 'Drawer counted (INR)')).toBe('6950');
    expect(col(day1, 'Over/short (INR)')).toBe('-50');
    expect(col(day1, 'Handed over (INR)')).toBe('4950');
    expect(col(day1, 'Float left (INR)')).toBe('2000');
    expect(col(day1, 'Closing count 500 (pcs)')).toBe('13');
    expect(col(day1, 'Closing count 50 (pcs)')).toBe('1');
    expect(col(day1, 'Closing count 1 (pcs)')).toBe('0');
    expect(col(day2, 'Cash day')).toBe('');
    expect(col(day2, 'Closing count 500 (pcs)')).toBe('');
    expect(col(total, 'Over/short (INR)')).toBe('-50');
    expect(col(total, 'Handed over (INR)')).toBe('4950');
    expect(col(total, 'Drawer counted (INR)')).toBe('');
  });

  it('writes a CSV with a row per day and a total row', () => {
    const r = buildReport(
      base({
        orders: [{ id: 'a', created_at: '2026-09-27T05:00:00Z', status: 'completed', payment_status: 'paid', total_inr: 300, subtotal_inr: 300, tax_inr: 0, discount_inr: 0 }],
        paidOrders: [{ id: 'a', payment_method: 'cash', total_inr: 300, subtotal_inr: 300, paid_at: '2026-09-27T05:10:00Z' }],
      }),
    );
    const lines = reportCsv(r).trim().split('\n');
    expect(lines).toHaveLength(4); // header, 2 days, total
    expect(lines[0].startsWith('Date,Orders,')).toBe(true);
    expect(lines[1].startsWith('2026-09-27,1,0,300,')).toBe(true);
    expect(lines[3].startsWith('TOTAL,1,0,300,')).toBe(true);
  });

  it('puts the Expenses column right after Cash out, with totals', () => {
    const r = buildReport(
      base({
        movements: [
          { direction: 'out', amount_inr: 500, created_at: '2026-09-27T12:00:00Z' },
          { direction: 'out', amount_inr: 90, created_at: '2026-09-27T13:00:00Z', category: 'water' },
        ],
      }),
    );
    const [header, day1, , total] = reportCsv(r).trim().split('\n').map((l) => l.split(','));
    const at = header.indexOf('Cash out (INR)');
    expect(header[at + 1]).toBe('Expenses (INR)');
    expect(day1.slice(at, at + 2)).toEqual(['590', '90']);
    expect(total.slice(at, at + 2)).toEqual(['590', '90']);
  });
});

describe('reportCsv — HIOC Ritual columns (CP-D21)', () => {
  it('always carries the four Ritual columns right after Net sales, zero when unused', () => {
    const r = buildReport(
      base({
        orders: [{ id: 'a', created_at: '2026-09-27T05:00:00Z', status: 'completed', payment_status: 'paid', total_inr: 300, subtotal_inr: 300, tax_inr: 0, discount_inr: 0 }],
        paidOrders: [{ id: 'a', payment_method: 'cash', total_inr: 300, subtotal_inr: 300, paid_at: '2026-09-27T05:10:00Z' }],
      }),
    );
    const [header, day1, , total] = reportCsv(r).trim().split('\n').map((l) => l.split(','));
    const at = header.indexOf('Net sales (INR)');
    expect(header.slice(at + 1, at + 5)).toEqual([
      'HIOC Ritual sales',
      'HIOC Ritual sales (INR)',
      'Ritual cups served',
      'Ritual cups covered (INR)',
    ]);
    expect(day1.slice(at + 1, at + 5)).toEqual(['0', '0', '0', '0']);
    expect(total.slice(at + 1, at + 5)).toEqual(['0', '0', '0', '0']);
  });

  it('writes the day and TOTAL figures from passSales and passRedemptions', () => {
    const r = buildReport(
      base({
        orders: [{ id: 'a', created_at: '2026-09-27T05:00:00Z', status: 'completed', payment_status: 'paid', total_inr: 300, subtotal_inr: 300, tax_inr: 0, discount_inr: 0 }],
        paidOrders: [{ id: 'a', payment_method: 'cash', total_inr: 300, subtotal_inr: 300, paid_at: '2026-09-27T05:10:00Z' }],
      }),
    );
    // The CSV only reads the report's own figures; set them as buildReport would.
    r.days[0].passSales = { count: 2, inr: 1576 };
    r.days[0].passRedemptions = { drinks: 3, inr: 390 };
    r.totals.passSales = { count: 2, inr: 1576 };
    r.totals.passRedemptions = { drinks: 3, inr: 390 };
    const [header, day1, , total] = reportCsv(r).trim().split('\n').map((l) => l.split(','));
    const at = header.indexOf('HIOC Ritual sales');
    expect(day1.slice(at, at + 4)).toEqual(['2', '1576', '3', '390']);
    expect(total.slice(at, at + 4)).toEqual(['2', '1576', '3', '390']);
  });
});
