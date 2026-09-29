import { describe, expect, it } from 'vitest';
import {
  buildReport,
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
    expect(r.days[0].cashDay?.over_short_inr).toBe(-50);
    expect(r.totals).toMatchObject({ cashInInr: 500, cashOutInr: 2000, cashDaysClosed: 1, overShortInr: -50 });
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
});
