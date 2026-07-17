'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { OrderQueueBoard } from '@/components/staff/OrderQueueBoard';
import { NewOrderAlert } from '@/components/staff/NewOrderAlert';
import { Spinner } from '@/components/ui/Spinner';
import type { Order, OrderItem, OrderStatus } from '@/lib/types';

const POLL_INTERVAL_MS = 15000;

type OrderWithItems = Order & { items: OrderItem[] };

export default function StaffOrdersPage() {
  const [orders, setOrders] = useState<OrderWithItems[]>([]);
  const [loading, setLoading] = useState(true);
  // IDs of orders in "received" status that arrived after the initial page
  // load and haven't been advanced yet — drives the new-order alert.
  const [newOrderIds, setNewOrderIds] = useState<Set<string>>(new Set());

  // Snapshot of "received" order IDs as of the previous poll, used to detect
  // arrivals. Not state — doesn't need to trigger a render on its own.
  const previousReceivedIdsRef = useRef<Set<string> | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const res = await fetch('/api/orders', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const nextOrders: OrderWithItems[] = data.orders ?? [];
      setOrders(nextOrders);

      const receivedIds = new Set(
        nextOrders.filter((o) => o.status === 'received').map((o) => o.id),
      );

      if (previousReceivedIdsRef.current) {
        const previouslySeen = previousReceivedIdsRef.current;
        setNewOrderIds((prev) => {
          const next = new Set(prev);
          let changed = false;

          // Orders newly in "received" status since the last poll.
          receivedIds.forEach((id) => {
            if (!previouslySeen.has(id) && !next.has(id)) {
              next.add(id);
              changed = true;
            }
          });

          // Drop anything that's no longer "received" (advanced/completed
          // by this staff member or anyone else) — this is what actually
          // clears the alert.
          next.forEach((id) => {
            if (!receivedIds.has(id)) {
              next.delete(id);
              changed = true;
            }
          });

          return changed ? next : prev;
        });
      }
      // On the very first successful load, just record the baseline —
      // orders already sitting there should never trigger the alert.
      previousReceivedIdsRef.current = receivedIds;
    } catch {
      // Keep showing the last known-good list on a transient network error;
      // the next 15s poll will retry.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOrders();
    const interval = setInterval(fetchOrders, POLL_INTERVAL_MS);

    // Timers get throttled in backgrounded tabs, so refetch immediately as
    // soon as the tab regains visibility/focus rather than waiting for the
    // next interval tick.
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        fetchOrders();
      }
    };
    const handleFocus = () => {
      fetchOrders();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('focus', handleFocus);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('focus', handleFocus);
    };
  }, [fetchOrders]);

  const handleAdvance = useCallback(
    async (id: string, next: OrderStatus) => {
      // Optimistic update so staff see the card move immediately.
      setOrders((prev) =>
        prev.map((o) => (o.id === id ? { ...o, status: next } : o)),
      );
      // Optimistically clear the alert for this order too, so the sound/
      // banner stop right away instead of waiting for the next poll.
      setNewOrderIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      try {
        await fetch(`/api/orders/${id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: next }),
        });
      } finally {
        fetchOrders();
      }
    },
    [fetchOrders],
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-charcoal">Today&apos;s Orders</h1>
        <span className="text-xs text-muted">Auto-refreshing every 15s</span>
      </div>

      <NewOrderAlert count={newOrderIds.size} />

      {loading ? (
        <Spinner label="Loading orders…" />
      ) : (
        <OrderQueueBoard orders={orders} onAdvance={handleAdvance} />
      )}
    </div>
  );
}
