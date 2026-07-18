'use client';

// The staff queue board (S1): four lanes for active orders, newest-first
// within each lane. Completed/rejected/cancelled leave the active lanes.

import { OrderCard } from '@/components/staff/OrderCard';
import { ACTIVE_LANES, STATUS_LABELS } from '@/lib/orders/stateMachine';
import type { Order, OrderItem } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

export function OrderQueueBoard({
  orders,
  onOpen,
  onPrimary,
}: {
  orders: OrderWithItems[];
  onOpen: (o: OrderWithItems) => void;
  onPrimary: (o: OrderWithItems) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {ACTIVE_LANES.map((lane) => {
        const laneOrders = orders
          .filter((o) => o.status === lane)
          .sort((a, b) => b.created_at.localeCompare(a.created_at));
        return (
          <section key={lane} className="flex flex-col gap-3">
            <h2 className="flex items-center justify-between border-b border-[#e5e5e5] pb-2 text-sm font-bold uppercase tracking-wide text-charcoal">
              {STATUS_LABELS[lane]}
              <span className="rounded-full bg-charcoal px-2 py-0.5 text-[11px] text-cream">
                {laneOrders.length}
              </span>
            </h2>
            {laneOrders.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted">No orders</p>
            ) : (
              laneOrders.map((o) => (
                <OrderCard key={o.id} order={o} onOpen={onOpen} onPrimary={onPrimary} />
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}
