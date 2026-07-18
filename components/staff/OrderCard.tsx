'use client';

// A single order card on the staff queue board (S1). Tap to open the detail
// view; the primary button advances one step along the happy path.

import { ElapsedTime } from '@/components/staff/ElapsedTime';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { PRIMARY_NEXT, STATUS_LABELS } from '@/lib/orders/stateMachine';
import type { Order, OrderItem, OrderStatus } from '@/lib/types';

const PRIMARY_LABEL: Partial<Record<OrderStatus, string>> = {
  received: 'Accept',
  accepted: 'Start',
  preparing: 'Ready',
  ready: 'Complete',
};

const TYPE_LABEL: Record<Order['order_type'], string> = {
  takeaway: 'Takeaway',
  dine_in: 'Dine-in',
  delivery: 'Delivery',
};

export function OrderCard({
  order,
  onOpen,
  onPrimary,
}: {
  order: Order & { items: OrderItem[] };
  onOpen: (order: Order & { items: OrderItem[] }) => void;
  onPrimary: (order: Order & { items: OrderItem[] }) => void;
}) {
  const next = PRIMARY_NEXT[order.status];
  const itemCount = order.items.reduce((n, i) => n + i.quantity, 0);
  const isReady = order.status === 'ready';

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpen(order)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(order);
        }
      }}
      className={
        'flex cursor-pointer flex-col gap-2 rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm transition hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan ' +
        (isReady ? 'border-l-4 border-l-tan' : '')
      }
    >
      <div className="flex items-center justify-between">
        <span className="font-bold text-charcoal">#{formatOrderNumber(order.order_number)}</span>
        <span className="rounded-full bg-[#f2efe9] px-2 py-0.5 text-[11px] font-bold text-charcoal">
          {TYPE_LABEL[order.order_type]}
        </span>
      </div>

      <div className="text-sm text-charcoal">
        <p className="font-bold">{order.customer_name}</p>
        <p className="text-xs text-muted">
          {itemCount} item{itemCount === 1 ? '' : 's'} · ₹{order.total_inr ?? order.subtotal_inr} ·{' '}
          {order.pickup_slot_label || order.pickup_time}
        </p>
      </div>

      <div className="flex items-center justify-between text-xs text-muted">
        {/* Live total age (amber >10m, red >20m) + time in the current stage. */}
        <span>
          <ElapsedTime since={order.created_at} warnAfterMin={10} dangerAfterMin={20} /> total
        </span>
        <span>
          {STATUS_LABELS[order.status]} · <ElapsedTime since={order.updated_at} />
        </span>
      </div>

      {next && PRIMARY_LABEL[order.status] ? (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPrimary(order);
          }}
          className="mt-1 rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          {PRIMARY_LABEL[order.status]}
        </button>
      ) : null}
    </div>
  );
}
