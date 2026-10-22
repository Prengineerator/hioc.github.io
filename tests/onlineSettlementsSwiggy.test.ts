import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { readWorkbook } from '@/lib/online-settlements/sheets';
import { ingestSettlementFile } from '@/lib/online-settlements/ingest';
import { isSwiggySettlement, parseSwiggySettlement, payoutPeriod } from '@/lib/online-settlements/swiggy';
import { isZomatoSettlement } from '@/lib/online-settlements/zomato';
import { memoryStore } from './helpers/memorySettlementStore';
import { HEADER, buildSwiggyWorkbook, orderPayout, orderRow, type SwiggyOrder } from './helpers/swiggySettlementFixture';
import { buildZomatoWorkbook } from './helpers/zomatoSettlementFixture';

// The Swiggy payout annexure parser (lib/online-settlements/swiggy.ts), against
// a workbook built in the real report's layout (tests/helpers/
// swiggySettlementFixture.ts) and read through the real exceljs path; how
// Zomato and Swiggy files are told apart; and the ingest pipeline reading one.

const NAME = 'invoice_Annexure_555001_14102026_1700000000000.xlsx';

const ORDERS: SwiggyOrder[] = [
  {
    id: '260000000000001', date: '2026-10-04 19:01:14', payment: 'cash', coupon: 'TESTCODE', itemTotal: 500, discount: 100,
    gst: 21, commission: 105.84, paymentFee: 8.82, gstOnFees: 20.64, tds: 0.42,
  },
  {
    id: '260000000000002', date: '2026-10-05 12:30:00', payment: 'prepaid', itemTotal: 300, gst: 16, commission: 80.64,
    longDistance: 15, paymentFee: 6.72, gstOnFees: 18.42, tds: 0.32,
  },
  {
    id: '260000000000003', date: '2026-10-06 20:00:00', status: 'cancelled', cancelledBy: 'Restaurant', itemTotal: 250,
    cancelCharge: 30, payout: -30,
  },
];
const PAYOUTS = 453.18; // 284.28 + 198.9 − 30

const read = async (opts: Parameters<typeof buildSwiggyWorkbook>[0], fileName = NAME) =>
  parseSwiggySettlement(await readWorkbook(await buildSwiggyWorkbook(opts)), fileName);

describe('payoutPeriod', () => {
  it('puts the year on a day-and-month period from a day near the report', () => {
    expect(payoutPeriod('04 October - 10 October', '2026-10-14')).toEqual(['2026-10-04', '2026-10-10']);
    expect(payoutPeriod('04 October – 10 October', '2026-10-14')).toEqual(['2026-10-04', '2026-10-10']);
  });

  it('handles a period that crosses New Year, whichever side the report day is on', () => {
    expect(payoutPeriod('28 December - 03 January', '2027-01-07')).toEqual(['2026-12-28', '2027-01-03']);
    expect(payoutPeriod('28 December - 03 January', '2026-12-31')).toEqual(['2026-12-28', '2027-01-03']);
    expect(payoutPeriod('22 December - 28 December', '2027-01-02')).toEqual(['2026-12-22', '2026-12-28']);
  });

  it('uses the years the text has, and refuses what it cannot place', () => {
    expect(payoutPeriod('28 Dec 2026 - 03 Jan 2027', null)).toEqual(['2026-12-28', '2027-01-03']);
    expect(payoutPeriod('04 October - 10 October', null)).toBeNull();
    expect(payoutPeriod('sometime this week', '2026-10-14')).toBeNull();
    expect(payoutPeriod('31 February - 10 March', '2026-03-12')).toBeNull();
    expect(payoutPeriod('10 October - 04 October', '2026-10-14')).toBeNull(); // not a year-long payout
  });
});

describe('parseSwiggySettlement', () => {
  it('reads every order, the period and the restaurant from a real-layout workbook', async () => {
    const p = await read({ orders: ORDERS });
    expect(p.warnings).toEqual([]);
    expect(p.platform).toBe('swiggy');
    expect(p.restaurantRef).toBe('555001');
    expect(p.periodStart).toBe('2026-10-04');
    expect(p.periodEnd).toBe('2026-10-10');
    expect(p.deductions).toEqual([]);
    expect(p.orders).toHaveLength(3);

    const [a, b] = p.orders;
    expect(a).toMatchObject({
      orderId: '260000000000001',
      orderedAt: '2026-10-04T19:01:14+05:30',
      status: 'delivered',
      orderType: 'Swiggy',
      paymentMode: 'cash',
      offer: 'TESTCODE',
      cancelReason: '',
      menuSales: 500,
      packaging: 20,
      discount: 100,
      gstFromCustomer: 21,
      netOrderValue: 441,
      commissionPct: 24,
      commission: 105.84,
      paymentFee: 8.82,
      gstOnFees: 20.64,
      gstPaidByPlatform: 21,
      tcs: 0,
      tds: 0.42,
      otherDeductions: 0,
      payout: 284.28,
      settlementStatus: 'settled',
      settlementDate: '2026-10-14',
      utr: 'TESTUTR000123',
      unsettled: 0,
      customerRef: null,
    });
    expect(b).toMatchObject({ paymentMode: 'prepaid', offer: '', payout: 198.9 });
  });

  it("splits Swiggy's fee total so commission + gateway fee + GST on fees add up to it", async () => {
    const p = await read({ orders: ORDERS });
    const [, b, c] = p.orders;
    // 120.78 is the order's Total Swiggy Fees: the long-distance charge stays in commission.
    expect(b.commission).toBe(95.64);
    expect(b.commission + b.paymentFee + b.gstOnFees).toBeCloseTo(120.78, 2);
    // A restaurant cancellation charge is part of the fee total too.
    expect(c.commission + c.paymentFee + c.gstOnFees).toBeCloseTo(30, 2);
    // And with the taxes taken off the customer's bill, what is left is the payout.
    for (const o of p.orders.slice(0, 2)) {
      const fees = o.commission + o.paymentFee + o.gstOnFees;
      expect(o.netOrderValue - fees - o.otherDeductions - o.gstPaidByPlatform - o.tcs - o.tds).toBeCloseTo(o.payout, 2);
    }
  });

  it('reads the same report when every number is stored as padded text', async () => {
    const asNumbers = await read({ orders: ORDERS });
    const asText = await read({ orders: ORDERS, textNumbers: true });
    expect(asText.warnings).toEqual([]);
    expect(asText.orders).toEqual(asNumbers.orders);
  });

  it('reads a cancelled order with its reason and its payout', async () => {
    const p = await read({ orders: ORDERS });
    expect(p.orders[2]).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Restaurant',
      menuSales: 250,
      commission: 30,
      payout: -30,
    });
  });

  it('marks an order with no settlement date as not settled, with no UTR', async () => {
    const p = await read({ orders: [{ ...ORDERS[0], settlement: '' }], totalPayout: '₹284.28  ' });
    expect(p.orders[0]).toMatchObject({ settlementStatus: '', settlementDate: null, utr: '' });
  });

  it('takes the year from the file name, and crosses New Year', async () => {
    const orders: SwiggyOrder[] = [
      { ...ORDERS[0], id: '260000000000011', date: '2026-12-29 19:01:14', settlement: '07-01-2027' },
      { ...ORDERS[1], id: '260000000000012', date: '2027-01-02 12:30:00', settlement: '07-01-2027' },
    ];
    const p = await read({ period: '28 December - 03 January', orders }, 'invoice_Annexure_555001_07012027_1700000000001.xlsx');
    expect([p.periodStart, p.periodEnd]).toEqual(['2026-12-28', '2027-01-03']);
    expect(p.warnings).toEqual([]);

    // Renamed file: the orders' own settlement date gives the year.
    const renamed = await read({ period: '28 December - 03 January', orders }, 'payout.xlsx');
    expect([renamed.periodStart, renamed.periodEnd]).toEqual(['2026-12-28', '2027-01-03']);
  });

  it('falls back to the order dates for the period, and to the file name for the restaurant', async () => {
    const orders = ORDERS.map((o) => ({ ...o, settlement: '' }));
    const p = await read({ period: 'not a period', orders, totalPayout: `₹${PAYOUTS}  ` }, NAME);
    expect([p.periodStart, p.periodEnd]).toEqual(['2026-10-04', '2026-10-06']);
    expect(p.warnings).toEqual(['Report period taken from the order dates']);

    const sheets = await readWorkbook(await buildSwiggyWorkbook({ orders: ORDERS }));
    sheets['Summary'] = [['Summary']];
    const noSummary = parseSwiggySettlement(sheets, NAME);
    expect(noSummary.restaurantRef).toBe('555001'); // from the file name
    expect([noSummary.periodStart, noSummary.periodEnd]).toEqual(['2026-10-04', '2026-10-06']);
    expect(noSummary.warnings).toEqual(['Report period taken from the order dates', 'The Summary has no readable Total Payout, so the order payouts were not cross-checked']);
  });

  it("reads this week's and last week's adjustments and ads", async () => {
    const p = await read({
      orders: ORDERS,
      adjustments: [
        { type: 'Ads Charges', total: 120, from: '2026-10-04', to: '2026-10-10', invoice: 'INV-A1' },
        { type: 'TDS Refund', total: -12.5, from: '04 October', to: '10 October', invoice: 'INV-T1' },
        { type: 'Packaging Recovery', total: 30, settled: 10, outstanding: 20, invoice: 'INV-P1' },
      ],
      previousAdjustments: [
        { type: 'Ads Charges', total: 80, settled: 40, outstanding: 40, from: '28 September', to: '03 October', invoice: 'INV-O1' },
      ],
      ads: [
        { type: 'CPC Campaign', total: 200, campaignStart: '2026-10-01', campaignEnd: '2026-10-07', from: '04 October', to: '10 October', invoice: 'AD-1' },
      ],
      previousAds: [{ type: 'Sponsored Listing', total: 90, from: '27 September', to: '03 October', invoice: 'AD-0' }],
    });
    expect(p.warnings).toEqual([]);
    expect(p.deductions).toEqual([
      {
        kind: 'ads', label: 'Ads Charges', ref: 'INV-A1', periodText: '2026-10-04 - 2026-10-10', periodStart: '2026-10-04',
        periodEnd: '2026-10-10', settlementStatus: 'settled', amount: 120, settled: 120, outstanding: 0,
      },
      {
        kind: 'other', label: 'TDS Refund', ref: 'INV-T1', periodText: '2026-10-04 - 2026-10-10', periodStart: '2026-10-04',
        periodEnd: '2026-10-10', settlementStatus: 'settled', amount: -12.5, settled: -12.5, outstanding: 0,
      },
      {
        kind: 'other', label: 'Packaging Recovery', ref: 'INV-P1', periodText: '', periodStart: null, periodEnd: null,
        settlementStatus: 'pending', amount: 30, settled: 10, outstanding: 20,
      },
      {
        kind: 'adjustment', label: 'Ads Charges', ref: 'INV-O1', periodText: '2026-09-28 - 2026-10-03', periodStart: '2026-09-28',
        periodEnd: '2026-10-03', settlementStatus: 'pending', amount: 80, settled: 40, outstanding: 40,
      },
      // the ads table's Invoice Number header sits on its own row under the main header
      {
        kind: 'ads', label: 'CPC Campaign', ref: 'AD-1', periodText: '2026-10-04 - 2026-10-10', periodStart: '2026-10-04',
        periodEnd: '2026-10-10', settlementStatus: 'settled', amount: 200, settled: 200, outstanding: 0,
      },
      {
        kind: 'adjustment', label: 'Sponsored Listing', ref: 'AD-0', periodText: '2026-09-27 - 2026-10-03', periodStart: '2026-09-27',
        periodEnd: '2026-10-03', settlementStatus: 'settled', amount: 90, settled: 90, outstanding: 0,
      },
    ]);
  });

  it('adds together rows that would share one stored key, so no money is dropped', async () => {
    const p = await read({
      orders: ORDERS,
      adjustments: [
        { type: 'Packaging Recovery', total: 20, settled: 20 },
        { type: 'Packaging Recovery', total: 15, settled: 5, outstanding: 10 },
      ],
    });
    expect(p.deductions).toEqual([
      expect.objectContaining({ kind: 'other', label: 'Packaging Recovery', ref: '', amount: 35, settled: 25, outstanding: 10, settlementStatus: 'pending' }),
    ]);
    expect(p.warnings).toEqual(['1 adjustment row(s) with the same type, invoice and period were added together']);
  });

  it('keeps an ad bill positive whichever sign Swiggy prints, and uses the campaign dates when the period is blank', async () => {
    const p = await read({
      orders: ORDERS,
      ads: [{ type: 'Ads', total: -50, campaignStart: '01-10-2026', campaignEnd: '07-10-2026' }],
      totalPayout: `₹${(PAYOUTS - 50).toFixed(2)}  `,
    });
    expect(p.warnings).toEqual([]);
    expect(p.deductions).toEqual([
      expect.objectContaining({ kind: 'ads', amount: 50, settled: 50, periodStart: '2026-10-01', periodEnd: '2026-10-07' }),
    ]);
  });

  it('warns, with both numbers, when the orders and adjustments do not add up to the Summary total', async () => {
    const ok = await read({ orders: ORDERS, adjustments: [{ type: 'Ads', total: 50 }] });
    expect(ok.warnings).toEqual([]);
    // within a rupee is rounding, not a gap
    expect((await read({ orders: ORDERS, totalPayout: '₹452.50  ' })).warnings).toEqual([]);

    const p = await read({ orders: ORDERS, adjustments: [{ type: 'Ads', total: 50 }], totalPayout: '₹500.00  ' });
    expect(p.orders).toHaveLength(3); // the report is still read
    expect(p.warnings).toEqual(["Order payouts ₹453.18 less this week's adjustments ₹50.00 come to ₹403.18, but the Summary's Total Payout is ₹500.00"]);
  });

  it("leaves last week's carried-forward items out of the payout check", async () => {
    const p = await read({ orders: ORDERS, previousAdjustments: [{ type: 'Misc', total: 40 }] });
    expect(p.warnings).toEqual([]);
    expect(p.deductions).toEqual([expect.objectContaining({ kind: 'adjustment', amount: 40 })]);
  });

  it('says so when the Summary has no readable Total Payout', async () => {
    const p = await read({ orders: ORDERS, totalPayout: 'pending' });
    expect(p.warnings).toEqual(['The Summary has no readable Total Payout, so the order payouts were not cross-checked']);
  });

  it('finds columns by header text, not position', async () => {
    const header = ['Net Payout for Order (after taxes)\n[A-B-C-D]', 'Total Swiggy Fees\n[6+7+8-9]', 'Item Total', 'Order Status', 'Order Date', 'Order ID', 'Extra Column '];
    const rows = [[284.28, 135.3, 500, 'delivered', '2026-10-04 19:01:14', '260000000000001', 'x']];
    const p = await read({ orders: [], header, rows, totalPayout: '₹284.28  ' });
    expect(p.warnings).toEqual([]);
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0]).toMatchObject({ orderId: '260000000000001', menuSales: 500, payout: 284.28, commission: 135.3, discount: 0, settlementStatus: '' });
  });

  it('refuses a sheet missing a required column, saying which', async () => {
    const header = ['Order ID', 'Order Date', 'Net Payout for Order (after taxes)']; // no status, item total or fee total
    const p = await read({ orders: [], header, rows: [['260000000000001', '2026-10-04 19:01:14', 284.28]] });
    expect(p.orders).toEqual([]);
    expect(p.warnings.join(' ')).toMatch(/missing columns: status, itemTotal, totalFees/);
  });

  it('skips rows that are not orders, counting the unreadable ones', async () => {
    const good = orderRow(ORDERS[0]);
    const badDate = orderRow({ ...ORDERS[1], date: 'yesterday' });
    const p = await read({ orders: [], rows: [good, [], ['Total'], badDate], totalPayout: '₹284.28  ' });
    expect(p.orders).toHaveLength(1);
    expect(p.warnings).toEqual(['1 order row(s) skipped: unreadable order id or date']);
  });

  it('warns when the deductions sheet is missing, and when there are no order rows', async () => {
    const p = await read({ orders: ORDERS, noDeductionSheet: true });
    expect(p.warnings).toEqual(['"Growth Investments and Other Deductions" sheet not found: ads and other deductions not read']);
    expect((await read({ orders: [] })).warnings).toContain('"Order Level" has no order rows');
  });

  it('builds fixture rows exactly as wide as the header (guards the fixture itself)', async () => {
    const rows = (await readWorkbook(await buildSwiggyWorkbook({ orders: ORDERS })))['Order Level'];
    expect(orderRow(ORDERS[0])).toHaveLength(HEADER.length);
    expect(rows[2]).toHaveLength(HEADER.length);
    expect(orderPayout(ORDERS[0])).toBe(284.28);
    expect(orderPayout(ORDERS[1])).toBe(198.9);
  });
});

describe('telling Zomato and Swiggy files apart', () => {
  it('takes a Swiggy annexure for Swiggy only, and a Zomato report for Zomato only', async () => {
    const swiggy = await readWorkbook(await buildSwiggyWorkbook({ orders: ORDERS }));
    expect(isSwiggySettlement(swiggy)).toBe(true);
    expect(isZomatoSettlement(swiggy)).toBe(false); // both have an 'Order Level' sheet with Order ID and Order Date

    const zomato = await readWorkbook(
      await buildZomatoWorkbook({ period: '01 Apr 2026 - 07 Apr 2026', orders: [{ id: '9000000001', date: '2026-04-01 11:05:31', subtotal: 205, payout: 111.53 }] }),
    );
    expect(isZomatoSettlement(zomato)).toBe(true);
    expect(isSwiggySettlement(zomato)).toBe(false);
  });

  it('takes neither for another workbook, nor for an order table without a payout column', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Order Level').addRow(['Order ID', 'Order Date', 'Subtotal (items total)']);
    const sheets = await readWorkbook(new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer));
    expect(isSwiggySettlement(sheets)).toBe(false);
    expect(isZomatoSettlement(sheets)).toBe(false);
    expect(isSwiggySettlement({ Sheet1: [['Monthly stock count']] })).toBe(false);
  });
});

describe('ingestSettlementFile with a Swiggy annexure', () => {
  it('detects and reads one with no hint and a name that does not say Swiggy', async () => {
    const m = memoryStore();
    const bytes = await buildSwiggyWorkbook({
      orders: ORDERS,
      adjustments: [{ type: 'Ads Charges', total: 120, from: '2026-10-04', to: '2026-10-10', invoice: 'INV-A1' }],
    });
    const out = await ingestSettlementFile(m.store, { bytes, fileName: 'weekly_payout.xlsx', source: 'upload' });

    expect(out).toMatchObject({ status: 'read', platform: 'swiggy', orders: 3, periodStart: '2026-10-04', periodEnd: '2026-10-10', olderRowsSkipped: 0 });
    expect(m.reports).toHaveLength(1);
    expect(m.reports[0]).toMatchObject({
      platform: 'swiggy', status: 'read', restaurant_ref: '555001', orders_count: 3, deductions_count: 1, period_end: '2026-10-10', error: null, warnings: [],
    });
    expect(m.reports[0].storage_path).toMatch(/^swiggy\/[0-9a-f]{2}\/[0-9a-f]{64}-weekly_payout\.xlsx$/);
    expect(m.files.size).toBe(1);
    expect(m.orders.get('swiggy|260000000000001')).toMatchObject({
      status: 'delivered', menu_sales_inr: 500, discount_inr: 100, commission_inr: 105.84, payment_fee_inr: 8.82, gst_on_fees_inr: 20.64,
      payout_inr: 284.28, settlement_status: 'settled', settlement_date: '2026-10-14', utr: 'TESTUTR000123', customer_ref: null,
      report_period_end: '2026-10-10', restaurant_ref: '555001',
    });
    expect(m.orders.get('swiggy|260000000000003')).toMatchObject({ status: 'cancelled', cancel_reason: 'Restaurant', payout_inr: -30 });
    expect([...m.deductions.values()]).toEqual([expect.objectContaining({ platform: 'swiggy', kind: 'ads', amount_inr: 120, period_start: '2026-10-04' })]);

    // The same file again, from the sender's address this time: already read.
    const again = await ingestSettlementFile(m.store, { bytes, fileName: NAME, source: 'email', platformHint: 'swiggy' });
    expect(again.status).toBe('duplicate');
  });

  it('keeps a file the owner calls Swiggy but that is not the annexure as unsupported, with why', async () => {
    const m = memoryStore();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary').addRow(['Swiggy tax invoice summary']);
    const bytes = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const out = await ingestSettlementFile(m.store, { bytes, fileName: 'Invoice_Summary.xlsx', source: 'email', platformHint: 'swiggy' });
    expect(out).toMatchObject({ status: 'unsupported', platform: 'swiggy', message: expect.stringMatching(/Swiggy's weekly payout annexure/) });
    expect(m.reports[0]).toMatchObject({ platform: 'swiggy', status: 'unsupported', orders_count: 0, error: out.message });
    expect(m.files.size).toBe(1);
    expect(m.orders.size).toBe(0);
  });

  it('keeps a Swiggy .zip as unsupported rather than failing it', async () => {
    const m = memoryStore();
    const out = await ingestSettlementFile(m.store, { bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0]), fileName: 'annexure.zip', source: 'email', platformHint: 'swiggy' });
    expect(out).toMatchObject({ status: 'unsupported', platform: 'swiggy' });
    expect(m.files.size).toBe(1);
  });

  it('reads a Swiggy annexure that arrived as Zomato, as Swiggy, and says so', async () => {
    const m = memoryStore();
    const bytes = await buildSwiggyWorkbook({ orders: ORDERS });
    const out = await ingestSettlementFile(m.store, { bytes, fileName: 'Zomato_mixup.xlsx', source: 'email', platformHint: 'zomato' });

    expect(out).toMatchObject({ status: 'read', platform: 'swiggy', orders: 3 });
    expect(m.reports[0]).toMatchObject({ platform: 'swiggy', status: 'read' });
    expect(m.reports[0].storage_path).toMatch(/^swiggy\//);
    expect(m.reports[0].warnings).toEqual([
      'Arrived as a Zomato report (sender, file name or your choice), but its contents are a Swiggy settlement report: read as Swiggy',
    ]);
    expect(m.orders.has('swiggy|260000000000001')).toBe(true);
    expect(m.orders.has('zomato|260000000000001')).toBe(false);
  });

  it('reads a Zomato report that arrived as Swiggy, as Zomato, and says so', async () => {
    const m = memoryStore();
    const bytes = await buildZomatoWorkbook({
      period: '22 Sep 2026 - 28 Sep 2026',
      orders: [{ id: '9000000001', date: '2026-09-28 13:00:00', subtotal: 300, payout: 150 }],
    });
    const out = await ingestSettlementFile(m.store, { bytes, fileName: 'upload.xlsx', source: 'upload', platformHint: 'swiggy' });

    expect(out).toMatchObject({ status: 'read', platform: 'zomato', orders: 1 });
    expect(m.reports[0].warnings).toEqual([
      'Arrived as a Swiggy report (sender, file name or your choice), but its contents are a Zomato settlement report: read as Zomato',
    ]);
    expect(m.orders.has('zomato|9000000001')).toBe(true);
  });

  it('does not warn when the hint and the contents agree', async () => {
    const m = memoryStore();
    const out = await ingestSettlementFile(m.store, {
      bytes: await buildSwiggyWorkbook({ orders: ORDERS }),
      fileName: NAME,
      source: 'email',
      platformHint: 'swiggy',
    });
    expect(out.status).toBe('read');
    expect(m.reports[0].warnings).toEqual([]);
  });

  it('keeps the payout-check warning on the report row', async () => {
    const m = memoryStore();
    const bytes = await buildSwiggyWorkbook({ orders: ORDERS, totalPayout: '₹10.00  ' });
    const out = await ingestSettlementFile(m.store, { bytes, fileName: NAME, source: 'email' });
    expect(out.status).toBe('read');
    expect(m.reports[0].warnings).toEqual([expect.stringMatching(/Total Payout is ₹10\.00/)]);
  });
});
