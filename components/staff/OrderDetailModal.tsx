'use client';

// Order detail + actions (S3 · POS-2 · POS-4). Shows everything about one order
// and exposes the legal transitions: Accept (with an adjustable ready ETA),
// Reject (with a required reason), the forward steps, Cancel, mark-payment
// (S7/STF-041), the manager-gated Refund (FND-5), and — Phase-3 — the dine-in
// Settle & complete / Comp flow (POS-2) plus per-line Void (POS-4). The parent
// owns the API calls (optimistic update + refetch); this is pure UI. Server
// routes enforce authz (§5.2) — the UI only exposes the actions.

import { useEffect, useRef, useState } from 'react';
import { ElapsedTime } from '@/components/staff/ElapsedTime';
import { useModalDismiss } from '@/lib/hooks/useModalDismiss';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import { PRIMARY_NEXT, STATUS_LABELS } from '@/lib/orders/stateMachine';
import { canRemind } from '@/lib/orders/quickActions';
import { PickupReminderButton } from '@/components/staff/PickupReminderButton';
import { settlePrintPlan } from '@/lib/staff/autoPrint';
import { RITUAL_SALE_LABEL, cupsOnOrder, isRitualSale, ritualBillRow } from '@/lib/pos/ritual';
import { openDrawerIfCash } from '@/lib/desktop/drawer';
import { useCounterDefaults } from '@/lib/hooks/useCounterDefaults';
import { canChangePayment, describeOrderPayment, isSettleable } from '@/lib/orders/settleList';
import {
  COUNTER_PAYMENT_METHODS,
  isAppPaymentMethod,
  parsePaymentReference,
  PAYMENT_REFERENCE_LABEL,
} from '@/lib/orders/payments';
import { PAYMENT_METHOD_LABEL } from '@/lib/print/labels';
import type { SettleIntent } from '@/components/staff/SettlePaymentDialog';
import {
  billStatusTone,
  parseResendResult,
  type BillStatusView,
} from '@/lib/staff/confirmation';
import type { PrintType } from '@/lib/staff/autoPrint';
import type { Order, OrderItem, PaymentMethod } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

const REJECT_REASONS = ['Out of stock', 'Too busy', 'Closing soon', 'Other'];
// Common void reasons (POS-4), mirroring REJECT_REASONS. 'Other' → free text.
const VOID_REASONS = ['Wrong item', 'Customer changed mind', 'Kitchen error', 'Other'];
// Every tender the counter takes — the dining apps (Swiggy Dineout, Zomato
// District) included, since a table that booked through one settles here.
const PAYMENT_METHODS = COUNTER_PAYMENT_METHODS;
const DEFAULT_PREP_MIN = 15;
// A paid order can still be refunded (in full or partially) even after it's
// gone terminal — a manager might refund a completed order over a complaint.
const REFUNDABLE_PAYMENT_STATUSES = ['paid', 'partially_refunded'];
// The non-terminal, pre-settle states in which an open order can still be
// corrected (voided) — mirrors OPEN_STATUSES in the /amend route.
const OPEN_STATUSES: Order['status'][] = ['accepted', 'preparing', 'ready'];

export function OrderDetailModal({
  order,
  defaultPrepMin = DEFAULT_PREP_MIN,
  initialMode,
  onClose,
  onRemind,
  onTransition,
  onPayment,
  onPrint,
  onRefund,
  onVoid,
  onComp,
  onOpenPayment,
}: {
  order: OrderWithItems;
  defaultPrepMin?: number;
  /** Open straight on the reject-reason step (a card's "Reject…" menu item). */
  initialMode?: 'reject';
  onClose: () => void;
  /**
   * Resend the "order ready" WhatsApp (POST /api/orders/[id]/remind). The parent
   * owns the request and the toast; omit to hide the button.
   */
  onRemind?: (o: OrderWithItems) => Promise<void>;
  /**
   * Hands a print to the page-level dock (components/staff/PrintDock). Not a
   * queue owned here: this modal unmounts the moment the staffer closes the
   * order, which used to kill the in-flight job and the failure chip with it.
   */
  onPrint: (orderId: string, type: PrintType) => void;
  onTransition: (o: OrderWithItems, to: Order['status'], extra?: { reason?: string; promised_ready_at?: string }) => void;
  /** Resolves true once the server has recorded the payment. */
  /** `reference`: the booking / transaction ID, required for a dining-app method. */
  onPayment: (o: OrderWithItems, method: PaymentMethod, reference?: string) => Promise<boolean>;
  // Optional — omit to hide the refund panel entirely (e.g. a surface that
  // never shows paid orders). The server route is manager/owner-gated
  // (FND-5) regardless of whether this UI is shown.
  // `method` (REF-1) names which tender to refund. Omit for a single-tender
  // order; required by the server when a split leaves the choice ambiguous.
  onRefund?: (
    o: OrderWithItems,
    amountInr: number,
    reason: string,
    method?: string,
    idempotencyKey?: string,
  ) => Promise<void> | void;
  // Void a wrongly-punched line (POS-4). The /amend route is manager-gated
  // (hasPermission('void_line'), D4) — the UI just exposes the action.
  onVoid?: (o: OrderWithItems, itemId: string, reason: string) => Promise<void> | void;
  // Manager comp (₹0 settle + complete) for an unpaid dine-in at `ready`
  // (POS-2). The /status route is manager-gated server-side.
  onComp?: (o: OrderWithItems, reason: string) => Promise<void> | void;
  /**
   * The full payment step (cash + change, split) for this order: 'settle' an
   * unpaid bill, or 'change' how a paid one was paid (cash → UPI). Omit to
   * hide both buttons.
   */
  onOpenPayment?: (o: OrderWithItems, intent: SettleIntent) => void;
}) {
  useModalDismiss(onClose);
  const [mode, setMode] = useState<'view' | 'accept' | 'reject' | 'refund' | 'void' | 'comp' | 'appRef'>(
    initialMode === 'reject' && order.status === 'received' ? 'reject' : 'view',
  );
  const [prepMin, setPrepMin] = useState(defaultPrepMin);
  const [reasonChoice, setReasonChoice] = useState(REJECT_REASONS[0]);
  const [reasonText, setReasonText] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [refundAmount, setRefundAmount] = useState(order.total_inr ?? order.subtotal_inr);
  const [refundReason, setRefundReason] = useState('');
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  // REF-1: which tender the money goes back on. Empty = let the server decide
  // (correct for the common single-tender order).
  const [refundMethod, setRefundMethod] = useState('');
  // REF-2 — one key per OPEN REFUND PANEL, not per click. A double-tap reuses
  // it so the route replays instead of paying twice; a deliberate second refund
  // means reopening the panel, which mints a fresh one. `guard_refund_total`
  // caps the total but does not deduplicate, so this is the only thing standing
  // between a laggy tablet and a double payout.
  const refundKeyRef = useRef<string>('');
  const [tenders, setTenders] = useState<{ method: string; amount_inr: number }[]>([]);
  // Void panel state (POS-4): which line, and the picked/typed reason.
  const [voidItemId, setVoidItemId] = useState<string | null>(null);
  const [voidReasonChoice, setVoidReasonChoice] = useState(VOID_REASONS[0]);
  const [voidReasonText, setVoidReasonText] = useState('');
  const [voidSubmitting, setVoidSubmitting] = useState(false);
  // Comp panel state (POS-2): the manager's reason.
  const [compReason, setCompReason] = useState('');
  const [compSubmitting, setCompSubmitting] = useState(false);

  // Prep/handover checklist (R5): while preparing or ready, each line item is
  // tickable so staff verify it's made with the right variant/addons/notes.
  // Persisted to localStorage per order so it survives a refresh on the tablet.
  const checklistMode = order.status === 'preparing' || order.status === 'ready';
  const [checked, setChecked] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem(`hioc:checklist:${order.id}`);
      setChecked(raw ? new Set(JSON.parse(raw) as string[]) : new Set());
    } catch {
      setChecked(new Set());
    }
  }, [order.id]);
  const toggleChecked = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(`hioc:checklist:${order.id}`, JSON.stringify([...next]));
      } catch {
        /* private mode / quota — non-fatal */
      }
      return next;
    });
  };

  // Pickup-code verification at handover (CUS-056): the customer reads out the
  // code on their status page; staff type it to confirm they're handing the
  // order to the right person. Empty = skip (fast path); mismatch is overridable.
  const enteredCode = codeInput.trim();
  const codeMatches = enteredCode.length > 0 && enteredCode === (order.pickup_code ?? '');
  const codeMismatch = enteredCode.length > 0 && !codeMatches;

  // HIOC Ritual: the SALE of a pass is a payment, not food. It has no kitchen
  // steps (no accept/reject, prep, ready, handover, KOT or token — the status API
  // refuses them too), so this view keeps only what applies to money: payment,
  // receipt and refund, plus cancelling it while it is still unpaid.
  const ritualSale = isRitualSale(order);
  const next = ritualSale ? undefined : PRIMARY_NEXT[order.status];
  const isNew = !ritualSale && order.status === 'received';
  const isActive = ['received', 'accepted', 'preparing', 'ready'].includes(order.status);
  const canRefund = Boolean(onRefund) && REFUNDABLE_PAYMENT_STATUSES.includes(order.payment_status);

  // Phase-3 dine-in / correction context. Money is never computed here — the
  // Total always comes from order.total_inr (server-recomputed on void/settle).
  const isDineIn = order.order_type === 'dine_in';
  const isPaid = order.payment_status === 'paid';
  const isOpen = OPEN_STATUSES.includes(order.status);
  // A line is voidable when the order is open and unpaid (POS-4). The /amend
  // route re-checks this + the manager permission; the button is a convenience.
  const canVoidLine = Boolean(onVoid) && isOpen && !isPaid && !ritualSale;
  // Voided lines survive for audit but drop out of the checklist denominator.
  const activeItems = order.items.filter((i) => !i.voided);
  const voidTarget = voidItemId ? order.items.find((i) => i.id === voidItemId) : undefined;

  // Print KOT / receipt / token (KOT-1, KOT-2). PRT-1: the staff-gated 80mm print
  // page is mounted in a hidden same-origin iframe instead of a new tab — the
  // queue prints one job at a time (concurrent window.print() calls race and one
  // vanishes) and raises a failure line if a job doesn't report back in 10s.
  // Token is only meaningful for a walk-in takeaway (it has a pickup_code);
  // receipt suits dine-in and settled orders.
  // PRT-3: the queue, the iframe and the failure chip live at PAGE level now
  // (components/staff/PrintDock). They used to be here, which meant closing this
  // modal — Escape, a backdrop tap, or just getting back to the board — silently
  // cancelled an in-flight print and destroyed the shift's failure tally along
  // with the Retry buttons. `onPrint` hands the job to the dock and returns.
  const openPrint = (type: 'kot' | 'receipt' | 'token') => {
    onPrint(order.id, type);
  };
  const canPrintToken = !ritualSale && order.order_type === 'takeaway' && Boolean(order.pickup_code);
  const ritualRow = ritualBillRow(order, cupsOnOrder(order.items));

  // POS4-3 + DEV-3 — the same three-way resolution the POS uses, through the
  // same hook, so settling from the queue prints exactly what settling from the
  // counter prints. A machine set to "never print" must mean it whichever button
  // was used; two copies of this rule is how that stops being true.
  const { autoPrint } = useCounterDefaults();

  // Every "mark paid" tap goes through here so the print rule can't differ per
  // button. No KOT here: the kitchen got its ticket at placement, and a second
  // one at payment time reads as a second order on the rail.
  //
  // PRT-1 removed the reason the print had to fire before the settle: an iframe
  // isn't a pop-up, so nothing has to happen inside the click any more. It still
  // does, because `onPayment` is fire-and-forget (the parent owns the request)
  // and this component has no way to learn that the settle succeeded.
  // PRN-6 / DRW-1 — the drawer opens on the Cash tap itself, alongside the
  // settle rather than after it: the staffer is holding the customer's notes
  // now. If the settle then fails, the order stays unpaid on the board and is
  // settled again — the cash is already in the right place. No-op outside the
  // desktop app or with no drawer printer configured; a drawer failure is a
  // small note, never blocking.
  const [drawerNote, setDrawerNote] = useState<string | null>(null);
  // A dining-app settle first asks for the platform's booking ID (mode
  // 'appRef'); the server refuses one without it, or one already on another bill.
  const [appMethod, setAppMethod] = useState<PaymentMethod>('swiggy_dineout');
  const [appRef, setAppRef] = useState('');
  const [appBusy, setAppBusy] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const appRefParsed = parsePaymentReference(appRef);
  const confirmAppSettle = async () => {
    if (!appRefParsed.ok || appBusy) return;
    setAppBusy(true);
    setAppError(null);
    const ok = await onPayment(order, appMethod, appRefParsed.reference);
    setAppBusy(false);
    if (!ok) {
      setAppError('Not recorded — check the booking ID and try again.');
      return;
    }
    for (const type of settlePrintPlan(autoPrint, { orderKind: order.order_kind })) openPrint(type);
    setMode('view');
  };

  // The booking IDs recorded on this order's dining-app tenders, so staff can
  // read one back to a diner or the owner. Only fetched for an order that has
  // an app tender — the queue shouldn't pay for it on every card.
  const hasAppTender =
    isAppPaymentMethod(order.payment_method) || (order.payments ?? []).some((p) => isAppPaymentMethod(p.method));
  const [appRefs, setAppRefs] = useState<{ method: string; reference: string }[]>([]);
  useEffect(() => {
    if (!hasAppTender || order.payment_status === 'unpaid') {
      setAppRefs([]);
      return;
    }
    let cancelled = false;
    fetch(`/api/orders/${order.id}/payment`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { tenders: [] }))
      .then((d: { tenders?: { method: string; reference?: string | null }[] }) => {
        if (cancelled) return;
        setAppRefs(
          (d.tenders ?? [])
            .filter((t): t is { method: string; reference: string } => Boolean(t.reference))
            .map((t) => ({ method: t.method, reference: t.reference })),
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [hasAppTender, order.id, order.payment_status, order.payment_method]);

  const settle = (method: PaymentMethod) => {
    if (isAppPaymentMethod(method)) {
      setAppMethod(method);
      setAppRef('');
      setAppError(null);
      setMode('appRef');
      return;
    }
    for (const type of settlePrintPlan(autoPrint, { orderKind: order.order_kind })) openPrint(type);
    setDrawerNote(null);
    void openDrawerIfCash([{ method }], { orderId: order.id }).then((err) => {
      if (err) setDrawerNote(err);
    });
    void onPayment(order, method);
  };

  // Resend the bill (BILL-4) — wires up the RCT-1 route that shipped with no
  // caller. Only offered when the order actually has somewhere to send to;
  // otherwise the honest answer is "capture a number", not a button that fails.
  const canResendBill = Boolean(order.customer_phone || order.customer_email);
  const [resending, setResending] = useState(false);
  // WA-5: the same BillStatusView the POS confirmation renders, so "sent" and
  // "delivered" don't quietly become the same word on this screen.
  const [resendResult, setResendResult] = useState<BillStatusView | null>(null);

  const doResendBill = async () => {
    if (resending) return;
    setResending(true);
    setResendResult(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/resend-bill`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      // Shared with the POS confirmation (POS4-4) so a resend can't be reported
      // two different ways on two screens — including the honest "nothing sent".
      setResendResult(parseResendResult(res.ok, data));
    } catch {
      setResendResult({
        state: 'failed',
        ok: false,
        message: 'Network error — please try again.',
        failedChannels: [],
      });
    } finally {
      setResending(false);
    }
  };

  const doAccept = () => {
    const promised = new Date(Date.now() + prepMin * 60_000).toISOString();
    onTransition(order, 'accepted', { promised_ready_at: promised });
  };
  const doReject = () => {
    const reason = reasonChoice === 'Other' ? reasonText.trim() : reasonChoice;
    if (!reason) return;
    onTransition(order, 'rejected', { reason });
  };
  // Load the tender breakdown only when the refund panel opens — a split order
  // needs a choice, a single-tender one doesn't, and the queue shouldn't pay for
  // this query on every card.
  useEffect(() => {
    if (mode !== 'refund') return;
    refundKeyRef.current =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? `refund-${crypto.randomUUID()}`
        : `refund-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    let cancelled = false;
    fetch(`/api/orders/${order.id}/payment`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { tenders: [] }))
      .then((d: { tenders?: { method: string; amount_inr: number }[] }) => {
        if (cancelled) return;
        const list = d.tenders ?? [];
        setTenders(list);
        // Preselect when there's no ambiguity, so the common case stays one tap.
        if (list.length === 1) setRefundMethod(list[0].method);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mode, order.id]);

  const doRefund = async () => {
    if (!onRefund || refundAmount <= 0 || !refundReason.trim()) return;
    setRefundSubmitting(true);
    try {
      await onRefund(order, refundAmount, refundReason.trim(), refundMethod || undefined, refundKeyRef.current);
      setMode('view');
    } finally {
      setRefundSubmitting(false);
    }
  };
  const startVoid = (itemId: string) => {
    setVoidItemId(itemId);
    setVoidReasonChoice(VOID_REASONS[0]);
    setVoidReasonText('');
    setMode('void');
  };
  const doVoid = async () => {
    if (!onVoid || !voidItemId) return;
    const reason = voidReasonChoice === 'Other' ? voidReasonText.trim() : voidReasonChoice;
    if (!reason) return;
    setVoidSubmitting(true);
    try {
      await onVoid(order, voidItemId, reason);
      setMode('view');
      setVoidItemId(null);
    } finally {
      setVoidSubmitting(false);
    }
  };
  const doComp = async () => {
    if (!onComp || !compReason.trim()) return;
    setCompSubmitting(true);
    try {
      await onComp(order, compReason.trim());
      setMode('view');
    } finally {
      setCompSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div
        className="max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-xl bg-cream p-6 shadow-xl sm:rounded-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-bold text-charcoal">#{formatOrderNumber(order.order_number)}</h2>
            <p className="text-xs text-muted">
              {STATUS_LABELS[order.status]} · {ritualSale ? RITUAL_SALE_LABEL : order.order_type}
              {isDineIn && order.table_label ? ` · ${order.table_label}` : ''} · placed{' '}
              {formatIstTime(new Date(order.created_at))}
            </p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-muted hover:text-charcoal">×</button>
        </div>

        <div className="mt-3 text-sm text-charcoal">
          <p className="font-bold">{order.customer_name || (isDineIn ? 'Walk-in' : 'Guest')}</p>
          {order.customer_phone ? (
            <a href={`tel:${order.customer_phone}`} className="text-tan-dark hover:underline">{order.customer_phone}</a>
          ) : null}
          {ritualSale ? null : isDineIn ? (
            order.table_label ? <p className="mt-1 text-xs text-muted">Table: {order.table_label}</p> : null
          ) : (
            <p className="mt-1 text-xs text-muted">Pickup: {order.pickup_slot_label || order.pickup_time}</p>
          )}
          {!ritualSale && !isDineIn && order.pickup_code ? <p className="text-xs text-muted">Code: {order.pickup_code}</p> : null}
          {!ritualSale && order.promised_ready_at ? (
            <p className="text-xs text-muted">ETA: ~{formatIstTime(new Date(order.promised_ready_at))}</p>
          ) : null}
          {ritualSale ? null : (
            <p className="text-xs text-muted">
              Elapsed{' '}
              <ElapsedTime since={order.created_at} className="font-bold" warnAfterMin={10} dangerAfterMin={20} />
              {' '}· in {STATUS_LABELS[order.status]}{' '}
              <ElapsedTime since={order.updated_at} />
            </p>
          )}
        </div>

        {checklistMode ? (
          <p className="mt-4 flex items-center justify-between text-xs font-bold uppercase tracking-wide text-charcoal">
            <span>{order.status === 'ready' ? 'Handover checklist' : 'Prep checklist'}</span>
            <span className={checked.size === activeItems.length ? 'text-[#2f6b38]' : 'text-tan-dark'}>
              {checked.size}/{activeItems.length} verified
            </span>
          </p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-2 border-t border-line pt-3 text-sm text-charcoal">
          {order.items.map((item) => {
            const isChecked = checklistMode && !item.voided && checked.has(item.id);
            const struck = item.voided || isChecked;
            const detail = (
              <>
                <div className="flex justify-between gap-2">
                  <span className={struck ? 'text-muted line-through' : ''}>
                    {item.quantity}× {item.name_snapshot}
                    {item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : ''}
                  </span>
                  <span className={'shrink-0 font-bold' + (item.voided ? ' text-muted line-through' : '')}>
                    ₹{item.line_total_inr}
                  </span>
                </div>
                {item.voided ? (
                  <p className="text-xs font-bold text-red-600">
                    Voided{item.void_reason ? ` — ${item.void_reason}` : ''}
                  </p>
                ) : null}
                {/* HIOC Ritual cups that paid for part of this line. */}
                {!item.voided && (item.pass_drinks ?? 0) > 0 ? (
                  <p className="text-xs font-bold text-tan-dark">
                    Ritual ×{item.pass_drinks} · ₹{item.pass_covered_inr ?? 0} covered
                  </p>
                ) : null}
                {item.addons.length > 0 ? (
                  <p className="text-xs text-muted">+ {item.addons.map((a) => a.option_name_snapshot).join(', ')}</p>
                ) : null}
                {item.special_instructions ? (
                  <p className="text-xs italic text-tan-dark">Note: {item.special_instructions}</p>
                ) : null}
              </>
            );
            return (
              <li key={item.id} className="flex items-start gap-2">
                {checklistMode && !item.voided ? (
                  <label className="flex flex-1 cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleChecked(item.id)}
                      className="mt-1 h-4 w-4 shrink-0 accent-tan"
                    />
                    <span className="flex-1">{detail}</span>
                  </label>
                ) : (
                  <div className="flex-1">{detail}</div>
                )}
                {mode === 'view' && canVoidLine && !item.voided ? (
                  <button
                    type="button"
                    onClick={() => startVoid(item.id)}
                    className="-my-1 min-h-[36px] shrink-0 rounded-md border border-red-200 px-3 text-xs font-bold text-red-700 hover:bg-red-50"
                  >
                    Void
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>

        {/* What HIOC Ritual cups covered, ahead of the total they came off (the
            server's own figure — the bill's other rows live on the receipt). */}
        {ritualRow ? (
          <div className="mt-3 flex justify-between border-t border-line pt-2 text-sm text-charcoal">
            <span>{ritualRow.label}</span>
            <span className="font-mono tabular-nums">-₹{Math.abs(ritualRow.value)}</span>
          </div>
        ) : null}
        <div className={'flex justify-between text-sm ' + (ritualRow ? 'pt-1' : 'mt-3 border-t border-line pt-2')}>
          <span className="font-bold text-charcoal">Total</span>
          <span className="font-bold text-tan-dark">₹{order.total_inr ?? order.subtotal_inr}</span>
        </div>
        {order.notes ? <p className="mt-2 text-sm italic text-muted">Order note: {order.notes}</p> : null}

        {/* Print row (KOT-1 / KOT-2). Unobtrusive — sits above the transition
            actions and never blocks them. KOT is available for any order (reprint
            is the same route); receipt/token open the 80mm print page. */}
        <div className="mt-3 flex flex-wrap gap-2 border-t border-line pt-3">
          {/* No kitchen ticket for the sale of a HIOC Ritual — only a receipt. */}
          {ritualSale ? null : (
            <button
              type="button"
              onClick={() => openPrint('kot')}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan hover:text-tan-dark"
            >
              Print KOT
            </button>
          )}
          <button
            type="button"
            onClick={() => openPrint('receipt')}
            className="rounded-md border border-line px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan hover:text-tan-dark"
          >
            Print receipt
          </button>
          {canPrintToken ? (
            <button
              type="button"
              onClick={() => openPrint('token')}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan hover:text-tan-dark"
            >
              Print token
            </button>
          ) : null}
          {/* BILL-4: the resend route has existed since RCT-1 with nothing calling
              it. Shown only when there's somewhere to send. */}
          {canResendBill ? (
            <button
              type="button"
              onClick={doResendBill}
              disabled={resending}
              className="rounded-md border border-line px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan hover:text-tan-dark disabled:opacity-50"
            >
              {resending ? 'Sending…' : 'Resend bill'}
            </button>
          ) : null}
        </div>

        {resendResult ? (
          <p
            role="status"
            className={
              'mt-2 text-xs font-bold ' +
              (billStatusTone(resendResult) === 'good'
                ? 'text-green-700'
                : billStatusTone(resendResult) === 'wait'
                  ? 'text-charcoal'
                  : 'text-red-700')
            }
          >
            {resendResult.message}
          </p>
        ) : null}

        {/* Actions */}
        {mode === 'appRef' ? (
          <div className="mt-5 rounded-md border border-line p-4">
            <p className="text-sm font-bold text-charcoal">
              {PAYMENT_METHOD_LABEL[appMethod] ?? appMethod} — ₹{order.total_inr ?? order.subtotal_inr}
            </p>
            <label htmlFor="detail-app-ref" className="mt-3 block text-xs font-bold uppercase tracking-wide text-muted">
              {PAYMENT_REFERENCE_LABEL}
            </label>
            <input
              id="detail-app-ref"
              value={appRef}
              onChange={(e) => {
                setAppRef(e.target.value);
                setAppError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void confirmAppSettle();
              }}
              autoFocus
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              maxLength={60}
              placeholder="From the diner's booking screen"
              className="mt-1 w-full rounded-md border border-line px-3 py-2.5 text-base font-bold uppercase tracking-wide outline-none focus:border-tan"
            />
            {appError || (appRef.trim() && !appRefParsed.ok) ? (
              <p role="alert" className="mt-1 text-xs text-red-700">
                {appError ?? (appRefParsed.ok ? '' : appRefParsed.error)}
              </p>
            ) : (
              <p className="mt-1 text-xs text-muted">
                Check it on the diner&rsquo;s app or the partner app — it&rsquo;s how the payout is matched.
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <button
                onClick={() => void confirmAppSettle()}
                disabled={!appRefParsed.ok || appBusy}
                className="flex-1 rounded-md bg-tan-dark py-2 font-bold text-cream hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-50"
              >
                {appBusy ? 'Recording…' : 'Confirm settle'}
              </button>
              <button onClick={() => setMode('view')} className="rounded-md border border-line px-4 py-2 text-muted">Back</button>
            </div>
          </div>
        ) : mode === 'accept' ? (
          <div className="mt-5 rounded-md border border-line p-4">
            <p className="text-sm font-bold text-charcoal">Ready in</p>
            <div className="mt-2 flex items-center gap-3">
              <button onClick={() => setPrepMin((m) => Math.max(5, m - 5))} className="h-9 w-9 rounded-md border border-line font-bold">−</button>
              <span className="w-24 text-center font-bold text-charcoal">{prepMin} min</span>
              <button onClick={() => setPrepMin((m) => m + 5)} className="h-9 w-9 rounded-md border border-line font-bold">+</button>
            </div>
            <p className="mt-1 text-xs text-muted">~{formatIstTime(new Date(Date.now() + prepMin * 60_000))}</p>
            <div className="mt-3 flex gap-2">
              <button onClick={doAccept} className="flex-1 rounded-md bg-tan-dark py-2 font-bold text-cream hover:bg-tan-darker">Confirm Accept</button>
              <button onClick={() => setMode('view')} className="rounded-md border border-line px-4 py-2 text-muted">Back</button>
            </div>
          </div>
        ) : mode === 'refund' ? (
          <div className="mt-5 rounded-md border border-red-200 p-4">
            <p className="text-sm font-bold text-charcoal">Refund (manager)</p>
            <p className="mt-1 text-xs text-muted">
              {order.payment_method === 'online'
                ? 'Issues a refund via the payment gateway. Adjust the amount for a partial refund.'
                : 'Records a refund given at the counter. Cash comes out of the drawer; UPI and card are reversed on the terminal.'}
            </p>

            {/* REF-1: a split order must be told WHICH tender to refund — you
                can't hand back more cash than the customer paid in cash. */}
            {tenders.length > 1 ? (
              <>
                <label className="mt-3 block text-xs font-bold text-charcoal">Refund on</label>
                <div className="mt-1 flex flex-wrap gap-2">
                  {tenders.map((t) => (
                    <button
                      key={t.method}
                      type="button"
                      onClick={() => {
                        setRefundMethod(t.method);
                        setRefundAmount(t.amount_inr);
                      }}
                      className={
                        'rounded-md border px-3 py-1.5 text-xs font-bold transition-colors ' +
                        (refundMethod === t.method
                          ? 'border-tan bg-tan-dark text-cream'
                          : 'border-line text-charcoal hover:border-tan')
                      }
                    >
                      {PAYMENT_METHOD_LABEL[t.method] ?? t.method} · ₹{t.amount_inr}
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            {ritualSale ? (
              <p className="mt-2 rounded-md bg-surface px-3 py-2 text-xs font-bold text-charcoal">
                Refunding cancels the pass. A Ritual that has already been used can’t be refunded.
              </p>
            ) : null}

            <label className="mt-3 block text-xs font-bold text-charcoal">Amount (₹)</label>
            <input
              type="number"
              min={1}
              max={order.total_inr ?? order.subtotal_inr}
              value={refundAmount}
              onChange={(e) => setRefundAmount(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-line p-2 text-sm"
            />
            <label className="mt-3 block text-xs font-bold text-charcoal">Reason</label>
            <input
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              placeholder="e.g. Order cancelled after payment"
              className="mt-1 w-full rounded-md border border-line p-2 text-sm"
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={doRefund}
                disabled={refundSubmitting || refundAmount <= 0 || !refundReason.trim()}
                className="flex-1 rounded-md bg-red-600 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {refundSubmitting ? 'Refunding…' : `Refund ₹${refundAmount}`}
              </button>
              <button onClick={() => setMode('view')} className="rounded-md border border-line px-4 py-2 text-muted">Back</button>
            </div>
          </div>
        ) : mode === 'void' ? (
          <div className="mt-5 rounded-md border border-red-200 p-4">
            <p className="text-sm font-bold text-charcoal">Void line (manager)</p>
            {voidTarget ? (
              <p className="mt-1 text-xs text-muted">
                {voidTarget.quantity}× {voidTarget.name_snapshot}
                {voidTarget.variant_label_snapshot ? ` (${voidTarget.variant_label_snapshot})` : ''} · ₹{voidTarget.line_total_inr}
              </p>
            ) : null}
            <p className="mt-1 text-xs text-muted">
              Drops this line from the bill (recomputed server-side). The line is kept, struck-through, for the audit trail.
            </p>
            <label className="mt-3 block text-xs font-bold text-charcoal">Reason</label>
            <select
              value={voidReasonChoice}
              onChange={(e) => setVoidReasonChoice(e.target.value)}
              className="mt-1 w-full rounded-md border border-line p-2 text-sm"
            >
              {VOID_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            {voidReasonChoice === 'Other' ? (
              <input
                value={voidReasonText}
                onChange={(e) => setVoidReasonText(e.target.value)}
                placeholder="Reason…"
                className="mt-2 w-full rounded-md border border-line p-2 text-sm"
              />
            ) : null}
            <div className="mt-3 flex gap-2">
              <button
                onClick={doVoid}
                disabled={voidSubmitting || (voidReasonChoice === 'Other' && !voidReasonText.trim())}
                className="flex-1 rounded-md bg-red-600 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {voidSubmitting ? 'Voiding…' : 'Void line'}
              </button>
              <button
                onClick={() => { setMode('view'); setVoidItemId(null); }}
                className="rounded-md border border-line px-4 py-2 text-muted"
              >
                Back
              </button>
            </div>
          </div>
        ) : mode === 'comp' ? (
          <div className="mt-5 rounded-md border border-line p-4">
            <p className="text-sm font-bold text-charcoal">Comp order (manager)</p>
            <p className="mt-1 text-xs text-muted">
              Completes this order at ₹0 without collecting payment. Manager-authorized and audited.
            </p>
            <label className="mt-3 block text-xs font-bold text-charcoal">Reason</label>
            <input
              value={compReason}
              onChange={(e) => setCompReason(e.target.value)}
              placeholder="e.g. Service recovery — spilled order"
              className="mt-1 w-full rounded-md border border-line p-2 text-sm"
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={doComp}
                disabled={compSubmitting || !compReason.trim()}
                className="flex-1 rounded-md bg-charcoal py-2 font-bold text-cream hover:opacity-90 disabled:opacity-50"
              >
                {compSubmitting ? 'Comping…' : 'Comp & complete'}
              </button>
              <button onClick={() => setMode('view')} className="rounded-md border border-line px-4 py-2 text-muted">Back</button>
            </div>
          </div>
        ) : mode === 'reject' ? (
          <div className="mt-5 rounded-md border border-red-200 p-4">
            <p className="text-sm font-bold text-charcoal">Reject reason</p>
            <select value={reasonChoice} onChange={(e) => setReasonChoice(e.target.value)} className="mt-2 w-full rounded-md border border-line p-2 text-sm">
              {REJECT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            {reasonChoice === 'Other' ? (
              <input value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder="Reason…" className="mt-2 w-full rounded-md border border-line p-2 text-sm" />
            ) : null}
            <div className="mt-3 flex gap-2">
              <button onClick={doReject} className="flex-1 rounded-md bg-red-600 py-2 font-bold text-white hover:bg-red-700">Confirm Reject</button>
              <button onClick={() => setMode('view')} className="rounded-md border border-line px-4 py-2 text-muted">Back</button>
            </div>
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-2">
            {isNew ? (
              <div className="flex gap-2">
                <button onClick={() => setMode('accept')} className="flex-1 rounded-md bg-tan-dark py-2.5 font-bold text-cream hover:bg-tan-darker">Accept</button>
                <button onClick={() => setMode('reject')} className="flex-1 rounded-md border border-red-300 py-2.5 font-bold text-red-700 hover:bg-red-50">Reject</button>
              </div>
            ) : null}
            {order.status === 'ready' ? (
              isDineIn ? (
                // Dine-in settle & complete (POS-2). Unpaid → collect via
                // onPayment then complete (server blocks completion until paid,
                // FND3-5); paid → complete in one tap. Comp is the ₹0 manager
                // override. Money shown is server-authoritative (order.total_inr).
                <div className="rounded-md border border-line p-4">
                  <p className="text-sm font-bold text-charcoal">Settle &amp; complete</p>
                  <p className="text-xs text-muted">
                    {order.table_label ? `Table ${order.table_label} · ` : ''}₹{order.total_inr ?? order.subtotal_inr} due
                  </p>
                  {isPaid ? (
                    <button
                      onClick={() => onTransition(order, 'completed')}
                      className="mt-3 w-full rounded-md bg-green-600 py-2.5 font-bold text-cream hover:bg-green-700"
                    >
                      Complete
                    </button>
                  ) : (
                    <>
                      <p className="mt-2 text-xs text-muted">Collect payment to settle, then complete.</p>
                      <div className="mt-2 grid grid-cols-3 gap-2">
                        {PAYMENT_METHODS.map((m) => (
                          <button
                            key={m}
                            onClick={() => settle(m)}
                            className="rounded-md border border-line px-1 py-2 text-xs font-bold uppercase text-charcoal hover:border-tan hover:text-tan-dark"
                          >
                            {PAYMENT_METHOD_LABEL[m] ?? m}
                          </button>
                        ))}
                      </div>
                      <button
                        disabled
                        title="Settle the bill first"
                        className="mt-3 w-full cursor-not-allowed rounded-md bg-tan/40 py-2.5 font-bold text-cream"
                      >
                        Complete (settle first)
                      </button>
                      {onComp ? (
                        <button
                          onClick={() => { setCompReason(''); setMode('comp'); }}
                          className="mt-2 w-full rounded-md border border-line py-1.5 text-xs font-bold text-charcoal hover:border-tan"
                        >
                          Comp (₹0, manager)
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              ) : !isPaid ? (
                // Takeaway / delivery / web pay-at-counter: completing now
                // requires payment too (the ready → completed guard), so the
                // money is collected here BEFORE the pickup-code check.
                <div className="rounded-md border border-red-200 bg-red-50/40 p-4">
                  <p className="text-sm font-bold text-charcoal">Collect payment</p>
                  <p className="text-xs text-muted">
                    ₹{order.total_inr ?? order.subtotal_inr} due · the order can be handed over once it&apos;s paid.
                  </p>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {PAYMENT_METHODS.map((m) => (
                      <button
                        key={m}
                        onClick={() => settle(m)}
                        className="rounded-md border border-line bg-cream px-1 py-2 text-xs font-bold uppercase text-charcoal hover:border-tan hover:text-tan-dark"
                      >
                        {PAYMENT_METHOD_LABEL[m] ?? m}
                      </button>
                    ))}
                  </div>
                  <button
                    disabled
                    title="Collect payment first"
                    className="mt-3 w-full cursor-not-allowed rounded-md bg-tan/40 py-2.5 font-bold text-cream"
                  >
                    Complete (collect payment first)
                  </button>
                  {onComp ? (
                    <button
                      onClick={() => { setCompReason(''); setMode('comp'); }}
                      className="mt-2 w-full rounded-md border border-line py-1.5 text-xs font-bold text-charcoal hover:border-tan"
                    >
                      Comp (₹0, manager)
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="rounded-md border border-line p-4">
                  <p className="text-sm font-bold text-charcoal">Verify pickup code</p>
                  <p className="text-xs text-muted">Ask the customer for the code shown on their order page.</p>
                  <input
                    value={codeInput}
                    onChange={(e) => setCodeInput(e.target.value)}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="e.g. 1608"
                    className="mt-2 w-full rounded-md border border-line p-2 text-center text-lg tracking-[0.3em]"
                  />
                  {codeMismatch ? <p className="mt-1 text-xs font-bold text-red-600">Code doesn&apos;t match this order.</p> : null}
                  {codeMatches ? <p className="mt-1 text-xs font-bold text-green-600">Code matches ✓</p> : null}
                  <button
                    onClick={() => onTransition(order, 'completed')}
                    disabled={codeMismatch}
                    className={
                      'mt-3 w-full rounded-md py-2.5 font-bold text-cream disabled:opacity-40 ' +
                      (codeMatches ? 'bg-green-600 hover:bg-green-700' : 'bg-tan-dark hover:bg-tan-darker')
                    }
                  >
                    {codeMatches ? 'Verify & complete pickup' : 'Complete pickup'}
                  </button>
                  {codeMismatch ? (
                    <button onClick={() => onTransition(order, 'completed')} className="mt-1 w-full text-xs text-muted underline">
                      Complete anyway (override)
                    </button>
                  ) : null}
                </div>
              )
            ) : next && !isNew ? (
              <button onClick={() => onTransition(order, next)} className="rounded-md bg-tan-dark py-2.5 font-bold text-cream hover:bg-tan-darker">
                Mark {STATUS_LABELS[next]}
              </button>
            ) : null}
            {onRemind && canRemind(order) ? (
              <PickupReminderButton
                remindedAt={order.pickup_reminded_at}
                onRemind={() => onRemind(order)}
              />
            ) : null}
            {ritualSale ? (
              // The one status move the API allows on a pass sale: cancelling it
              // while nothing has been paid. A paid one is refunded instead.
              isSettleable(order) ? (
                <button
                  onClick={() => {
                    if (window.confirm(`Cancel this ${RITUAL_SALE_LABEL}? The customer hasn’t paid for it yet.`)) {
                      onTransition(order, 'cancelled', { reason: 'Cancelled by staff' });
                    }
                  }}
                  className="min-h-[44px] rounded-md border border-line py-2 text-sm font-bold text-muted hover:text-red-700"
                >
                  Cancel sale
                </button>
              ) : null
            ) : isActive && !isNew && order.status !== 'ready' ? (
              <button onClick={() => onTransition(order, 'cancelled', { reason: 'Cancelled by staff' })} className="rounded-md border border-line py-2 text-sm font-bold text-muted hover:text-red-700">
                Cancel order
              </button>
            ) : null}

            {/* Mark payment (S7). The settle / collect-payment section above
                already surfaces the Cash/UPI/Card buttons at `ready` (every
                order type), so suppress the duplicate set there; keep them for
                every other open state. */}
            <div className="mt-2 border-t border-line pt-3">
              <p className="text-xs text-muted">
                Payment:{' '}
                <span className="font-bold text-charcoal">
                  {order.payment_status}
                  {order.payment_method ? ` (${describeOrderPayment(order)})` : ''}
                </span>
              </p>
              {appRefs.map((r) => (
                <p key={`${r.method}-${r.reference}`} className="text-xs text-muted">
                  {PAYMENT_METHOD_LABEL[r.method] ?? r.method} ID:{' '}
                  <span className="font-mono font-bold text-charcoal">{r.reference}</span>
                </p>
              ))}
              {order.payment_status !== 'paid' && order.status !== 'ready' ? (
                <div className="mt-2 grid grid-cols-3 gap-2">
                  {PAYMENT_METHODS.map((m) => (
                    <button key={m} onClick={() => settle(m)} className="rounded-md border border-line px-1 py-1.5 text-xs font-bold uppercase text-charcoal hover:border-tan hover:text-tan-dark">
                      {PAYMENT_METHOD_LABEL[m] ?? m}
                    </button>
                  ))}
                </div>
              ) : null}
              {onOpenPayment && isSettleable(order) ? (
                <button
                  onClick={() => onOpenPayment(order, 'settle')}
                  className="mt-2 w-full rounded-md border border-line py-1.5 text-xs font-bold text-charcoal hover:border-tan hover:text-tan-dark"
                >
                  Split or cash with change…
                </button>
              ) : null}
              {onOpenPayment && canChangePayment(order) ? (
                <button
                  onClick={() => onOpenPayment(order, 'change')}
                  className="mt-2 w-full rounded-md border border-line py-1.5 text-xs font-bold text-charcoal hover:border-tan hover:text-tan-dark"
                >
                  Change payment
                </button>
              ) : null}
              {/* Refund (PAY-3/FND-2) — server route is manager/owner-gated
                  (FND-5); shown here whenever the order has a captured
                  payment left to refund. */}
              {canRefund ? (
                <button
                  onClick={() => setMode('refund')}
                  className="mt-2 w-full rounded-md border border-red-200 py-1.5 text-xs font-bold text-red-700 hover:bg-red-50"
                >
                  Refund (manager)
                </button>
              ) : null}
              {drawerNote ? <p className="mt-2 text-xs font-bold text-red-700">{drawerNote}</p> : null}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
