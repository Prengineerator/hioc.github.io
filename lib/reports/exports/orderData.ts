// Turns the raw rows of a date range into the OrderDataset every order-based
// report reads (lib/reports/exports/types.ts). Pure — the rows are fetched by
// lib/reports/exports/orderDataServer.ts — so every rule here is unit-tested and
// the GST, sales and cash sheets all agree on what a sale and its tax are.
//
// THE TAX. The app charges GST once per order, rounded to a whole rupee
// (lib/store/hours.ts computeBill), on the lines that are not GST-exempt less
// what a HIOC Ritual cup covered, BEFORE any coupon / Beanies discount; packaging
// is never taxed. The reports show that tax as CHARGED (orders.tax_inr), never a
// recomputed one, and spread it over the order's lines so a sheet by item or by
// HSN code adds up to the same figure as a sheet by bill:
//   • a taxable line is non-exempt, not voided, with something left after the
//     pass cover (base = line total − pass cover);
//   • the order's tax is shared out pro-rata by base, in paise, and the last
//     taxable line takes the remainder, so the lines add up EXACTLY to tax_inr;
//   • exclusive pricing: a line's taxable value is its base; inclusive pricing
//     (the GST is inside the prices): base minus the line's tax;
//   • all sales are intra-state, so tax is half CGST, half SGST. Order tax is a
//     whole rupee, so its halves are exact. A line's halves are rounded
//     cumulatively through the order, so each is within a paisa of half the
//     line's tax and the lines still add up exactly to the order's halves — a
//     plain round-half-up per line would favour CGST by a paisa on every odd line.
// All sums are done in integer paise and turned into rupees at the very end.

import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { istDateOf } from '@/lib/reports/reconcile';
import { gstCodeFor } from '@/lib/reports/exports/gstCodes';
import type {
  ExportLine,
  ExportOrder,
  ExportRefund,
  OrderDataset,
  VoidedLine,
} from '@/lib/reports/exports/types';

// ── Input rows (as fetched) ─────────────────────────────────────────────────

export interface OrderRow {
  id: string;
  order_number: number;
  created_at: string;
  status: string;
  payment_status: string;
  payment_method: string | null;
  channel: string | null;
  order_type: string | null;
  table_label: string | null;
  reject_reason: string | null;
  created_by: string | null;
  subtotal_inr: number | null;
  tax_inr: number | null;
  packaging_inr: number | null;
  discount_inr: number | null;
  total_inr: number | null;
  /** Optional columns: absent before their migration (read as 0 / 'menu'). */
  settle_discount_inr?: number | null;
  tip_inr?: number | null;
  order_kind?: string | null;
  pass_discount_inr?: number | null;
}

export interface ItemRow {
  id: string;
  order_id: string;
  menu_item_id: string | null;
  name_snapshot: string;
  variant_label_snapshot: string | null;
  quantity: number;
  line_total_inr: number;
  gst_exempt?: boolean | null;
  voided?: boolean | null;
  void_reason?: string | null;
  pass_drinks?: number | null;
  pass_covered_inr?: number | null;
  coffee_pass_plan_id?: string | null;
  weight_grams?: number | null;
}

export interface MenuItemRow {
  id: string;
  category: string | null;
  sold_by_weight?: boolean | null;
}

/** One split-bill part (order_payments). */
export interface OrderPartRow {
  order_id: string;
  method: string;
  created_at?: string | null;
}

export interface RedemptionRow {
  order_id: string;
  discount_inr: number;
  /** coupons.code; null when the coupon is gone. */
  code: string | null;
}

export interface RefundRow {
  id: string;
  order_id: string;
  amount_inr: number;
  method?: string | null;
  reason: string | null;
  status: string;
  processed_at: string | null;
  created_by: string | null;
  created_at: string;
}

/** Enough of an order to print a refund's invoice number and order date. */
export interface RefundOrderRow {
  id: string;
  order_number: number;
  created_at: string;
}

export interface OrderDatasetInput {
  from: string;
  to: string;
  gstRatePercent: number;
  gstInclusive: boolean;
  /** Orders created in the range, any status. */
  orders: OrderRow[];
  /** Their order_items (voided ones included). */
  items: ItemRow[];
  menuItems: MenuItemRow[];
  /** Split-bill parts of these orders. */
  parts: OrderPartRow[];
  redemptions: RedemptionRow[];
  /** Every refund against these orders, whenever it happened. */
  orderRefunds: RefundRow[];
  /** Refunds whose processed_at (or created_at while not processed) is in the range, on any order. */
  rangeRefunds: RefundRow[];
  /** The orders of rangeRefunds that are not in `orders` (placed before the range). */
  refundOrders: RefundOrderRow[];
  /** User id → display name, for orders.created_by and refunds.created_by. */
  staffNames: ReadonlyMap<string, string>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DEAD = new Set(['cancelled', 'rejected']);
export const UNKNOWN_STAFF = 'Unknown staff';

/** IST wall-clock HH:MM and hour of an instant. */
function istClock(iso: string): { time: string; hour: number } {
  const time = new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(11, 16);
  return { time, hour: Number(time.slice(0, 2)) };
}

const toPaise = (inr: number | null | undefined): number => Math.round((inr ?? 0) * 100);
const fromPaise = (p: number): number => p / 100;

function groupBy<T>(rows: readonly T[], key: (r: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function nameOf(id: string | null, names: ReadonlyMap<string, string>): string {
  return id ? (names.get(id) ?? UNKNOWN_STAFF) : '';
}

// ── One order's lines and tax ───────────────────────────────────────────────

interface PricedOrder {
  lines: ExportLine[];
  voidedLines: VoidedLine[];
  taxableValueInr: number;
  exemptValueInr: number;
  cgstInr: number;
  sgstInr: number;
}

function priceOrder(
  order: OrderRow,
  items: readonly ItemRow[],
  menuById: ReadonlyMap<string, MenuItemRow>,
  gstRatePercent: number,
  gstInclusive: boolean,
): PricedOrder {
  const voidedLines: VoidedLine[] = items
    .filter((i) => i.voided === true)
    .map((i) => ({
      name: i.name_snapshot,
      variant: i.variant_label_snapshot ?? '',
      quantity: i.quantity,
      lineTotalInr: i.line_total_inr,
      reason: i.void_reason?.trim() || null,
    }));

  const live = items
    .filter((i) => i.voided !== true)
    .map((row) => {
      const lineP = toPaise(row.line_total_inr);
      const coveredP = Math.min(Math.max(0, toPaise(row.pass_covered_inr)), lineP);
      return { row, coveredP, baseP: lineP - coveredP, exempt: row.gst_exempt === true };
    });

  // Taxable lines carry the tax; exempt lines and lines the pass paid for in full carry none.
  const taxable: number[] = [];
  live.forEach((l, i) => {
    if (!l.exempt && l.baseP > 0) taxable.push(i);
  });
  const isTaxable = new Set(taxable);
  const totalBaseP = taxable.reduce((s, i) => s + live[i].baseP, 0);
  const orderTaxP = toPaise(order.tax_inr);

  const taxP = live.map(() => 0);
  const cgstP = live.map(() => 0);
  let allocatedP = 0;
  let cumTaxP = 0;
  let cumCgstP = 0;
  taxable.forEach((i, k) => {
    taxP[i] =
      k === taxable.length - 1
        ? orderTaxP - allocatedP
        : Math.floor((orderTaxP * live[i].baseP) / totalBaseP);
    allocatedP += taxP[i];
    cumTaxP += taxP[i];
    const cum = Math.round(cumTaxP / 2);
    cgstP[i] = cum - cumCgstP;
    cumCgstP = cum;
  });

  const lines: ExportLine[] = live.map((l, i) => {
    const menu = l.row.menu_item_id ? menuById.get(l.row.menu_item_id) : undefined;
    const weightGrams = l.row.weight_grams ?? null;
    // A line with a weight was sold by weight even if the item has since been switched back.
    const soldByWeight = menu?.sold_by_weight === true || weightGrams !== null;
    return {
      id: l.row.id,
      menuItemId: l.row.menu_item_id,
      name: l.row.name_snapshot,
      variant: l.row.variant_label_snapshot ?? '',
      category: l.row.coffee_pass_plan_id ? 'HIOC Ritual' : menu?.category?.trim() || 'Uncategorised',
      quantity: l.row.quantity,
      weightGrams,
      lineTotalInr: l.row.line_total_inr,
      passCoveredInr: fromPaise(l.coveredP),
      passDrinks: l.row.pass_drinks ?? 0,
      gstExempt: l.exempt,
      gstCode: gstCodeFor({ soldByWeight }),
      taxableInr: isTaxable.has(i) ? fromPaise(gstInclusive ? l.baseP - taxP[i] : l.baseP) : 0,
      cgstInr: fromPaise(cgstP[i]),
      sgstInr: fromPaise(taxP[i] - cgstP[i]),
    };
  });

  // The order's own halves: exact, tax_inr being whole rupees.
  const orderCgstP = Math.round(orderTaxP / 2);
  const orderSgstP = orderTaxP - orderCgstP;

  // Tax was charged but no line can carry it (data that should not exist: every
  // line voided, exempt or pass-paid). Keep the tax on the order and back the
  // taxable value out of it — rate × value = tax holds for exclusive and inclusive pricing alike.
  let taxableP: number;
  if (taxable.length > 0) {
    taxableP = taxable.reduce((s, i) => s + (gstInclusive ? live[i].baseP - taxP[i] : live[i].baseP), 0);
  } else if (orderTaxP > 0 && gstRatePercent > 0) {
    taxableP = Math.round((orderTaxP * 100) / gstRatePercent);
  } else {
    taxableP = 0;
  }

  return {
    lines,
    voidedLines,
    taxableValueInr: fromPaise(taxableP),
    exemptValueInr: fromPaise(live.reduce((s, l) => s + (l.exempt ? l.baseP : 0), 0)),
    cgstInr: fromPaise(orderCgstP),
    sgstInr: fromPaise(orderSgstP),
  };
}

// ── The dataset ─────────────────────────────────────────────────────────────

export function buildOrderDataset(input: OrderDatasetInput): OrderDataset {
  const { gstRatePercent, gstInclusive, staffNames } = input;
  const menuById = new Map(input.menuItems.map((m) => [m.id, m]));
  const itemsByOrder = groupBy(input.items, (i) => i.order_id);
  const redemptionsByOrder = groupBy(input.redemptions, (r) => r.order_id);
  // Parts in the order they were taken, so the methods read "cash + upi" the way the bill was paid.
  const partsByOrder = groupBy(
    [...input.parts].sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? '')),
    (p) => p.order_id,
  );
  const processedRefundsByOrder = groupBy(
    input.orderRefunds.filter((r) => r.status === 'processed'),
    (r) => r.order_id,
  );

  const orders: ExportOrder[] = input.orders.map((o) => {
    const priced = priceOrder(o, itemsByOrder.get(o.id) ?? [], menuById, gstRatePercent, gstInclusive);
    const redemptions = redemptionsByOrder.get(o.id) ?? [];
    const couponDiscountInr = redemptions.reduce((s, r) => s + (r.discount_inr ?? 0), 0);
    const discountInr = o.discount_inr ?? 0;
    const partMethods = [...new Set((partsByOrder.get(o.id) ?? []).map((p) => p.method).filter(Boolean))];
    const clock = istClock(o.created_at);
    return {
      id: o.id,
      orderNumber: o.order_number,
      invoiceNo: formatOrderNumber(o.order_number),
      createdAt: o.created_at,
      date: istDateOf(o.created_at),
      time: clock.time,
      hour: clock.hour,
      status: o.status,
      valid: !DEAD.has(o.status),
      rejectReason: o.reject_reason?.trim() || null,
      paymentStatus: o.payment_status,
      paymentMethods: partMethods.length > 0 ? partMethods : o.payment_method ? [o.payment_method] : [],
      channel: o.channel ?? 'customer_web',
      orderType: o.order_type ?? 'takeaway',
      orderKind: o.order_kind ?? 'menu',
      tableLabel: o.table_label?.trim() || null,
      createdById: o.created_by,
      createdByName: nameOf(o.created_by, staffNames),
      subtotalInr: o.subtotal_inr ?? 0,
      taxInr: o.tax_inr ?? 0,
      packagingInr: o.packaging_inr ?? 0,
      discountInr,
      passDiscountInr: o.pass_discount_inr ?? 0,
      totalInr: o.total_inr ?? o.subtotal_inr ?? 0,
      settleDiscountInr: o.settle_discount_inr ?? 0,
      tipInr: o.tip_inr ?? 0,
      couponCodes: [...new Set(redemptions.map((r) => r.code?.trim()).filter((c): c is string => !!c))],
      couponDiscountInr,
      beaniesDiscountInr: Math.max(0, discountInr - couponDiscountInr),
      refundedInr: (processedRefundsByOrder.get(o.id) ?? []).reduce((s, r) => s + (r.amount_inr ?? 0), 0),
      taxableValueInr: priced.taxableValueInr,
      exemptValueInr: priced.exemptValueInr,
      cgstInr: priced.cgstInr,
      sgstInr: priced.sgstInr,
      lines: priced.lines,
      voidedLines: priced.voidedLines,
    };
  });
  orders.sort((a, b) => a.orderNumber - b.orderNumber);

  // A refund can be on a bill from an earlier month, so look its order up in both lists.
  const orderInfo = new Map<string, { orderNumber: number; createdAt: string }>();
  for (const o of input.refundOrders) orderInfo.set(o.id, { orderNumber: o.order_number, createdAt: o.created_at });
  for (const o of input.orders) orderInfo.set(o.id, { orderNumber: o.order_number, createdAt: o.created_at });

  const refunds: ExportRefund[] = input.rangeRefunds
    .map((r): ExportRefund => {
      const info = orderInfo.get(r.order_id);
      return {
        id: r.id,
        orderId: r.order_id,
        invoiceNo: info ? formatOrderNumber(info.orderNumber) : '',
        orderDate: info ? istDateOf(info.createdAt) : '',
        date: istDateOf(r.processed_at ?? r.created_at),
        amountInr: r.amount_inr,
        method: r.method ?? null,
        reason: r.reason?.trim() || null,
        status: r.status,
        processedAt: r.processed_at,
        createdById: r.created_by,
        createdByName: nameOf(r.created_by, staffNames),
      };
    })
    // The loader reads a little wide; the contract is "falls in the range".
    .filter((r) => r.date >= input.from && r.date <= input.to)
    .sort((a, b) => a.date.localeCompare(b.date) || (a.processedAt ?? '').localeCompare(b.processedAt ?? '') || a.id.localeCompare(b.id));

  return { from: input.from, to: input.to, gstRatePercent, gstInclusive, orders, refunds };
}
