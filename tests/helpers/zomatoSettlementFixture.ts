import ExcelJS from 'exceljs';

// Builds a Zomato settlement workbook laid out like the real 2026 reports
// (lib/online-settlements/zomato.ts describes the layout): the same sheet
// names, the "(1) (2) …" numbering row above the header, the '#REF!' row under
// it, IDs and dates stored as TEXT and money as numbers, and a deductions sheet
// that starts in column B. Invented values only; no real report is committed.

export interface FixtureOrder {
  id: string;
  date: string; // 'YYYY-MM-DD HH:MM:SS'
  status?: string; // DELIVERED | CANCELLED | REJECTED | TIMEDOUT
  offer?: string;
  subtotal: number;
  packaging?: number;
  promo?: number;
  otherDiscount?: number;
  gst?: number;
  commission?: number;
  paymentFee?: number;
  gstOnFees?: number;
  tds?: number;
  gst95?: number;
  otherDeductions?: number;
  additions?: number;
  payout: number;
  settlement?: 'settled' | 'pending';
  settlementDate?: string;
  utr?: string;
  customer?: string;
  reason?: string;
}

export interface FixtureAd {
  campaign: string;
  window: string; // '01 April 26 - 05 April 26'
  amount: number;
  status?: 'settled' | 'pending';
}

const HEADER = [
  'S.No.', 'Order ID', 'Order Date', 'Week No.', 'Res. name', 'Res. ID', 'Discount Construct', 'Mode of payment',
  'Order status (Delivered/ Cancelled/ Rejected)', 'Cancellation policy\n(% Amount refunded back to restaurant partner)',
  'Cancellation/ Rejection Reason', 'Cancelled/ Rejected State\n(Order status at the time it was cancelled/ rejected)',
  'Order type', 'Delivery State code', 'Subtotal (items total)', 'Packaging charge',
  'Delivery charge for restaurants on self logistics', 'Restaurant discount [Promo]',
  'Restaurant Discount [BOGO, Freebies, Gold, Brand pack & others]', 'Brand pack subscription fee ',
  'Delivery charge discount / Relisting discount ', 'Total GST collected from customers',
  'Net order value\n[(1) + (2) + (3) - (4) - (5) + (6) - (7) + (8)]',
  'Commissionable value (excludes customer GST)\n[(A) + (7) - (8) - (6) - (3)]', 'Service fees %',
  'Service fee\n[ (9) * (10) ]', 'Payment mechanism fee', 'Service fee & payment mechanism fees\n[(11) + (12)]',
  'Taxes on service & payment mechanism fees\n(B) * 18%', 'Applicable amount for TCS', 'Applicable amount for 9(5)',
  'Tax collected at source', 'TCS IGST amount', 'TDS 194O amount',
  'GST paid by Zomato on behalf of restaurant - under section 9(5)', 'GST to be paid by Restaurant partner to Govt.',
  'Government charges\n[(13) + (16) + (17) + (18) + (19)]', 'Customer Compensation/Recoupment',
  'Delivery Charges Recovery', 'Amount received in cash (on self delivery orders)', 'Credit note/(Debit Note) adjustment',
  'Promo recovery adjustment', 'Extra Inventory Ads and Misc. (order level deduction)', 'Brand loyalty points redemption',
  'Express Order Fee', 'Other order-level deductions\n[(21) + (22) + (23) + (24) + (25) + (26) + (27) + (28)]',
  'Net Deductions\n(B) + (C) + (D)',
  'Net Additions \n(cancellation refund for cancelled orders/Tip for Kitchen Staff for delivered orders)',
  'Order level Payout\n(A) - (E) + (F)', 'Settlement status', 'Settlement date', 'Bank UTR', 'Unsettled Amount', 'Customer ID',
];

export function orderRow(o: FixtureOrder, i: number): unknown[] {
  const status = o.status ?? 'DELIVERED';
  const delivered = status === 'DELIVERED';
  const packaging = o.packaging ?? (delivered ? 20 : 0);
  const promo = o.promo ?? 0;
  const other = o.otherDiscount ?? 0;
  const gst = o.gst ?? 0;
  const nov = o.subtotal + packaging - promo - other + gst;
  return [
    String(i + 1), o.id, o.date, '14', 'Hioc', '20788341', o.offer ?? 'NA', 'ONLINE', status,
    delivered ? 'NA' : '0.0%', o.reason ?? 'NA', delivered ? 'NA' : 'Order ready, not picked up by rider', 'O2', '9',
    o.subtotal, packaging, 0, promo, other, 0, 0, gst, nov, nov - gst, delivered ? 25 : 0,
    o.commission ?? 0, o.paymentFee ?? 0, (o.commission ?? 0) + (o.paymentFee ?? 0), o.gstOnFees ?? 0, 0, nov - gst,
    0, 0, o.tds ?? 0, o.gst95 ?? 0, 0, 0, o.otherDeductions ?? 0, 0, 0, 0, 0, 0, 0, 0, o.otherDeductions ?? 0, 0,
    o.additions ?? 0, o.payout, o.settlement ?? 'settled', o.settlementDate ?? '2026-04-08 05:30:00',
    o.utr ?? 'CITIN26650036706', o.settlement === 'pending' ? o.payout : 0, o.customer ?? 'abc123',
  ];
}

/** The Order Level header and order rows, the same cells a .csv export of that sheet holds. */
export function orderTable(orders: FixtureOrder[]): { header: string[]; rows: unknown[][] } {
  return { header: HEADER, rows: orders.map(orderRow) };
}

export async function buildZomatoWorkbook(opts: {
  period: string; // '01 Apr 2026 - 30 Apr 2026'
  orders: FixtureOrder[];
  ads?: FixtureAd[];
  header?: string[]; // to test reordered / missing columns
  rows?: unknown[][]; // raw order rows instead of `orders`
}): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();

  const summary = wb.addWorksheet('Summary');
  summary.addRow([]);
  summary.addRow(['Report Summary']);

  wb.addWorksheet('Payout Breakup').addRow(['Payout Breakup']);

  const ol = wb.addWorksheet('Order Level');
  ol.addRow(['Order level Breakup']);
  ol.addRow(['Detailed view of your order level earnings, deductions, pay-outs and UTRs for settled orders. ']);
  ol.addRow(['Get definition of terms used in this sheet- Glossary']);
  ol.addRow([]);
  ol.addRow(['RESTAURANT DETAILS >', null, null, null, null, null, null, null, null, 'Customer Payable']);
  ol.addRow(['(1)', '(2)', '(3)', '(4)', '(5)']);
  ol.addRow(opts.header ?? HEADER);
  ol.addRow(['#REF!', '#REF!', '#REF!']);
  for (const r of opts.rows ?? opts.orders.map(orderRow)) ol.addRow(r);

  const ad = wb.addWorksheet('Addition Deductions Details');
  const b = (cells: unknown[]) => ad.addRow([null, ...cells]); // the real sheet starts in column B
  b(['Addition/ Deduction Details (non-order level additions & deductions and adjustments from previous weeks)']);
  b([]);
  b(['Addition Type']);
  b(['Type', 'NA', 'Invoice No/Order id', 'Order date', 'Settlement status', 'Total amount', 'Adjusted amount', 'Outstanding amount']);
  b(['Total Additions', '', '', '', '', 0, 0, 0]);
  b(['Deduction Type']);
  b(['A) Investments in growth services']);
  b(['Type', 'Res id for which deduction created', 'Invoice No/Campaign id', 'Deduction time period', 'Settlement Status', 'Total amount', 'Adjusted amount', 'Outstanding amount']);
  let total = 0;
  for (const a of opts.ads ?? []) {
    const settled = (a.status ?? 'settled') === 'settled';
    total += a.amount;
    b(['ADS', '20788341', a.campaign, a.window, a.status ?? 'settled', a.amount, settled ? a.amount : 0, settled ? 0 : a.amount]);
  }
  b(['Total Ads & miscellaneous services', null, null, null, null, total, total, 0]);
  b(['B) Investments in Hyperpure']);
  b(['Type', 'Res id for which deduction created', 'OrderId', 'Deduction time period', 'Settlement Status', 'Total amount', 'Adjusted amount', 'Outstanding amount']);
  b(['Total Hyperpure', null, null, null, null, 0, 0, 0]);
  b(['C) Other deductions']);
  b(['D) Adjustments from previous weeks']);
  b(['Total Deductions (A) + (B) + (C)', '', '', '', '', total, total, 0]);

  const hs = wb.addWorksheet('HSummary');
  hs.addRow([]);
  hs.addRow([null, null, null, null, opts.period, '20788341', '667149', 'OWNER NAME', 'Hioc', 'Some address', 'PANPAN0000P', '09GSTIN', '', 'Weekly (Every Wednesday)']);

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
