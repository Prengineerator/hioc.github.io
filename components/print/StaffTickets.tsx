// Staff 80mm print tickets (KOT-1 kitchen ticket · KOT-2 receipt & token slip).
// Pure presentational Server Components — no client JS, no data fetching. The
// print page loads the order (getStaffPrintOrder) and picks the ticket; auto-
// printing is handled by the sibling <AutoPrint/> island. Layouts model the
// existing customer receipt (app/order/[id]/receipt) but narrowed to ~80mm and
// forced to black ink for thermal paper. Money never appears on the KOT.

import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { CAFE_NAME, CAFE_ADDRESS, CAFE_PHONE_DISPLAY } from '@/lib/constants';
import { BUSINESS } from '@/lib/legal';
import type { StaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';
import {
  ORDER_TYPE_LABEL,
  PAYMENT_BANNER_LABEL,
  formatIstDateTime,
  formatIstDateShort,
} from '@/lib/print/labels';
import { BRAND_NAME_EN, BRAND_NAME_HI } from '@/lib/print/brandHeader';
import { DEFAULT_KOT_ROUTING, splitKotItems, type KotSlip } from '@/lib/print/kotRouting';
import { describeOrderPayment } from '@/lib/orders/paymentLabel';

function Divider() {
  return <div className="my-3 border-t border-dashed border-black" />;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span>{label}</span>
      <span className="text-right font-bold">{value}</span>
    </div>
  );
}

function BillRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** A meta line with two independent values on it — "Date: … | Dine-in",
 * "Cashier: … | Bill No.: …" — unlike `MetaRow` (one label, one value),
 * both sides here are already-composed strings. */
function TwoCol({ left, right }: { left: string; right: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span>{left}</span>
      <span className="text-right">{right}</span>
    </div>
  );
}

/** ₹ formatted to 2 decimals, matching the reference bill ("₹290.00"). The
 * ESC/POS side keeps its own ASCII-safe "Rs. 290.00" (formatMoney in
 * lib/print/ticketModel.ts) — this is the HTML-only, ₹-glyph equivalent. */
function money(amountInr: number): string {
  return `₹${amountInr.toFixed(2)}`;
}

/**
 * The item table's Price column: `line_total_inr / quantity`, NOT the raw
 * `price_inr_snapshot` field — mirrors `unitPriceInclAddons` in
 * lib/print/ticketModel.ts (see its comment for why: deriving Price FROM
 * Amount, rather than printing the snapshot next to it, is what guarantees
 * `Qty × Price = Amount` on-screen too). Never divides by zero — `quantity`
 * is `>= 1` for every real order line.
 */
function unitPriceInclAddons(item: { price_inr_snapshot: number; line_total_inr: number; quantity: number }): number {
  return item.quantity > 0 ? item.line_total_inr / item.quantity : item.price_inr_snapshot;
}

// The item table's column template — No. / Item / Qty. / Price / Amount —
// shared by the header row and every item row so they line up. Unlike the
// ESC/POS renderer (lib/print/escpos.ts's layoutColumns), the HTML grid
// never needs to drop the Price column: the browser has as much width as
// the page gives it, not a hard 32-character budget.
const ITEM_GRID_COLS = 'grid-cols-[1.5rem_1fr_2.25rem_3.25rem_3.5rem]';

function ItemHeaderRow() {
  return (
    <div className={`grid ${ITEM_GRID_COLS} gap-1 text-[11px] font-bold`}>
      <span>No.</span>
      <span>Item</span>
      <span className="text-right">Qty.</span>
      <span className="text-right">Price</span>
      <span className="text-right">Amount</span>
    </div>
  );
}

interface AddonForLine {
  group_name_snapshot: string;
  option_name_snapshot: string;
  price_inr_snapshot: number;
}

/** A rupee amount with no trailing zeros when it's whole, otherwise 2
 * decimals — mirrors lib/print/ticketModel.ts's `formatUnits` so "1x40 = 40"
 * reads the same on-screen as it prints. Rounds to the nearest paise first
 * so float multiplication (qty * unit price) can't leave a stray
 * `40.00000000001`. */
function formatUnits(amountInr: number): string {
  const rounded = Math.round(amountInr * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2);
}

/**
 * Addon lines, grouped by `group_name_snapshot` — mirrors `addonsLines` in
 * lib/print/ticketModel.ts so the printed KOT/receipt and this HTML mirror
 * can't drift on what the group-name fix actually renders.
 *
 * KOT (`withPrice: false`, money-free, keeps the "+ " marker): one line per
 * group, options comma-joined — "+ Milk: Oat, Extra shot".
 *
 * Receipt (`withPrice: true`, no leading "+ "): free options in a group
 * still share one plain comma-joined line ("Sugar: Normal"), but each
 * PRICED option gets its own line — "Choose Milk: Almond - 1x40 = 40"
 * (qty = `opts.itemQuantity`, the parent item's quantity; unit price;
 * qty × unit price) — so a long option name still wraps cleanly instead of
 * one very long comma list.
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

// Devanagari text needs a font that actually ships those glyphs — the app's
// default (DM Sans, Latin-only) doesn't. app/layout.tsx (the root layout this
// page inherits — see app/staff-print/[id]/[type]/page.tsx's own comment on
// why) declares this CSS variable via next/font/google
// (lib/print/devanagariFont.ts); 'Nirmala UI'/'Mangal' are the Windows-bundled
// Devanagari fallbacks in case that variable is ever unavailable.
const DEVANAGARI_FONT_STACK = "var(--font-noto-devanagari), 'Nirmala UI', 'Mangal', sans-serif";

// Brand header for receipts and token slips (NOT the KOT — see KotTicket
// below): the logo (public/images/logo-black.png) centered above, then
// "हाईओक" and "HIOC." side by side on one row — Hindi at the left edge,
// English at the right edge of the printable width, sharing a baseline.
// Black art prints cleanly on the 80mm thermal; a plain <img> is used (not
// next/image) for print reliability. Mirrors the raster header
// lib/print/brandHeaderRaster.ts's `computeHeaderLayout` draws for the
// ESC/POS raw-print path (side-by-side at both "corners", falling back to a
// stacked/centered pair only when the two wouldn't fit — that fallback is a
// raster-canvas concern the fixed-width HTML ticket doesn't need to mirror),
// and lib/print/brandHeader.ts is the shared source for both strings.
function BrandHeader() {
  return (
    <div className="mx-auto mb-1 flex flex-col items-center gap-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/images/logo-black.png"
        alt={CAFE_NAME}
        className="h-auto w-[55%] max-w-[44mm]"
      />
      <div className="flex w-full items-baseline justify-between px-2">
        <span className="text-lg leading-tight" style={{ fontFamily: DEVANAGARI_FONT_STACK }}>
          {BRAND_NAME_HI}
        </span>
        <span className="text-sm font-bold leading-tight">{BRAND_NAME_EN}</span>
      </div>
    </div>
  );
}

// --- KOT-1 — Kitchen Order Ticket -------------------------------------------
// Qty × name (variant) + addons + notes. NO prices, NO totals. Voided lines
// print struck-through so the kitchen sees the correction on a reprint.
//
// With KOT counters configured (lib/print/kotRouting.ts) this renders one
// slip per counter, each on its own printed page — a thermal driver set to
// cut after each page cuts them apart, mirroring the `cut` blocks the ESC/POS
// path (lib/print/ticketModel.ts buildKotBlocks) sends.
export function KotTicket({ order }: { order: StaffPrintOrder }) {
  const slips = splitKotItems(order.items, order.kot_categories ?? {}, order.kot_routing ?? DEFAULT_KOT_ROUTING);
  return (
    <div className="font-sans text-black">
      {slips.map((slip, index) => (
        <div
          key={`${slip.kind}-${slip.title ?? 'kot'}`}
          className={index < slips.length - 1 ? 'print:break-after-page' : undefined}
        >
          <KotSlipView order={order} slip={slip} index={index} total={slips.length} />
          {index < slips.length - 1 ? (
            <p className="my-4 border-t-2 border-dashed border-black pt-1 text-center text-[10px] uppercase tracking-widest print:hidden">
              cut here
            </p>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function KotSlipView({
  order,
  slip,
  index,
  total,
}: {
  order: StaffPrintOrder;
  slip: KotSlip<StaffPrintOrder['items'][number]>;
  index: number;
  total: number;
}) {
  const isDineIn = order.order_type === 'dine_in';
  return (
    <>
      <div className="text-center">
        {order.kot_addition ? <p className="text-lg font-bold uppercase">** Added items **</p> : null}
        {slip.title !== null ? (
          <>
            <p className="text-lg font-bold uppercase">{slip.title}</p>
            <p className="text-xs">
              KOT {index + 1} of {total}
            </p>
          </>
        ) : (
          <p className="text-sm font-bold uppercase tracking-[0.2em]">Kitchen Order</p>
        )}
        <p className="mt-1 text-lg font-bold">{formatOrderNumber(order.order_number)}</p>
      </div>

      <Divider />

      <div className="text-sm">
        {isDineIn ? (
          <p className="text-base font-bold">Table: {order.table_label || '—'}</p>
        ) : (
          <p className="text-base font-bold">Token: {order.pickup_code || '—'}</p>
        )}
        <p className="text-xs">{ORDER_TYPE_LABEL[order.order_type] ?? order.order_type}</p>
        <p className="text-xs">{formatIstDateTime(order.created_at)}</p>
      </div>

      <Divider />

      <ul className="flex flex-col gap-2 text-sm">
        {slip.items.map((item) => (
          <li key={item.id} className={item.voided ? 'line-through' : ''}>
            <p className="font-bold">
              {item.quantity} × {item.name_snapshot}
              {item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : ''}
              {item.voided ? '  [VOID]' : ''}
            </p>
            {addonsLines(item.addons, { withPrice: false }).map((line) => (
              <p key={line} className="pl-4 text-xs">
                {line}
              </p>
            ))}
            {item.special_instructions ? (
              <p className="pl-4 text-xs italic">Note: {item.special_instructions}</p>
            ) : null}
          </li>
        ))}
      </ul>

      {order.notes ? (
        <>
          <Divider />
          <p className="text-xs italic">Order note: {order.notes}</p>
        </>
      ) : null}
    </>
  );
}

// --- KOT-2 — Receipt --------------------------------------------------------
// Modelled on the café's previous POS (Petpooja) paper bill: a PAID/UNPAID
// banner, "RETAIL INVOICE", legal name/address/phone/GSTIN, customer details,
// a Date/Type + Cashier/Bill No. + Table-or-Token meta block, an item table
// (CSS grid — No./Item/Qty./Price/Amount, mirroring lib/print/ticketModel.ts
// buildReceiptBlocks' `columns` blocks 1:1 so the on-screen ticket and the
// ESC/POS print can't drift on content), totals ending in a bold Grand Total,
// payment method, customer notes, loyalty points, and the FSSAI/tagline
// footer. Money is display-only from the order's server-stored fields —
// nothing is computed here.
export function ReceiptTicket({ order }: { order: StaffPrintOrder }) {
  const isDineIn = order.order_type === 'dine_in';
  const activeItems = order.items.filter((i) => !i.voided);
  const total = order.total_inr ?? order.subtotal_inr;
  const discountLabel = order.coupon_code ? `Discount (${order.coupon_code})` : 'Discount';
  const points = order.points_earned ?? 0;
  const redeemed = order.points_redeemed ?? 0;
  const totalQty = activeItems.reduce((sum, i) => sum + i.quantity, 0);
  const billNo = formatOrderNumber(order.order_number);
  const hasPointsRows = redeemed > 0 || points > 0 || (order.points_balance !== null && order.points_balance !== undefined);

  return (
    <div className="font-sans text-black">
      <div className="text-center">
        <BrandHeader />
        <p className="mt-1 text-sm font-bold">
          {PAYMENT_BANNER_LABEL[order.payment_status] ?? order.payment_status.toUpperCase()}
        </p>
        <p className="text-[11px]">RETAIL INVOICE</p>
        <p className="text-xs font-bold">{BUSINESS.legalName}</p>
        <p className="text-[11px] leading-tight">{CAFE_ADDRESS}</p>
        <p className="text-[11px]">Phone No- {CAFE_PHONE_DISPLAY}</p>
        {BUSINESS.gstin ? <p className="text-[11px]">GST No-{BUSINESS.gstin}</p> : null}
      </div>

      {order.customer_name || order.customer_phone ? (
        <>
          <Divider />
          <div className="flex flex-col gap-0.5 text-xs">
            {order.customer_name ? <p>Name: {order.customer_name}</p> : null}
            {order.customer_phone ? <p>Phone: {order.customer_phone}</p> : null}
          </div>
        </>
      ) : null}

      <Divider />

      <div className="flex flex-col gap-0.5 text-xs">
        <TwoCol
          left={`Date: ${formatIstDateShort(order.created_at)}`}
          right={ORDER_TYPE_LABEL[order.order_type] ?? order.order_type}
        />
        {order.cashier_name ? (
          <TwoCol left={`Cashier: ${order.cashier_name}`} right={`Bill No.: ${billNo}`} />
        ) : (
          <MetaRow label="Bill No." value={billNo} />
        )}
        {isDineIn && order.table_label ? (
          <MetaRow label="Table" value={order.table_label} />
        ) : !isDineIn && order.pickup_code ? (
          <MetaRow label="Token No." value={order.pickup_code} />
        ) : null}
      </div>

      <Divider />

      <div className="flex flex-col gap-1.5 text-xs">
        <ItemHeaderRow />
        <div className="border-t border-black" />
        {activeItems.map((item, index) => (
          <div key={item.id} className={`grid ${ITEM_GRID_COLS} items-start gap-x-1 gap-y-0.5`}>
            <span>{index + 1}</span>
            <span>
              {item.name_snapshot}
              {item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : ''}
            </span>
            <span className="text-right">{item.quantity}</span>
            <span className="text-right">{unitPriceInclAddons(item).toFixed(2)}</span>
            <span className="text-right font-bold">{item.line_total_inr.toFixed(2)}</span>
            {addonsLines(item.addons, { withPrice: true, itemQuantity: item.quantity }).length > 0 ||
            item.special_instructions ? (
              <div className="col-start-2 col-end-6 flex flex-col gap-0.5 text-[11px]">
                {addonsLines(item.addons, { withPrice: true, itemQuantity: item.quantity }).map((line) => (
                  <p key={line}>{line}</p>
                ))}
                {item.special_instructions ? <p className="italic">Note: {item.special_instructions}</p> : null}
              </div>
            ) : null}
          </div>
        ))}
      </div>

      <Divider />

      <div className="flex flex-col gap-1 text-xs">
        <BillRow label="Total Qty" value={String(totalQty)} />
        <BillRow label="Sub Total" value={money(order.subtotal_inr)} />
        {order.discount_inr > 0 ? <BillRow label={discountLabel} value={`(${money(order.discount_inr)})`} /> : null}
        {order.tax_inr > 0 ? <BillRow label="GST" value={money(order.tax_inr)} /> : null}
        {order.packaging_inr > 0 ? <BillRow label="Packaging" value={money(order.packaging_inr)} /> : null}
        <div className="mt-1 flex items-center justify-between border-t border-black pt-1 text-base font-bold">
          <span>Grand Total</span>
          <span>{money(total)}</span>
        </div>
        {order.payment_status === 'paid' && order.payment_method ? (
          <p className="text-center">
            Paid via {describeOrderPayment(order)}
          </p>
        ) : null}
      </div>

      <Divider />

      {order.notes ? (
        <>
          <p className="text-xs">Customer Notes: {order.notes}</p>
          <Divider />
        </>
      ) : null}

      {hasPointsRows ? (
        <>
          <div className="flex flex-col gap-1 text-xs">
            {/* Loyalty points — only ever populated for an order linked to a
                customer account (getStaffPrintOrder resolves all three
                best-effort from the ledger); a guest order leaves them null
                and none of these rows (or this whole block) render. */}
            {redeemed > 0 ? <BillRow label="Points redeemed" value={String(redeemed)} /> : null}
            {points > 0 ? <BillRow label="Points earned" value={String(points)} /> : null}
            {order.points_balance !== null && order.points_balance !== undefined ? (
              <BillRow label="Points balance" value={String(order.points_balance)} />
            ) : null}
          </div>
          <Divider />
        </>
      ) : null}

      <div className="text-center text-[11px]">
        <p>FSSAI Lic No. {BUSINESS.fssaiLicense}</p>
        <p>Love to get you high on Coffee!</p>
        <p>Please Visit Again!</p>
      </div>
    </div>
  );
}

// --- KOT-2 — Token slip -----------------------------------------------------
// Minimal walk-in takeaway slip: big token # (pickup_code) + item count.
export function TokenSlip({ order }: { order: StaffPrintOrder }) {
  const itemCount = order.items
    .filter((i) => !i.voided)
    .reduce((sum, i) => sum + i.quantity, 0);

  return (
    <div className="font-sans text-center text-black">
      <BrandHeader />

      <Divider />

      <p className="text-xs uppercase tracking-wide">Token</p>
      <p className="my-2 text-6xl font-bold leading-none">{order.pickup_code || '—'}</p>
      <p className="text-xs">{formatOrderNumber(order.order_number)}</p>

      <Divider />

      <p className="text-sm font-bold">
        {itemCount} item{itemCount === 1 ? '' : 's'}
      </p>
      <p className="mt-1 text-[11px]">{formatIstDateTime(order.created_at)}</p>

      <Divider />

      <p className="text-[11px]">Please wait for your token to be called.</p>
    </div>
  );
}
