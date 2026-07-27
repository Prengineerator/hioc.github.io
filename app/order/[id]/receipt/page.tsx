import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/api/constants';
import { getOrderWithCoupon } from '@/lib/orders/getOrder';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { CAFE_NAME, CAFE_ADDRESS, CAFE_PHONE_DISPLAY } from '@/lib/constants';
import { PrintButton } from './PrintButton';

// Server-rendered, print-optimized bill/receipt (CUS/PAY). Regenerated
// authoritatively from the stored order row — the same data GET /api/orders/[id]
// returns — so it's always current and needs no client fetch. The opaque uuid in
// the URL is the access control (same as the status page). Site chrome is
// print:hidden globally, so the browser's Print / Save-as-PDF yields a clean bill.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Bill' };

const PAYMENT_LABEL: Record<string, string> = {
  unpaid: 'Pay at counter',
  payment_pending: 'Payment pending',
  paid: 'Paid',
  refunded: 'Refunded',
  partially_refunded: 'Partially refunded',
};

const ORDER_TYPE_LABEL: Record<string, string> = {
  takeaway: 'Takeaway',
  dine_in: 'Dine-in',
  delivery: 'Delivery',
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

export default async function ReceiptPage({ params }: { params: { id: string } }) {
  const { id } = params;
  if (!isUuid(id)) {
    notFound();
  }

  const order = await getOrderWithCoupon(id);
  if (!order) {
    notFound();
  }

  const total = order.total_inr ?? order.subtotal_inr;
  const discountLabel = order.coupon_code ? `Discount (${order.coupon_code})` : 'Discount';

  return (
    <div className="mx-auto max-w-sm px-4 py-8 text-charcoal print:py-0 print:text-black">
      {/* On-screen actions — never printed. */}
      <div className="mb-6 flex items-center justify-between print:hidden">
        <Link href={`/order/${order.id}`} className="text-sm text-tan hover:underline">
          ← Back to order
        </Link>
        <PrintButton />
      </div>

      <div className="rounded-md border border-[#e5e5e5] bg-white p-6 shadow-sm print:border-0 print:p-0 print:shadow-none">
        {/* Store header — the wordmark logo stands in for the text name. */}
        <div className="text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/images/logo-black.png"
            alt={CAFE_NAME}
            className="mx-auto mb-1 h-auto w-40 max-w-[60%]"
          />
          <p className="mt-1 text-[11px] leading-tight text-muted print:text-black">{CAFE_ADDRESS}</p>
          <p className="text-[11px] text-muted print:text-black">{CAFE_PHONE_DISPLAY}</p>
        </div>

        <Divider />

        {/* Order meta */}
        <div className="flex flex-col gap-0.5 text-xs">
          <MetaRow label="Order" value={formatOrderNumber(order.order_number)} />
          <MetaRow label="Date" value={formatIstDateTime(order.created_at)} />
          <MetaRow label="Customer" value={order.customer_name} />
          <MetaRow label="Phone" value={order.customer_phone} />
          <MetaRow label="Type" value={ORDER_TYPE_LABEL[order.order_type] ?? order.order_type} />
          <MetaRow label="Pickup" value={order.pickup_slot_label || order.pickup_time} />
          {order.pickup_code ? <MetaRow label="Pickup code" value={order.pickup_code} /> : null}
        </div>

        <Divider />

        {/* Itemized lines */}
        <ul className="flex flex-col gap-2 text-xs">
          {order.items.map((item) => (
            <li key={item.id}>
              <div className="flex items-start justify-between gap-2">
                <span>
                  {item.quantity} × {item.name_snapshot}
                  {item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : ''}
                </span>
                <span className="shrink-0 font-bold">₹{item.line_total_inr}</span>
              </div>
              {item.addons.length > 0 ? (
                <p className="pl-4 text-[11px] text-muted print:text-black">
                  + {item.addons.map((a) => a.option_name_snapshot).join(', ')}
                </p>
              ) : null}
              {item.special_instructions ? (
                <p className="pl-4 text-[11px] italic text-muted print:text-black">
                  Note: {item.special_instructions}
                </p>
              ) : null}
            </li>
          ))}
        </ul>

        <Divider />

        {/* Bill breakup */}
        <div className="flex flex-col gap-1 text-xs">
          <BillRow label="Subtotal" value={`₹${order.subtotal_inr}`} />
          {order.tax_inr > 0 ? <BillRow label="GST" value={`₹${order.tax_inr}`} /> : null}
          {order.packaging_inr > 0 ? <BillRow label="Packaging" value={`₹${order.packaging_inr}`} /> : null}
          {order.discount_inr > 0 ? <BillRow label={discountLabel} value={`-₹${order.discount_inr}`} /> : null}
          <div className="mt-1 flex items-center justify-between border-t border-[#c9c9c9] pt-1 text-sm font-bold">
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

        <Divider />

        <p className="text-center text-[11px] text-muted print:text-black">
          Thank you for your order! · {CAFE_NAME}
        </p>
      </div>
    </div>
  );
}

function Divider() {
  return <div className="my-4 border-t border-dashed border-[#c9c9c9]" />;
}

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-muted print:text-black">{label}</span>
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
