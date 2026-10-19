import { describe, expect, it, vi } from 'vitest';
import type { CsvTable, CsvValue } from '@/lib/reports/csv';
import type {
  ExportLine,
  ExportOrder,
  ExportRefund,
  GstCode,
  OrderDataset,
} from '@/lib/reports/exports/types';
import {
  cancellationReport,
  categorySales,
  daySales,
  discountReport,
  hourlySales,
  itemSales,
  orderRegister,
  refundReport,
  staffSales,
} from '@/lib/reports/exports/salesReports';

// The sales downloads (lib/reports/exports/salesReports.ts): pure builders over
// an OrderDataset, so the fixtures here are built by hand — no database, no
// dataset loader. One small café month:
//   HIOC-000001  1 Sep 09:15  Asha     valid, coupon + Beanies, cash + UPI, tip 5
//   HIOC-000002  1 Sep 18:30  online   valid, beans by weight, one voided brownie
//   HIOC-000003  3 Sep 09:45  Asha     valid, Ritual cup + exempt water, settle discount 5
//   HIOC-000004  2 Sep 12:05  Ravi     cancelled (refunded in full)
//   HIOC-000005  2 Sep 13:00  online   rejected
// Valid sales: 3 orders, bill total 1428, GST 68 (34 + 34).

const SAC: GstCode = { code: '996331', description: 'Restaurant service', uqc: 'NA', kind: 'service' };
const HSN: GstCode = { code: '0901', description: 'Coffee, roasted', uqc: 'KGS-KILOGRAMS', kind: 'goods' };

function line(name: string, over: Partial<ExportLine> = {}): ExportLine {
  return {
    id: `line-${name}`,
    menuItemId: null,
    name,
    variant: '',
    category: 'Coffee',
    quantity: 1,
    weightGrams: null,
    lineTotalInr: 0,
    passCoveredInr: 0,
    passDrinks: 0,
    gstExempt: false,
    gstCode: SAC,
    taxableInr: 0,
    exemptValueInr: 0,
    cgstInr: 0,
    sgstInr: 0,
    ...over,
  };
}

function order(n: number, over: Partial<ExportOrder> = {}): ExportOrder {
  return {
    id: `o${n}`,
    orderNumber: n,
    invoiceNo: `HIOC-${String(n).padStart(6, '0')}`,
    createdAt: '2026-09-01T04:30:00.000Z',
    date: '2026-09-01',
    time: '10:00',
    hour: 10,
    status: 'completed',
    valid: true,
    rejectReason: null,
    paymentStatus: 'paid',
    paymentMethods: ['cash'],
    channel: 'staff_pos',
    orderType: 'dine_in',
    orderKind: 'menu',
    tableLabel: null,
    createdById: null,
    createdByName: '',
    subtotalInr: 0,
    taxInr: 0,
    packagingInr: 0,
    discountInr: 0,
    passDiscountInr: 0,
    totalInr: 0,
    settleDiscountInr: 0,
    tipInr: 0,
    couponCodes: [],
    couponDiscountInr: 0,
    beaniesDiscountInr: 0,
    refundedInr: 0,
    gstRule: 'pre_discount',
    taxableValueInr: 0,
    exemptValueInr: 0,
    cgstInr: 0,
    sgstInr: 0,
    packagingTaxableInr: 0,
    packagingCgstInr: 0,
    packagingSgstInr: 0,
    lines: [],
    voidedLines: [],
    ...over,
  };
}

function refund(id: string, over: Partial<ExportRefund> = {}): ExportRefund {
  return {
    id,
    orderId: 'o1',
    invoiceNo: 'HIOC-000001',
    orderDate: '2026-09-01',
    date: '2026-09-01',
    amountInr: 0,
    method: 'cash',
    reason: null,
    status: 'processed',
    processedAt: '2026-09-01T06:00:00.000Z',
    createdById: null,
    createdByName: '',
    ...over,
  };
}

const dataset = (orders: ExportOrder[], refunds: ExportRefund[] = [], over: Partial<OrderDataset> = {}): OrderDataset => ({
  from: '2026-09-01',
  to: '2026-09-03',
  gstRatePercent: 5,
  gstInclusive: false,
  orders,
  refunds,
  ...over,
});

const o1 = order(1, {
  time: '09:15',
  hour: 9,
  createdByName: 'Asha',
  paymentMethods: ['cash', 'upi'],
  tableLabel: 'T4',
  subtotalInr: 400,
  taxInr: 20,
  packagingInr: 10,
  discountInr: 30,
  couponCodes: ['WELCOME'],
  couponDiscountInr: 20,
  beaniesDiscountInr: 10,
  totalInr: 400,
  tipInr: 5,
  taxableValueInr: 400,
  cgstInr: 10,
  sgstInr: 10,
  lines: [
    line('Cappuccino', { variant: 'Regular', quantity: 2, lineTotalInr: 300, taxableInr: 300, cgstInr: 7.5, sgstInr: 7.5 }),
    line('Croissant', { category: 'Bakery', lineTotalInr: 100, taxableInr: 100, cgstInr: 2.5, sgstInr: 2.5 }),
  ],
});

const o2 = order(2, {
  time: '18:30',
  hour: 18,
  channel: 'customer_web',
  orderType: 'takeaway',
  paymentMethods: ['upi'],
  subtotalInr: 960,
  taxInr: 48,
  totalInr: 1008,
  taxableValueInr: 960,
  cgstInr: 24,
  sgstInr: 24,
  lines: [
    line('Cappuccino', { variant: 'Regular', lineTotalInr: 160, taxableInr: 160, cgstInr: 4, sgstInr: 4 }),
    line('Single Origin', {
      variant: '250g',
      category: 'Beans',
      quantity: 2,
      weightGrams: 250,
      lineTotalInr: 800,
      gstCode: HSN,
      taxableInr: 800,
      cgstInr: 20,
      sgstInr: 20,
    }),
  ],
  voidedLines: [{ name: 'Brownie', variant: 'Warm', quantity: 1, lineTotalInr: 120, reason: 'Customer changed mind' }],
});

const o3 = order(3, {
  date: '2026-09-03',
  time: '09:45',
  hour: 9,
  createdByName: 'Asha',
  subtotalInr: 170,
  passDiscountInr: 150,
  totalInr: 20,
  settleDiscountInr: 5,
  exemptValueInr: 20,
  refundedInr: 10,
  lines: [
    line('Cappuccino', { variant: 'Regular', lineTotalInr: 150, passCoveredInr: 150, passDrinks: 1 }),
    line('Packaged water', { category: 'Beverages', lineTotalInr: 20, gstExempt: true }),
  ],
});

const o4 = order(4, {
  date: '2026-09-02',
  time: '12:05',
  hour: 12,
  status: 'cancelled',
  valid: false,
  rejectReason: 'Customer left',
  paymentStatus: 'refunded',
  createdByName: 'Ravi',
  subtotalInr: 200,
  taxInr: 10,
  totalInr: 210,
  refundedInr: 210,
  taxableValueInr: 200,
  cgstInr: 5,
  sgstInr: 5,
  lines: [line('Latte', { variant: 'Regular', lineTotalInr: 200, taxableInr: 200, cgstInr: 5, sgstInr: 5 })],
});

const o5 = order(5, {
  date: '2026-09-02',
  time: '13:00',
  hour: 13,
  status: 'rejected',
  valid: false,
  rejectReason: 'Out of stock',
  paymentStatus: 'unpaid',
  paymentMethods: [],
  channel: 'customer_web',
  totalInr: 180,
});

const refunds: ExportRefund[] = [
  refund('r1', {
    orderId: 'o3',
    invoiceNo: 'HIOC-000003',
    orderDate: '2026-09-03',
    date: '2026-09-03',
    amountInr: 10,
    reason: 'Wrong item',
    createdByName: 'Asha',
  }),
  refund('r2', {
    orderId: 'o4',
    invoiceNo: 'HIOC-000004',
    orderDate: '2026-09-02',
    date: '2026-09-02',
    amountInr: 210,
    method: 'upi',
    reason: 'Cancelled by customer',
    createdByName: 'Ravi',
  }),
  refund('r3', { status: 'pending', processedAt: null, amountInr: 50, method: null }),
];

const full = dataset([o1, o2, o3, o4, o5], refunds);

/** The cell under `header` in data row `row`. */
function at(t: CsvTable, row: number, header: string): CsvValue {
  const i = t.columns.indexOf(header);
  expect(i, `column "${header}"`).toBeGreaterThanOrEqual(0);
  return t.rows[row][i];
}
const last = (t: CsvTable): number => t.rows.length - 1;

const BUILDERS: [string, (ds: OrderDataset) => CsvTable][] = [
  ['orderRegister', orderRegister],
  ['daySales', daySales],
  ['itemSales', itemSales],
  ['categorySales', categorySales],
  ['hourlySales', hourlySales],
  ['staffSales', staffSales],
  ['discountReport', discountReport],
  ['cancellationReport', cancellationReport],
  ['refundReport', refundReport],
];

describe('every sales sheet', () => {
  it.each(BUILDERS)('%s: rectangular, money headers end in (INR), last row is TOTAL', (_name, build) => {
    for (const ds of [full, dataset([])]) {
      const t = build(ds);
      for (const row of t.rows) expect(row).toHaveLength(t.columns.length);
      for (const h of t.columns) if (/INR/.test(h)) expect(h).toMatch(/ \(INR\)$/);
      expect(t.rows[last(t)][0]).toBe('TOTAL');
    }
  });

  it.each(BUILDERS)('%s: an empty dataset is a header and a TOTAL row of zeros', (name, build) => {
    const t = build(dataset([], [], { from: '2026-09-01', to: '2026-09-01' }));
    expect(t.columns.length).toBeGreaterThan(3);
    expect(t.rows).toHaveLength(name === 'daySales' ? 2 : 1); // daySales also lists its one (zero) date
    const total = t.rows[last(t)];
    expect(total[0]).toBe('TOTAL');
    expect(total.filter((c) => typeof c === 'number').every((c) => c === 0)).toBe(true);
  });
});

describe('orderRegister', () => {
  const t = orderRegister(full);

  it('lists every order including cancelled and rejected, then a TOTAL', () => {
    expect(t.rows).toHaveLength(6);
    expect(t.rows.slice(0, 5).map((r) => r[0])).toEqual([
      'HIOC-000001',
      'HIOC-000002',
      'HIOC-000003',
      'HIOC-000004',
      'HIOC-000005',
    ]);
  });

  it('shows an order in full', () => {
    expect(at(t, 0, 'Date')).toBe('2026-09-01');
    expect(at(t, 0, 'Time')).toBe('09:15');
    expect(at(t, 0, 'Table')).toBe('T4');
    expect(at(t, 0, 'Items')).toBe(3);
    expect(at(t, 0, 'Subtotal (INR)')).toBe(400);
    expect(at(t, 0, 'Coupon discount (INR)')).toBe(20);
    expect(at(t, 0, 'Coupon codes')).toBe('WELCOME');
    expect(at(t, 0, 'Beanies discount (INR)')).toBe(10);
    expect(at(t, 0, 'Total GST (INR)')).toBe(20);
    expect(at(t, 0, 'Packaging (INR)')).toBe(10);
    expect(at(t, 0, 'Bill total (INR)')).toBe(400);
    expect(at(t, 0, 'Tip (INR)')).toBe(5);
    expect(at(t, 0, 'Payment method(s)')).toBe('cash + upi');
    expect(at(t, 0, 'Rung up by')).toBe('Asha');
    expect(at(t, 1, 'Rung up by')).toBe('Online / customer');
    expect(at(t, 2, 'Ritual cups covered (INR)')).toBe(150);
    expect(at(t, 2, 'GST-exempt value (INR)')).toBe(20);
    expect(at(t, 2, 'Refunded (INR)')).toBe(10);
  });

  it('keeps cancelled and rejected orders as rows with their status and reason', () => {
    expect(at(t, 3, 'Status')).toBe('cancelled');
    expect(at(t, 3, 'Reason')).toBe('Customer left');
    expect(at(t, 3, 'Bill total (INR)')).toBe(210);
    expect(at(t, 4, 'Status')).toBe('rejected');
    expect(at(t, 4, 'Reason')).toBe('Out of stock');
    expect(at(t, 4, 'Payment method(s)')).toBe('');
  });

  it('adds up the valid orders only in the TOTAL row, and says so', () => {
    const i = last(t);
    expect(at(t, i, 'Invoice no')).toBe('TOTAL');
    expect(at(t, i, 'Status')).toBe('valid orders only');
    expect(at(t, i, 'Items')).toBe(8);
    expect(at(t, i, 'Subtotal (INR)')).toBe(1530);
    expect(at(t, i, 'Coupon discount (INR)')).toBe(20);
    expect(at(t, i, 'Beanies discount (INR)')).toBe(10);
    expect(at(t, i, 'Ritual cups covered (INR)')).toBe(150);
    expect(at(t, i, 'Taxable value (INR)')).toBe(1360);
    expect(at(t, i, 'CGST (INR)')).toBe(34);
    expect(at(t, i, 'SGST (INR)')).toBe(34);
    expect(at(t, i, 'Total GST (INR)')).toBe(68);
    expect(at(t, i, 'GST-exempt value (INR)')).toBe(20);
    expect(at(t, i, 'Packaging (INR)')).toBe(10);
    expect(at(t, i, 'Bill total (INR)')).toBe(1428); // not 1428 + 210 + 180
    expect(at(t, i, 'Settle discount (INR)')).toBe(5);
    expect(at(t, i, 'Tip (INR)')).toBe(5);
    expect(at(t, i, 'Refunded (INR)')).toBe(10); // the cancelled order's 210 is not a sale refund
  });
});

describe('daySales', () => {
  const t = daySales(full);

  it('has a row for every date in the range, zeros when nothing was sold', () => {
    expect(t.rows.map((r) => r[0])).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', 'TOTAL']);
    // 2 Sep only had the cancelled and the rejected order
    expect(at(t, 1, 'Orders')).toBe(0);
    expect(at(t, 1, 'Cancelled/rejected')).toBe(2);
    for (const h of t.columns.slice(3).filter((c) => c !== 'GST basis')) expect(at(t, 1, h), h).toBe(0);
    expect(at(t, 1, 'GST basis')).toBe('');
  });

  it('adds up a day from its valid orders', () => {
    expect(at(t, 0, 'Orders')).toBe(2);
    expect(at(t, 0, 'Cancelled/rejected')).toBe(0);
    expect(at(t, 0, 'Items sold')).toBe(6);
    expect(at(t, 0, 'Subtotal (INR)')).toBe(1360);
    expect(at(t, 0, 'Discounts (INR)')).toBe(30);
    expect(at(t, 0, 'Taxable value (INR)')).toBe(1360);
    expect(at(t, 0, 'CGST (INR)')).toBe(34);
    expect(at(t, 0, 'SGST (INR)')).toBe(34);
    expect(at(t, 0, 'Total GST (INR)')).toBe(68);
    expect(at(t, 0, 'Packaging (INR)')).toBe(10);
    expect(at(t, 0, 'Bill total (INR)')).toBe(1408);
    expect(at(t, 0, 'Net sales (INR)')).toBe(1408);
    expect(at(t, 0, 'Tips (INR)')).toBe(5);
    expect(at(t, 0, 'Avg bill (INR)')).toBe(704);

    expect(at(t, 2, 'Orders')).toBe(1);
    expect(at(t, 2, 'Ritual cups covered (INR)')).toBe(150);
    expect(at(t, 2, 'GST-exempt value (INR)')).toBe(20);
    expect(at(t, 2, 'Bill total (INR)')).toBe(20);
    expect(at(t, 2, 'Settle discounts (INR)')).toBe(5);
    expect(at(t, 2, 'Net sales (INR)')).toBe(15);
  });

  it('totals the days', () => {
    const i = last(t);
    expect(at(t, i, 'Orders')).toBe(3);
    expect(at(t, i, 'Cancelled/rejected')).toBe(2);
    expect(at(t, i, 'Items sold')).toBe(8);
    expect(at(t, i, 'Subtotal (INR)')).toBe(1530);
    expect(at(t, i, 'Discounts (INR)')).toBe(30);
    expect(at(t, i, 'Ritual cups covered (INR)')).toBe(150);
    expect(at(t, i, 'Taxable value (INR)')).toBe(1360);
    expect(at(t, i, 'Total GST (INR)')).toBe(68);
    expect(at(t, i, 'GST-exempt value (INR)')).toBe(20);
    expect(at(t, i, 'Packaging (INR)')).toBe(10);
    expect(at(t, i, 'Bill total (INR)')).toBe(1428);
    expect(at(t, i, 'Settle discounts (INR)')).toBe(5);
    expect(at(t, i, 'Net sales (INR)')).toBe(1423);
    expect(at(t, i, 'Tips (INR)')).toBe(5);
    expect(at(t, i, 'Avg bill (INR)')).toBe(476);
  });

  it('rounds the average bill to paise', () => {
    const three = dataset(
      [order(1, { totalInr: 100 }), order(2, { totalInr: 100 }), order(3, { totalInr: 101 })],
      [],
      { to: '2026-09-01' },
    );
    expect(at(daySales(three), 0, 'Avg bill (INR)')).toBe(100.33);
  });

  it('still shows an order dated outside the range rather than dropping its money', () => {
    const t2 = daySales(dataset([order(1, { date: '2026-08-31', totalInr: 50 })], [], { to: '2026-09-01' }));
    expect(t2.rows.map((r) => r[0])).toEqual(['2026-08-31', '2026-09-01', 'TOTAL']);
    expect(at(t2, last(t2), 'Bill total (INR)')).toBe(50);
  });
});

describe('itemSales', () => {
  const t = itemSales(full);

  it('groups valid lines by item and variant, best seller first', () => {
    expect(t.rows.map((r) => [r[0], r[1]])).toEqual([
      ['Single Origin', '250g'],
      ['Cappuccino', 'Regular'],
      ['Croissant', ''],
      ['Packaged water', ''],
      ['TOTAL', ''],
    ]);
    // the cancelled order's Latte is not a sale
    expect(t.rows.some((r) => r[0] === 'Latte')).toBe(false);
  });

  it('adds up a group across orders', () => {
    expect(at(t, 1, 'Category')).toBe('Coffee');
    expect(at(t, 1, 'HSN/SAC')).toBe('996331');
    expect(at(t, 1, 'Quantity')).toBe(4);
    expect(at(t, 1, 'Orders')).toBe(3);
    expect(at(t, 1, 'Gross sales (INR)')).toBe(610);
    expect(at(t, 1, 'Ritual cups covered (INR)')).toBe(150);
    expect(at(t, 1, 'GST-exempt')).toBe('No');
    expect(at(t, 1, 'Taxable value (INR)')).toBe(460);
    expect(at(t, 1, 'CGST (INR)')).toBe(11.5);
    expect(at(t, 1, 'SGST (INR)')).toBe(11.5);
    expect(at(t, 1, 'Share of sales %')).toBe(39.9);
  });

  it('gives weight in kg only for items sold by weight', () => {
    expect(at(t, 0, 'HSN/SAC')).toBe('0901');
    expect(at(t, 0, 'Weight (kg)')).toBe(0.5);
    expect(at(t, 0, 'Share of sales %')).toBe(52.3);
    expect(at(t, 1, 'Weight (kg)')).toBe('');
  });

  it('marks exempt items', () => {
    expect(at(t, 3, 'GST-exempt')).toBe('Yes');
    expect(at(t, 3, 'Taxable value (INR)')).toBe(0);
  });

  it('totals, counting each order once', () => {
    const i = last(t);
    expect(at(t, i, 'Quantity')).toBe(8);
    expect(at(t, i, 'Weight (kg)')).toBe(0.5);
    expect(at(t, i, 'Orders')).toBe(3);
    expect(at(t, i, 'Gross sales (INR)')).toBe(1530);
    expect(at(t, i, 'Ritual cups covered (INR)')).toBe(150);
    expect(at(t, i, 'Taxable value (INR)')).toBe(1360);
    expect(at(t, i, 'CGST (INR)')).toBe(34);
    expect(at(t, i, 'SGST (INR)')).toBe(34);
    expect(at(t, i, 'Share of sales %')).toBe(100);
  });

  it('keeps an item that was exempt on some bills and taxed on others on separate rows', () => {
    const mixed = dataset([
      order(1, { lines: [line('Water', { lineTotalInr: 20, gstExempt: true })] }),
      order(2, { lines: [line('Water', { lineTotalInr: 20, taxableInr: 20, cgstInr: 0.5, sgstInr: 0.5 })] }),
    ]);
    const m = itemSales(mixed);
    expect(m.rows.map((r) => r[m.columns.indexOf('GST-exempt')]).sort()).toEqual(['', 'No', 'Yes']);
  });
});

describe('categorySales', () => {
  const t = categorySales(full);

  it('groups valid lines by category, biggest first', () => {
    expect(t.rows.map((r) => r[0])).toEqual(['Beans', 'Coffee', 'Bakery', 'Beverages', 'TOTAL']);
    expect(at(t, 1, 'Items sold')).toBe(4);
    expect(at(t, 1, 'Orders')).toBe(3);
    expect(at(t, 1, 'Gross sales (INR)')).toBe(610);
    expect(at(t, 1, 'Ritual cups covered (INR)')).toBe(150);
    expect(at(t, 1, 'Taxable value (INR)')).toBe(460);
    expect(at(t, 1, 'Total GST (INR)')).toBe(23);
    expect(at(t, 1, 'Share of sales %')).toBe(39.9);
    expect(at(t, 0, 'Share of sales %')).toBe(52.3);
  });

  it('totals, counting each order once', () => {
    const i = last(t);
    expect(at(t, i, 'Items sold')).toBe(8);
    expect(at(t, i, 'Orders')).toBe(3);
    expect(at(t, i, 'Gross sales (INR)')).toBe(1530);
    expect(at(t, i, 'Taxable value (INR)')).toBe(1360);
    expect(at(t, i, 'Total GST (INR)')).toBe(68);
    expect(at(t, i, 'Share of sales %')).toBe(100);
  });
});

describe('hourlySales', () => {
  const t = hourlySales(full);

  it('lists only the hours that had valid orders', () => {
    expect(t.rows.map((r) => r[0])).toEqual(['09:00–10:00', '18:00–19:00', 'TOTAL']);
    // the cancelled 12:05 and rejected 13:00 orders add no hour
  });

  it('counts orders, bill total, average and share per hour', () => {
    expect(at(t, 0, 'Orders')).toBe(2);
    expect(at(t, 0, 'Bill total (INR)')).toBe(420);
    expect(at(t, 0, 'Avg bill (INR)')).toBe(210);
    expect(at(t, 0, 'Share of sales %')).toBe(29.4);
    expect(at(t, 1, 'Orders')).toBe(1);
    expect(at(t, 1, 'Bill total (INR)')).toBe(1008);
    expect(at(t, 1, 'Share of sales %')).toBe(70.6);
  });

  it('totals', () => {
    const i = last(t);
    expect(at(t, i, 'Orders')).toBe(3);
    expect(at(t, i, 'Bill total (INR)')).toBe(1428);
    expect(at(t, i, 'Avg bill (INR)')).toBe(476);
    expect(at(t, i, 'Share of sales %')).toBe(100);
  });

  it('labels the last hour of the day', () => {
    const late = hourlySales(dataset([order(1, { hour: 23, time: '23:40', totalInr: 10 })]));
    expect(late.rows[0][0]).toBe('23:00–24:00');
  });
});

describe('staffSales', () => {
  const t = staffSales(full);

  it('groups by who rang it up, customer orders under Online / customer, biggest first', () => {
    expect(t.rows.map((r) => r[0])).toEqual(['Online / customer', 'Asha', 'Ravi', 'TOTAL']);
  });

  it('counts each person’s valid orders, money, cancellations and voids', () => {
    expect(at(t, 0, 'Orders')).toBe(1);
    expect(at(t, 0, 'Bill total (INR)')).toBe(1008);
    expect(at(t, 0, 'Cancelled/rejected')).toBe(1); // o5
    expect(at(t, 0, 'Voided lines')).toBe(1); // the brownie on o2

    expect(at(t, 1, 'Orders')).toBe(2);
    expect(at(t, 1, 'Bill total (INR)')).toBe(420);
    expect(at(t, 1, 'Discounts (INR)')).toBe(30);
    expect(at(t, 1, 'Settle discounts (INR)')).toBe(5);
    expect(at(t, 1, 'Tips (INR)')).toBe(5);
    expect(at(t, 1, 'Cancelled/rejected')).toBe(0);

    // Ravi only has a cancelled order: no sales, one cancellation
    expect(at(t, 2, 'Orders')).toBe(0);
    expect(at(t, 2, 'Bill total (INR)')).toBe(0);
    expect(at(t, 2, 'Cancelled/rejected')).toBe(1);
  });

  it('totals', () => {
    const i = last(t);
    expect(at(t, i, 'Orders')).toBe(3);
    expect(at(t, i, 'Bill total (INR)')).toBe(1428);
    expect(at(t, i, 'Discounts (INR)')).toBe(30);
    expect(at(t, i, 'Settle discounts (INR)')).toBe(5);
    expect(at(t, i, 'Tips (INR)')).toBe(5);
    expect(at(t, i, 'Cancelled/rejected')).toBe(2);
    expect(at(t, i, 'Voided lines')).toBe(1);
  });
});

describe('discountReport', () => {
  const t = discountReport(full);

  it('lists the valid orders that had a discount of any kind', () => {
    // o2 had none; o4 (cancelled) is not a sale
    expect(t.rows.map((r) => r[0])).toEqual(['HIOC-000001', 'HIOC-000003', 'TOTAL']);
    expect(at(t, 0, 'Coupon codes')).toBe('WELCOME');
    expect(at(t, 0, 'Coupon discount (INR)')).toBe(20);
    expect(at(t, 0, 'Beanies discount (INR)')).toBe(10);
    expect(at(t, 1, 'Settle discount (INR)')).toBe(5);
    expect(at(t, 1, 'Ritual cups covered (INR)')).toBe(150);
    expect(at(t, 1, 'Bill total (INR)')).toBe(20);
  });

  it('totals', () => {
    const i = last(t);
    expect(at(t, i, 'Coupon discount (INR)')).toBe(20);
    expect(at(t, i, 'Beanies discount (INR)')).toBe(10);
    expect(at(t, i, 'Settle discount (INR)')).toBe(5);
    expect(at(t, i, 'Ritual cups covered (INR)')).toBe(150);
    expect(at(t, i, 'Bill total (INR)')).toBe(420);
  });
});

describe('cancellationReport', () => {
  const t = cancellationReport(full);

  it('has a row per cancelled/rejected order and per voided line, in invoice order', () => {
    expect(t.rows.map((r) => [r[0], r[1]])).toEqual([
      ['Item voided', 'HIOC-000002'],
      ['Order cancelled', 'HIOC-000004'],
      ['Order rejected', 'HIOC-000005'],
      ['TOTAL', ''],
    ]);
  });

  it('describes a voided item', () => {
    expect(at(t, 0, 'Item')).toBe('Brownie (Warm)');
    expect(at(t, 0, 'Qty')).toBe(1);
    expect(at(t, 0, 'Value (INR)')).toBe(120);
    expect(at(t, 0, 'Reason')).toBe('Customer changed mind');
    expect(at(t, 0, 'Date')).toBe('2026-09-01');
    expect(at(t, 0, 'Time')).toBe('18:30');
  });

  it('describes a cancelled and a rejected order', () => {
    expect(at(t, 1, 'Item')).toBe('');
    expect(at(t, 1, 'Qty')).toBe(null);
    expect(at(t, 1, 'Value (INR)')).toBe(210);
    expect(at(t, 1, 'Payment status')).toBe('refunded');
    expect(at(t, 1, 'Refunded (INR)')).toBe(210);
    expect(at(t, 1, 'Reason')).toBe('Customer left');
    expect(at(t, 2, 'Value (INR)')).toBe(180);
    expect(at(t, 2, 'Payment status')).toBe('unpaid');
    expect(at(t, 2, 'Reason')).toBe('Out of stock');
  });

  it('totals', () => {
    const i = last(t);
    expect(at(t, i, 'Qty')).toBe(1);
    expect(at(t, i, 'Value (INR)')).toBe(510);
    expect(at(t, i, 'Refunded (INR)')).toBe(210);
  });

  it('lists a voided line even on a cancelled order', () => {
    const both = cancellationReport(
      dataset([order(7, { status: 'cancelled', valid: false, totalInr: 90, voidedLines: [{ name: 'Tea', variant: '', quantity: 2, lineTotalInr: 40, reason: null }] })]),
    );
    expect(both.rows.map((r) => r[0])).toEqual(['Order cancelled', 'Item voided', 'TOTAL']);
    expect(at(both, 1, 'Item')).toBe('Tea');
    expect(at(both, 1, 'Reason')).toBe('');
  });
});

describe('refundReport', () => {
  const t = refundReport(full);

  it('lists refunds oldest first', () => {
    expect(t.rows.map((r) => r[0])).toEqual(['2026-09-01', '2026-09-02', '2026-09-03', 'TOTAL']);
    expect(at(t, 1, 'Invoice no')).toBe('HIOC-000004');
    expect(at(t, 1, 'Order date')).toBe('2026-09-02');
    expect(at(t, 1, 'Amount (INR)')).toBe(210);
    expect(at(t, 1, 'Method')).toBe('upi');
    expect(at(t, 1, 'Status')).toBe('processed');
    expect(at(t, 1, 'Reason')).toBe('Cancelled by customer');
    expect(at(t, 1, 'Processed by')).toBe('Ravi');
    expect(at(t, 0, 'Status')).toBe('pending');
    expect(at(t, 0, 'Method')).toBe('');
    expect(at(t, 0, 'Reason')).toBe('');
  });

  it('totals the processed refunds only, and says so', () => {
    const i = last(t);
    expect(at(t, i, 'Amount (INR)')).toBe(220); // not 270: the pending 50 hasn't gone out
    expect(at(t, i, 'Status')).toBe('processed only');
  });
});

describe('GST basis and packaging (GST_NET_OF_DISCOUNT_FROM)', () => {
  // An earlier bill (packaging untaxed) and a later one (packaging taxed, discount cut).
  const early = order(1, {
    date: '2026-10-10',
    packagingInr: 10,
    taxableValueInr: 200,
    cgstInr: 5,
    sgstInr: 5,
    lines: [line('Latte', { lineTotalInr: 200, taxableInr: 200, cgstInr: 5, sgstInr: 5 })],
  });
  const later = order(2, {
    date: '2026-10-25',
    gstRule: 'net_of_discount',
    orderType: 'takeaway',
    packagingInr: 10,
    taxableValueInr: 280,
    cgstInr: 7,
    sgstInr: 7,
    packagingTaxableInr: 10,
    packagingCgstInr: 0.25,
    packagingSgstInr: 0.25,
    lines: [line('Latte', { lineTotalInr: 300, taxableInr: 270, cgstInr: 6.75, sgstInr: 6.75 })],
  });
  const mixed = dataset([early, later], [], { from: '2026-10-09', to: '2026-10-26' });

  it('the order register says which basis each bill used, Mixed in the total', () => {
    const t = orderRegister(mixed);
    expect([0, 1, 2].map((i) => at(t, i, 'GST basis'))).toEqual([
      'Before discount, packaging untaxed',
      'After discount, packaging taxed',
      'Mixed',
    ]);
    expect(at(orderRegister(dataset([early])), 1, 'GST basis')).toBe('Before discount, packaging untaxed');
    expect(at(orderRegister(dataset([])), 0, 'GST basis')).toBe('');
  });

  it('the day sheet says it per day and overall', () => {
    const t = daySales(mixed);
    const day = (d: string) => t.rows.findIndex((r) => r[0] === d);
    expect(at(t, day('2026-10-10'), 'GST basis')).toBe('Before discount, packaging untaxed');
    expect(at(t, day('2026-10-25'), 'GST basis')).toBe('After discount, packaging taxed');
    expect(at(t, day('2026-10-11'), 'GST basis')).toBe('');
    expect(at(t, last(t), 'GST basis')).toBe('Mixed');
  });

  it('the item and category sheets list the packaging on a row of its own so the GST ties to the register', () => {
    const items = itemSales(mixed);
    expect(items.rows.map((r) => r[0])).toEqual(['Latte', 'Packaging charges', 'TOTAL']);
    expect(at(items, 1, 'HSN/SAC')).toBe('996331');
    expect(at(items, 1, 'Quantity')).toBe('');
    expect(at(items, 1, 'Gross sales (INR)')).toBe('');
    expect(at(items, 1, 'Orders')).toBe(1);
    expect(at(items, 1, 'Taxable value (INR)')).toBe(10);
    expect(at(items, 1, 'CGST (INR)')).toBe(0.25);
    // 200 + 270 + 10 taxable, 5 + 6.75 + 0.25 CGST: the order register's 480 and 12.
    expect(at(items, last(items), 'Taxable value (INR)')).toBe(480);
    expect(at(items, last(items), 'CGST (INR)')).toBe(12);
    expect(at(items, last(items), 'Gross sales (INR)')).toBe(500);
    expect(at(items, last(items), 'Orders')).toBe(2);
    const register = orderRegister(mixed);
    expect(at(register, last(register), 'Taxable value (INR)')).toBe(480);

    const cats = categorySales(mixed);
    expect(cats.rows.map((r) => r[0])).toEqual(['Coffee', 'Packaging charges', 'TOTAL']);
    expect(at(cats, 1, 'Items sold')).toBe('');
    expect(at(cats, 1, 'Taxable value (INR)')).toBe(10);
    expect(at(cats, 1, 'Total GST (INR)')).toBe(0.5);
    expect(at(cats, last(cats), 'Taxable value (INR)')).toBe(480);
    expect(at(cats, last(cats), 'Total GST (INR)')).toBe(24);
    expect(at(cats, last(cats), 'Orders')).toBe(2);
  });

  it('has no packaging row when no packaging was taxed', () => {
    expect(itemSales(dataset([early])).rows.map((r) => r[0])).toEqual(['Latte', 'TOTAL']);
    expect(categorySales(dataset([early])).rows.map((r) => r[0])).toEqual(['Coffee', 'TOTAL']);
  });
});

describe('SALES_REPORTS', () => {
  const loadOrderDataset = vi.fn(async () => full);
  vi.doMock('@/lib/reports/exports/orderDataServer', () => ({ loadOrderDataset }));

  it('registers the nine sheets under the sales group, each building from the loaded dataset', async () => {
    const { SALES_REPORTS } = await import('@/lib/reports/exports/salesReportsServer');
    expect(SALES_REPORTS.map((r) => r.key)).toEqual([
      'orders',
      'day-wise',
      'items',
      'categories',
      'hourly',
      'staff',
      'discounts',
      'cancellations',
      'refunds',
    ]);
    for (const r of SALES_REPORTS) {
      expect(r.group).toBe('sales');
      expect(r.title).toBeTruthy();
      expect(r.description).toBeTruthy();
    }

    const admin = {} as never;
    const sheet = await SALES_REPORTS.find((r) => r.key === 'orders')!.load(admin, '2026-09-01', '2026-09-03');
    expect(loadOrderDataset).toHaveBeenCalledWith(admin, '2026-09-01', '2026-09-03');
    expect(sheet).toEqual(orderRegister(full));
  });
});
