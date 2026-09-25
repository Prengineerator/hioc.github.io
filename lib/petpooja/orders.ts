import { normalizeLegacyPhone } from './phone';
import { parsePetpoojaDateTime, fiscalYearOf } from './dates';
import { splitItems } from './items';
import { matchMenuItem } from './match';
import type { LegacyPayment, MenuSnapshotItem, ParsedLegacyItem, ParsedLegacyOrder, SkipCount } from './types';

// Parses one Petpooja "Order Report" Sheet1 (read as unknown[][], e.g. via
// exceljs) into ParsedLegacyOrder[]. Rows 0-3 are a title block; row 4 is
// the 23-column header, found dynamically as the first row whose cell 0 is
// 'Order No.' rather than assumed to be a fixed index.
//
// A "bill row" has a non-empty `Created`. A "part-payment continuation
// row" has `Created` empty and only Order No. / Grand Total (the part
// amount) / Payment Type set; it always immediately follows its parent
// bill row, whose own Payment Type is 'Part Payment' (or a QR-code
// variant), Grand Total is 0, and Payment Description is
// 'Total : <amount>.00'.

const HEADER = [
  'Order No.',
  'Client OrderID',
  'Order Type',
  'Sub Order Type',
  'Customer Name',
  'Customer Phone',
  'GSTIN',
  'Customer Address',
  'Delivery Boy',
  'Delivery Boy Number',
  'Items',
  'My Amount (₹)',
  'Total Discount (₹)',
  'Delivery Charge (₹)',
  'Container Charge (₹)',
  'Total Tax (₹)',
  'Round Off (₹)',
  'Grand Total (₹)',
  'Payment Type',
  'Payment Description',
  'Status',
  'Created',
  'Sequence Name',
] as const;

const COL = {
  ORDER_NO: 0,
  CLIENT_ORDER_ID: 1,
  ORDER_TYPE: 2,
  SUB_ORDER_TYPE: 3,
  CUSTOMER_NAME: 4,
  CUSTOMER_PHONE: 5,
  GSTIN: 6,
  CUSTOMER_ADDRESS: 7,
  ITEMS: 10,
  MY_AMOUNT: 11,
  TOTAL_DISCOUNT: 12,
  DELIVERY_CHARGE: 13,
  CONTAINER_CHARGE: 14,
  TOTAL_TAX: 15,
  ROUND_OFF: 16,
  GRAND_TOTAL: 17,
  PAYMENT_TYPE: 18,
  PAYMENT_DESCRIPTION: 19,
  STATUS: 20,
  CREATED: 21,
} as const;

function cellStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v).trim();
}

function cellStrOrNull(v: unknown): string | null {
  const s = cellStr(v);
  return s ? s : null;
}

function cellNum(v: unknown): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function isBlankRow(row: unknown[]): boolean {
  return row.every((c) => c === null || c === undefined || String(c).trim() === '');
}

function rawFromRow(row: unknown[]): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  HEADER.forEach((name, i) => {
    raw[name] = row[i] ?? null;
  });
  return raw;
}

function channelOf(
  orderType: string,
  subOrderType: string | null,
): { channel: ParsedLegacyOrder['channel']; table_label: string } {
  if (subOrderType === 'Zomato') return { channel: 'zomato', table_label: '' };
  if (subOrderType === 'Hioc - Swiggy') return { channel: 'swiggy', table_label: '' };
  if (subOrderType === 'Menu QR Code') return { channel: 'qr', table_label: '' };
  if (orderType.startsWith('Dine In')) {
    const m = /\((\d+)\)/.exec(orderType);
    return { channel: 'dine_in', table_label: m ? m[1] : '' };
  }
  if (subOrderType === 'Delivery') return { channel: 'delivery', table_label: '' };
  return { channel: 'counter', table_label: '' };
}

/** 'Total : 1007.00' -> 1007. Returns null when the description doesn't
 * carry a total (caller falls back to summing the part payments). */
function parseTotalFromDescription(description: string): number | null {
  const m = /Total\s*:\s*([\d.]+)/.exec(description);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function buildItems(itemsText: string, menu: MenuSnapshotItem[]): ParsedLegacyItem[] {
  return splitItems(itemsText).map((split, position) => {
    const matched = matchMenuItem(split.item_name, split.variant_label, menu);
    return {
      position,
      raw_name: split.raw_name,
      item_name: split.item_name,
      variant_label: split.variant_label,
      menu_item_id: matched.menu_item_id,
      variant_id: matched.variant_id,
      matched_menu_name: matched.matched_menu_name,
    };
  });
}

function bumpSkip(skipped: Map<string, number>, reason: string): void {
  skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
}

export function parseOrderSheet(
  rows: unknown[][],
  menu: MenuSnapshotItem[],
): { orders: ParsedLegacyOrder[]; skipped: SkipCount[] } {
  const headerIdx = rows.findIndex((row) => cellStr(row[COL.ORDER_NO]) === 'Order No.');
  if (headerIdx === -1) {
    return { orders: [], skipped: [{ reason: 'no_header_row', count: 1 }] };
  }

  const orders: ParsedLegacyOrder[] = [];
  const skipped = new Map<string, number>();
  const fallbackTotal = new Set<ParsedLegacyOrder>();

  let currentParent: ParsedLegacyOrder | null = null;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || isBlankRow(row)) {
      if (row) bumpSkip(skipped, 'blank_row');
      continue;
    }

    const billNo = cellStr(row[COL.ORDER_NO]);
    const createdRaw = cellStr(row[COL.CREATED]);

    if (!createdRaw) {
      // Part-payment continuation row.
      if (currentParent && currentParent.bill_no === billNo) {
        const amount = cellNum(row[COL.GRAND_TOTAL]);
        const method = cellStr(row[COL.PAYMENT_TYPE]);
        currentParent.payments.push({ method, amount_inr: amount });
        if (fallbackTotal.has(currentParent)) {
          currentParent.total_inr = currentParent.payments.reduce((sum, p) => sum + p.amount_inr, 0);
        }
      } else {
        bumpSkip(skipped, 'orphan_continuation_row');
      }
      continue;
    }

    let orderedAt: string;
    try {
      orderedAt = parsePetpoojaDateTime(createdRaw);
    } catch {
      bumpSkip(skipped, 'unparseable_created_date');
      currentParent = null;
      continue;
    }

    const orderType = cellStr(row[COL.ORDER_TYPE]);
    const subOrderType = cellStrOrNull(row[COL.SUB_ORDER_TYPE]);
    const { channel, table_label } = channelOf(orderType, subOrderType);

    const statusRaw = cellStr(row[COL.STATUS]);
    const status: ParsedLegacyOrder['status'] = statusRaw === 'Printed' ? 'completed' : 'cancelled';

    const phoneRaw = row[COL.CUSTOMER_PHONE];
    const customerPhone = normalizeLegacyPhone(phoneRaw);
    const customerPhoneRaw = cellStr(phoneRaw);

    const paymentType = cellStr(row[COL.PAYMENT_TYPE]);
    const paymentDescription = cellStr(row[COL.PAYMENT_DESCRIPTION]);
    const grandTotal = cellNum(row[COL.GRAND_TOTAL]);
    const isPartPayment = paymentType.includes('Part Payment');

    const itemsText = cellStr(row[COL.ITEMS]);

    const order: ParsedLegacyOrder = {
      source: 'petpooja',
      bill_no: billNo,
      fiscal_year: fiscalYearOf(orderedAt),
      ordered_at: orderedAt,
      client_order_id: cellStrOrNull(row[COL.CLIENT_ORDER_ID]),
      order_type: orderType,
      sub_order_type: subOrderType,
      channel,
      table_label,
      customer_name: cellStr(row[COL.CUSTOMER_NAME]),
      customer_phone: customerPhone,
      customer_phone_raw: customerPhoneRaw,
      customer_address: cellStr(row[COL.CUSTOMER_ADDRESS]),
      customer_gstin: cellStr(row[COL.GSTIN]),
      items_text: itemsText,
      subtotal_inr: cellNum(row[COL.MY_AMOUNT]),
      discount_inr: cellNum(row[COL.TOTAL_DISCOUNT]),
      delivery_charge_inr: cellNum(row[COL.DELIVERY_CHARGE]),
      container_charge_inr: cellNum(row[COL.CONTAINER_CHARGE]),
      tax_inr: cellNum(row[COL.TOTAL_TAX]),
      round_off_inr: cellNum(row[COL.ROUND_OFF]),
      total_inr: grandTotal,
      payment_type: paymentType,
      payments: [{ method: paymentType, amount_inr: grandTotal }] as LegacyPayment[],
      status,
      raw: rawFromRow(row),
      items: buildItems(itemsText, menu),
    };

    if (isPartPayment) {
      order.payments = [];
      const parsedTotal = parseTotalFromDescription(paymentDescription);
      if (parsedTotal === null) {
        fallbackTotal.add(order);
        order.total_inr = 0; // patched as continuation rows arrive
      } else {
        order.total_inr = parsedTotal;
      }
    }

    orders.push(order);
    currentParent = order;
  }

  return { orders, skipped: [...skipped].map(([reason, count]) => ({ reason, count })) };
}

/**
 * Keys a legacy bill by `bill_no` + the *instant* `ordered_at` names, not by
 * its string spelling. `ordered_at` round-trips through Postgres/PostgREST,
 * which renders timestamptz back out in UTC (e.g.
 * '2026-09-25T17:30:56+00:00') — a different string than the
 * '2026-09-25T23:00:56+05:30' this module produces for the same instant, so
 * comparing the raw strings silently never matches. `Date.parse` normalizes
 * both: it accepts a colon or no-colon offset and any fractional-second
 * precision, which covers every form PostgREST is known to emit.
 *
 * Throws if `orderedAt` doesn't parse, so a malformed timestamp fails loudly
 * (as `NaN\0...`) rather than silently colliding with every other malformed
 * row.
 */
export function legacyOrderKey(billNo: string, orderedAt: string): string {
  const instant = Date.parse(orderedAt);
  if (Number.isNaN(instant)) {
    throw new Error(`legacyOrderKey: unparseable ordered_at: ${JSON.stringify(orderedAt)}`);
  }
  return `${billNo}\u0000${instant}`;
}

/** Dedupes on `bill_no + ordered_at` (the export files overlap); first
 * occurrence wins. */
export function dedupeOrders(orders: ParsedLegacyOrder[]): { orders: ParsedLegacyOrder[]; duplicates: number } {
  const seen = new Set<string>();
  const kept: ParsedLegacyOrder[] = [];
  let duplicates = 0;

  for (const order of orders) {
    const key = legacyOrderKey(order.bill_no, order.ordered_at);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    kept.push(order);
  }

  return { orders: kept, duplicates };
}
