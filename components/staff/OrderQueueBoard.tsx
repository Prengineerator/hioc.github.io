'use client';

// The staff queue board (S1): four lanes for active orders, newest-first
// within each lane. Completed/rejected/cancelled leave the active lanes.

import { OrderCard } from '@/components/staff/OrderCard';
import { ACTIVE_LANES, STATUS_LABELS } from '@/lib/orders/stateMachine';
import type { QuickAction } from '@/lib/orders/quickActions';
import type { Order, OrderItem } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

export function OrderQueueBoard({
  orders,
  busyIds,
  onOpen,
  onAction,
  onRemind,
}: {
  orders: OrderWithItems[];
  // Orders with a status request in flight — their card buttons are disabled.
  busyIds: ReadonlySet<string>;
  onOpen: (o: OrderWithItems) => void;
  onAction: (o: OrderWithItems, action: QuickAction) => void;
  onRemind: (o: OrderWithItems) => Promise<void>;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {ACTIVE_LANES.map((lane) => {
        // Oldest first — a kitchen queue is FIFO. Newest-first pushed the
        // longest-waiting order (the one whose timer is already amber/red) to
        // the bottom of the lane, often below the fold on the tablet.
        const laneOrders = orders
          .filter((o) => o.status === lane)
          .sort((a, b) => a.created_at.localeCompare(b.created_at));
        return (
          <section key={lane} className="flex flex-col gap-3">
            {/* Pinned under the 60px StaffHeader while a long lane scrolls. */}
            <h2 className="sticky top-[60px] z-10 flex items-center justify-between border-b border-line bg-cream/95 pb-2 pt-1 text-sm font-bold uppercase tracking-wide text-charcoal backdrop-blur">
              {STATUS_LABELS[lane]}
              <span className="rounded-full bg-charcoal px-2 py-0.5 font-mono text-xs tabular-nums text-cream">
                {laneOrders.length}
              </span>
            </h2>
            {laneOrders.length === 0 ? (
              <p className="py-6 text-center text-xs text-muted">No orders</p>
            ) : (
              laneOrders.map((o) => (
                <OrderCard
                  key={o.id}
                  order={o}
                  busy={busyIds.has(o.id)}
                  onOpen={onOpen}
                  onAction={onAction}
                  onRemind={onRemind}
                />
              ))
            )}
          </section>
        );
      })}
    </div>
  );
}
