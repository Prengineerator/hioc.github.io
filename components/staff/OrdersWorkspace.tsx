'use client';

// Staff order workspace — both "Live orders" (/staff, the running board) and
// "Orders" (/staff/orders, every order placed today with its payment state).
// One component so the two share the order detail, settle, void, comp, refund
// and print handling instead of duplicating it.
//
// Live staff order cockpit (S1–S3, S5, S7). Realtime board (< 2s via
// useStaffOrdersRealtime, poll fallback), persistent new-order alert, order
// detail with accept/reject/ETA/advance/cancel/payment, and search. The
// order-alert sound and counter mode live in the staff shell
// (components/staff/StaffShell.tsx) so they survive switching tabs.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { istDateIso } from '@/lib/api/date';
import { OrderQueueBoard } from '@/components/staff/OrderQueueBoard';
import { TodayOrdersList } from '@/components/staff/TodayOrdersList';
import { OrderDetailModal } from '@/components/staff/OrderDetailModal';
import { usePrintDock } from '@/components/staff/PrintDock';
import { SettlePaymentDialog, type SettleIntent } from '@/components/staff/SettlePaymentDialog';
import { describeOrderPayment } from '@/lib/orders/settleList';
import { acceptPrintPlan, settlePrintPlan } from '@/lib/staff/autoPrint';
import { useCounterDefaults } from '@/lib/hooks/useCounterDefaults';
import { NewOrderAlert } from '@/components/staff/NewOrderAlert';
import { NotClockedInBanner } from '@/components/staff/NotClockedInBanner';
import { LeaveReminderBanner } from '@/components/staff/LeaveReminderBanner';
import { Spinner } from '@/components/ui/Spinner';
import { useStaffOrdersRealtime } from '@/lib/realtime/hooks';
import { transitionExtra, type QuickAction } from '@/lib/orders/quickActions';
import { PICKUP_REMINDER_COOLDOWN_SEC, formatCountdown } from '@/lib/notifications/pickupReminder';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { useStaffShell } from '@/components/staff/StaffShell';
import { isAppPaymentMethod } from '@/lib/orders/payments';
import { kitchenOrders } from '@/lib/pos/ritual';
import { PAYMENT_METHOD_LABEL } from '@/lib/print/labels';
import type { Order, OrderItem, PaymentMethod } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

export type OrdersView = 'live' | 'today';

/** '2026-09-27' → '27 Sep'. */
function shortIstDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function OrdersWorkspace({ view }: { view: OrdersView }) {
  const [orders, setOrders] = useState<OrderWithItems[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<OrderWithItems | null>(null);
  // Which panel the detail view opens on (a card's "Reject…" goes straight to
  // the reason step). Cleared whenever the detail closes or another opens.
  const [selectedMode, setSelectedMode] = useState<'reject' | undefined>(undefined);
  // Orders with a status request in flight; their card buttons are disabled.
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [newOrderIds, setNewOrderIds] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState('');
  const [prepMin, setPrepMin] = useState(15);
  const [toast, setToast] = useState('');
  const shell = useStaffShell();
  const { refreshNewOrders } = shell;
  const prevReceivedRef = useRef<Set<string> | null>(null);
  // Orders tab date filter: an IST day ('YYYY-MM-DD'), today by default. A
  // ref as well, so the realtime refresh always fetches the day on screen.
  const today = istDateIso();
  const [date, setDate] = useState(today);
  const dateRef = useRef(date);

  // PRT-1/PRT-3 — mounted HERE, not inside the order modal. The print iframe and
  // the failure chip have to outlive the modal: closing an order used to cancel
  // an in-flight print silently and wipe the shift's failure tally.
  const printDock = usePrintDock();
  const { enqueue: enqueuePrint } = printDock;
  const { autoPrint } = useCounterDefaults();
  // The full payment step for one order (split, cash change, change payment).
  const [paying, setPaying] = useState<{ order: OrderWithItems; intent: SettleIntent } | null>(null);

  const fetchOrders = useCallback(async () => {
    try {
      const day = dateRef.current;
      const url = view === 'today' && day !== istDateIso() ? `/api/orders?date=${day}` : '/api/orders';
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      const next: OrderWithItems[] = data.orders ?? [];
      setOrders(next);

      // A HIOC Ritual sale is never a kitchen order, so it never rings the alert.
      const received = new Set(kitchenOrders(next).filter((o) => o.status === 'received').map((o) => o.id));
      if (prevReceivedRef.current) {
        const prev = prevReceivedRef.current;
        setNewOrderIds((cur) => {
          const s = new Set(cur);
          received.forEach((id) => !prev.has(id) && s.add(id));
          s.forEach((id) => !received.has(id) && s.delete(id));
          return s;
        });
      }
      prevReceivedRef.current = received;
    } catch {
      /* keep last-known-good; realtime/poll retries */
    } finally {
      setLoading(false);
    }
  }, [view]);

  const changeDate = useCallback(
    (next: string) => {
      if (!next || next > istDateIso()) return;
      dateRef.current = next;
      // Another day's orders are not "new": don't let them ring the alert.
      prevReceivedRef.current = null;
      setNewOrderIds(new Set());
      setDate(next);
      setLoading(true);
      void fetchOrders();
    },
    [fetchOrders],
  );
  const dayLabel = date === today ? 'today' : `on ${shortIstDate(date)}`;

  const connection = useStaffOrdersRealtime(fetchOrders);

  useEffect(() => {
    fetchOrders();
    fetch('/api/store-settings')
      .then((r) => r.json())
      .then((d) => setPrepMin(d?.settings?.default_prep_min ?? 15))
      .catch(() => {});
  }, [fetchOrders]);

  // Keep the open detail modal in sync with fresh data.
  useEffect(() => {
    if (selected) {
      const fresh = orders.find((o) => o.id === selected.id);
      if (fresh && fresh !== selected) setSelected(fresh);
    }
  }, [orders, selected]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3500);
  };

  const openDetail = useCallback((o: OrderWithItems, mode?: 'reject') => {
    setSelectedMode(mode);
    setSelected(o);
  }, []);
  const closeDetail = useCallback(() => {
    setSelectedMode(undefined);
    setSelected(null);
  }, []);

  const patchStatus = useCallback(
    async (o: OrderWithItems, to: Order['status'], extra?: { reason?: string; promised_ready_at?: string }) => {
      setBusyIds((prev) => new Set(prev).add(o.id));
      // Optimistic move.
      setOrders((prev) => prev.map((x) => (x.id === o.id ? { ...x, status: to } : x)));
      setNewOrderIds((prev) => {
        if (!prev.has(o.id)) return prev;
        const s = new Set(prev);
        s.delete(o.id);
        return s;
      });
      try {
        const res = await fetch(`/api/orders/${o.id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: to, version: o.version, ...extra }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          showToast(d.error ?? 'Could not update order');
        } else if (o.status === 'received' && to === 'accepted') {
          // A website order's KOT goes out on Accept — its placement, as far as
          // the kitchen is concerned — and so does the receipt of one already
          // paid online. Only once the server has taken the move: a 409'd
          // accept is not an order the kitchen should start.
          const jobs = acceptPrintPlan(autoPrint, { paid: o.payment_status === 'paid', orderKind: o.order_kind }).map(
            (type) => ({ orderId: o.id, type }),
          );
          if (jobs.length > 0) enqueuePrint(jobs);
        }
      } catch {
        showToast('Could not update order — check the connection');
      } finally {
        // Stop the shell's alarm right away once an order is accepted/rejected.
        refreshNewOrders();
        // Re-enable the card only after the refetch: the next tap must carry the
        // order's NEW version, or the server answers 409 to a perfectly valid move.
        await fetchOrders();
        setBusyIds((prev) => {
          const s = new Set(prev);
          s.delete(o.id);
          return s;
        });
      }
    },
    [fetchOrders, refreshNewOrders, autoPrint, enqueuePrint],
  );

  // The corner button and "⋯" menu on a card. A one-tap move goes straight to
  // patchStatus (optimistic); anything that needs more input opens the dialog
  // it needs instead.
  const handleAction = useCallback(
    (o: OrderWithItems, action: QuickAction) => {
      if (action.kind === 'settle') {
        setPaying({ order: o, intent: 'settle' });
        return;
      }
      if (action.kind === 'open_detail') {
        openDetail(o, action.detail);
        return;
      }
      if (!action.to) return;
      if (action.confirm && !window.confirm(action.confirm)) return;
      patchStatus(o, action.to, transitionExtra(action, prepMin, Date.now()));
    },
    [patchStatus, openDetail, prepMin],
  );

  // Resend the "order ready" WhatsApp. The server owns the 5-minute cooldown;
  // the local stamp just keeps the card's countdown in step until the refetch.
  const handleRemind = useCallback(async (o: OrderWithItems) => {
    const stamp = (iso: string) =>
      setOrders((prev) => prev.map((x) => (x.id === o.id ? { ...x, pickup_reminded_at: iso } : x)));
    try {
      const res = await fetch(`/api/orders/${o.id}/remind`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        stamp(d.reminded_at ?? new Date().toISOString());
        showToast(`Pickup reminder sent to ${o.customer_name || 'the customer'}`);
      } else if (res.status === 429) {
        const wait = Number(d.retry_after_seconds) || PICKUP_REMINDER_COOLDOWN_SEC;
        stamp(new Date(Date.now() - (PICKUP_REMINDER_COOLDOWN_SEC - wait) * 1000).toISOString());
        showToast(`Already reminded — try again in ${formatCountdown(wait)}`);
      } else {
        showToast(d.error ?? 'Could not send the reminder');
      }
    } catch {
      showToast('Could not send the reminder — check the connection');
    }
  }, []);

  const handlePayment = useCallback(
    async (o: OrderWithItems, method: PaymentMethod, reference?: string) => {
      try {
        const res = await fetch(`/api/orders/${o.id}/payment`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reference ? { payment_method: method, reference } : { payment_method: method }),
        });
        if (!res.ok) {
          // e.g. a booking ID already on another bill — say which, not just "failed".
          const d = await res.json().catch(() => ({}));
          showToast(d?.error ?? 'Payment not recorded — try again.');
        }
        return res.ok;
      } catch {
        return false;
      } finally {
        fetchOrders();
      }
    },
    [fetchOrders],
  );

  // Refund (PAY-3) — the server route is manager/owner-gated (FND-5); a plain
  // staff member sees this fail with a clear message rather than the button
  // being hidden (role isn't plumbed to this client page).
  const handleRefund = useCallback(
    async (o: OrderWithItems, amountInr: number, reason: string, method?: string, refundKey?: string) => {
      try {
        const res = await fetch(`/api/orders/${o.id}/refund`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // REF-2: identifies THIS refund attempt. The key belongs to the
            // open refund panel, NOT to the click — so a double-tap replays it
            // and the route returns the refund it already made, instead of
            // paying the customer twice.
            ...(refundKey ? { 'Idempotency-Key': refundKey } : {}),
          },
          body: JSON.stringify({ amount_inr: amountInr, reason, ...(method ? { method } : {}) }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          showToast(d.error ?? 'Refund failed — only managers can issue refunds.');
        } else {
          const d = await res.json().catch(() => ({}));
          const r = d?.refunded as { method?: string; amount_inr?: number } | undefined;
          // Say what the staffer must physically do: cash leaves the drawer, a
          // dining-app payment is reversed in that app's partner dashboard,
          // anything else is reversed on the terminal.
          showToast(
            r?.method === 'cash'
              ? `Refunded ₹${r.amount_inr} — give it back from the drawer.`
              : r?.method && isAppPaymentMethod(r.method)
                ? `Refunded ₹${r.amount_inr} on ${PAYMENT_METHOD_LABEL[r.method] ?? r.method} — reverse it in the partner app.`
                : r?.method
                  ? `Refunded ₹${r.amount_inr} on ${r.method.toUpperCase()} — reverse it on the terminal.`
                  : 'Refund issued.',
          );
        }
      } catch {
        showToast('Refund failed — please try again.');
      } finally {
        fetchOrders();
      }
    },
    [fetchOrders],
  );

  // Void a line (POS-4) — POST /amend voids the line, recomputes totals
  // server-side, and audits it. The route is manager-gated (hasPermission
  // ('void_line'), D4): a plain staff member gets a 403 surfaced here rather
  // than the button being hidden (role isn't plumbed to this client page). 409
  // covers paid/terminal/last-line. The corrected total lands on refetch.
  const handleVoid = useCallback(
    async (o: OrderWithItems, itemId: string, reason: string) => {
      try {
        const res = await fetch(`/api/orders/${o.id}/amend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_id: itemId, reason }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          showToast(
            res.status === 403
              ? 'A manager is required to void a line'
              : d.error ?? 'Could not void the line.',
          );
        } else {
          showToast('Line voided — total updated.');
        }
      } catch {
        showToast('Could not void the line — please try again.');
      } finally {
        fetchOrders();
      }
    },
    [fetchOrders],
  );

  // Manager comp (POS-2) — PATCH /status with a comp payload completes an unpaid
  // dine-in order at ₹0 (server sets a paid-equivalent + audit, then completes).
  // Manager-gated server-side: a 403 is surfaced clearly. Version-guarded like
  // any other transition. Success is reflected on refetch.
  const handleComp = useCallback(
    async (o: OrderWithItems, reason: string) => {
      try {
        const res = await fetch(`/api/orders/${o.id}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'completed', comp: { reason }, version: o.version }),
        });
        if (!res.ok) {
          const d = await res.json().catch(() => ({}));
          showToast(
            res.status === 403
              ? 'A manager is required to comp'
              : d.error ?? 'Could not comp the order.',
          );
        } else {
          showToast('Order comped and completed.');
        }
      } catch {
        showToast('Could not comp the order — please try again.');
      } finally {
        fetchOrders();
      }
    },
    [fetchOrders],
  );

  const closeModalAfter = (fn: () => void) => {
    fn();
    closeDetail();
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(
      (o) =>
        o.customer_name.toLowerCase().includes(q) ||
        o.customer_phone.includes(q) ||
        formatOrderNumber(o.order_number).toLowerCase().includes(q) ||
        String(o.order_number).includes(q) ||
        // Pickup code the customer shows at the counter (CUS-056) — staff type
        // it to pull up the order and hand over the right one.
        (o.pickup_code ?? '').includes(q),
    );
  }, [orders, query]);

  // Paid orders that were cancelled/rejected still owe the customer a refund
  // (M8 / PAY-3) — surface them so they aren't silently lost.
  const refundNeeded = orders.filter(
    (o) => (o.status === 'cancelled' || o.status === 'rejected') && o.payment_status === 'paid',
  );

  return (
    <div className={shell.counterMode ? 'mx-auto max-w-7xl px-4 py-4' : 'mx-auto max-w-7xl px-4 py-8'}>
      <div>
        {/* ATT-3. Hidden in counter mode — that is a full-screen kitchen view
            and a nudge there is noise, not help. */}
        {shell.counterMode ? null : <NotClockedInBanner />}
        {shell.counterMode ? null : <LeaveReminderBanner />}
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold text-charcoal">
            {view === 'live' ? 'Live orders' : date === today ? 'Orders' : `Orders · ${shortIstDate(date)}`}
          </h1>
          <div className="flex items-center gap-3">
            {view === 'today' ? (
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-sm text-muted">
                  <span>Date</span>
                  <input
                    type="date"
                    value={date}
                    max={today}
                    onChange={(e) => changeDate(e.target.value)}
                    aria-label="Show orders for date"
                    className="min-h-[40px] rounded-md border border-line bg-white px-3 text-sm text-charcoal outline-none focus:border-tan"
                  />
                </label>
                {date !== today ? (
                  <button
                    type="button"
                    onClick={() => changeDate(today)}
                    className="min-h-[40px] rounded-md border border-line bg-white px-3 text-sm font-bold text-charcoal hover:border-charcoal"
                  >
                    Today
                  </button>
                ) : null}
              </div>
            ) : null}
            <ConnectionBadge connection={connection} />
          </div>
        </div>

        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Search orders"
          placeholder="Search order #, name, phone, or pickup code…"
          autoComplete="off"
          className="mb-4 min-h-[44px] w-full rounded-md border border-line px-3 py-2 text-base outline-none focus:border-tan sm:max-w-sm sm:text-sm"
        />

        <NewOrderAlert count={newOrderIds.size} soundReady={shell.soundOn && shell.soundReady} />

        {refundNeeded.length > 0 ? (
          <div className="mb-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm">
            <p className="font-bold text-red-800">
              {refundNeeded.length} paid order{refundNeeded.length === 1 ? '' : 's'} need a refund
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {refundNeeded.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => openDetail(o)}
                  className="min-h-[40px] rounded-md border border-red-300 bg-cream px-3 font-mono text-xs font-bold tabular-nums text-red-700 hover:bg-red-100"
                >
                  #{formatOrderNumber(o.order_number)} · ₹{o.total_inr ?? o.subtotal_inr}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {loading ? (
          <Spinner label="Loading orders…" />
        ) : (
          view === 'live' ? (
            <OrderQueueBoard
              orders={filtered}
              busyIds={busyIds}
              onOpen={openDetail}
              onAction={handleAction}
              onRemind={handleRemind}
            />
          ) : (
            <TodayOrdersList orders={filtered} onOpen={openDetail} dayLabel={dayLabel} />
          )
        )}
      </div>

      {toast ? (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 animate-fade-in rounded-md bg-charcoal px-4 py-2 text-sm text-cream shadow-lg"
        >
          {toast}
        </div>
      ) : null}

      {selected ? (
        <OrderDetailModal
          order={selected}
          defaultPrepMin={prepMin}
          initialMode={selectedMode}
          onClose={closeDetail}
          onRemind={handleRemind}
          onTransition={(o, to, extra) => closeModalAfter(() => patchStatus(o, to, extra))}
          onPayment={(o, m, ref) => handlePayment(o, m, ref)}
          onPrint={(orderId, type) => printDock.enqueue([{ orderId, type }])}
          onRefund={(o, amountInr, reason, method, key) => handleRefund(o, amountInr, reason, method, key)}
          onVoid={(o, itemId, reason) => handleVoid(o, itemId, reason)}
          onComp={(o, reason) => handleComp(o, reason)}
          onOpenPayment={(o, intent) => {
            closeDetail();
            setPaying({ order: o, intent });
          }}
        />
      ) : null}

      {paying ? (
        <SettlePaymentDialog
          order={paying.order}
          intent={paying.intent}
          onClose={() => setPaying(null)}
          onDone={(updated) => {
            const { order, intent } = paying;
            setPaying(null);
            if (intent === 'settle') {
              const jobs = settlePrintPlan(autoPrint, { orderKind: order.order_kind }).map((type) => ({ orderId: order.id, type }));
              if (jobs.length > 0) printDock.enqueue(jobs);
            }
            showToast(
              `#${formatOrderNumber(order.order_number)} ${intent === 'settle' ? 'settled' : 'changed to'} ${describeOrderPayment(updated)}`,
            );
            void fetchOrders();
          }}
        />
      ) : null}

      {printDock.node}
    </div>
  );
}

function ConnectionBadge({ connection }: { connection: 'connecting' | 'live' | 'reconnecting' }) {
  const live = connection === 'live';
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-muted">
      <span className={'inline-block h-2 w-2 rounded-full ' + (live ? 'bg-green-500' : connection === 'connecting' ? 'bg-amber-400' : 'bg-muted')} />
      {live ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Polling'}
    </span>
  );
}
