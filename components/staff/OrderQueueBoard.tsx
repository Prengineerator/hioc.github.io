'use client';

// The staff queue board (S1): one grid of every active order, oldest first.
// No status lanes — a card keeps its place as its status changes and staff just
// press its button (Accept → Start → Ready → Complete). Completed/rejected/
// cancelled orders drop off the board.

import { OrderCard } from '@/components/staff/OrderCard';
import { ACTIVE_LANES } from '@/lib/orders/stateMachine';
import { kitchenOrders } from '@/lib/pos/ritual';
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
  // Filtered here rather than trusting the feed, so finished orders never show
  // whatever /api/orders returns. Oldest first — a kitchen queue is FIFO, and
  // created_at (unlike status) never changes, so cards don't jump around.
  // A HIOC Ritual sale is a payment, not food: it sits 'accepted' while unpaid,
  // which would otherwise put it on the kitchen's board. It lives in Settle and
  // Orders instead (the status API refuses its kitchen moves anyway).
  const active = kitchenOrders(orders)
    .filter((o) => (ACTIVE_LANES as readonly string[]).includes(o.status))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  if (active.length === 0) {
    return <p className="py-16 text-center text-sm text-muted">No active orders</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-bold uppercase tracking-wide text-muted">
        {active.length} active order{active.length === 1 ? '' : 's'}
      </p>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {active.map((o) => (
          <OrderCard
            key={o.id}
            order={o}
            busy={busyIds.has(o.id)}
            onOpen={onOpen}
            onAction={onAction}
            onRemind={onRemind}
          />
        ))}
      </div>
    </div>
  );
}
