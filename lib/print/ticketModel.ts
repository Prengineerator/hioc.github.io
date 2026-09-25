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
import type { TicketDoc, TicketBlock } from '@/lib/print/ticketDoc';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { CAFE_NAME, CAFE_ADDRESS, CAFE_PHONE_DISPLAY } from '@/lib/constants';
import { BUSINESS } from '@/lib/legal';
import { ORDER_TYPE_LABEL, PAYMENT_LABEL, formatIstDateTime } from '@/lib/print/labels';

// Thermal code pages (the ones ESC/POS printers actually ship with) have no
// ₹ glyph — it prints as a mangled box or a wrong currency sign depending on
// the code page. The HTML ticket keeps ₹ (a browser renders it fine); this is
// the one place money gets the ASCII-safe "Rs. 120" form for print.
function formatMoney(amountInr: number): string {
  return `Rs. ${amountInr}`;
}

function addonsLine(addons: { option_name_snapshot: string }[]): string | null {
  if (addons.length === 0) return null;
  return `+ ${addons.map((a) => a.option_name_snapshot).join(', ')}`;
}

function itemLabel(item: { quantity: number; name_snapshot: string; variant_label_snapshot: string }): string {
  const variant = item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : '';
  return `${item.quantity} × ${item.name_snapshot}${variant}`;
}

// --- KOT-1 — Kitchen Order Ticket -------------------------------------------
// Mirrors components/print/StaffTickets.tsx `KotTicket`. Qty × name (variant)
// + addons + notes; voided lines carry `strike: true` instead of being
// dropped, so a reprint still shows the kitchen what was cancelled. NO money.
function buildKotBlocks(order: StaffPrintOrder): TicketBlock[] {
  const isDineIn = order.order_type === 'dine_in';
  const blocks: TicketBlock[] = [
    { kind: 'text', text: 'KITCHEN ORDER', align: 'center', bold: true },
    { kind: 'text', text: formatOrderNumber(order.order_number), align: 'center', bold: true },
    { kind: 'divider' },
    isDineIn
      ? { kind: 'text', text: `Table: ${order.table_label || '—'}`, align: 'center', bold: true, size: 'large' }
      : { kind: 'text', text: `Token: ${order.pickup_code || '—'}`, align: 'center', bold: true, size: 'large' },
    { kind: 'text', text: ORDER_TYPE_LABEL[order.order_type] ?? order.order_type, align: 'center' },
    { kind: 'text', text: formatIstDateTime(order.created_at), align: 'center' },
    { kind: 'divider' },
  ];

  for (const item of order.items) {
    blocks.push({ kind: 'text', text: itemLabel(item), bold: true, strike: item.voided });
    const addons = addonsLine(item.addons);
    if (addons) {
      blocks.push({ kind: 'text', text: `  ${addons}` });
    }
    if (item.special_instructions) {
      blocks.push({ kind: 'text', text: `  Note: ${item.special_instructions}` });
    }
  }

  if (order.notes) {
    blocks.push({ kind: 'divider' });
    blocks.push({ kind: 'text', text: `Order note: ${order.notes}` });
  }

  return blocks;
}

// --- KOT-2 — Receipt --------------------------------------------------------
// Mirrors `ReceiptTicket`. Non-voided items only, with line totals, GST
// breakup, discount (coupon-labelled), bold total, payment line and points
// earned. Starts with the brandHeader placeholder — logo + "हाईओक" / "HIOC."
// — resolved to a raster image by printExecutor.ts's resolveBrandHeader; see
// ticketDoc.ts for the fallback if that resolution ever fails.
function buildReceiptBlocks(order: StaffPrintOrder): TicketBlock[] {
  const isDineIn = order.order_type === 'dine_in';
  const activeItems = order.items.filter((i) => !i.voided);
  const total = order.total_inr ?? order.subtotal_inr;
  const discountLabel = order.coupon_code ? `Discount (${order.coupon_code})` : 'Discount';
  const points = order.points_earned ?? 0;

  const blocks: TicketBlock[] = [
    { kind: 'brandHeader' },
    { kind: 'text', text: CAFE_ADDRESS, align: 'center' },
    { kind: 'text', text: CAFE_PHONE_DISPLAY, align: 'center' },
  ];
  if (BUSINESS.gstin) {
    blocks.push({ kind: 'text', text: `GSTIN: ${BUSINESS.gstin}`, align: 'center' });
  }

  blocks.push({ kind: 'divider' });
  blocks.push({ kind: 'row', left: 'Order', right: formatOrderNumber(order.order_number) });
  blocks.push({ kind: 'row', left: 'Date', right: formatIstDateTime(order.created_at) });
  blocks.push({ kind: 'row', left: 'Type', right: ORDER_TYPE_LABEL[order.order_type] ?? order.order_type });
  if (isDineIn && order.table_label) {
    blocks.push({ kind: 'row', left: 'Table', right: order.table_label });
  }
  if (!isDineIn && order.pickup_code) {
    blocks.push({ kind: 'row', left: 'Token', right: order.pickup_code });
  }
  if (order.customer_name) {
    blocks.push({ kind: 'row', left: 'Customer', right: order.customer_name });
  }
  if (order.customer_phone) {
    blocks.push({ kind: 'row', left: 'Phone', right: order.customer_phone });
  }

  blocks.push({ kind: 'divider' });
  for (const item of activeItems) {
    blocks.push({ kind: 'row', left: itemLabel(item), right: formatMoney(item.line_total_inr) });
    const addons = addonsLine(item.addons);
    if (addons) {
      blocks.push({ kind: 'text', text: `  ${addons}` });
    }
    if (item.special_instructions) {
      blocks.push({ kind: 'text', text: `  Note: ${item.special_instructions}` });
    }
  }

  blocks.push({ kind: 'divider' });
  blocks.push({ kind: 'row', left: 'Subtotal', right: formatMoney(order.subtotal_inr) });
  if (order.tax_inr > 0) {
    blocks.push({ kind: 'row', left: 'GST', right: formatMoney(order.tax_inr) });
  }
  if (order.packaging_inr > 0) {
    blocks.push({ kind: 'row', left: 'Packaging', right: formatMoney(order.packaging_inr) });
  }
  if (order.discount_inr > 0) {
    blocks.push({ kind: 'row', left: discountLabel, right: `-${formatMoney(order.discount_inr)}` });
  }
  blocks.push({ kind: 'row', left: 'Total', right: formatMoney(total), bold: true });

  const paymentValue =
    (PAYMENT_LABEL[order.payment_status] ?? order.payment_status) +
    (order.payment_status === 'paid' && order.payment_method ? ` · ${order.payment_method}` : '');
  blocks.push({ kind: 'row', left: 'Payment', right: paymentValue });

  if (points > 0) {
    blocks.push({ kind: 'divider' });
    blocks.push({
      kind: 'text',
      text: `You earned ${points} loyalty point${points === 1 ? '' : 's'}`,
      align: 'center',
      bold: true,
    });
  }

  blocks.push({ kind: 'divider' });
  blocks.push({ kind: 'text', text: `Thank you for your order! · ${CAFE_NAME}`, align: 'center' });

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
