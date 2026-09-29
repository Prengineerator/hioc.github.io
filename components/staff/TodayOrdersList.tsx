'use client';

// "Orders" (/staff/orders) — every order placed today, not just the running
// ones the Live orders board shows: completed, cancelled and rejected too, each
// with whether its money has been collected. A "Payment received" strip shows
// what came in by method (cash / UPI / card / online); unpaid orders are
// highlighted and have their own filter and total, so nothing leaves the counter
// unbilled unnoticed. Filters (status, payment method, order type, search) all
// combine. Tapping a row opens the same order detail as the board (bill,
// payment, print, refund).

import { useMemo, useState } from 'react';
import { PaymentBadge } from '@/components/staff/PaymentBadge';
import { amountDueInr, isPaymentDue } from '@/lib/orders/staffPayment';
import { describeOrderPayment } from '@/lib/orders/paymentLabel';
import { PAYMENT_METHODS, receivedByMethod, totalReceived } from '@/lib/orders/paymentTotals';
import {
  CLOSED_UNSOLD,
  matchesPayment,
  matchesSearch,
  matchesStatusGroup,
  type PaymentFilter,
  type StatusGroup,
} from '@/lib/orders/todayFilters';
import { STATUS_LABELS } from '@/lib/orders/stateMachine';
import { PAYMENT_METHOD_LABEL } from '@/lib/print/labels';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { Order, OrderItem, OrderStatus, OrderType } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

const TYPE_LABEL: Record<Order['order_type'], string> = {
  takeaway: 'Takeaway',
  dine_in: 'Dine-in',
  delivery: 'Delivery',
};

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

function timeIst(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

export function TodayOrdersList({ orders, onOpen }: { orders: OrderWithItems[]; onOpen: (o: OrderWithItems) => void }) {
  const [group, setGroup] = useState<StatusGroup>('all');
  const [pay, setPay] = useState<PaymentFilter>('all');
  const [search, setSearch] = useState('');
  const [type, setType] = useState<'all' | OrderType>('all');
  const [status, setStatus] = useState<'all' | OrderStatus>('all');

  const sorted = useMemo(() => [...orders].sort((a, b) => b.created_at.localeCompare(a.created_at)), [orders]);
  const shown = useMemo(
    () =>
      sorted.filter(
        (o) =>
          matchesStatusGroup(o, group) &&
          matchesPayment(o, pay) &&
          (type === 'all' || o.order_type === type) &&
          (status === 'all' || o.status === status) &&
          matchesSearch(o, search),
      ),
    [sorted, group, pay, type, status, search],
  );

  const unpaidCount = orders.filter(isPaymentDue).length;
  const received = useMemo(() => receivedByMethod(orders), [orders]);
  const due = amountDueInr(orders);

  // Statuses that actually occur today, in lifecycle order, for the dropdown.
  const statusOptions = (Object.keys(STATUS_LABELS) as OrderStatus[]).filter((st) => orders.some((o) => o.status === st));

  const filtersActive = group !== 'all' || pay !== 'all' || type !== 'all' || status !== 'all' || search.trim() !== '';
  const clearFilters = () => {
    setGroup('all');
    setPay('all');
    setType('all');
    setStatus('all');
    setSearch('');
  };

  const groups: { id: StatusGroup; label: string }[] = [
    { id: 'all', label: `All (${orders.length})` },
    { id: 'running', label: 'Running' },
    { id: 'completed', label: 'Completed' },
    { id: 'cancelled', label: 'Cancelled' },
  ];
  const payments: { id: PaymentFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    ...PAYMENT_METHODS.map((m) => ({ id: m as PaymentFilter, label: PAYMENT_METHOD_LABEL[m] })),
    { id: 'unpaid', label: `Unpaid (${unpaidCount})` },
  ];

  const chip = (active: boolean, alert = false) =>
    'min-h-[40px] shrink-0 rounded-full border px-4 text-sm font-bold transition-colors ' +
    (active
      ? 'border-charcoal bg-charcoal text-cream'
      : alert
        ? 'border-red-300 text-red-800 hover:bg-red-50'
        : 'border-[#e5e5e5] text-charcoal hover:border-tan');
  const field =
    'min-h-[40px] rounded-md border border-[#e5e5e5] bg-white px-3 text-sm text-charcoal outline-none focus:border-tan';

  return (
    <div className="flex flex-col gap-4">
      {/* Payment received — what came in today, by method. A method tile
          filters the list to the orders it was taken on. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className="rounded-md border border-[#e5e5e5] bg-white p-3">
          <p className="text-xs text-muted">Orders today</p>
          <p className="text-xl font-bold text-charcoal">{orders.length}</p>
        </div>
        {PAYMENT_METHODS.filter((m) => received[m].amount_inr > 0).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setPay(pay === m ? 'all' : m)}
            aria-pressed={pay === m}
            className={
              'rounded-md border p-3 text-left transition-colors ' +
              (pay === m ? 'border-charcoal bg-surface' : 'border-[#e5e5e5] bg-white hover:border-tan')
            }
          >
            <p className="text-xs text-muted">{PAYMENT_METHOD_LABEL[m]}</p>
            <p className="text-xl font-bold text-charcoal">{rupees(received[m].amount_inr)}</p>
            <p className="text-xs text-muted">
              {received[m].orders} order{received[m].orders === 1 ? '' : 's'}
            </p>
          </button>
        ))}
        <div className="rounded-md border border-[#e5e5e5] bg-white p-3">
          <p className="text-xs text-muted">Total received</p>
          <p className="text-xl font-bold text-charcoal">{rupees(totalReceived(received))}</p>
        </div>
        <button
          type="button"
          onClick={() => setPay('unpaid')}
          className={'rounded-md border p-3 text-left ' + (due > 0 ? 'border-red-300 bg-red-50' : 'border-[#e5e5e5] bg-white')}
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

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search order no., name, phone, table or token"
          aria-label="Search orders"
          className={`${field} min-w-0 flex-1 basis-56`}
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as 'all' | OrderType)}
          aria-label="Filter by order type"
          className={field}
        >
          <option value="all">All types</option>
          {(Object.keys(TYPE_LABEL) as OrderType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as 'all' | OrderStatus)}
          aria-label="Filter by status"
          className={field}
        >
          <option value="all">All statuses</option>
          {statusOptions.map((st) => (
            <option key={st} value={st}>
              {STATUS_LABELS[st]}
            </option>
          ))}
        </select>
        {filtersActive ? (
          <button type="button" onClick={clearFilters} className="text-sm font-bold text-tan hover:underline">
            Clear filters
          </button>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Filter orders by status">
          {groups.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={group === f.id}
              onClick={() => setGroup(f.id)}
              className={chip(group === f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="Filter orders by payment method">
          {payments.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={pay === f.id}
              onClick={() => setPay(f.id)}
              className={chip(pay === f.id, f.id === 'unpaid' && unpaidCount > 0)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <p className="-mt-2 text-xs text-muted">
        Showing {shown.length} of {orders.length}
      </p>

      {shown.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted">
          {orders.length === 0
            ? 'No orders here.'
            : pay === 'unpaid' && group === 'all' && type === 'all' && status === 'all' && search.trim() === ''
              ? 'Every order today is paid.'
              : 'No orders match these filters.'}
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
