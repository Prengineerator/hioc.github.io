'use client';

// "Settle" (/staff/settle) — every bill still owed, from any day, in one list,
// each with its own Settle button. Settling used to mean Orders → Unpaid →
// open the order → a method button, one bill at a time, with no split and no
// cash change once the order had been placed "collect later".
//
// Settle opens the same payment step as New order (cash with change, UPI,
// card, split). Bills settled here stay under "Just settled" for the shift,
// with "Change payment" — the customer said cash, then paid by UPI.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PaymentBadge } from '@/components/staff/PaymentBadge';
import { usePrintDock } from '@/components/staff/PrintDock';
import { SettlePaymentDialog, type SettleIntent } from '@/components/staff/SettlePaymentDialog';
import { Spinner } from '@/components/ui/Spinner';
import { useCounterDefaults } from '@/lib/hooks/useCounterDefaults';
import { describePaymentMethod, groupForSettle, isSettleable } from '@/lib/orders/settleList';
import { STATUS_LABELS } from '@/lib/orders/stateMachine';
import { usePostgresChangesRefresh } from '@/lib/realtime/hooks';
import { settlePrintPlan } from '@/lib/staff/autoPrint';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { Order, OrderItem } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

const JUST_SETTLED_LIMIT = 8;

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const totalOf = (o: Order) => o.total_inr ?? o.subtotal_inr;

function timeIst(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
}

function dateIst(iso: string): string {
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
}

function whereOf(o: Order): string {
  if (o.order_type === 'dine_in') return o.table_label ? `Table ${o.table_label}` : 'Dine-in';
  if (o.pickup_code) return `Token ${o.pickup_code}`;
  return o.order_type === 'delivery' ? 'Delivery' : 'Takeaway';
}

function itemsSummary(o: OrderWithItems): string {
  const lines = o.items.filter((i) => !i.voided);
  const names = lines.slice(0, 3).map((i) => `${i.quantity > 1 ? `${i.quantity}× ` : ''}${i.name_snapshot}`);
  return names.join(', ') + (lines.length > 3 ? ` +${lines.length - 3} more` : '');
}

export function SettleWorkspace() {
  const [orders, setOrders] = useState<OrderWithItems[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [paying, setPaying] = useState<{ order: OrderWithItems; intent: SettleIntent } | null>(null);
  const [justSettled, setJustSettled] = useState<OrderWithItems[]>([]);
  const [toast, setToast] = useState('');
  const printDock = usePrintDock();
  const { autoPrint } = useCounterDefaults();

  const fetchUnpaid = useCallback(async () => {
    try {
      const res = await fetch('/api/orders?payment=unpaid', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const data = (await res.json()) as { orders?: OrderWithItems[] };
      setOrders((data.orders ?? []).filter(isSettleable));
      setLoadError(false);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchUnpaid();
  }, [fetchUnpaid]);

  // A bill placed unpaid (or settled) anywhere else shows up here within seconds.
  usePostgresChangesRefresh({ table: 'orders', channelName: 'staff-settle', onChange: fetchUnpaid });

  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(''), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const groups = useMemo(() => groupForSettle(orders), [orders]);
  const owed = orders.reduce((sum, o) => sum + totalOf(o), 0);

  function handleDone(updated: Order) {
    if (!paying) return;
    const { order, intent } = paying;
    const merged: OrderWithItems = { ...order, ...updated, items: order.items };
    setPaying(null);
    setOrders((prev) => prev.filter((o) => o.id !== order.id));
    setJustSettled((prev) => [merged, ...prev.filter((o) => o.id !== order.id)].slice(0, JUST_SETTLED_LIMIT));
    const label = `#${formatOrderNumber(order.order_number)}`;
    if (intent === 'settle') {
      // Same print rule as settling from the order detail or the POS.
      const jobs = settlePrintPlan(autoPrint).map((type) => ({ orderId: order.id, type }));
      if (jobs.length > 0) printDock.enqueue(jobs);
      setToast(`${label} settled · ${describePaymentMethod(updated.payment_method)}`);
    } else {
      setToast(`${label} changed to ${describePaymentMethod(updated.payment_method)}`);
    }
    void fetchUnpaid();
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-charcoal">Settle</h1>
          <p className="text-sm text-muted">Every bill still to be paid, from any day. Oldest first.</p>
        </div>
        <div
          className={
            'rounded-md border px-4 py-2 text-right ' +
            (owed > 0 ? 'border-red-300 bg-red-50' : 'border-[#e5e5e5] bg-white')
          }
        >
          <p className={`text-xs ${owed > 0 ? 'font-bold text-red-800' : 'text-muted'}`}>Still to collect</p>
          <p className={`text-xl font-bold ${owed > 0 ? 'text-red-800' : 'text-charcoal'}`}>{rupees(owed)}</p>
          <p className="text-xs text-muted">
            {orders.length} bill{orders.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>

      {loading ? (
        <Spinner label="Loading unpaid bills…" />
      ) : loadError && orders.length === 0 ? (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          Could not load the unpaid bills.{' '}
          <button type="button" onClick={() => void fetchUnpaid()} className="font-bold underline">
            Try again
          </button>
        </div>
      ) : orders.length === 0 ? (
        <p className="rounded-md border border-[#e5e5e5] bg-white py-10 text-center text-sm text-muted">
          Nothing to settle — every bill is paid.
        </p>
      ) : (
        <>
          <SettleGroup
            title="Earlier days"
            orders={groups.earlier}
            showDate
            onSettle={(o) => setPaying({ order: o, intent: 'settle' })}
          />
          <SettleGroup title="Today" orders={groups.today} onSettle={(o) => setPaying({ order: o, intent: 'settle' })} />
        </>
      )}

      {justSettled.length > 0 ? (
        <section aria-labelledby="just-settled-heading">
          <h2 id="just-settled-heading" className="mb-2 text-xs font-bold uppercase tracking-wide text-muted">
            Just settled
          </h2>
          <ul className="flex flex-col gap-2">
            {justSettled.map((o) => (
              <li
                key={o.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#e5e5e5] bg-white px-4 py-3"
              >
                <span className="flex min-w-0 items-center gap-3 text-sm">
                  <span className="font-mono font-bold tabular-nums text-charcoal">#{formatOrderNumber(o.order_number)}</span>
                  <span className="truncate text-charcoal">{o.customer_name || whereOf(o)}</span>
                  <PaymentBadge status={o.payment_status} />
                  <span className="text-muted">{describePaymentMethod(o.payment_method)}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-mono font-bold tabular-nums text-charcoal">{rupees(totalOf(o))}</span>
                  <button
                    type="button"
                    onClick={() => setPaying({ order: o, intent: 'change' })}
                    className="min-h-[40px] rounded-md border border-[#e5e5e5] px-3 text-sm font-bold text-charcoal hover:border-tan"
                  >
                    Change payment
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {paying ? (
        <SettlePaymentDialog
          order={paying.order}
          intent={paying.intent}
          onClose={() => setPaying(null)}
          onDone={handleDone}
        />
      ) : null}

      {toast ? (
        <div
          role="status"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md bg-charcoal px-4 py-2 text-sm text-cream shadow-lg"
        >
          {toast}
        </div>
      ) : null}

      {printDock.node}
    </div>
  );
}

function SettleGroup({
  title,
  orders,
  showDate = false,
  onSettle,
}: {
  title: string;
  orders: OrderWithItems[];
  showDate?: boolean;
  onSettle: (o: OrderWithItems) => void;
}) {
  if (orders.length === 0) return null;
  const sum = orders.reduce((s, o) => s + totalOf(o), 0);
  return (
    <section>
      <h2 className="mb-2 flex items-baseline justify-between text-xs font-bold uppercase tracking-wide text-muted">
        <span>
          {title} · {orders.length}
        </span>
        <span className="font-mono tabular-nums">{rupees(sum)}</span>
      </h2>
      <ul className="flex flex-col gap-2">
        {orders.map((o) => (
          <li
            key={o.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-red-200 border-l-4 border-l-red-500 bg-white px-4 py-3"
          >
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-mono font-bold tabular-nums text-charcoal">#{formatOrderNumber(o.order_number)}</span>
                <span className="text-xs text-muted">
                  {showDate ? `${dateIst(o.created_at)}, ` : ''}
                  {timeIst(o.created_at)}
                </span>
                <span className="font-bold text-charcoal">{whereOf(o)}</span>
                {o.customer_name ? <span className="text-charcoal">{o.customer_name}</span> : null}
                <span className="rounded-full bg-[#f2efe9] px-2 py-0.5 text-[11px] font-bold text-charcoal">
                  {STATUS_LABELS[o.status] ?? o.status}
                </span>
              </p>
              <p className="mt-1 truncate text-xs text-muted">{itemsSummary(o)}</p>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-lg font-bold tabular-nums text-red-800">{rupees(totalOf(o))}</span>
              <button
                type="button"
                onClick={() => onSettle(o)}
                className="min-h-[44px] rounded-md bg-tan px-5 text-sm font-bold text-cream hover:bg-tan-dark"
              >
                Settle
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
