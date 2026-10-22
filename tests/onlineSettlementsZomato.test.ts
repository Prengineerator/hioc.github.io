import { describe, expect, it } from 'vitest';
import { plainCell, readCsv, readWorkbook } from '@/lib/online-settlements/sheets';
import { dayMonthYear, headerKey, istTimestamp, normalizeStatus, num } from '@/lib/online-settlements/common';
import { dateRange, isZomatoSettlement, parseZomatoSettlement } from '@/lib/online-settlements/zomato';
import { buildZomatoWorkbook, orderRow, type FixtureOrder } from './helpers/zomatoSettlementFixture';

// The Zomato settlement parser (lib/online-settlements/zomato.ts), against a
// workbook built in the real report's layout (tests/helpers/
// zomatoSettlementFixture.ts) and read through the real exceljs path.

const ORDERS: FixtureOrder[] = [
  {
    id: '7958194966', date: '2026-04-01 11:05:31', offer: '30% off upto ₹75 (2026-03-03 - 2031-01-01)', subtotal: 205,
    promo: 61.5, gst: 8.18, commission: 40.88, paymentFee: 3.16, gstOnFees: 7.93, gst95: 8.18, payout: 111.53,
    settlementDate: '2026-04-08 05:30:00', utr: 'CITIN26650036706', customer: 'cust-a',
  },
  {
    id: '7947787342', date: '2026-04-01 14:40:27', offer: 'SmartPromos GETOFF120ON199', subtotal: 245, promo: 70,
    otherDiscount: 5, gst: 9.58, commission: 47.88, paymentFee: 3.7, gstOnFees: 9.29, tds: 1.25, gst95: 9.58,
    payout: 118.2, customer: 'cust-b',
  },
  {
    id: '8059698044', date: '2026-04-30 22:42:25', status: 'TIMEDOUT', subtotal: 350, reason: 'Not accepted ON time',
    otherDeductions: 87.5, payout: -87.5, settlement: 'pending', settlementDate: 'NA', utr: 'NA', customer: 'NA',
  },
  {
    id: '8066624770', date: '2026-04-30 19:14:29', status: 'CANCELLED', subtotal: 215, additions: 78.45, payout: 78.45,
    reason: 'Customer cancellation due to delay',
  },
];

const ADS = [
  { campaign: '36242233', window: '01 April 26 - 05 April 26', amount: 488.52 },
  { campaign: '37049140', window: '29 April 26 - 30 April 26', amount: 184.08, status: 'pending' as const },
];

describe('cell and value helpers', () => {
  it('flattens exceljs cell shapes to what Excel shows', () => {
    expect(plainCell({ formula: 'A1+1', result: 42 })).toBe(42);
    expect(plainCell({ richText: [{ text: 'Order ' }, { text: 'ID' }] })).toBe('Order ID');
    expect(plainCell({ text: 'link', hyperlink: 'https://x' })).toBe('link');
    expect(plainCell({ error: '#REF!' })).toBeNull();
    // exceljs returns a sheet's wall-clock time as if it were UTC
    expect(plainCell(new Date(Date.UTC(2026, 3, 1, 11, 5, 31)))).toBe('2026-04-01 11:05:31');
  });

  it('reads report numbers, treating NA and blanks as zero', () => {
    expect(num(12.5)).toBe(12.5);
    expect(num('1,234.50')).toBe(1234.5);
    expect(num('₹ 20')).toBe(20);
    expect(num('NA')).toBe(0);
    expect(num('')).toBe(0);
    expect(num(null)).toBe(0);
  });

  it('normalises statuses, header text, timestamps and date ranges', () => {
    expect(normalizeStatus('DELIVERED')).toBe('delivered');
    expect(normalizeStatus('TIMEDOUT')).toBe('timed_out');
    expect(normalizeStatus('Partially Refunded')).toBe('partially_refunded');
    expect(headerKey('Net Additions \n(cancellation refund …)')).toBe('net additions');
    expect(istTimestamp('2026-04-01 11:05:31')).toBe('2026-04-01T11:05:31+05:30');
    expect(istTimestamp('NA')).toBeNull();
    expect(dayMonthYear('01 April 26')).toBe('2026-04-01');
    expect(dayMonthYear('30 Sep 2026')).toBe('2026-09-30');
    expect(dateRange('28 September 26 - 29 September 26')).toEqual(['2026-09-28', '2026-09-29']);
    expect(dateRange('soon')).toEqual([null, null]);
  });
});

describe('readCsv', () => {
  const csv = (s: string) => new TextEncoder().encode(s);

  it('splits rows on LF or CRLF, keeps blank lines in the middle and drops them at the end', () => {
    expect(readCsv(csv('a,b,c\n1,2,3\r\n4,5,6\r\n\r\n'))).toEqual([['a', 'b', 'c'], [1, 2, 3], [4, 5, 6]]);
    expect(readCsv(csv('a\n\nb'))).toEqual([['a'], [], ['b']]);
    expect(readCsv(csv('a,b'))).toEqual([['a', 'b']]);
    expect(readCsv(csv(''))).toEqual([]);
  });

  it('handles quotes, doubled quotes, and commas and line breaks inside quoted fields', () => {
    expect(readCsv(csv('"Name","Note"\n"Smith, J","He said ""hi""\nthen left"\n,"",x\n'))).toEqual([
      ['Name', 'Note'],
      ['Smith, J', 'He said "hi"\nthen left'],
      ['', '', 'x'],
    ]);
  });

  it('drops a UTF-8 byte-order mark and reads non-ASCII text as is', () => {
    expect(readCsv(csv('﻿Order ID,Note\n9000000001,₹ café\n'))).toEqual([['Order ID', 'Note'], [9000000001, '₹ café']]);
  });

  it('turns plain numbers into numbers and leaves every other cell as text', () => {
    const [row] = readCsv(csv('1234.50,-20,0.5,0,007,1e3,"1,234.50",NA,,123456789012345,1234567890123456789\n'));
    expect(row).toEqual([1234.5, -20, 0.5, 0, '007', '1e3', '1,234.50', 'NA', '', 123456789012345, '1234567890123456789']);
  });

  it('keeps an order ID of more than 15 digits as text, so no digit is lost', () => {
    const [[id]] = readCsv(csv('7958194966123456789\n'));
    expect(id).toBe('7958194966123456789');
  });
});

describe('parseZomatoSettlement', () => {
  it('reads every order, the ads and the period from a real-layout workbook', async () => {
    const bytes = await buildZomatoWorkbook({ period: '01 Apr 2026 - 30 Apr 2026', orders: ORDERS, ads: ADS });
    const sheets = await readWorkbook(bytes);
    expect(isZomatoSettlement(sheets)).toBe(true);

    const p = parseZomatoSettlement(sheets, 'Zomato_Settlement_Report_20788341_01_Apr_2026_30_Apr_2026.xlsx');
    expect(p.warnings).toEqual([]);
    expect(p.platform).toBe('zomato');
    expect(p.restaurantRef).toBe('20788341');
    expect(p.periodStart).toBe('2026-04-01');
    expect(p.periodEnd).toBe('2026-04-30');
    expect(p.orders).toHaveLength(4);

    const [a, b, timedOut, cancelled] = p.orders;
    expect(a).toMatchObject({
      orderId: '7958194966',
      orderedAt: '2026-04-01T11:05:31+05:30',
      status: 'delivered',
      offer: '30% off upto ₹75 (2026-03-03 - 2031-01-01)',
      menuSales: 205,
      packaging: 20,
      discount: 61.5,
      gstFromCustomer: 8.18,
      commissionPct: 25,
      commission: 40.88,
      paymentFee: 3.16,
      gstOnFees: 7.93,
      gstPaidByPlatform: 8.18,
      payout: 111.53,
      settlementStatus: 'settled',
      settlementDate: '2026-04-08',
      utr: 'CITIN26650036706',
      customerRef: 'cust-a',
    });
    // promo + the BOGO/freebies column are both the restaurant's discount
    expect(b.discount).toBe(75);
    expect(b.tds).toBe(1.25);
    expect(timedOut).toMatchObject({
      status: 'timed_out',
      cancelReason: 'Not accepted ON time',
      otherDeductions: 87.5,
      payout: -87.5,
      settlementStatus: 'pending',
      settlementDate: null,
      utr: '',
      unsettled: -87.5,
      customerRef: null,
    });
    expect(cancelled).toMatchObject({ status: 'cancelled', additions: 78.45, payout: 78.45 });

    expect(p.deductions).toEqual([
      expect.objectContaining({
        kind: 'ads', label: 'ADS', ref: '36242233', periodStart: '2026-04-01', periodEnd: '2026-04-05',
        settlementStatus: 'settled', amount: 488.52, settled: 488.52, outstanding: 0,
      }),
      expect.objectContaining({
        kind: 'ads', ref: '37049140', periodStart: '2026-04-29', periodEnd: '2026-04-30',
        settlementStatus: 'pending', amount: 184.08, settled: 0, outstanding: 184.08,
      }),
    ]);
  });

  it('finds columns by header text, not position', async () => {
    const header = ['Order ID', 'Order Date', 'Order status (Delivered/ Cancelled/ Rejected)', 'Order level Payout\n(A) - (E) + (F)', 'Subtotal (items total)', 'Express Order Fee'];
    const rows = [['7958194966', '2026-04-01 11:05:31', 'DELIVERED', 111.53, 205, 0]];
    const bytes = await buildZomatoWorkbook({ period: '01 Apr 2026 - 07 Apr 2026', orders: [], header, rows });
    const p = parseZomatoSettlement(await readWorkbook(bytes), 'report.xlsx');
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0]).toMatchObject({ orderId: '7958194966', menuSales: 205, payout: 111.53, status: 'delivered', discount: 0 });
  });

  it('refuses a sheet missing a required column, saying which', async () => {
    const header = ['Order ID', 'Order Date', 'Subtotal (items total)']; // no status, no payout
    const bytes = await buildZomatoWorkbook({ period: '01 Apr 2026 - 07 Apr 2026', orders: [], header, rows: [['7958194966', '2026-04-01 11:05:31', 205]] });
    const p = parseZomatoSettlement(await readWorkbook(bytes), 'report.xlsx');
    expect(p.orders).toEqual([]);
    expect(p.warnings.join(' ')).toMatch(/missing columns: status, payout/);
  });

  it('falls back to the file name for the period when HSummary has none', async () => {
    const bytes = await buildZomatoWorkbook({ period: 'not a period', orders: ORDERS.slice(0, 1) });
    const p = parseZomatoSettlement(await readWorkbook(bytes), 'Zomato_Settlement_Report_20788341_01_Sep_2026_30_Sep_2026.xlsx');
    expect([p.periodStart, p.periodEnd, p.restaurantRef]).toEqual(['2026-09-01', '2026-09-30', '20788341']);
  });

  it('takes the period from the order dates when neither HSummary nor the file name has one', async () => {
    const bytes = await buildZomatoWorkbook({ period: 'not a period', orders: ORDERS });
    const p = parseZomatoSettlement(await readWorkbook(bytes), 'weekly_orders.xlsx');
    expect([p.periodStart, p.periodEnd]).toEqual(['2026-04-01', '2026-04-30']);
    expect(p.warnings).toEqual(['Report period taken from the order dates']);
  });

  it('says so when the Order Level header has no order rows', async () => {
    const bytes = await buildZomatoWorkbook({ period: '01 Apr 2026 - 30 Apr 2026', orders: [] });
    const p = parseZomatoSettlement(await readWorkbook(bytes), 'report.xlsx');
    expect(p.orders).toEqual([]);
    expect(p.warnings).toEqual(['"Order Level" has no order rows']);
  });

  it('builds fixture rows exactly as wide as the header (guards the fixture itself)', async () => {
    const bytes = await buildZomatoWorkbook({ period: '01 Apr 2026 - 30 Apr 2026', orders: ORDERS });
    const rows = (await readWorkbook(bytes))['Order Level'];
    expect(orderRow(ORDERS[0], 0)).toHaveLength(rows[6].length);
  });
});
