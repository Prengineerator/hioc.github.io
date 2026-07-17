import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { CAFE_ADDRESS, CAFE_PHONE_DISPLAY, CAFE_PHONE_HREF } from '@/lib/constants';
import type { Order, OrderItem } from '@/lib/types';

export const metadata: Metadata = {
  title: 'Order Confirmation',
};

type OrderWithItems = Order & { items: OrderItem[] };

async function fetchOrder(orderId: string): Promise<OrderWithItems | null> {
  const headerList = headers();
  const host = headerList.get('host');
  const protocol = host?.startsWith('localhost') || host?.startsWith('127.0.0.1') ? 'http' : 'https';
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? `${protocol}://${host}`;

  const res = await fetch(`${baseUrl}/api/orders/${orderId}`, {
    cache: 'no-store',
  });

  if (res.status === 404) return null;
  if (!res.ok) return null;

  const data = await res.json();
  return data.order as OrderWithItems;
}

export default async function OrderConfirmationPage({
  params,
}: {
  params: { orderId: string };
}) {
  const order = await fetchOrder(params.orderId);

  if (!order) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Order Not Found</h1>
        <p className="mt-4 text-muted">
          We couldn&apos;t find that order. It may have expired or the link
          is incorrect.
        </p>
        <Link
          href="/menu"
          className="mt-6 inline-block rounded-md bg-tan px-6 py-3 font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          Back to Menu
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-charcoal md:text-3xl">
          Order #{formatOrderNumber(order.order_number)} confirmed!
        </h1>
        <p className="mt-2 text-muted">
          Thank you, {order.customer_name}! We&apos;ve received your order
          and we&apos;re getting it ready.
        </p>
      </div>

      <div className="mt-8 rounded-md border border-[#e5e5e5] bg-cream p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-bold text-charcoal">
          Order Summary
        </h2>
        <ul className="flex flex-col gap-3">
          {order.items.map((item) => (
            <li key={item.id} className="text-sm text-charcoal">
              <div className="flex items-start justify-between">
                <span>
                  {item.name_snapshot}
                  {item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : ''} ×{' '}
                  {item.quantity}
                </span>
                <span className="shrink-0 font-bold">₹{item.line_total_inr}</span>
              </div>
              {item.addons.length > 0 ? (
                <p className="mt-0.5 text-xs text-muted">
                  {item.addons.map((a) => a.option_name_snapshot).join(', ')}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex items-center justify-between border-t border-[#e5e5e5] pt-4">
          <span className="font-bold text-charcoal">Subtotal</span>
          <span className="font-bold text-tan">₹{order.subtotal_inr}</span>
        </div>
      </div>

      <p className="mt-6 text-center font-bold text-charcoal">
        Pickup Time: {order.pickup_time}
      </p>

      <p className="mt-2 text-center text-sm italic text-muted">
        Pay at the counter when you collect your order.
      </p>

      <div className="mt-8 rounded-md border border-[#e5e5e5] bg-cream p-6 text-center shadow-sm">
        <h3 className="font-bold text-charcoal">Need directions or help?</h3>
        <p className="mt-2 text-sm text-muted">{CAFE_ADDRESS}</p>
        <a
          href={CAFE_PHONE_HREF}
          className="mt-1 inline-block text-sm text-tan hover:underline"
        >
          {CAFE_PHONE_DISPLAY}
        </a>
      </div>

      <div className="mt-8 text-center">
        <Link
          href="/menu"
          className="inline-block rounded-md bg-tan px-6 py-3 font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          Back to Menu
        </Link>
      </div>
    </div>
  );
}
