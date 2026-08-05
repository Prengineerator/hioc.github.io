'use client';

// Order detail + actions (S3 · POS-2 · POS-4). Shows everything about one order
// and exposes the legal transitions: Accept (with an adjustable ready ETA),
// Reject (with a required reason), the forward steps, Cancel, mark-payment
// (S7/STF-041), the manager-gated Refund (FND-5), and — Phase-3 — the dine-in
// Settle & complete / Comp flow (POS-2) plus per-line Void (POS-4). The parent
// owns the API calls (optimistic update + refetch); this is pure UI. Server
// routes enforce authz (§5.2) — the UI only exposes the actions.

import { useEffect, useState } from 'react';
import { ElapsedTime } from '@/components/staff/ElapsedTime';
import { useModalDismiss } from '@/lib/hooks/useModalDismiss';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import { PRIMARY_NEXT, STATUS_LABELS } from '@/lib/orders/stateMachine';
import { describeBillOutcome } from '@/lib/notifications/reasons';
import type { Order, OrderItem, PaymentMethod } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

const REJECT_REASONS = ['Out of stock', 'Too busy', 'Closing soon', 'Other'];
// Common void reasons (POS-4), mirroring REJECT_REASONS. 'Other' → free text.
const VOID_REASONS = ['Wrong item', 'Customer changed mind', 'Kitchen error', 'Other'];
const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'upi', 'card'];
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
  onClose,
  onTransition,
  onPayment,
  onRefund,
  onVoid,
  onComp,
}: {
  order: OrderWithItems;
  defaultPrepMin?: number;
  onClose: () => void;
  onTransition: (o: OrderWithItems, to: Order['status'], extra?: { reason?: string; promised_ready_at?: string }) => void;
  onPayment: (o: OrderWithItems, method: PaymentMethod) => void;
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
  ) => Promise<void> | void;
  // Void a wrongly-punched line (POS-4). The /amend route is manager-gated
  // (hasPermission('void_line'), D4) — the UI just exposes the action.
  onVoid?: (o: OrderWithItems, itemId: string, reason: string) => Promise<void> | void;
  // Manager comp (₹0 settle + complete) for an unpaid dine-in at `ready`
  // (POS-2). The /status route is manager-gated server-side.
  onComp?: (o: OrderWithItems, reason: string) => Promise<void> | void;
}) {
  useModalDismiss(onClose);
  const [mode, setMode] = useState<'view' | 'accept' | 'reject' | 'refund' | 'void' | 'comp'>('view');
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

  const next = PRIMARY_NEXT[order.status];
  const isNew = order.status === 'received';
  const isActive = ['received', 'accepted', 'preparing', 'ready'].includes(order.status);
  const canRefund = Boolean(onRefund) && REFUNDABLE_PAYMENT_STATUSES.includes(order.payment_status);

  // Phase-3 dine-in / correction context. Money is never computed here — the
  // Total always comes from order.total_inr (server-recomputed on void/settle).
  const isDineIn = order.order_type === 'dine_in';
  const isPaid = order.payment_status === 'paid';
  const isOpen = OPEN_STATUSES.includes(order.status);
  // A line is voidable when the order is open and unpaid (POS-4). The /amend
  // route re-checks this + the manager permission; the button is a convenience.
  const canVoidLine = Boolean(onVoid) && isOpen && !isPaid;
  // Voided lines survive for audit but drop out of the checklist denominator.
  const activeItems = order.items.filter((i) => !i.voided);
  const voidTarget = voidItemId ? order.items.find((i) => i.id === voidItemId) : undefined;

  // Print KOT / receipt / token (KOT-1, KOT-2). Opens the staff-gated 80mm print
  // page in a new tab, which auto-fires the browser print dialog (decision D3 —
  // USB thermal printer, no driver). Token is only meaningful for a walk-in
  // takeaway (it has a pickup_code); receipt suits dine-in and settled orders.
  const openPrint = (type: 'kot' | 'receipt' | 'token') => {
    window.open(`/staff-print/${order.id}/${type}`, '_blank', 'noopener');
  };
  const canPrintToken = order.order_type === 'takeaway' && Boolean(order.pickup_code);

  // Resend the bill (BILL-4) — wires up the RCT-1 route that shipped with no
  // caller. Only offered when the order actually has somewhere to send to;
  // otherwise the honest answer is "capture a number", not a button that fails.
  const canResendBill = Boolean(order.customer_phone || order.customer_email);
  const [resending, setResending] = useState(false);
  const [resendResult, setResendResult] = useState<{ ok: boolean; message: string } | null>(null);

  const doResendBill = async () => {
    if (resending) return;
    setResending(true);
    setResendResult(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/resend-bill`, { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        sent?: { whatsapp: boolean; email: boolean };
        reasons?: { whatsapp: string; email: string };
      };
      if (!res.ok) {
        // Covers the 429 rate limit, whose message is already staff-readable.
        setResendResult({ ok: false, message: data.error ?? 'Could not resend the bill.' });
        return;
      }
      const sent = data.sent ?? { whatsapp: false, email: false };
      const reasons = data.reasons ?? { whatsapp: '', email: '' };
      // A send where NOTHING went out is a failure, not a success — reporting it
      // as "done" is the bug BILL-3/4 exist to remove.
      setResendResult({
        ok: sent.whatsapp || sent.email,
        message: describeBillOutcome(sent, reasons),
      });
    } catch {
      setResendResult({ ok: false, message: 'Network error — please try again.' });
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
      await onRefund(order, refundAmount, refundReason.trim(), refundMethod || undefined);
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
              {STATUS_LABELS[order.status]} · {order.order_type}
              {isDineIn && order.table_label ? ` · ${order.table_label}` : ''} · placed{' '}
              {formatIstTime(new Date(order.created_at))}
            </p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-muted hover:text-charcoal">×</button>
        </div>

        <div className="mt-3 text-sm text-charcoal">
          <p className="font-bold">{order.customer_name || (isDineIn ? 'Walk-in' : 'Guest')}</p>
          {order.customer_phone ? (
            <a href={`tel:${order.customer_phone}`} className="text-tan hover:underline">{order.customer_phone}</a>
          ) : null}
          {isDineIn ? (
            order.table_label ? <p className="mt-1 text-xs text-muted">Table: {order.table_label}</p> : null
          ) : (
            <p className="mt-1 text-xs text-muted">Pickup: {order.pickup_slot_label || order.pickup_time}</p>
          )}
          {!isDineIn && order.pickup_code ? <p className="text-xs text-muted">Code: {order.pickup_code}</p> : null}
          {order.promised_ready_at ? (
            <p className="text-xs text-muted">ETA: ~{formatIstTime(new Date(order.promised_ready_at))}</p>
          ) : null}
          <p className="text-xs text-muted">
            Elapsed{' '}
            <ElapsedTime since={order.created_at} className="font-bold" warnAfterMin={10} dangerAfterMin={20} />
            {' '}· in {STATUS_LABELS[order.status]}{' '}
            <ElapsedTime since={order.updated_at} />
          </p>
        </div>

        {checklistMode ? (
          <p className="mt-4 flex items-center justify-between text-xs font-bold uppercase tracking-wide text-charcoal">
            <span>{order.status === 'ready' ? 'Handover checklist' : 'Prep checklist'}</span>
            <span className={checked.size === activeItems.length ? 'text-[#2f6b38]' : 'text-tan-dark'}>
              {checked.size}/{activeItems.length} verified
            </span>
          </p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-2 border-t border-[#e5e5e5] pt-3 text-sm text-charcoal">
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
                {item.addons.length > 0 ? (
                  <p className="text-xs text-muted">+ {item.addons.map((a) => a.option_name_snapshot).join(', ')}</p>
                ) : null}
                {item.special_instructions ? (
                  <p className="text-xs italic text-tan">Note: {item.special_instructions}</p>
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
                    className="mt-0.5 shrink-0 rounded-md border border-red-200 px-2 py-0.5 text-[11px] font-bold text-red-700 hover:bg-red-50"
                  >
                    Void
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>

        <div className="mt-3 flex justify-between border-t border-[#e5e5e5] pt-2 text-sm">
          <span className="font-bold text-charcoal">Total</span>
          <span className="font-bold text-tan">₹{order.total_inr ?? order.subtotal_inr}</span>
        </div>
        {order.notes ? <p className="mt-2 text-sm italic text-muted">Order note: {order.notes}</p> : null}

        {/* Print row (KOT-1 / KOT-2). Unobtrusive — sits above the transition
            actions and never blocks them. KOT is available for any order (reprint
            is the same route); receipt/token open the 80mm print page. */}
        <div className="mt-3 flex flex-wrap gap-2 border-t border-[#e5e5e5] pt-3">
          <button
            type="button"
            onClick={() => openPrint('kot')}
            className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan hover:text-tan"
          >
            Print KOT
          </button>
          <button
            type="button"
            onClick={() => openPrint('receipt')}
            className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan hover:text-tan"
          >
            Print receipt
          </button>
          {canPrintToken ? (
            <button
              type="button"
              onClick={() => openPrint('token')}
              className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan hover:text-tan"
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
              className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan hover:text-tan disabled:opacity-50"
            >
              {resending ? 'Sending…' : 'Resend bill'}
            </button>
          ) : null}
        </div>

        {resendResult ? (
          <p
            role="status"
            className={
              'mt-2 text-xs font-bold ' + (resendResult.ok ? 'text-green-700' : 'text-red-700')
            }
          >
            {resendResult.message}
          </p>
        ) : null}

        {/* Actions */}
        {mode === 'accept' ? (
          <div className="mt-5 rounded-md border border-[#e5e5e5] p-4">
            <p className="text-sm font-bold text-charcoal">Ready in</p>
            <div className="mt-2 flex items-center gap-3">
              <button onClick={() => setPrepMin((m) => Math.max(5, m - 5))} className="h-9 w-9 rounded-md border border-[#e5e5e5] font-bold">−</button>
              <span className="w-24 text-center font-bold text-charcoal">{prepMin} min</span>
              <button onClick={() => setPrepMin((m) => m + 5)} className="h-9 w-9 rounded-md border border-[#e5e5e5] font-bold">+</button>
            </div>
            <p className="mt-1 text-xs text-muted">~{formatIstTime(new Date(Date.now() + prepMin * 60_000))}</p>
            <div className="mt-3 flex gap-2">
              <button onClick={doAccept} className="flex-1 rounded-md bg-tan py-2 font-bold text-cream hover:bg-tan-dark">Confirm Accept</button>
              <button onClick={() => setMode('view')} className="rounded-md border border-[#e5e5e5] px-4 py-2 text-muted">Back</button>
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
                          ? 'border-tan bg-tan text-cream'
                          : 'border-[#e5e5e5] text-charcoal hover:border-tan')
                      }
                    >
                      {t.method.toUpperCase()} · ₹{t.amount_inr}
                    </button>
                  ))}
                </div>
              </>
            ) : null}

            <label className="mt-3 block text-xs font-bold text-charcoal">Amount (₹)</label>
            <input
              type="number"
              min={1}
              max={order.total_inr ?? order.subtotal_inr}
              value={refundAmount}
              onChange={(e) => setRefundAmount(Number(e.target.value))}
              className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2 text-sm"
            />
            <label className="mt-3 block text-xs font-bold text-charcoal">Reason</label>
            <input
              value={refundReason}
              onChange={(e) => setRefundReason(e.target.value)}
              placeholder="e.g. Order cancelled after payment"
              className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2 text-sm"
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={doRefund}
                disabled={refundSubmitting || refundAmount <= 0 || !refundReason.trim()}
                className="flex-1 rounded-md bg-red-600 py-2 font-bold text-white hover:bg-red-700 disabled:opacity-50"
              >
                {refundSubmitting ? 'Refunding…' : `Refund ₹${refundAmount}`}
              </button>
              <button onClick={() => setMode('view')} className="rounded-md border border-[#e5e5e5] px-4 py-2 text-muted">Back</button>
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
              className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2 text-sm"
            >
              {VOID_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            {voidReasonChoice === 'Other' ? (
              <input
                value={voidReasonText}
                onChange={(e) => setVoidReasonText(e.target.value)}
                placeholder="Reason…"
                className="mt-2 w-full rounded-md border border-[#e5e5e5] p-2 text-sm"
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
                className="rounded-md border border-[#e5e5e5] px-4 py-2 text-muted"
              >
                Back
              </button>
            </div>
          </div>
        ) : mode === 'comp' ? (
          <div className="mt-5 rounded-md border border-[#e5e5e5] p-4">
            <p className="text-sm font-bold text-charcoal">Comp order (manager)</p>
            <p className="mt-1 text-xs text-muted">
              Completes this dine-in order at ₹0 without collecting payment. Manager-authorized and audited.
            </p>
            <label className="mt-3 block text-xs font-bold text-charcoal">Reason</label>
            <input
              value={compReason}
              onChange={(e) => setCompReason(e.target.value)}
              placeholder="e.g. Service recovery — spilled order"
              className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2 text-sm"
            />
            <div className="mt-3 flex gap-2">
              <button
                onClick={doComp}
                disabled={compSubmitting || !compReason.trim()}
                className="flex-1 rounded-md bg-charcoal py-2 font-bold text-cream hover:opacity-90 disabled:opacity-50"
              >
                {compSubmitting ? 'Comping…' : 'Comp & complete'}
              </button>
              <button onClick={() => setMode('view')} className="rounded-md border border-[#e5e5e5] px-4 py-2 text-muted">Back</button>
            </div>
          </div>
        ) : mode === 'reject' ? (
          <div className="mt-5 rounded-md border border-red-200 p-4">
            <p className="text-sm font-bold text-charcoal">Reject reason</p>
            <select value={reasonChoice} onChange={(e) => setReasonChoice(e.target.value)} className="mt-2 w-full rounded-md border border-[#e5e5e5] p-2 text-sm">
              {REJECT_REASONS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            {reasonChoice === 'Other' ? (
              <input value={reasonText} onChange={(e) => setReasonText(e.target.value)} placeholder="Reason…" className="mt-2 w-full rounded-md border border-[#e5e5e5] p-2 text-sm" />
            ) : null}
            <div className="mt-3 flex gap-2">
              <button onClick={doReject} className="flex-1 rounded-md bg-red-600 py-2 font-bold text-white hover:bg-red-700">Confirm Reject</button>
              <button onClick={() => setMode('view')} className="rounded-md border border-[#e5e5e5] px-4 py-2 text-muted">Back</button>
            </div>
          </div>
        ) : (
          <div className="mt-5 flex flex-col gap-2">
            {isNew ? (
              <div className="flex gap-2">
                <button onClick={() => setMode('accept')} className="flex-1 rounded-md bg-tan py-2.5 font-bold text-cream hover:bg-tan-dark">Accept</button>
                <button onClick={() => setMode('reject')} className="flex-1 rounded-md border border-red-300 py-2.5 font-bold text-red-700 hover:bg-red-50">Reject</button>
              </div>
            ) : null}
            {order.status === 'ready' ? (
              isDineIn ? (
                // Dine-in settle & complete (POS-2). Unpaid → collect via
                // onPayment then complete (server blocks completion until paid,
                // FND3-5); paid → complete in one tap. Comp is the ₹0 manager
                // override. Money shown is server-authoritative (order.total_inr).
                <div className="rounded-md border border-[#e5e5e5] p-4">
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
                      <div className="mt-2 flex gap-2">
                        {PAYMENT_METHODS.map((m) => (
                          <button
                            key={m}
                            onClick={() => onPayment(order, m)}
                            className="flex-1 rounded-md border border-[#e5e5e5] py-2 text-xs font-bold uppercase text-charcoal hover:border-tan hover:text-tan"
                          >
                            {m}
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
                          className="mt-2 w-full rounded-md border border-[#e5e5e5] py-1.5 text-xs font-bold text-charcoal hover:border-tan"
                        >
                          Comp (₹0, manager)
                        </button>
                      ) : null}
                    </>
                  )}
                </div>
              ) : (
                <div className="rounded-md border border-[#e5e5e5] p-4">
                  <p className="text-sm font-bold text-charcoal">Verify pickup code</p>
                  <p className="text-xs text-muted">Ask the customer for the code shown on their order page.</p>
                  <input
                    value={codeInput}
                    onChange={(e) => setCodeInput(e.target.value)}
                    inputMode="numeric"
                    maxLength={6}
                    placeholder="e.g. 1608"
                    className="mt-2 w-full rounded-md border border-[#e5e5e5] p-2 text-center text-lg tracking-[0.3em]"
                  />
                  {codeMismatch ? <p className="mt-1 text-xs font-bold text-red-600">Code doesn&apos;t match this order.</p> : null}
                  {codeMatches ? <p className="mt-1 text-xs font-bold text-green-600">Code matches ✓</p> : null}
                  <button
                    onClick={() => onTransition(order, 'completed')}
                    disabled={codeMismatch}
                    className={
                      'mt-3 w-full rounded-md py-2.5 font-bold text-cream disabled:opacity-40 ' +
                      (codeMatches ? 'bg-green-600 hover:bg-green-700' : 'bg-tan hover:bg-tan-dark')
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
              <button onClick={() => onTransition(order, next)} className="rounded-md bg-tan py-2.5 font-bold text-cream hover:bg-tan-dark">
                Mark {STATUS_LABELS[next]}
              </button>
            ) : null}
            {isActive && !isNew && order.status !== 'ready' ? (
              <button onClick={() => onTransition(order, 'cancelled', { reason: 'Cancelled by staff' })} className="rounded-md border border-[#e5e5e5] py-2 text-sm font-bold text-muted hover:text-red-700">
                Cancel order
              </button>
            ) : null}

            {/* Mark payment (S7). The dine-in settle section above already
                surfaces the Cash/UPI/Card buttons at `ready`, so suppress the
                duplicate set there; keep them for every other open state. */}
            <div className="mt-2 border-t border-[#e5e5e5] pt-3">
              <p className="text-xs text-muted">
                Payment: <span className="font-bold text-charcoal">{order.payment_status}{order.payment_method ? ` (${order.payment_method})` : ''}</span>
              </p>
              {order.payment_status !== 'paid' && !(isDineIn && order.status === 'ready') ? (
                <div className="mt-2 flex gap-2">
                  {PAYMENT_METHODS.map((m) => (
                    <button key={m} onClick={() => onPayment(order, m)} className="flex-1 rounded-md border border-[#e5e5e5] py-1.5 text-xs font-bold uppercase text-charcoal hover:border-tan hover:text-tan">
                      {m}
                    </button>
                  ))}
                </div>
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
