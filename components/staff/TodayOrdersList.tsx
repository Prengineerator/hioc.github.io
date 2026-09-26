'use client';

// "Orders" (/staff/orders) — every order placed today, not just the running
// ones the Live orders board shows: completed, cancelled and rejected too, each
// with whether its money has been collected. Unpaid orders are highlighted and
// have their own filter and total, so nothing leaves the counter unbilled
// unnoticed. Tapping a row opens the same order detail as the board (bill,
// payment, print, refund).

import { useMemo, useState } from 'react';
import { PaymentBadge } from '@/components/staff/PaymentBadge';
import { amountDueInr, isPaymentDue } from '@/lib/orders/staffPayment';
import { describeOrderPayment } from '@/lib/orders/paymentLabel';
import { STATUS_LABELS } from '@/lib/orders/stateMachine';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { Order, OrderItem, OrderStatus } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

type Filter = 'all' | 'unpaid' | 'running' | 'completed' | 'cancelled';

const RUNNING: ReadonlySet<OrderStatus> = new Set(['placed', 'received', 'accepted', 'preparing', 'ready']);
const CLOSED_UNSOLD: ReadonlySet<OrderStatus> = new Set(['cancelled', 'rejected']);

const TYPE_LABEL: Record<Order['order_type'], string> = {
  takeaway: 'Takeaway',
  dine_in: 'Dine-in',
  delivery: 'Delivery',
};

function matches(order: Order, filter: Filter): boolean {
  switch (filter) {
    case 'unpaid':
      return isPaymentDue(order);
    case 'running':
      return RUNNING.has(order.status);
    case 'completed':
      return order.status === 'completed';
    case 'cancelled':
      return CLOSED_UNSOLD.has(order.status);
    default:
      return true;
  }
}

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function timeIst(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export function TodayOrdersList({ orders, onOpen }: { orders: OrderWithItems[]; onOpen: (o: OrderWithItems) => void }) {
  const [filter, setFilter] = useState<Filter>('all');

  const sorted = useMemo(() => [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at)), [orders]);
  const shown = useMemo(() => sorted.filter((o) => matches(o, filter)), [sorted, filter]);

  const unpaidCount = orders.filter(isPaymentDue).length;
  const collected = orders
    .filter((o) => o.payment_status === 'paid' && !CLOSED_UNSOLD.has(o.status))
    .reduce((sum, o) => sum + (o.total_inr ?? o.subtotal_inr), 0);
  const due = amountDueInr(orders);

  const filters: { id: Filter; label: string }[] = [
    { id: 'all', label: `All (${orders.length})` },
    { id: 'unpaid', label: `Unpaid (${unpaidCount})` },
    { id: 'running', label: 'Running' },
    { id: 'completed', label: 'Completed' },
    { id: 'cancelled', label: 'Cancelled' },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="rounded-md border border-[#e5e5e5] bg-white p-3">
          <p className="text-xs text-muted">Orders today</p>
          <p className="text-xl font-bold text-charcoal">{orders.length}</p>
        </div>
        <div className="rounded-md border border-[#e5e5e5] bg-white p-3">
          <p className="text-xs text-muted">Collected</p>
          <p className="text-xl font-bold text-charcoal">{rupees(collected)}</p>
        </div>
        <button
          type="button"
          onClick={() => setFilter('unpaid')}
          className={
            'col-span-2 rounded-md border p-3 text-left sm:col-span-1 ' +
            (due > 0 ? 'border-red-300 bg-red-50' : 'border-[#e5e5e5] bg-white')
          }
        >
          <p className={`text-xs ${due > 0 ? 'font-bold text-red-800' : 'text-muted'}`}>Still to collect</p>
          <p className={`text-xl font-bold ${due > 0 ? 'text-red-800' : 'text-charcoal'}`}>{rupees(due)}</p>
          {unpaidCount > 0 ? (
            <p className="text-xs text-red-800">
              {unpaidCount} unpaid order{unpaidCount === 1 ? '' : 's'}
            </p>
          ) : null}
        </button>
      </div>

      <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Filter orders">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={
              'min-h-[40px] shrink-0 rounded-full border px-4 text-sm font-bold transition-colors ' +
              (filter === f.id
                ? 'border-charcoal bg-charcoal text-cream'
                : f.id === 'unpaid' && unpaidCount > 0
                  ? 'border-red-300 text-red-800 hover:bg-red-50'
                  : 'border-[#e5e5e5] text-charcoal hover:border-tan')
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">
          {filter === 'unpaid' ? 'Every order today is paid.' : 'No orders here.'}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {shown.map((o) => {
            const due = isPaymentDue(o);
            const closedUnsold = CLOSED_UNSOLD.has(o.status);
            const itemCount = o.items.filter((i) => !i.voided).reduce((n, i) => n + i.quantity, 0);
            const where =
              o.order_type === 'dine_in'
                ? o.table_label
                  ? `Table ${o.table_label}`
                  : 'Dine-in'
                : o.pickup_code
                  ? `Token ${o.pickup_code}`
                  : TYPE_LABEL[o.order_type];
            return (
              <li key={o.id}>
                <button
                  type="button"
                  onClick={() => onOpen(o)}
                  className={
                    'flex w-full flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md border px-4 py-3 text-left transition hover:shadow-sm ' +
                    (due
                      ? 'border-red-200 border-l-4 border-l-red-500 bg-red-50/60'
                      : closedUnsold
                        ? 'border-[#e5e5e5] bg-surface text-muted'
                        : 'border-[#e5e5e5] bg-white')
                  }
                >
                  <span className="flex min-w-0 items-center gap-3">
                    <span className="font-mono font-bold tabular-nums text-charcoal">
                      #{formatOrderNumber(o.order_number)}
                    </span>
                    <span className="text-xs text-muted">{timeIst(o.created_at)}</span>
                    <span className="min-w-0 truncate text-sm text-charcoal">
                      {o.customer_name || where}
                      <span className="text-muted">
                        {' '}
                        · {where} · {itemCount} item{itemCount === 1 ? '' : 's'}
                      </span>
                    </span>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="rounded-full bg-[#f2efe9] px-2 py-0.5 text-[11px] font-bold text-charcoal">
                      {STATUS_LABELS[o.status] ?? o.status}
                    </span>
                    <PaymentBadge status={o.payment_status} />
                    {o.payment_status === 'paid' && o.payment_method ? (
                      <span className="text-xs text-muted">{describeOrderPayment(o)}</span>
                    ) : null}
                    <span className={`font-mono font-bold tabular-nums ${due ? 'text-red-800' : 'text-charcoal'}`}>
                      {rupees(o.total_inr ?? o.subtotal_inr)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
