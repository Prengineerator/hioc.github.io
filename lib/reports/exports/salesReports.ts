// The owner's sales downloads (Owner → Reports → Downloads → Sales): order-wise,
// day-wise, item-wise, category-wise, hour-wise and staff-wise sales, discounts
// given, cancelled bills and refunds. Pure — each builder turns the one
// OrderDataset (lib/reports/exports/orderDataServer.ts) into a CsvTable, so every
// sheet agrees on what a sale is.
//
// Rules shared by every sheet:
//   • A sale is a VALID order (not cancelled or rejected), dated by the IST day
//     it was placed. Only the order register and the cancellation sheet list the
//     other orders; they count in no total.
//   • Lines are the non-voided ones (the dataset already left voided lines out);
//     voided lines are reported on their own in the cancellation sheet.
//   • Money is whole ₹ from the orders and 2 dp for the GST split; column
//     headers say "(INR)". Percentages are to 1 dp.
//   • Taxable value is what the bill's GST was charged on (see orderData.ts):
//     from GST_NET_OF_DISCOUNT_FROM that is after the coupon / Beanies discount
//     and includes takeaway packaging; earlier bills charged it before the
//     discount with packaging untaxed. The order and day sheets say which in a
//     "GST basis" column; the item and category sheets list the packaging's
//     taxable value and GST on a row of its own, so their totals tie to the
//     order register.
//   • Every sheet ends with a TOTAL row, zeros on an empty dataset, so the
//     columns line up the same whether or not anything was sold.

import { datesBetween } from '@/lib/reports/reconcile';
import { round2, type CsvTable, type CsvValue } from '@/lib/reports/csv';
import { SAC_RESTAURANT } from '@/lib/reports/exports/gstCodes';
import type { ExportLine, ExportOrder, ExportRefund, OrderDataset } from '@/lib/reports/exports/types';

// ── Table plumbing ──────────────────────────────────────────────────────────

interface Col<T> {
  header: string;
  cell: (r: T) => CsvValue;
  /** The TOTAL row's cell; blank when omitted. */
  total?: (rows: T[]) => CsvValue;
}

/** Header, one row per `rows` item, then a TOTAL row computed over `totalRows` (default: all rows). */
function tableOf<T>(cols: Col<T>[], rows: T[], totalRows: T[] = rows): CsvTable {
  return {
    columns: cols.map((c) => c.header),
    rows: [
      ...rows.map((r) => cols.map((c) => c.cell(r))),
      cols.map((c) => (c.total ? c.total(totalRows) : '')),
    ],
  };
}

const sumBy = <T>(xs: T[], f: (x: T) => number): number => round2(xs.reduce((s, x) => s + f(x), 0));
const sum =
  <T>(f: (r: T) => number) =>
  (rs: T[]): number =>
    sumBy(rs, f);
const text = (s: string) => () => s;

/** part / whole as a percentage to 1 dp; 0 when there is no whole. */
function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

/** Share column's TOTAL: everything is 100%, an empty sheet 0%. */
const fullShare = (whole: number) => (): number => (whole > 0 ? 100 : 0);

function avg(total: number, count: number): number {
  return count > 0 ? round2(total / count) : 0;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const validOrders = (ds: OrderDataset): ExportOrder[] => ds.orders.filter((o) => o.valid);
const itemCount = (o: ExportOrder): number => o.lines.reduce((s, l) => s + l.quantity, 0);
const totalGst = (o: ExportOrder): number => round2(o.cgstInr + o.sgstInr);
/** What the GST on these orders was charged on: the rule changed on GST_NET_OF_DISCOUNT_FROM, so a range can hold both. */
function gstBasis(orders: ExportOrder[]): string {
  if (orders.length === 0) return '';
  const current = orders.filter((o) => o.gstRule === 'net_of_discount').length;
  if (current === orders.length) return 'After discount, packaging taxed';
  return current === 0 ? 'Before discount, packaging untaxed' : 'Mixed';
}

/** The packaging the valid orders were taxed on: its taxable value, GST and the orders that had any. */
function packagingTax(ds: OrderDataset): { orders: Set<string>; taxableInr: number; cgstInr: number; sgstInr: number } {
  const t = { orders: new Set<string>(), taxableInr: 0, cgstInr: 0, sgstInr: 0 };
  for (const o of validOrders(ds)) {
    if (o.packagingTaxableInr === 0 && o.packagingCgstInr === 0 && o.packagingSgstInr === 0) continue;
    t.orders.add(o.id);
    t.taxableInr += o.packagingTaxableInr;
    t.cgstInr += o.packagingCgstInr;
    t.sgstInr += o.packagingSgstInr;
  }
  return t;
}
const PACKAGING_LABEL = 'Packaging charges';
const ONLINE_STAFF = 'Online / customer';
const staffLabel = (o: ExportOrder): string => o.createdByName || ONLINE_STAFF;
const variantLabel = (name: string, variant: string): string => (variant ? `${name} (${variant})` : name);

// ── Order-wise sales register ───────────────────────────────────────────────

/** One row per order placed in the range, cancelled and rejected ones too; the TOTAL row adds up the valid orders only. */
export function orderRegister(ds: OrderDataset): CsvTable {
  const cols: Col<ExportOrder>[] = [
    { header: 'Invoice no', cell: (o) => o.invoiceNo, total: text('TOTAL') },
    { header: 'Date', cell: (o) => o.date },
    { header: 'Time', cell: (o) => o.time },
    { header: 'Status', cell: (o) => o.status, total: text('valid orders only') },
    { header: 'Channel', cell: (o) => o.channel },
    { header: 'Order type', cell: (o) => o.orderType },
    { header: 'Table', cell: (o) => o.tableLabel ?? '' },
    { header: 'Items', cell: itemCount, total: sum(itemCount) },
    { header: 'Subtotal (INR)', cell: (o) => o.subtotalInr, total: sum((o) => o.subtotalInr) },
    { header: 'Coupon discount (INR)', cell: (o) => o.couponDiscountInr, total: sum((o) => o.couponDiscountInr) },
    { header: 'Coupon codes', cell: (o) => o.couponCodes.join(', ') },
    { header: 'Beanies discount (INR)', cell: (o) => o.beaniesDiscountInr, total: sum((o) => o.beaniesDiscountInr) },
    { header: 'Manager discount (INR)', cell: manualOf, total: sum(manualOf) },
    { header: 'Ritual cups covered (INR)', cell: (o) => o.passDiscountInr, total: sum((o) => o.passDiscountInr) },
    { header: 'Taxable value (INR)', cell: (o) => o.taxableValueInr, total: sum((o) => o.taxableValueInr) },
    { header: 'CGST (INR)', cell: (o) => o.cgstInr, total: sum((o) => o.cgstInr) },
    { header: 'SGST (INR)', cell: (o) => o.sgstInr, total: sum((o) => o.sgstInr) },
    { header: 'Total GST (INR)', cell: totalGst, total: sum(totalGst) },
    { header: 'GST-exempt value (INR)', cell: (o) => o.exemptValueInr, total: sum((o) => o.exemptValueInr) },
    { header: 'GST basis', cell: (o) => gstBasis([o]), total: gstBasis },
    { header: 'Packaging (INR)', cell: (o) => o.packagingInr, total: sum((o) => o.packagingInr) },
    { header: 'Bill total (INR)', cell: (o) => o.totalInr, total: sum((o) => o.totalInr) },
    { header: 'Settle discount (INR)', cell: (o) => o.settleDiscountInr, total: sum((o) => o.settleDiscountInr) },
    { header: 'Tip (INR)', cell: (o) => o.tipInr, total: sum((o) => o.tipInr) },
    { header: 'Refunded (INR)', cell: (o) => o.refundedInr, total: sum((o) => o.refundedInr) },
    { header: 'Payment method(s)', cell: (o) => o.paymentMethods.join(' + ') },
    { header: 'Payment status', cell: (o) => o.paymentStatus },
    { header: 'Rung up by', cell: staffLabel },
    { header: 'Reason', cell: (o) => o.rejectReason ?? '' },
  ];
  return tableOf(cols, ds.orders, validOrders(ds));
}

// ── Day-wise sales ──────────────────────────────────────────────────────────

interface DayRow {
  date: string;
  valid: ExportOrder[];
  /** Cancelled and rejected orders placed this day. */
  dead: number;
}

/** A column that adds up `f` over the day's valid orders (and, in TOTAL, over all days'). */
function dayCol(header: string, f: (o: ExportOrder) => number): Col<DayRow> {
  return { header, cell: (d) => sumBy(d.valid, f), total: (rs) => sumBy(rs.flatMap((d) => d.valid), f) };
}

/** One row per date in the range, a zero row on a day nothing was sold. */
export function daySales(ds: OrderDataset): CsvTable {
  const days = new Map<string, DayRow>(datesBetween(ds.from, ds.to).map((d) => [d, { date: d, valid: [], dead: 0 }]));
  for (const o of ds.orders) {
    let day = days.get(o.date);
    if (!day) {
      // Never drop money: an order dated outside from..to still gets its row.
      day = { date: o.date, valid: [], dead: 0 };
      days.set(o.date, day);
    }
    if (o.valid) day.valid.push(o);
    else day.dead += 1;
  }
  const rows = [...days.values()].sort((a, b) => a.date.localeCompare(b.date));

  const cols: Col<DayRow>[] = [
    { header: 'Date', cell: (d) => d.date, total: text('TOTAL') },
    { header: 'Orders', cell: (d) => d.valid.length, total: (rs) => rs.reduce((s, d) => s + d.valid.length, 0) },
    { header: 'Cancelled/rejected', cell: (d) => d.dead, total: (rs) => rs.reduce((s, d) => s + d.dead, 0) },
    dayCol('Items sold', itemCount),
    dayCol('Subtotal (INR)', (o) => o.subtotalInr),
    dayCol('Discounts (INR)', (o) => o.discountInr),
    dayCol('Ritual cups covered (INR)', (o) => o.passDiscountInr),
    dayCol('Taxable value (INR)', (o) => o.taxableValueInr),
    dayCol('CGST (INR)', (o) => o.cgstInr),
    dayCol('SGST (INR)', (o) => o.sgstInr),
    dayCol('Total GST (INR)', totalGst),
    dayCol('GST-exempt value (INR)', (o) => o.exemptValueInr),
    { header: 'GST basis', cell: (d) => gstBasis(d.valid), total: (rs) => gstBasis(rs.flatMap((d) => d.valid)) },
    dayCol('Packaging (INR)', (o) => o.packagingInr),
    dayCol('Bill total (INR)', (o) => o.totalInr),
    dayCol('Settle discounts (INR)', (o) => o.settleDiscountInr),
    dayCol('Net sales (INR)', (o) => o.totalInr - o.settleDiscountInr),
    dayCol('Tips (INR)', (o) => o.tipInr),
    {
      header: 'Avg bill (INR)',
      cell: (d) => avg(sumBy(d.valid, (o) => o.totalInr), d.valid.length),
      total: (rs) => {
        const all = rs.flatMap((d) => d.valid);
        return avg(sumBy(all, (o) => o.totalInr), all.length);
      },
    },
  ];
  return tableOf(cols, rows);
}

// ── Item-wise and category-wise sales ───────────────────────────────────────

interface ItemGroup {
  name: string;
  variant: string;
  category: string;
  code: string;
  exempt: boolean;
  quantity: number;
  /** kg sold, null unless a line of this item is sold by weight. */
  kg: number | null;
  orderIds: Set<string>;
  grossInr: number;
  coverInr: number;
  taxableInr: number;
  cgstInr: number;
  sgstInr: number;
  /** The packaging row: no item, only the packaging's taxable value and GST. */
  packaging?: boolean;
}

/** The valid orders' lines, each with its order id. */
function validLines(ds: OrderDataset): { orderId: string; line: ExportLine }[] {
  return validOrders(ds).flatMap((o) => o.lines.map((line) => ({ orderId: o.id, line })));
}

/**
 * Lines grouped by item and variant, best seller first. An item that is GST
 * exempt on some bills and taxed on others (or filed under another code) gets a
 * row for each, so the GST columns stay true to the bills.
 */
export function itemSales(ds: OrderDataset): CsvTable {
  const groups = new Map<string, ItemGroup>();
  for (const { orderId, line: l } of validLines(ds)) {
    const key = [l.name, l.variant, l.gstExempt ? 'x' : 't', l.gstCode.code].join('\u0001');
    let g = groups.get(key);
    if (!g) {
      g = {
        name: l.name,
        variant: l.variant,
        category: l.category,
        code: l.gstCode.code,
        exempt: l.gstExempt,
        quantity: 0,
        kg: null,
        orderIds: new Set(),
        grossInr: 0,
        coverInr: 0,
        taxableInr: 0,
        cgstInr: 0,
        sgstInr: 0,
      };
      groups.set(key, g);
    }
    g.quantity += l.quantity;
    if (l.weightGrams !== null) g.kg = (g.kg ?? 0) + (l.quantity * l.weightGrams) / 1000;
    g.orderIds.add(orderId);
    g.grossInr += l.lineTotalInr;
    g.coverInr += l.passCoveredInr;
    g.taxableInr += l.taxableInr;
    g.cgstInr += l.cgstInr;
    g.sgstInr += l.sgstInr;
  }
  const items = [...groups.values()].sort(
    (a, b) => b.grossInr - a.grossInr || a.name.localeCompare(b.name) || a.variant.localeCompare(b.variant),
  );
  const wholeGross = sumBy(items, (g) => g.grossInr);
  const distinctOrders = new Set(items.flatMap((g) => [...g.orderIds])).size;
  // Packaging is taxed from GST_NET_OF_DISCOUNT_FROM: its own last row keeps the GST columns tied to the order register.
  const pack = packagingTax(ds);
  const rows: ItemGroup[] =
    pack.orders.size === 0
      ? items
      : [
          ...items,
          {
            name: PACKAGING_LABEL,
            variant: '',
            category: PACKAGING_LABEL,
            code: SAC_RESTAURANT.code,
            exempt: false,
            quantity: 0,
            kg: null,
            orderIds: pack.orders,
            grossInr: 0,
            coverInr: 0,
            taxableInr: pack.taxableInr,
            cgstInr: pack.cgstInr,
            sgstInr: pack.sgstInr,
            packaging: true,
          },
        ];

  const cols: Col<ItemGroup>[] = [
    { header: 'Item', cell: (g) => g.name, total: text('TOTAL') },
    { header: 'Variant', cell: (g) => g.variant },
    { header: 'Category', cell: (g) => g.category },
    { header: 'HSN/SAC', cell: (g) => g.code },
    { header: 'Quantity', cell: (g) => (g.packaging ? '' : g.quantity), total: sum((g) => g.quantity) },
    {
      header: 'Weight (kg)',
      cell: (g) => (g.kg === null ? '' : round3(g.kg)),
      total: (rs) => (rs.some((g) => g.kg !== null) ? round3(rs.reduce((s, g) => s + (g.kg ?? 0), 0)) : ''),
    },
    // The total counts each order once, not once per item it holds.
    { header: 'Orders', cell: (g) => g.orderIds.size, total: () => distinctOrders },
    { header: 'Gross sales (INR)', cell: (g) => (g.packaging ? '' : round2(g.grossInr)), total: sum((g) => g.grossInr) },
    { header: 'Ritual cups covered (INR)', cell: (g) => (g.packaging ? '' : round2(g.coverInr)), total: sum((g) => g.coverInr) },
    { header: 'GST-exempt', cell: (g) => (g.exempt ? 'Yes' : 'No') },
    { header: 'Taxable value (INR)', cell: (g) => round2(g.taxableInr), total: sum((g) => g.taxableInr) },
    { header: 'CGST (INR)', cell: (g) => round2(g.cgstInr), total: sum((g) => g.cgstInr) },
    { header: 'SGST (INR)', cell: (g) => round2(g.sgstInr), total: sum((g) => g.sgstInr) },
    { header: 'Share of sales %', cell: (g) => (g.packaging ? '' : pct(g.grossInr, wholeGross)), total: fullShare(wholeGross) },
  ];
  return tableOf(cols, rows);
}

interface CategoryGroup {
  category: string;
  quantity: number;
  orderIds: Set<string>;
  grossInr: number;
  coverInr: number;
  taxableInr: number;
  gstInr: number;
  /** The packaging row: no items, only the packaging's taxable value and GST. */
  packaging?: boolean;
}

/** Lines grouped by menu category, biggest first. */
export function categorySales(ds: OrderDataset): CsvTable {
  const groups = new Map<string, CategoryGroup>();
  for (const { orderId, line: l } of validLines(ds)) {
    let g = groups.get(l.category);
    if (!g) {
      g = { category: l.category, quantity: 0, orderIds: new Set(), grossInr: 0, coverInr: 0, taxableInr: 0, gstInr: 0 };
      groups.set(l.category, g);
    }
    g.quantity += l.quantity;
    g.orderIds.add(orderId);
    g.grossInr += l.lineTotalInr;
    g.coverInr += l.passCoveredInr;
    g.taxableInr += l.taxableInr;
    g.gstInr += l.cgstInr + l.sgstInr;
  }
  const categories = [...groups.values()].sort((a, b) => b.grossInr - a.grossInr || a.category.localeCompare(b.category));
  const wholeGross = sumBy(categories, (g) => g.grossInr);
  const distinctOrders = new Set(categories.flatMap((g) => [...g.orderIds])).size;
  const pack = packagingTax(ds);
  const rows: CategoryGroup[] =
    pack.orders.size === 0
      ? categories
      : [
          ...categories,
          {
            category: PACKAGING_LABEL,
            quantity: 0,
            orderIds: pack.orders,
            grossInr: 0,
            coverInr: 0,
            taxableInr: pack.taxableInr,
            gstInr: pack.cgstInr + pack.sgstInr,
            packaging: true,
          },
        ];

  const cols: Col<CategoryGroup>[] = [
    { header: 'Category', cell: (g) => g.category, total: text('TOTAL') },
    { header: 'Items sold', cell: (g) => (g.packaging ? '' : g.quantity), total: sum((g) => g.quantity) },
    { header: 'Orders', cell: (g) => g.orderIds.size, total: () => distinctOrders },
    { header: 'Gross sales (INR)', cell: (g) => (g.packaging ? '' : round2(g.grossInr)), total: sum((g) => g.grossInr) },
    { header: 'Ritual cups covered (INR)', cell: (g) => (g.packaging ? '' : round2(g.coverInr)), total: sum((g) => g.coverInr) },
    { header: 'Taxable value (INR)', cell: (g) => round2(g.taxableInr), total: sum((g) => g.taxableInr) },
    { header: 'Total GST (INR)', cell: (g) => round2(g.gstInr), total: sum((g) => g.gstInr) },
    { header: 'Share of sales %', cell: (g) => (g.packaging ? '' : pct(g.grossInr, wholeGross)), total: fullShare(wholeGross) },
  ];
  return tableOf(cols, rows);
}

// ── Hour-wise sales ─────────────────────────────────────────────────────────

interface HourRow {
  hour: number;
  orders: ExportOrder[];
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Valid orders by the IST hour they were placed; hours with no orders are left out. */
export function hourlySales(ds: OrderDataset): CsvTable {
  const byHour = new Map<number, ExportOrder[]>();
  for (const o of validOrders(ds)) byHour.set(o.hour, [...(byHour.get(o.hour) ?? []), o]);
  const rows: HourRow[] = [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([hour, orders]) => ({ hour, orders }));
  const whole = sumBy(validOrders(ds), (o) => o.totalInr);
  const billOf = (h: HourRow) => sumBy(h.orders, (o) => o.totalInr);

  const cols: Col<HourRow>[] = [
    { header: 'Hour', cell: (h) => `${pad2(h.hour)}:00–${pad2(h.hour + 1)}:00`, total: text('TOTAL') },
    { header: 'Orders', cell: (h) => h.orders.length, total: (rs) => rs.reduce((s, h) => s + h.orders.length, 0) },
    { header: 'Bill total (INR)', cell: billOf, total: sum(billOf) },
    {
      header: 'Avg bill (INR)',
      cell: (h) => avg(billOf(h), h.orders.length),
      total: (rs) => avg(sumBy(rs, billOf), rs.reduce((s, h) => s + h.orders.length, 0)),
    },
    { header: 'Share of sales %', cell: (h) => pct(billOf(h), whole), total: fullShare(whole) },
  ];
  return tableOf(cols, rows);
}

// ── Staff-wise sales ────────────────────────────────────────────────────────

interface StaffRow {
  name: string;
  valid: ExportOrder[];
  /** Cancelled and rejected orders. */
  dead: number;
  voidedLines: number;
}

/** Who rang the orders up ('Online / customer' for orders nobody rang up), biggest first. */
export function staffSales(ds: OrderDataset): CsvTable {
  const groups = new Map<string, StaffRow>();
  for (const o of ds.orders) {
    const name = staffLabel(o);
    let g = groups.get(name);
    if (!g) {
      g = { name, valid: [], dead: 0, voidedLines: 0 };
      groups.set(name, g);
    }
    if (o.valid) g.valid.push(o);
    else g.dead += 1;
    g.voidedLines += o.voidedLines.length;
  }
  const billOf = (g: StaffRow) => sumBy(g.valid, (o) => o.totalInr);
  const rows = [...groups.values()].sort((a, b) => billOf(b) - billOf(a) || a.name.localeCompare(b.name));

  const cols: Col<StaffRow>[] = [
    { header: 'Staff', cell: (g) => g.name, total: text('TOTAL') },
    { header: 'Orders', cell: (g) => g.valid.length, total: sum((g) => g.valid.length) },
    { header: 'Bill total (INR)', cell: billOf, total: sum(billOf) },
    {
      header: 'Discounts (INR)',
      cell: (g) => sumBy(g.valid, (o) => o.discountInr),
      total: sum((g) => sumBy(g.valid, (o) => o.discountInr)),
    },
    {
      header: 'Settle discounts (INR)',
      cell: (g) => sumBy(g.valid, (o) => o.settleDiscountInr),
      total: sum((g) => sumBy(g.valid, (o) => o.settleDiscountInr)),
    },
    {
      header: 'Tips (INR)',
      cell: (g) => sumBy(g.valid, (o) => o.tipInr),
      total: sum((g) => sumBy(g.valid, (o) => o.tipInr)),
    },
    { header: 'Cancelled/rejected', cell: (g) => g.dead, total: sum((g) => g.dead) },
    { header: 'Voided lines', cell: (g) => g.voidedLines, total: sum((g) => g.voidedLines) },
  ];
  return tableOf(cols, rows);
}

// ── Discounts given ─────────────────────────────────────────────────────────

/** A manager discount on the order (absent on datasets read before its migration). */
function manualOf(o: ExportOrder): number {
  return o.manualDiscountInr ?? 0;
}

/** Valid orders where something was knocked off: a coupon, Beanies, a manager or settle discount, or Ritual cups. */
export function discountReport(ds: OrderDataset): CsvTable {
  const rows = validOrders(ds).filter(
    (o) =>
      o.couponDiscountInr > 0 ||
      o.beaniesDiscountInr > 0 ||
      manualOf(o) > 0 ||
      o.settleDiscountInr > 0 ||
      o.passDiscountInr > 0,
  );
  const cols: Col<ExportOrder>[] = [
    { header: 'Invoice no', cell: (o) => o.invoiceNo, total: text('TOTAL') },
    { header: 'Date', cell: (o) => o.date },
    { header: 'Coupon codes', cell: (o) => o.couponCodes.join(', ') },
    { header: 'Coupon discount (INR)', cell: (o) => o.couponDiscountInr, total: sum((o) => o.couponDiscountInr) },
    { header: 'Beanies discount (INR)', cell: (o) => o.beaniesDiscountInr, total: sum((o) => o.beaniesDiscountInr) },
    { header: 'Manager discount (INR)', cell: manualOf, total: sum(manualOf) },
    { header: 'Manager discount reason', cell: (o) => o.manualDiscountReason ?? '' },
    { header: 'Given by', cell: (o) => (manualOf(o) > 0 ? staffLabel(o) : '') },
    { header: 'Settle discount (INR)', cell: (o) => o.settleDiscountInr, total: sum((o) => o.settleDiscountInr) },
    { header: 'Ritual cups covered (INR)', cell: (o) => o.passDiscountInr, total: sum((o) => o.passDiscountInr) },
    { header: 'Bill total (INR)', cell: (o) => o.totalInr, total: sum((o) => o.totalInr) },
  ];
  return tableOf(cols, rows);
}

// ── Cancelled bills & voided items ──────────────────────────────────────────

interface CancelRow {
  type: string;
  invoiceNo: string;
  date: string;
  time: string;
  item: string;
  /** Voided items only. */
  quantity: number | null;
  valueInr: number;
  /** Cancelled/rejected orders only. */
  paymentStatus: string;
  refundedInr: number | null;
  reason: string;
}

/** Every cancelled or rejected order, and every voided line of any order, in invoice order. */
export function cancellationReport(ds: OrderDataset): CsvTable {
  const rows: CancelRow[] = [];
  for (const o of ds.orders) {
    if (!o.valid) {
      rows.push({
        type: o.status === 'rejected' ? 'Order rejected' : 'Order cancelled',
        invoiceNo: o.invoiceNo,
        date: o.date,
        time: o.time,
        item: '',
        quantity: null,
        valueInr: o.totalInr,
        paymentStatus: o.paymentStatus,
        refundedInr: o.refundedInr,
        reason: o.rejectReason ?? '',
      });
    }
    for (const v of o.voidedLines) {
      rows.push({
        type: 'Item voided',
        invoiceNo: o.invoiceNo,
        date: o.date,
        time: o.time,
        item: variantLabel(v.name, v.variant),
        quantity: v.quantity,
        valueInr: v.lineTotalInr,
        paymentStatus: '',
        refundedInr: null,
        reason: v.reason ?? '',
      });
    }
  }
  const cols: Col<CancelRow>[] = [
    { header: 'Type', cell: (r) => r.type, total: text('TOTAL') },
    { header: 'Invoice no', cell: (r) => r.invoiceNo },
    { header: 'Date', cell: (r) => r.date },
    { header: 'Time', cell: (r) => r.time },
    { header: 'Item', cell: (r) => r.item },
    { header: 'Qty', cell: (r) => r.quantity, total: sum((r) => r.quantity ?? 0) },
    { header: 'Value (INR)', cell: (r) => r.valueInr, total: sum((r) => r.valueInr) },
    { header: 'Payment status', cell: (r) => r.paymentStatus },
    { header: 'Refunded (INR)', cell: (r) => r.refundedInr, total: sum((r) => r.refundedInr ?? 0) },
    { header: 'Reason', cell: (r) => r.reason },
  ];
  return tableOf(cols, rows);
}

// ── Refunds ─────────────────────────────────────────────────────────────────

/** Refunds in the range, oldest first; the TOTAL row adds up the processed ones only. */
export function refundReport(ds: OrderDataset): CsvTable {
  const rows: ExportRefund[] = [...ds.refunds].sort(
    (a, b) => a.date.localeCompare(b.date) || a.invoiceNo.localeCompare(b.invoiceNo) || a.id.localeCompare(b.id),
  );
  const cols: Col<ExportRefund>[] = [
    { header: 'Refund date', cell: (r) => r.date, total: text('TOTAL') },
    { header: 'Invoice no', cell: (r) => r.invoiceNo },
    { header: 'Order date', cell: (r) => r.orderDate },
    { header: 'Amount (INR)', cell: (r) => r.amountInr, total: sum((r) => r.amountInr) },
    { header: 'Method', cell: (r) => r.method ?? '' },
    { header: 'Status', cell: (r) => r.status, total: text('processed only') },
    { header: 'Reason', cell: (r) => r.reason ?? '' },
    { header: 'Processed by', cell: (r) => r.createdByName },
  ];
  return tableOf(
    cols,
    rows,
    rows.filter((r) => r.status === 'processed'),
  );
}
