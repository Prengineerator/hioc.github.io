'use client';

// "Settle" (/staff/settle) — every bill still owed, from any day, in one list,
// each with its own Settle button. Settling used to mean Orders → Unpaid →
// open the order → a method button, one bill at a time, with no split and no
// cash change once the order had been placed "collect later".
//
// Settle opens the same payment step as New order (cash with change, UPI,
// card, split). Bills settled here stay under "Just settled" for the shift,
// with "Change payment" — the customer said cash, then paid by UPI.
//
// Opening a bill (its row) shows what is on it. With the owner's permission
// (`settle_edit_order`, Team → Permissions) the sheet also lowers it before it
// is settled — a quantity down, a line off, with a reason — and offers the
// running-tab "Add items"; the amend route re-checks all of it.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { PaymentBadge } from '@/components/staff/PaymentBadge';
import { Badge } from '@/components/ui/Badge';
import { RITUAL_SALE_LABEL, isRitualSale } from '@/lib/pos/ritual';
import { usePrintDock } from '@/components/staff/PrintDock';
import { SettleOrderSheet, whereOf } from '@/components/staff/SettleOrderSheet';
import { SettlePaymentDialog, type SettleIntent } from '@/components/staff/SettlePaymentDialog';
import { Spinner } from '@/components/ui/Spinner';
import { useCounterDefaults } from '@/lib/hooks/useCounterDefaults';
import { describeOrderPayment, groupForSettle, isSettleable } from '@/lib/orders/settleList';
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

function itemsSummary(o: OrderWithItems): string {
  const lines = o.items.filter((i) => !i.voided);
  const names = lines.slice(0, 3).map((i) => `${i.quantity > 1 ? `${i.quantity}× ` : ''}${i.name_snapshot}`);
  return names.join(', ') + (lines.length > 3 ? ` +${lines.length - 3} more` : '');
}

export function SettleWorkspace({
  canEdit = false,
  canAddItems = false,
}: {
  /** The `settle_edit_order` permission: lower a bill before settling it. */
  canEdit?: boolean;
  /** May add items to a running bill (the POS add flow + its permission). */
  canAddItems?: boolean;
} = {}) {
  const [orders, setOrders] = useState<OrderWithItems[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  // The bill open in the sheet — held by id and read back out of `orders`, so
  // the sheet follows every refetch instead of showing a stale copy.
  const [viewingId, setViewingId] = useState<string | null>(null);
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
  const viewing = viewingId ? (orders.find((o) => o.id === viewingId) ?? null) : null;

  // Settled (or cancelled) on another till while it was open: the sheet closes.
  useEffect(() => {
    if (viewingId && !viewing) setViewingId(null);
  }, [viewingId, viewing]);

  // The amend route returns the whole order: swap it in, so the row, the "still
  // to collect" figure and the sheet all show the new total at once.
  function handleEdited(updated: OrderWithItems) {
    setOrders((prev) => prev.map((o) => (o.id === updated.id ? updated : o)).filter(isSettleable));
    setToast(`#${formatOrderNumber(updated.order_number)} updated · new total ${rupees(totalOf(updated))}`);
  }

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
      const jobs = settlePrintPlan(autoPrint, { orderKind: order.order_kind }).map((type) => ({ orderId: order.id, type }));
      if (jobs.length > 0) printDock.enqueue(jobs);
      setToast(`${label} settled · ${describeOrderPayment(updated)}`);
    } else {
      setToast(`${label} changed to ${describeOrderPayment(updated)}`);
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
            (owed > 0 ? 'border-red-300 bg-red-50' : 'border-line bg-white')
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
        <p className="rounded-md border border-line bg-white py-10 text-center text-sm text-muted">
          Nothing to settle — every bill is paid.
        </p>
      ) : (
        <>
          <SettleGroup
            title="Earlier days"
            orders={groups.earlier}
            showDate
            onOpen={(o) => setViewingId(o.id)}
            onSettle={(o) => setPaying({ order: o, intent: 'settle' })}
          />
          <SettleGroup
            title="Today"
            orders={groups.today}
            onOpen={(o) => setViewingId(o.id)}
            onSettle={(o) => setPaying({ order: o, intent: 'settle' })}
          />
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
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-white px-4 py-3"
              >
                <span className="flex min-w-0 items-center gap-3 text-sm">
                  <span className="font-mono font-bold tabular-nums text-charcoal">#{formatOrderNumber(o.order_number)}</span>
                  <span className="truncate text-charcoal">{o.customer_name || whereOf(o)}</span>
                  <PaymentBadge status={o.payment_status} />
                  <span className="text-muted">{describeOrderPayment(o)}</span>
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-mono font-bold tabular-nums text-charcoal">{rupees(totalOf(o))}</span>
                  {/* Bills print only when asked (auto-print for bills is off). */}
                  <button
                    type="button"
                    onClick={() => printDock.enqueue([{ orderId: o.id, type: 'receipt' }])}
                    className="min-h-[40px] rounded-md border border-line px-3 text-sm font-bold text-charcoal hover:border-tan"
                  >
                    Print bill
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaying({ order: o, intent: 'change' })}
                    className="min-h-[40px] rounded-md border border-line px-3 text-sm font-bold text-charcoal hover:border-tan"
                  >
                    Change payment
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {viewing ? (
        <SettleOrderSheet
          order={viewing}
          canEdit={canEdit}
          canAddItems={canAddItems}
          onClose={() => setViewingId(null)}
          onUpdated={handleEdited}
          onSettle={(o) => {
            setViewingId(null);
            setPaying({ order: o, intent: 'settle' });
          }}
        />
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
  onOpen,
  onSettle,
}: {
  title: string;
  orders: OrderWithItems[];
  showDate?: boolean;
  onOpen: (o: OrderWithItems) => void;
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
            {/* The info block opens the bill (what is on it, and — with the
                owner's permission — lowering it before it is settled). Spans, not
                paragraphs: a button holds phrasing content only. */}
            <button
              type="button"
              onClick={() => onOpen(o)}
              aria-label={`Open order #${formatOrderNumber(o.order_number)}`}
              className="-mx-2 -my-1 block min-h-[44px] min-w-0 flex-1 rounded-md px-2 py-1 text-left transition-colors hover:bg-surface focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
            >
              <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-mono font-bold tabular-nums text-charcoal">#{formatOrderNumber(o.order_number)}</span>
                <span className="text-xs text-muted">
                  {showDate ? `${dateIst(o.created_at)}, ` : ''}
                  {timeIst(o.created_at)}
                </span>
                {isRitualSale(o) ? null : <span className="font-bold text-charcoal">{whereOf(o)}</span>}
                {o.customer_name ? <span className="text-charcoal">{o.customer_name}</span> : null}
                {isRitualSale(o) ? (
                  // The sale sits 'accepted' until it is paid, which says nothing
                  // to a cashier: the label says what is being collected.
                  <Badge variant="tan">{RITUAL_SALE_LABEL}</Badge>
                ) : (
                  <span className="rounded-full bg-[#f2efe9] px-2 py-0.5 text-[11px] font-bold text-charcoal">
                    {STATUS_LABELS[o.status] ?? o.status}
                  </span>
                )}
              </span>
              <span className="mt-1 block truncate text-xs text-muted">{itemsSummary(o)}</span>
            </button>
            <div className="flex items-center gap-3">
              <span className="font-mono text-lg font-bold tabular-nums text-red-800">{rupees(totalOf(o))}</span>
              <button
                type="button"
                onClick={() => onSettle(o)}
                className="min-h-[44px] rounded-md bg-tan-dark px-5 text-sm font-bold text-cream hover:bg-tan-darker"
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
