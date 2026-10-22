import ExcelJS from 'exceljs';

// Builds a Swiggy weekly payout annexure workbook laid out like the real Oct
// 2026 reports (lib/online-settlements/swiggy.ts describes the layout): the
// same seven sheet names (the deductions sheet's name cut at 31 characters),
// the title row and the '(1) (2) (3a) …' numbering row above the Order Level
// header, header texts with their line breaks and trailing spaces, Summary
// values as padded text ('₹1234.50  '), 'Service Fees %' as text. Invented
// values only; no real report is committed.
//
// The ads table's data rows are an assumption: the real sample's tables were
// empty, so only their headers (including the 'Invoice Number' / 'Remarks'
// headers that sit on a row of their own under the first ads table) are real.

export interface SwiggyOrder {
  id: string;
  date: string; // 'YYYY-MM-DD HH:MM:SS'
  /** 'DD-MM-YYYY'; '' for an order with no settlement date. Default '14-10-2026'. */
  settlement?: string;
  status?: string; // delivered | cancelled
  payment?: string; // cash | prepaid
  cancelledBy?: string;
  coupon?: string;
  itemTotal: number;
  packaging?: number;
  discount?: number;
  gst?: number;
  pct?: number;
  commission?: number;
  longDistance?: number;
  paymentFee?: number;
  gstOnFees?: number;
  /** Restaurant Cancellation Charges. */
  cancelCharge?: number;
  complaint?: number;
  tcs?: number;
  tds?: number;
  /** Else worked out as Swiggy does: paid − fees − complaint charges − taxes. */
  payout?: number;
}

export interface SwiggyAdjustment {
  type: string;
  total: number;
  settled?: number;
  outstanding?: number;
  from?: string;
  to?: string;
  invoice?: string;
}

export interface SwiggyAd extends SwiggyAdjustment {
  campaignStart?: string;
  campaignEnd?: string;
}

export const HEADER = [
  'Order ID', 'Parent Order ID', 'Order Date', 'Order Settlement Date', 'Order Status', 'Order Category',
  'Order Payment Type', 'Cancelled By?', 'Coupon type applied by customer', 'Item Total', 'Packaging Charges',
  'Restaurant Discounts (Promo, Freebies, Flat Off, etc.)', 'Swiggy One \nExclusive Offer Discount',
  'Restaurant Discount Share [3a+3b]', 'Net Bill Value (before taxes) [1+2-3]', 'GST Collected',
  'Total Customer Paid [4+5]', 'Commission charged on', 'Service Fees %', 'Commission', 'Long Distance Charges\n',
  'Discount on Long Distance Fee', 'Pocket Hero Fees', 'No Fees Week - Cashback', 'Swiggy One Fees',
  'Payment Collection Charges\n', 'Restaurant Cancellation Charges\n', 'Call Center Charges\n',
  'Delivery Fee sponsored by Restaurant (w/o tax)', 'Bolt Fees', 'GST on Service Fee @18%\n',
  'Total Swiggy Fees\n[6+7+8-9+10+11+12+13+14+15+16+17]', 'Customer Cancellations\n', 'Customer Complaints',
  'Complaint & Cancellation Charges\n[18+19]', 'GST Deduction\n', 'TCS', 'TDS', 'Total Taxes\n[20+21+22]',
  'Net Payout for Order (after taxes)\n[A-B-C-D]', 'Long Distance Order\n', 'Last Mile (in km)', 'MFR Accurate?',
  'MFR Pressed?', 'Coupon Code Sourced', 'Discount Campaign ID', 'Replicated Order', 'Base order ID',
  'Cancellation time', 'Pick Up Status', 'Swiggy One Customer?', 'Pocket Hero Order?',
];

const r2 = (n: number) => Math.round(n * 100) / 100;

/** The payout Swiggy's own formula gives for the order (A − B − C − D). */
export function orderPayout(o: SwiggyOrder): number {
  if (o.payout !== undefined) return o.payout;
  const net = o.itemTotal + (o.packaging ?? 20) - (o.discount ?? 0);
  const paid = net + (o.gst ?? 0);
  const fees = (o.commission ?? 0) + (o.longDistance ?? 0) + (o.paymentFee ?? 0) + (o.gstOnFees ?? 0) + (o.cancelCharge ?? 0);
  return r2(paid - fees - (o.complaint ?? 0) - ((o.gst ?? 0) + (o.tcs ?? 0) + (o.tds ?? 0)));
}

/** One Order Level row, as wide as HEADER. `n` writes a number the way the sheet should hold it. */
export function orderRow(o: SwiggyOrder, n: (x: number) => unknown = (x) => x): unknown[] {
  const delivered = (o.status ?? 'delivered') === 'delivered';
  const packaging = o.packaging ?? 20;
  const discount = o.discount ?? 0;
  const net = o.itemTotal + packaging - discount;
  const gst = o.gst ?? 0;
  const paid = net + gst;
  const fees = (o.commission ?? 0) + (o.longDistance ?? 0) + (o.paymentFee ?? 0) + (o.gstOnFees ?? 0) + (o.cancelCharge ?? 0);
  const taxes = gst + (o.tcs ?? 0) + (o.tds ?? 0);
  return [
    o.id, '', o.date, o.settlement ?? '14-10-2026', o.status ?? 'delivered', 'Swiggy', o.payment ?? 'prepaid',
    delivered ? null : o.cancelledBy ?? 'Customer', o.coupon ?? '', n(o.itemTotal), n(packaging), n(discount), n(0),
    n(discount), n(net), n(gst), n(paid), n(paid), `${(o.pct ?? 24).toFixed(1)}%`, n(o.commission ?? 0),
    n(o.longDistance ?? 0), n(0), n(0), n(0), n(0), n(o.paymentFee ?? 0), n(o.cancelCharge ?? 0), n(0), n(0), n(0),
    n(o.gstOnFees ?? 0), n(fees), n(0), n(o.complaint ?? 0), n(o.complaint ?? 0), n(gst), n(o.tcs ?? 0),
    n(o.tds ?? 0), n(taxes), n(orderPayout(o)), o.longDistance ? 'Yes' : 'No', n(2.5), 'Yes', 'No', null,
    'campaign-1', 'No', '', null, '', 'No', 'No',
  ];
}

const money = (x: number) => `₹${x.toFixed(2)}  `;

export async function buildSwiggyWorkbook(opts: {
  /** Summary 'Payout Period' (no year). */
  period?: string;
  restId?: string;
  utr?: string;
  orders: SwiggyOrder[];
  /** 'Adjustments this week' rows. */
  adjustments?: SwiggyAdjustment[];
  /** 'Adjustments from previous week' rows. */
  previousAdjustments?: SwiggyAdjustment[];
  /** 'Investments this week' (ads) rows. */
  ads?: SwiggyAd[];
  /** 'Investments from previous week' rows. */
  previousAds?: SwiggyAd[];
  /** Summary 'Total Payout' text; else the orders' payouts less this week's adjustments and ads. */
  totalPayout?: string;
  /** Write every number as padded text ('  520.0') instead of a number. */
  textNumbers?: boolean;
  header?: string[]; // to test reordered / missing columns
  rows?: unknown[][]; // raw order rows instead of `orders`
  /** Leave the deductions sheet out. */
  noDeductionSheet?: boolean;
}): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const n = opts.textNumbers ? (x: number) => `  ${x}` : (x: number) => x;

  const thisWeek = [...(opts.adjustments ?? []), ...(opts.ads ?? [])].reduce((sum, a) => sum + a.total, 0);
  const payouts = opts.orders.reduce((sum, o) => sum + orderPayout(o), 0);

  const summary = wb.addWorksheet('Summary');
  const s = (cells: unknown[]) => summary.addRow([null, ...cells]); // the real sheet starts in column B
  for (let i = 0; i < 3; i++) summary.addRow([]);
  s(['Test Cafe']);
  s(['Some Road']);
  s(['Some City']);
  s([`Rest. ID - ${opts.restId ?? '555001'}`]);
  s(['GSTIN  - TESTGSTIN']);
  s([]);
  s(['Your Payout Details']);
  s(['Payout Period', opts.period ?? '04 October - 10 October']);
  s(['Payout Settlement Date', '13 October']);
  s(['Total Payout', opts.totalPayout ?? money(payouts - thisWeek)]);
  s(['Total Orders (Delivered + Cancelled)', `${opts.orders.length}  `]);
  s(['Bank UTR', `${opts.utr ?? 'TESTUTR000123'}  `]);
  s([]);
  s([]);
  s([]);
  s(['How to use this Annexure']);
  s(['Section/Tab Name', 'Description']);
  s(['Payout Breakup', 'Breakup of your total earnings for this payout period']);
  s(['Order Level', 'Detailed view of your order level earnings, deductions and other order details for paid orders']);

  wb.addWorksheet('Payout Breakup').addRow(['Payout Breakup\nBreakup of your total earnings for this payout period']);

  const ol = wb.addWorksheet('Order Level');
  ol.addRow(['Order Level Breakup\nDetailed view of your order level earnings, deductions and other order details for paid orders']);
  ol.addRow([null, null, null, null, null, null, null, null, null, '(1)', '(2)', '(3a)', '(3b)', '(3)', '(4)', '(5)', '(A)']);
  ol.addRow(opts.header ?? HEADER);
  for (const r of opts.rows ?? opts.orders.map((o) => orderRow(o, n))) ol.addRow(r);

  wb.addWorksheet('Unresolved Customer Complaints').addRow(['Payout Period', 'Order type', 'Status', 'No of orders']);

  if (!opts.noDeductionSheet) {
    const g = wb.addWorksheet('Growth Investments and Other De');
    const adjHead = ['Adjustment Type', 'Total Amount', 'Settled Amount', 'Outstanding Amount ', 'Period From', 'Period To', 'Invoice Number', 'Remarks'];
    const adjRow = (a: SwiggyAdjustment) => [
      a.type, n(a.total), n(a.settled ?? a.total), n(a.outstanding ?? 0), a.from ?? null, a.to ?? null, a.invoice ?? null, null,
    ];
    const adHead = [
      'Adjustment Type', 'Campaign Start Date', 'Campaign End Date', 'Total Amount', 'Settled Amount', 'Outstanding Amount ',
      'Period From', 'Period To',
    ];
    const adRow = (a: SwiggyAd) => [
      a.type, a.campaignStart ?? null, a.campaignEnd ?? null, n(a.total), n(a.settled ?? a.total), n(a.outstanding ?? 0),
      a.from ?? null, a.to ?? null, a.invoice ?? null, null,
    ];
    g.addRow(['Restaurant Adjustments Details\nSummary of all restaurant level deductions and refunds like Ads, TDS refunds, etc.']);
    g.addRow([]);
    g.addRow([]);
    g.addRow(['How to read this sheet-\nAdjustment this week: List of all deductions/refunds from this cycle\nAdjustment from previous week: List of deductions/refunds carried forward from previous cycles']);
    g.addRow([]);
    g.addRow([]);
    g.addRow([]);
    g.addRow([]);
    g.addRow([]);
    g.addRow(['Adjustments this week']);
    g.addRow(adjHead);
    for (const a of opts.adjustments ?? []) g.addRow(adjRow(a));
    g.addRow([]);
    g.addRow(['Adjustments from previous week']);
    g.addRow(adjHead);
    for (const a of opts.previousAdjustments ?? []) g.addRow(adjRow(a));
    g.addRow([]);
    g.addRow(['Total Adjustments', money(0), money(0), money(0)]);
    g.addRow([]);
    g.addRow([]);
    g.addRow(['Ads Investments Details\nSummary of all Ads investments and refunds for your investments in growth.']);
    g.addRow([]);
    g.addRow([]);
    g.addRow(['How to read this sheet-\nInvestments this week: List of all Ads Investments/refunds from this cycle']);
    g.addRow([]);
    g.addRow([]);
    g.addRow(['Investments this week']);
    g.addRow(adHead);
    g.addRow([]);
    g.addRow([null, null, null, null, null, null, null, null, 'Invoice Number', 'Remarks']);
    for (const a of opts.ads ?? []) g.addRow(adRow(a));
    g.addRow([]);
    g.addRow(['Investments from previous week']);
    g.addRow([...adHead, 'Invoice Number', 'Remarks']);
    for (const a of opts.previousAds ?? []) g.addRow(adRow(a));
    g.addRow([]);
    g.addRow(['Total Ads Investments', null, null, money(0), money(0), money(0)]);
    g.addRow([]);
    g.addRow([]);
    g.addRow(['Recovery Details']);
    g.addRow(['Recovery Outlet', 'Period  From', 'Period To', 'Recovered Amount', 'Invoice Number', 'Remarks']);
    g.addRow(['  ']);
  }

  wb.addWorksheet('Discount Summary').addRow(['Discount Summary\nList of all active discounts applied on orders during this report period']);
  wb.addWorksheet('Glossary').addRow(['Glossary\nDescriptions of all fields used in the Order Level section of this report']);

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
