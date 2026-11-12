import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ShopOrderStatus } from '@/components/shop/ShopOrderStatus';
import { isUuid } from '@/lib/api/constants';

// /shop/order/[id] — a customer's Instant Coffee order: payment, packing,
// shipping and tracking. The id (a random uuid) is the key; the page reads the
// public view from GET /api/shop/orders/[id], which leaves out the street
// address, phone and email. Not behind the shop flag: an order already paid
// must stay viewable even if the shop is switched off later.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Your Instant Coffee order',
  robots: { index: false, follow: false },
};

export default function ShopOrderPage({ params }: { params: { id: string } }) {
  if (!isUuid(params.id)) notFound();
  return (
    <div className="mx-auto max-w-2xl px-4 py-10 md:py-14">
      <ShopOrderStatus orderId={params.id} />
    </div>
  );
}
