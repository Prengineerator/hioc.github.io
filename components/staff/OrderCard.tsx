'use client';

import { timeAgo } from '@/lib/utils/timeAgo';
import type { Order, OrderItem, OrderStatus } from '@/lib/types';

const NEXT_ACTION: Partial<Record<OrderStatus, { label: string; next: OrderStatus }>> = {
  received: { label: 'Start Preparing', next: 'preparing' },
  preparing: { label: 'Mark Ready', next: 'ready' },
  ready: { label: 'Complete Order', next: 'completed' },
};

const BADGE_CLASSES: Record<OrderStatus, string> = {
  received: 'bg-charcoal text-cream',
  preparing: 'bg-tan text-cream',
  ready: 'bg-[#e5e5e5] text-charcoal',
  completed: 'bg-[#e5e5e5] text-muted',
};

const BADGE_LABEL: Record<OrderStatus, string> = {
  received: 'Received',
  preparing: 'Preparing',
  ready: 'Ready',
  completed: 'Completed',
};

export function OrderCard({
  order,
  onAdvance,
}: {
  order: Order & { items: OrderItem[] };
  onAdvance: (id: string, next: OrderStatus) => void;
}) {
  const action = NEXT_ACTION[order.status];
  const isCompleted = order.status === 'completed';
  const isReady = order.status === 'ready';

  return (
    <div
      className={
        'flex flex-col gap-2 rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm ' +
        (isReady ? 'border-l-4 border-l-tan ' : '') +
        (isCompleted ? 'opacity-60' : '')
      }
    >
      <div className="flex items-center justify-between">
        <span className="font-bold text-charcoal">
          #HIOC-{String(order.order_number).padStart(6, '0')}
        </span>
        <span
          className={
            'rounded-full px-3 py-1 text-xs font-bold ' + BADGE_CLASSES[order.status]
          }
        >
          {BADGE_LABEL[order.status]}
        </span>
      </div>

      <div className="text-sm text-charcoal">
        <p className="font-bold">{order.customer_name}</p>
        <a href={`tel:${order.customer_phone}`} className="text-tan hover:underline">
          {order.customer_phone}
        </a>
      </div>

      <ul className="text-sm text-charcoal">
        {order.items.map((item) => (
          <li key={item.id} className="py-0.5">
            <span>
              {item.quantity}× {item.name_snapshot}
              {item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : ''}
            </span>
            {item.addons.length > 0 ? (
              <p className="pl-4 text-xs text-muted">
                {item.addons.map((a) => a.option_name_snapshot).join(', ')}
              </p>
            ) : null}
          </li>
        ))}
      </ul>

      <p className="text-sm text-charcoal">Pickup: {order.pickup_time}</p>

      {order.notes ? (
        <p className="text-sm italic text-muted">Note: {order.notes}</p>
      ) : null}

      <p className="text-xs text-muted">{timeAgo(order.created_at)}</p>

      {action ? (
        <button
          type="button"
          onClick={() => onAdvance(order.id, action.next)}
          className="mt-2 rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          {action.label}
        </button>
      ) : null}
    </div>
  );
}
