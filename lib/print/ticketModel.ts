// PRN-3 — pure order → TicketDoc builder.
//
// This is the single source of ticket *content*: the HTML staff tickets
// (components/print/StaffTickets.tsx) and the ESC/POS renderer
// (lib/print/escpos.ts) both start from the same TicketDoc this module
// produces, so the printed paper and the on-screen ticket can't drift.
//
// Pure: no Supabase, no 'server-only'. `StaffPrintOrder` is imported as a
// type only — the module it lives in is server-only, but a type import is
// erased at compile time, so this file stays safely importable from the
// (browser-capable) ESC/POS path too.

import type { StaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';
import type { PrintType } from '@/lib/staff/autoPrint';
import type { TicketDoc, TicketBlock, TicketColumn } from '@/lib/print/ticketDoc';
import { DEFAULT_KOT_ROUTING, splitKotItems, type KotSlip } from '@/lib/print/kotRouting';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { CAFE_ADDRESS, CAFE_PHONE_DISPLAY } from '@/lib/constants';
import { BUSINESS } from '@/lib/legal';
import {
  ORDER_TYPE_LABEL,
  PAYMENT_BANNER_LABEL,
  PAYMENT_METHOD_LABEL,
  formatIstDateTime,
  formatIstDateShort,
} from '@/lib/print/labels';

// Thermal code pages (the ones ESC/POS printers actually ship with) have no
// ₹ glyph — it prints as a mangled box or a wrong currency sign depending on
// the code page. The HTML ticket keeps ₹ (a browser renders it fine); this is
// the one place money gets the ASCII-safe "Rs. 120.00" form for print, always
// to two decimals (the reference Petpooja bill this receipt is modelled on
// keeps two decimals throughout the item table and totals).
function formatMoney(amountInr: number): string {
  return `Rs. ${amountInr.toFixed(2)}`;
}

interface AddonForLine {
  group_name_snapshot: string;
  option_name_snapshot: string;
  price_inr_snapshot: number;
}

/** A rupee amount with no trailing zeros when it's whole, otherwise 2
 * decimals — "1x40 = 40" reads cleaner on the receipt's addon lines than
 * "1x40.00 = 40.00" when there's no paise involved anywhere in it. Rounds to
 * the nearest paise first so float multiplication (qty * unit price) can't
 * leave a `40.00000000001` that fails the whole-number check. */
function formatUnits(amountInr: number): string {
  const rounded = Math.round(amountInr * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

/**
 * Addon lines, grouped by `group_name_snapshot` (kept in the order each
 * group's first option appears — Map insertion order — matching
 * item.addons' own order). PRN-7 field report: the KOT/receipt used to print
 * just "+ Normal" with no indication of what "Normal" was an option OF.
 *
 * KOT (`withPrice: false`, money-free, keeps the "+ " marker the kitchen is
 * used to): one line per group, options comma-joined —
 * "+ Milk: Oat, Extra shot".
 *
 * Receipt (`withPrice: true`, no leading "+ "): free options in a group
 * still share one plain comma-joined line ("Sugar: Normal"), but each
 * PRICED option gets its own line spelling out the math —
 * "Choose Milk: Almond - 1x40 = 40" (qty = `opts.itemQuantity`, the parent
 * item's quantity; unit price; qty × unit price) — one line per priced
 * option rather than joining several onto one, so a long option name still
 * wraps cleanly instead of producing one very long comma list.
 */
function addonsLines(addons: AddonForLine[], opts: { withPrice: boolean; itemQuantity?: number }): string[] {
  if (addons.length === 0) return [];
  const groups = new Map<string, AddonForLine[]>();
  for (const addon of addons) {
    const list = groups.get(addon.group_name_snapshot);
    if (list) {
      list.push(addon);
    } else {
      groups.set(addon.group_name_snapshot, [addon]);
    }
  }

  const lines: string[] = [];
  for (const [group, options] of groups) {
    if (!opts.withPrice) {
      lines.push(`+ ${group}: ${options.map((o) => o.option_name_snapshot).join(', ')}`);
      continue;
    }
    const free = options.filter((o) => o.price_inr_snapshot <= 0);
    const priced = options.filter((o) => o.price_inr_snapshot > 0);
    if (free.length > 0) {
      lines.push(`${group}: ${free.map((o) => o.option_name_snapshot).join(', ')}`);
    }
    const qty = opts.itemQuantity ?? 1;
    for (const o of priced) {
      lines.push(
        `${group}: ${o.option_name_snapshot} - ${qty}x${formatUnits(o.price_inr_snapshot)} = ${formatUnits(qty * o.price_inr_snapshot)}`,
      );
    }
  }
  return lines;
}

function itemLabel(item: { quantity: number; name_snapshot: string; variant_label_snapshot: string }): string {
  const variant = item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : '';
  return `${item.quantity} × ${item.name_snapshot}${variant}`;
}

/** Item name + variant with no quantity prefix — the receipt's item table
 * has its own Qty. column, unlike the KOT's single "2 × Name" line. */
function itemDisplayName(item: { name_snapshot: string; variant_label_snapshot: string }): string {
  const variant = item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : '';
  return `${item.name_snapshot}${variant}`;
}

/**
 * The item table's Price column: `line_total_inr / quantity`, NOT the raw
 * `price_inr_snapshot` field. `resolveOrderLines` (lib/orders/lines.ts)
 * already bakes selected add-ons into `price_inr_snapshot` (`unitPrice =
 * variant.price_inr + addonsTotal`, then `line_total_inr = unitPrice *
 * quantity`), so the two should already agree — but deriving Price FROM
 * Amount here, rather than printing the snapshot field next to it, is what
 * actually GUARANTEES `Qty × Price = Amount` on the printed table (the
 * reference Petpooja bill's own invariant), with the addon line beneath it
 * only explaining the breakdown, not looking like an extra, unaccounted-for
 * charge. Never divides by zero — `quantity` is `>= 1` for every real order
 * line (lib/orders/lines.ts `parseItems`).
 */
function unitPriceInclAddons(item: { price_inr_snapshot: number; line_total_inr: number; quantity: number }): number {
  return item.quantity > 0 ? item.line_total_inr / item.quantity : item.price_inr_snapshot;
}

// The receipt's item table columns: No. / Item / Qty. / Price / Amount.
// `weight`/`minWidth` are tuned so the Price column survives at 48 cols
// (80mm) but is the one `optional` column `layoutColumns` (lib/print/
// escpos.ts) drops at 32 cols (58mm) when the other four don't leave it
// enough room — see that module for the actual per-width layout math.
function itemColumns(cells: { no: string; name: string; qty: string; price: string; amount: string }): TicketColumn[] {
  return [
    // minWidths are floored to fit their own header label ("No.", "Qty.",
    // "Price", "Amount") — wrapText hard-breaks any text (including a
    // header) that doesn't fit its column, so a column narrower than its
    // own heading would wrap "No." into "No" / "." on two lines.
    { text: cells.no, weight: 2, align: 'left', minWidth: 3 },
    { text: cells.name, weight: 18, align: 'left', minWidth: 14 },
    { text: cells.qty, weight: 4, align: 'right', minWidth: 4 },
    { text: cells.price, weight: 7, align: 'right', minWidth: 6, optional: true },
    { text: cells.amount, weight: 7, align: 'right', minWidth: 6 },
  ];
}

// The No. column is always exactly 3 wide (its `minWidth` above) plus the
// 1-space gap `layoutColumns` puts before the next column — at BOTH 48 and
// 32 cols, since its weight (2, the smallest of the five) never earns it
// any of the leftover width. So the Item column always starts at char 4,
// and addon/note lines hang-indent by that same amount (`text` block's
// `indent`, lib/print/ticketDoc.ts) to sit directly under it, on every
// wrapped line, not just the first.
const ITEM_COLUMN_INDENT = 4;

// --- KOT-1 — Kitchen Order Ticket -------------------------------------------
// Mirrors components/print/StaffTickets.tsx `KotTicket`. Qty × name (variant)
// + addons + notes; voided lines carry `strike: true` instead of being
// dropped, so a reprint still shows the kitchen what was cancelled. NO money.
//
// With KOT counters configured (lib/print/kotRouting.ts) the ticket is one
// slip per counter, each headed by the counter's name and separated by a
// `cut` block; with none, it is the single ticket it always was.
function buildKotBlocks(order: StaffPrintOrder): TicketBlock[] {
  const slips = splitKotItems(order.items, order.kot_categories ?? {}, order.kot_routing ?? DEFAULT_KOT_ROUTING);
  const blocks: TicketBlock[] = [];
  slips.forEach((slip, index) => {
    if (index > 0) blocks.push({ kind: 'cut' });
    blocks.push(...buildKotSlipBlocks(order, slip, index, slips.length));
  });
  return blocks;
}

function buildKotSlipBlocks(
  order: StaffPrintOrder,
  slip: KotSlip<StaffPrintOrder['items'][number]>,
  index: number,
  total: number,
): TicketBlock[] {
  const isDineIn = order.order_type === 'dine_in';
  const blocks: TicketBlock[] = [];
  if (slip.title !== null) {
    blocks.push({ kind: 'text', text: slip.title.toUpperCase(), align: 'center', bold: true, size: 'large' });
    blocks.push({ kind: 'text', text: `KOT ${index + 1} of ${total}`, align: 'center' });
  } else {
    blocks.push({ kind: 'text', text: 'KITCHEN ORDER', align: 'center', bold: true });
  }
  blocks.push(
    { kind: 'text', text: formatOrderNumber(order.order_number), align: 'center', bold: true },
    { kind: 'divider' },
    isDineIn
      ? { kind: 'text', text: `Table: ${order.table_label || '—'}`, align: 'center', bold: true, size: 'large' }
      : { kind: 'text', text: `Token: ${order.pickup_code || '—'}`, align: 'center', bold: true, size: 'large' },
    { kind: 'text', text: ORDER_TYPE_LABEL[order.order_type] ?? order.order_type, align: 'center' },
    { kind: 'text', text: formatIstDateTime(order.created_at), align: 'center' },
    { kind: 'divider' },
  );

  for (const item of slip.items) {
    blocks.push({ kind: 'text', text: itemLabel(item), bold: true, strike: item.voided });
    for (const line of addonsLines(item.addons, { withPrice: false })) {
      blocks.push({ kind: 'text', text: `  ${line}` });
    }
    if (item.special_instructions) {
      blocks.push({ kind: 'text', text: `  Note: ${item.special_instructions}` });
    }
  }

  // The order note goes on every slip: "no sugar in anything" or "pack
  // separately" matters to each counter, not just the first.
  if (order.notes) {
    blocks.push({ kind: 'divider' });
    blocks.push({ kind: 'text', text: `Order note: ${order.notes}` });
  }

  return blocks;
}

// --- KOT-2 — Receipt --------------------------------------------------------
// Mirrors `ReceiptTicket`. Modelled on the café's previous POS (Petpooja)
// paper bill: PAID/UNPAID banner, "RETAIL INVOICE", legal name + address +
// phone + GSTIN, then customer/meta/item-table/totals/points/footer blocks,
// each behind dividers, with no blank lines beyond them. Non-voided items
// only. Starts with the brandHeader placeholder — logo + "हाईओक" / "HIOC."
// — resolved to a raster image by printExecutor.ts's resolveBrandHeader; see
// ticketDoc.ts for the fallback if that resolution ever fails.
function buildReceiptBlocks(order: StaffPrintOrder): TicketBlock[] {
  const isDineIn = order.order_type === 'dine_in';
  const activeItems = order.items.filter((i) => !i.voided);
  const total = order.total_inr ?? order.subtotal_inr;
  const discountLabel = order.coupon_code ? `Discount (${order.coupon_code})` : 'Discount';
  const points = order.points_earned ?? 0;
  const redeemed = order.points_redeemed ?? 0;
  const totalQty = activeItems.reduce((sum, i) => sum + i.quantity, 0);
  const billNo = formatOrderNumber(order.order_number);

  const blocks: TicketBlock[] = [
    { kind: 'brandHeader' },
    {
      kind: 'text',
      text: PAYMENT_BANNER_LABEL[order.payment_status] ?? order.payment_status.toUpperCase(),
      align: 'center',
      bold: true,
    },
    { kind: 'text', text: 'RETAIL INVOICE', align: 'center' },
    { kind: 'text', text: BUSINESS.legalName, align: 'center', bold: true },
    { kind: 'text', text: CAFE_ADDRESS, align: 'center' },
    { kind: 'text', text: `Phone No- ${CAFE_PHONE_DISPLAY}`, align: 'center' },
  ];
  if (BUSINESS.gstin) {
    blocks.push({ kind: 'text', text: `GST No-${BUSINESS.gstin}`, align: 'center' });
  }

  if (order.customer_name || order.customer_phone) {
    blocks.push({ kind: 'divider' });
    if (order.customer_name) {
      blocks.push({ kind: 'text', text: `Name: ${order.customer_name}` });
    }
    if (order.customer_phone) {
      blocks.push({ kind: 'text', text: `Phone: ${order.customer_phone}` });
    }
  }

  blocks.push({ kind: 'divider' });
  blocks.push({
    kind: 'columns',
    columns: [
      { text: `Date: ${formatIstDateShort(order.created_at)}`, weight: 1, align: 'left', minWidth: 10 },
      { text: ORDER_TYPE_LABEL[order.order_type] ?? order.order_type, weight: 1, align: 'right', minWidth: 6 },
    ],
  });
  if (order.cashier_name) {
    blocks.push({
      kind: 'columns',
      columns: [
        { text: `Cashier: ${order.cashier_name}`, weight: 1, align: 'left', minWidth: 10 },
        { text: `Bill No.: ${billNo}`, weight: 1, align: 'right', minWidth: 10 },
      ],
    });
  } else {
    blocks.push({ kind: 'row', left: 'Bill No.', right: billNo });
  }
  if (isDineIn && order.table_label) {
    blocks.push({ kind: 'row', left: 'Table', right: order.table_label });
  } else if (!isDineIn && order.pickup_code) {
    blocks.push({ kind: 'row', left: 'Token No.', right: order.pickup_code });
  }

  blocks.push({ kind: 'divider' });
  blocks.push({
    kind: 'columns',
    bold: true,
    columns: itemColumns({ no: 'No.', name: 'Item', qty: 'Qty.', price: 'Price', amount: 'Amount' }),
  });
  blocks.push({ kind: 'divider' });

  activeItems.forEach((item, index) => {
    blocks.push({
      kind: 'columns',
      columns: itemColumns({
        no: String(index + 1),
        name: itemDisplayName(item),
        qty: String(item.quantity),
        price: unitPriceInclAddons(item).toFixed(2),
        amount: item.line_total_inr.toFixed(2),
      }),
    });
    for (const line of addonsLines(item.addons, { withPrice: true, itemQuantity: item.quantity })) {
      blocks.push({ kind: 'text', text: line, indent: ITEM_COLUMN_INDENT });
    }
    if (item.special_instructions) {
      blocks.push({ kind: 'text', text: `Note: ${item.special_instructions}`, indent: ITEM_COLUMN_INDENT });
    }
  });

  blocks.push({ kind: 'divider' });
  blocks.push({ kind: 'row', left: 'Total Qty', right: String(totalQty) });
  blocks.push({ kind: 'row', left: 'Sub Total', right: formatMoney(order.subtotal_inr) });
  if (order.discount_inr > 0) {
    blocks.push({ kind: 'row', left: discountLabel, right: `(${formatMoney(order.discount_inr)})` });
  }
  if (order.tax_inr > 0) {
    blocks.push({ kind: 'row', left: 'GST', right: formatMoney(order.tax_inr) });
  }
  if (order.packaging_inr > 0) {
    blocks.push({ kind: 'row', left: 'Packaging', right: formatMoney(order.packaging_inr) });
  }
  blocks.push({ kind: 'row', left: 'Grand Total', right: formatMoney(total), bold: true, size: 'large' });

  if (order.payment_status === 'paid' && order.payment_method) {
    blocks.push({
      kind: 'text',
      text: `Paid via ${PAYMENT_METHOD_LABEL[order.payment_method] ?? order.payment_method}`,
      align: 'center',
    });
  }

  blocks.push({ kind: 'divider' });

  if (order.notes) {
    blocks.push({ kind: 'text', text: `Customer Notes: ${order.notes}` });
    blocks.push({ kind: 'divider' });
  }

  // Loyalty points. Only ever populated for an order linked to a customer
  // account (getStaffPrintOrder resolves all three best-effort from the
  // ledger) — a guest/unlinked order leaves them null and none of these rows
  // (or the divider around them) print.
  const pointsRows: TicketBlock[] = [];
  if (redeemed > 0) {
    pointsRows.push({ kind: 'row', left: 'Points redeemed', right: String(redeemed) });
  }
  if (points > 0) {
    pointsRows.push({ kind: 'row', left: 'Points earned', right: String(points) });
  }
  if (order.points_balance !== null && order.points_balance !== undefined) {
    pointsRows.push({ kind: 'row', left: 'Points balance', right: String(order.points_balance) });
  }
  if (pointsRows.length > 0) {
    blocks.push(...pointsRows);
    blocks.push({ kind: 'divider' });
  }

  blocks.push({ kind: 'text', text: `FSSAI Lic No. ${BUSINESS.fssaiLicense}`, align: 'center' });
  blocks.push({ kind: 'text', text: 'Love to get you high on Coffee!', align: 'center' });
  blocks.push({ kind: 'text', text: 'Please Visit Again!', align: 'center' });

  return blocks;
}

// --- KOT-2 — Token slip -----------------------------------------------------
// Mirrors `TokenSlip`. Minimal walk-in takeaway slip: big token number, order
// number, item count, time, and the "wait to be called" line. Starts with the
// same brandHeader placeholder as the receipt — see buildReceiptBlocks above.
function buildTokenBlocks(order: StaffPrintOrder): TicketBlock[] {
  const itemCount = order.items.filter((i) => !i.voided).reduce((sum, i) => sum + i.quantity, 0);

  return [
    { kind: 'brandHeader' },
    { kind: 'divider' },
    { kind: 'text', text: 'Token', align: 'center' },
    { kind: 'text', text: order.pickup_code || '—', align: 'center', bold: true, size: 'large' },
    { kind: 'text', text: formatOrderNumber(order.order_number), align: 'center' },
    { kind: 'divider' },
    { kind: 'text', text: `${itemCount} item${itemCount === 1 ? '' : 's'}`, align: 'center', bold: true },
    { kind: 'text', text: formatIstDateTime(order.created_at), align: 'center' },
    { kind: 'divider' },
    { kind: 'text', text: 'Please wait for your token to be called.', align: 'center' },
  ];
}

/** Builds the printer-neutral TicketDoc for one order + ticket type. */
export function buildTicketDoc(order: StaffPrintOrder, type: PrintType): TicketDoc {
  const blocks =
    type === 'kot' ? buildKotBlocks(order) : type === 'receipt' ? buildReceiptBlocks(order) : buildTokenBlocks(order);

  return { type, orderId: order.id, blocks };
}
