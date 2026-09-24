'use client';

// "Order again" strip at the top of the menu (ACC-4) — a signed-in
// customer's 3 most recent orders, each re-added to the cart in one tap.
// Renders nothing for a guest (the history route 401s) or for a customer with
// no orders yet, so the menu looks exactly as before for them.

import { useEffect, useState } from 'react';
import { formatIstDate } from '@/lib/account/orderDisplay';
import { useReorder } from '@/lib/account/useReorder';
import type { OrderResponse } from '@/lib/api/orders';

const MAX_ORDERS = 3;

function itemsSummary(order: OrderResponse): string {
  const parts = order.items.map((i) => (i.quantity > 1 ? `${i.quantity}× ${i.name_snapshot}` : i.name_snapshot));
  if (parts.length <= 2) return parts.join(', ');
  return `${parts.slice(0, 2).join(', ')} +${parts.length - 2} more`;
}

export function OrderAgainStrip({ onAdded }: { onAdded: () => void }) {
  const [orders, setOrders] = useState<OrderResponse[]>([]);
  const [notice, setNotice] = useState('');
  const { reorder, reorderingId } = useReorder();

  useEffect(() => {
    let cancelled = false;
    fetch('/api/account/history?page=1', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { orders?: OrderResponse[] } | null) => {
        if (cancelled || !data?.orders) return;
        setOrders(data.orders.filter((o) => o.items.length > 0).slice(0, MAX_ORDERS));
      })
      .catch(() => {
        // Not signed in / offline — the strip simply doesn't show.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (orders.length === 0) return null;

  async function handleClick(orderId: string) {
    setNotice('');
    const result = await reorder(orderId);
    if (!result.ok) {
      setNotice(result.error ?? 'Could not reorder this order.');
      return;
    }
    if (result.added === 0) {
      setNotice(result.notice || 'None of these items are available right now.');
      return;
    }
    setNotice(result.notice);
    onAdded();
  }

  return (
    <section aria-labelledby="order-again-heading" className="mb-8">
      <h2 id="order-again-heading" className="mb-3 text-lg font-bold text-charcoal">
        Order again
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {orders.map((order) => (
          <div
            key={order.id}
            className="flex flex-col justify-between gap-3 rounded-md border border-line bg-cream p-4 shadow-card"
          >
            <div>
              <p className="text-xs text-muted">{formatIstDate(order.created_at)}</p>
              <p className="mt-1 text-sm font-bold text-charcoal">{itemsSummary(order)}</p>
              <p className="mt-1 text-sm text-tan">₹{order.total_inr ?? order.subtotal_inr}</p>
            </div>
            <button
              type="button"
              onClick={() => handleClick(order.id)}
              disabled={reorderingId !== null}
              className="rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-dark disabled:opacity-60"
            >
              {reorderingId === order.id ? 'Adding…' : 'Add to cart'}
            </button>
          </div>
        ))}
      </div>
      {notice ? <p className="mt-2 text-sm text-muted">{notice}</p> : null}
    </section>
  );
}
