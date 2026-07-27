// Staff 80mm print tickets (KOT-1 kitchen ticket · KOT-2 receipt & token slip).
// Pure presentational Server Components — no client JS, no data fetching. The
// print page loads the order (getStaffPrintOrder) and picks the ticket; auto-
// printing is handled by the sibling <AutoPrint/> island. Layouts model the
// existing customer receipt (app/order/[id]/receipt) but narrowed to ~80mm and
// forced to black ink for thermal paper. Money never appears on the KOT.

import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { CAFE_NAME, CAFE_ADDRESS, CAFE_PHONE_DISPLAY } from '@/lib/constants';
import type { StaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';

const ORDER_TYPE_LABEL: Record<string, string> = {
  takeaway: 'Takeaway',
  dine_in: 'Dine-in',
  delivery: 'Delivery',
};

const PAYMENT_LABEL: Record<string, string> = {
  unpaid: 'Pay at counter',
  payment_pending: 'Payment pending',
  paid: 'Paid',
  refunded: 'Refunded',
  partially_refunded: 'Partially refunded',
};

function formatIstDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return iso;
  }
}

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

// Brand wordmark (public/images/logo-black.png). The logo already contains the
// name, so it stands in for the text heading. Black art prints cleanly on the
// 80mm thermal; a plain <img> is used (not next/image) for print reliability.
function TicketLogo() {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/images/logo-black.png"
      alt={CAFE_NAME}
      className="mx-auto mb-1 h-auto w-[38mm] max-w-[70%]"
    />
  );
}

// --- KOT-1 — Kitchen Order Ticket -------------------------------------------
// Qty × name (variant) + addons + notes. NO prices, NO totals. Voided lines
// print struck-through so the kitchen sees the correction on a reprint.
export function KotTicket({ order }: { order: StaffPrintOrder }) {
  const isDineIn = order.order_type === 'dine_in';
  return (
    <div className="font-sans text-black">
      <div className="text-center">
        <p className="text-sm font-bold uppercase tracking-[0.2em]">Kitchen Order</p>
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
        {order.items.map((item) => (
          <li key={item.id} className={item.voided ? 'line-through' : ''}>
            <p className="font-bold">
              {item.quantity} × {item.name_snapshot}
              {item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : ''}
              {item.voided ? '  [VOID]' : ''}
            </p>
            {item.addons.length > 0 ? (
              <p className="pl-4 text-xs">
                + {item.addons.map((a) => a.option_name_snapshot).join(', ')}
              </p>
            ) : null}
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
    </div>
  );
}

// --- KOT-2 — Receipt --------------------------------------------------------
// Itemized bill (non-voided lines) with GST breakup, payment method, order #,
// table/token, and loyalty points earned when available. Money is display-only
// from the order's server-stored fields — nothing is computed here.
export function ReceiptTicket({ order }: { order: StaffPrintOrder }) {
  const isDineIn = order.order_type === 'dine_in';
  const activeItems = order.items.filter((i) => !i.voided);
  const total = order.total_inr ?? order.subtotal_inr;
  const discountLabel = order.coupon_code ? `Discount (${order.coupon_code})` : 'Discount';
  const points = order.points_earned ?? 0;

  return (
    <div className="font-sans text-black">
      <div className="text-center">
        <TicketLogo />
        <p className="mt-1 text-[11px] leading-tight">{CAFE_ADDRESS}</p>
        <p className="text-[11px]">{CAFE_PHONE_DISPLAY}</p>
      </div>

      <Divider />

      <div className="flex flex-col gap-0.5 text-xs">
        <MetaRow label="Order" value={formatOrderNumber(order.order_number)} />
        <MetaRow label="Date" value={formatIstDateTime(order.created_at)} />
        <MetaRow label="Type" value={ORDER_TYPE_LABEL[order.order_type] ?? order.order_type} />
        {isDineIn && order.table_label ? <MetaRow label="Table" value={order.table_label} /> : null}
        {!isDineIn && order.pickup_code ? <MetaRow label="Token" value={order.pickup_code} /> : null}
        {order.customer_name ? <MetaRow label="Customer" value={order.customer_name} /> : null}
        {order.customer_phone ? <MetaRow label="Phone" value={order.customer_phone} /> : null}
      </div>

      <Divider />

      <ul className="flex flex-col gap-2 text-xs">
        {activeItems.map((item) => (
          <li key={item.id}>
            <div className="flex items-start justify-between gap-2">
              <span>
                {item.quantity} × {item.name_snapshot}
                {item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : ''}
              </span>
              <span className="shrink-0 font-bold">₹{item.line_total_inr}</span>
            </div>
            {item.addons.length > 0 ? (
              <p className="pl-4 text-[11px]">
                + {item.addons.map((a) => a.option_name_snapshot).join(', ')}
              </p>
            ) : null}
            {item.special_instructions ? (
              <p className="pl-4 text-[11px] italic">Note: {item.special_instructions}</p>
            ) : null}
          </li>
        ))}
      </ul>

      <Divider />

      <div className="flex flex-col gap-1 text-xs">
        <BillRow label="Subtotal" value={`₹${order.subtotal_inr}`} />
        {order.tax_inr > 0 ? <BillRow label="GST" value={`₹${order.tax_inr}`} /> : null}
        {order.packaging_inr > 0 ? <BillRow label="Packaging" value={`₹${order.packaging_inr}`} /> : null}
        {order.discount_inr > 0 ? <BillRow label={discountLabel} value={`-₹${order.discount_inr}`} /> : null}
        <div className="mt-1 flex items-center justify-between border-t border-black pt-1 text-sm font-bold">
          <span>Total</span>
          <span>₹{total}</span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span>Payment</span>
          <span className="font-bold">
            {PAYMENT_LABEL[order.payment_status] ?? order.payment_status}
            {order.payment_status === 'paid' && order.payment_method
              ? ` · ${order.payment_method}`
              : ''}
          </span>
        </div>
      </div>

      {points > 0 ? (
        <>
          <Divider />
          <p className="text-center text-[11px] font-bold">
            You earned {points} loyalty point{points === 1 ? '' : 's'}
          </p>
        </>
      ) : null}

      <Divider />

      <p className="text-center text-[11px]">Thank you for your order! · {CAFE_NAME}</p>
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
      <TicketLogo />

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
