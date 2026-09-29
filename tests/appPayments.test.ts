import { describe, expect, it } from 'vitest';
import { isPaymentMethod, PAYMENT_METHODS } from '@/lib/api/constants';
import {
  APP_PAYMENT_METHODS,
  cashPortionInr,
  COUNTER_PAYMENT_METHODS,
  dominantMethod,
  isAppPaymentMethod,
  parsePaymentReference,
  validateParts,
} from '@/lib/orders/payments';
import { receivedByMethod, totalReceived } from '@/lib/orders/paymentTotals';
import { describeOrderPayment } from '@/lib/orders/paymentLabel';
import { tenderBalances, validateCounterRefund } from '@/lib/orders/refunds';
import { buildReport, reportCsv, type ReportInput } from '@/lib/reports/reconcile';
import { PAYMENT_METHOD_LABEL } from '@/lib/print/labels';

// Dining-app payments (supabase/2026-10-aggregator-payments.sql): a diner who
// booked through Swiggy Dineout or Zomato District pays inside that app, and
// the counter settles the bill against it. Non-cash, like UPI and card — the
// platform owes the money, the drawer never sees it.

describe('dining-app payment methods', () => {
  it('are valid payment methods the counter offers, and never the website gateway', () => {
    for (const m of ['swiggy_dineout', 'zomato_district']) {
      expect(isPaymentMethod(m)).toBe(true);
      expect(PAYMENT_METHODS).toContain(m);
      expect(COUNTER_PAYMENT_METHODS).toContain(m);
      expect(isAppPaymentMethod(m)).toBe(true);
    }
    expect(COUNTER_PAYMENT_METHODS).not.toContain('online');
    expect(APP_PAYMENT_METHODS).toEqual(['swiggy_dineout', 'zomato_district']);
    expect(isAppPaymentMethod('upi')).toBe(false);
    expect(isAppPaymentMethod(null)).toBe(false);
  });

  it('have human labels for the bill, receipt and staff screens', () => {
    expect(PAYMENT_METHOD_LABEL.swiggy_dineout).toBe('Swiggy Dineout');
    expect(PAYMENT_METHOD_LABEL.zomato_district).toBe('Zomato District');
  });
});

describe('settling against a dining app', () => {
  it('accepts the whole bill on one app, with its booking ID', () => {
    const v = validateParts([{ method: 'swiggy_dineout', amount_inr: 850, reference: 'sd-88231' }], 850);
    expect(v).toEqual({
      ok: true,
      parts: [{ method: 'swiggy_dineout', amount_inr: 850, tendered_inr: null, reference: 'SD-88231' }],
      changeInr: 0,
    });
  });

  it('refuses an app part with no booking ID', () => {
    const v = validateParts([{ method: 'zomato_district', amount_inr: 850 }], 850);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toMatch(/booking \/ transaction id/i);
  });

  it('drops a reference sent on a non-app part', () => {
    const v = validateParts([{ method: 'upi', amount_inr: 850, reference: 'X1234' }], 850);
    expect(v.ok && v.parts[0]).toEqual({ method: 'upi', amount_inr: 850, tendered_inr: null });
  });

  it('splits with cash, and only the cash part counts toward the drawer', () => {
    const v = validateParts(
      [
        { method: 'zomato_district', amount_inr: 600, reference: 'ZD1001' },
        { method: 'cash', amount_inr: 150, tendered_inr: 200 },
      ],
      750,
    );
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.changeInr).toBe(50);
    expect(cashPortionInr(v.parts)).toBe(150);
    expect(dominantMethod(v.parts)).toBe('zomato_district');
  });

  it('drops a tendered amount sent with an app part — nothing is handed over', () => {
    const v = validateParts([{ method: 'swiggy_dineout', amount_inr: 300, tendered_inr: 500, reference: 'SD1001' }], 300);
    expect(v.ok && v.parts[0].tendered_inr).toBe(null);
  });

  it('still rejects an unknown method, naming the real list', () => {
    const v = validateParts([{ method: 'swiggy', amount_inr: 300 }], 300);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toContain('swiggy_dineout');
    expect(v.error).toContain('zomato_district');
  });

  it('describes a split bill with the app named', () => {
    expect(
      describeOrderPayment({
        payment_method: 'swiggy_dineout',
        payments: [
          { method: 'swiggy_dineout', amount_inr: 500 },
          { method: 'upi', amount_inr: 120 },
        ],
      } as never),
    ).toBe('Swiggy Dineout ₹500 + UPI ₹120');
    expect(describeOrderPayment({ payment_method: 'zomato_district', payments: [] } as never)).toBe('Zomato District');
  });
});

describe('parsePaymentReference', () => {
  it('normalises how a staffer reads it off a phone: spaces out, upper-case', () => {
    expect(parsePaymentReference('  sd 4471 9920 ')).toEqual({ ok: true, reference: 'SD44719920' });
    expect(parsePaymentReference('zd-2026/0099_a')).toEqual({ ok: true, reference: 'ZD-2026/0099_A' });
  });

  it('refuses a missing, too-short, too-long or odd-character ID', () => {
    expect(parsePaymentReference(undefined).ok).toBe(false);
    expect(parsePaymentReference('   ').ok).toBe(false);
    expect(parsePaymentReference('ab1').ok).toBe(false);
    expect(parsePaymentReference('A'.repeat(41)).ok).toBe(false);
    expect(parsePaymentReference('SD#1234').ok).toBe(false);
    expect(parsePaymentReference('-1234').ok).toBe(false);
    expect(parsePaymentReference(12345).ok).toBe(false);
  });
});

describe('refunding a dining-app tender', () => {
  it('is refundable on that tender only, up to what the app paid', () => {
    const balances = tenderBalances(
      [
        { method: 'swiggy_dineout', amount_inr: 400 },
        { method: 'cash', amount_inr: 100 },
      ],
      [],
    );
    expect(validateCounterRefund(balances, 'swiggy_dineout', 150)).toMatchObject({
      ok: true,
      method: 'swiggy_dineout',
      amountInr: 150,
    });
    expect(validateCounterRefund(balances, 'zomato_district', 50).ok).toBe(false);
  });
});

describe('money received, by method', () => {
  it('Orders tab totals count each app separately', () => {
    const paid = { status: 'completed', payment_status: 'paid', subtotal_inr: 0 } as const;
    const received = receivedByMethod([
      { ...paid, payment_method: 'swiggy_dineout', payments: [], total_inr: 700 },
      { ...paid, payment_method: 'zomato_district', payments: [], total_inr: 450 },
      {
        ...paid,
        payment_method: 'zomato_district',
        payments: [
          { method: 'zomato_district', amount_inr: 300 },
          { method: 'cash', amount_inr: 100 },
        ],
        total_inr: 400,
      },
    ] as never);
    expect(received.swiggy_dineout).toEqual({ amount_inr: 700, orders: 1 });
    expect(received.zomato_district).toEqual({ amount_inr: 750, orders: 2 });
    expect(received.cash).toEqual({ amount_inr: 100, orders: 1 });
    expect(totalReceived(received)).toBe(1550);
  });

  it('the owner report and its CSV carry each app as its own column', () => {
    const input: ReportInput = {
      from: '2026-09-27',
      to: '2026-09-27',
      orders: [],
      parts: [
        { order_id: 's', method: 'swiggy_dineout', amount_inr: 500, created_at: '2026-09-27T10:00:00Z' },
        { order_id: 's', method: 'cash', amount_inr: 100, created_at: '2026-09-27T10:00:00Z' },
      ],
      paidOrders: [
        { id: 'z', payment_method: 'zomato_district', total_inr: 900, subtotal_inr: 900, paid_at: '2026-09-27T12:00:00Z' },
      ],
      ordersWithParts: new Set(['s']),
      refunds: [{ amount_inr: 200, method: 'zomato_district', processed_at: '2026-09-27T13:00:00Z' }],
      movements: [],
      cashDays: [],
    };
    const r = buildReport(input);
    expect(r.days[0].received).toMatchObject({ cash: 100, swiggy_dineout: 500, zomato_district: 900 });
    expect(r.days[0].refunds.zomato_district).toBe(200);
    expect(r.totals.receivedTotalInr).toBe(1500);
    expect(r.totals.netReceivedInr).toBe(1300);

    const [header, row] = reportCsv(r).split('\n');
    const cols = header.split(',');
    const cells = row.split(',');
    expect(cells[cols.indexOf('Swiggy Dineout received (INR)')]).toBe('500');
    expect(cells[cols.indexOf('Zomato District received (INR)')]).toBe('900');
  });
});
