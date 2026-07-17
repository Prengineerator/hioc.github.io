'use client';

import { OrderCard } from '@/components/staff/OrderCard';
import type { Order, OrderItem, OrderStatus } from '@/lib/types';

const COLUMNS: { status: OrderStatus; title: string }[] = [
  { status: 'received', title: 'Received' },
  { status: 'preparing', title: 'Preparing' },
  { status: 'ready', title: 'Ready' },
  { status: 'completed', title: 'Completed' },
];

export function OrderQueueBoard({
  orders,
  onAdvance,
}: {
  orders: (Order & { items: OrderItem[] })[];
  onAdvance: (id: string, next: OrderStatus) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
      {COLUMNS.map((col) => {
        const columnOrders = orders.filter((o) => o.status === col.status);
        return (
          <div key={col.status} className="flex flex-col gap-3">
            <h2 className="font-bold text-charcoal">
              {col.title} ({columnOrders.length})
            </h2>
            <div className="flex flex-col gap-3">
              {columnOrders.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted">
                  No orders yet
                </p>
              ) : (
                columnOrders.map((order) => (
                  <OrderCard key={order.id} order={order} onAdvance={onAdvance} />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
