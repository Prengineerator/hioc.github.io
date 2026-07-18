'use client';

// Order history (ACC-2) + reorder (ACC-4). Client component: fetches the
// caller's own orders from /api/account/history (server-verified session),
// and "Order again" loads a past order's lines into the cart via
// /api/account/reorder/[orderId] then routes to /checkout.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CartProvider, useCart } from '@/lib/cart/CartContext';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import { Spinner } from '@/components/ui/Spinner';
import type { OrderResponse } from '@/lib/api/orders';
import type { OrderStatus } from '@/lib/types';

const STATUS_LABEL: Record<OrderStatus, string> = {
  placed: 'Placed',
  received: 'Received',
  accepted: 'Accepted',
  preparing: 'Preparing',
  ready: 'Ready',
  completed: 'Collected',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
};

const STATUS_TONE: Record<OrderStatus, string> = {
  placed: 'text-muted',
  received: 'text-tan',
  accepted: 'text-tan',
  preparing: 'text-tan',
  ready: 'text-tan',
  completed: 'text-green-700',
  rejected: 'text-red-700',
  cancelled: 'text-red-700',
};

function formatIstDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function AccountOrdersPage() {
  return (
    <CartProvider>
      <AccountOrdersContent />
    </CartProvider>
  );
}

function AccountOrdersContent() {
  const router = useRouter();
  const { addItem } = useCart();

  const [orders, setOrders] = useState<OrderResponse[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [reorderingId, setReorderingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string>('');

  const load = useCallback(async (p: number) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/account/history?page=${p}`, { cache: 'no-store' });
      if (!res.ok) {
        setError('Could not load your orders.');
        return;
      }
      const data = await res.json();
      setOrders(data.orders ?? []);
      setHasMore(Boolean(data.hasMore));
      setPage(p);
    } catch {
      setError('Network error — please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(1);
  }, [load]);

  async function handleReorder(orderId: string) {
    setReorderingId(orderId);
    setNotice('');
    try {
      const res = await fetch(`/api/account/reorder/${orderId}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice(data.error ?? 'Could not reorder this order.');
        return;
      }
      for (const line of data.items ?? []) {
        const { qty, ...rest } = line;
        addItem(rest, qty);
      }
      const notes: string[] = [];
      if (data.skipped?.length) {
        notes.push(
          `Skipped (unavailable): ${data.skipped.map((s: { name: string }) => s.name).join(', ')}`,
        );
      }
      if (data.modified?.length) {
        notes.push(
          `Some add-ons dropped for: ${data.modified.map((m: { name: string }) => m.name).join(', ')}`,
        );
      }
      if (notes.length > 0) {
        // Small delay so the notice is readable before we navigate away.
        setNotice(notes.join(' · '));
        setTimeout(() => router.push('/checkout'), 1500);
      } else {
        router.push('/checkout');
      }
    } catch {
      setNotice('Network error — please try again.');
    } finally {
      setReorderingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-2xl font-bold text-charcoal">Your Orders</h1>

      {notice ? (
        <div className="rounded-md border border-[#e5e5e5] bg-[#f6efe9] px-4 py-3 text-sm text-charcoal">
          {notice}
        </div>
      ) : null}

      {loading ? (
        <Spinner label="Loading your orders…" />
      ) : error ? (
        <p className="py-10 text-center text-sm text-muted">{error}</p>
      ) : orders.length === 0 ? (
        <div className="rounded-md border border-[#e5e5e5] bg-cream p-8 text-center shadow-sm">
          <p className="text-muted">No orders yet.</p>
          <Link
            href="/menu"
            className="mt-4 inline-block rounded-md bg-tan px-5 py-2 text-sm font-bold text-cream hover:bg-tan-dark"
          >
            Browse the menu
          </Link>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {orders.map((order) => (
            <li key={order.id} className="rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Link href={`/order/${order.id}`} className="font-bold text-charcoal hover:underline">
                    #{formatOrderNumber(order.order_number)}
                  </Link>
                  <p className="text-xs text-muted">
                    {formatIstDate(order.created_at)} · {formatIstTime(new Date(order.created_at))}
                  </p>
                </div>
                <div className="text-right">
                  <p className={'text-sm font-bold ' + STATUS_TONE[order.status]}>
                    {STATUS_LABEL[order.status]}
                  </p>
                  <p className="text-sm font-bold text-charcoal">₹{order.total_inr ?? order.subtotal_inr}</p>
                </div>
              </div>

              <p className="mt-2 line-clamp-2 text-sm text-muted">
                {order.items
                  .map((i) => `${i.name_snapshot}${i.quantity > 1 ? ` ×${i.quantity}` : ''}`)
                  .join(', ')}
              </p>

              <div className="mt-3 flex items-center gap-3">
                <Link href={`/order/${order.id}`} className="text-xs font-bold text-tan hover:underline">
                  View receipt
                </Link>
                <button
                  type="button"
                  onClick={() => handleReorder(order.id)}
                  disabled={reorderingId === order.id}
                  className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal transition-colors hover:border-tan hover:text-tan disabled:opacity-60"
                >
                  {reorderingId === order.id ? 'Adding to cart…' : 'Order again'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {!loading && orders.length > 0 ? (
        <div className="flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={() => load(page - 1)}
            disabled={page <= 1}
            className="rounded-md border border-[#e5e5e5] px-4 py-2 text-sm font-bold text-charcoal disabled:opacity-40"
          >
            Newer
          </button>
          <span className="text-sm text-muted">Page {page}</span>
          <button
            type="button"
            onClick={() => load(page + 1)}
            disabled={!hasMore}
            className="rounded-md border border-[#e5e5e5] px-4 py-2 text-sm font-bold text-charcoal disabled:opacity-40"
          >
            Older
          </button>
        </div>
      ) : null}
    </div>
  );
}
