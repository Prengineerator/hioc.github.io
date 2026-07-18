'use client';

// Order detail + actions (S3). Shows everything about one order and exposes the
// legal transitions: Accept (with an adjustable ready ETA), Reject (with a
// required reason), the forward steps, Cancel, and mark-payment (S7/STF-041).
// The parent owns the API calls (optimistic update + refetch); this is pure UI.

import { useEffect, useState } from 'react';
import { ElapsedTime } from '@/components/staff/ElapsedTime';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import { PRIMARY_NEXT, STATUS_LABELS } from '@/lib/orders/stateMachine';
import type { Order, OrderItem, PaymentMethod } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

const REJECT_REASONS = ['Out of stock', 'Too busy', 'Closing soon', 'Other'];
const PAYMENT_METHODS: PaymentMethod[] = ['cash', 'upi', 'card'];
const DEFAULT_PREP_MIN = 15;
// A paid order can still be refunded (in full or partially) even after it's
// gone terminal — a manager might refund a completed order over a complaint.
const REFUNDABLE_PAYMENT_STATUSES = ['paid', 'partially_refunded'];

export function OrderDetailModal({
  order,
  defaultPrepMin = DEFAULT_PREP_MIN,
  onClose,
  onTransition,
  onPayment,
  onRefund,
}: {
  order: OrderWithItems;
  defaultPrepMin?: number;
  onClose: () => void;
  onTransition: (o: OrderWithItems, to: Order['status'], extra?: { reason?: string; promised_ready_at?: string }) => void;
  onPayment: (o: OrderWithItems, method: PaymentMethod) => void;
  // Optional — omit to hide the refund panel entirely (e.g. a surface that
  // never shows paid orders). The server route is manager/owner-gated
  // (FND-5) regardless of whether this UI is shown.
  onRefund?: (o: OrderWithItems, amountInr: number, reason: string) => Promise<void> | void;
}) {
  const [mode, setMode] = useState<'view' | 'accept' | 'reject' | 'refund'>('view');
  const [prepMin, setPrepMin] = useState(defaultPrepMin);
  const [reasonChoice, setReasonChoice] = useState(REJECT_REASONS[0]);
  const [reasonText, setReasonText] = useState('');
  const [codeInput, setCodeInput] = useState('');
  const [refundAmount, setRefundAmount] = useState(order.total_inr ?? order.subtotal_inr);
  const [refundReason, setRefundReason] = useState('');
  const [refundSubmitting, setRefundSubmitting] = useState(false);

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

  const doAccept = () => {
    const promised = new Date(Date.now() + prepMin * 60_000).toISOString();
    onTransition(order, 'accepted', { promised_ready_at: promised });
  };
  const doReject = () => {
    const reason = reasonChoice === 'Other' ? reasonText.trim() : reasonChoice;
    if (!reason) return;
    onTransition(order, 'rejected', { reason });
  };
  const doRefund = async () => {
    if (!onRefund || refundAmount <= 0 || !refundReason.trim()) return;
    setRefundSubmitting(true);
    try {
      await onRefund(order, refundAmount, refundReason.trim());
      setMode('view');
    } finally {
      setRefundSubmitting(false);
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
              {STATUS_LABELS[order.status]} · {order.order_type} · placed {formatIstTime(new Date(order.created_at))}
            </p>
          </div>
          <button onClick={onClose} className="text-2xl leading-none text-muted hover:text-charcoal">×</button>
        </div>

        <div className="mt-3 text-sm text-charcoal">
          <p className="font-bold">{order.customer_name}</p>
          <a href={`tel:${order.customer_phone}`} className="text-tan hover:underline">{order.customer_phone}</a>
          <p className="mt-1 text-xs text-muted">Pickup: {order.pickup_slot_label || order.pickup_time}</p>
          {order.pickup_code ? <p className="text-xs text-muted">Code: {order.pickup_code}</p> : null}
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
            <span className={checked.size === order.items.length ? 'text-[#2f6b38]' : 'text-tan-dark'}>
              {checked.size}/{order.items.length} verified
            </span>
          </p>
        ) : null}
        <ul className="mt-2 flex flex-col gap-2 border-t border-[#e5e5e5] pt-3 text-sm text-charcoal">
          {order.items.map((item) => {
            const isChecked = checklistMode && checked.has(item.id);
            const detail = (
              <>
                <div className="flex justify-between gap-2">
                  <span className={isChecked ? 'text-muted line-through' : ''}>
                    {item.quantity}× {item.name_snapshot}
                    {item.variant_label_snapshot ? ` (${item.variant_label_snapshot})` : ''}
                  </span>
                  <span className="shrink-0 font-bold">₹{item.line_total_inr}</span>
                </div>
                {item.addons.length > 0 ? (
                  <p className="text-xs text-muted">+ {item.addons.map((a) => a.option_name_snapshot).join(', ')}</p>
                ) : null}
                {item.special_instructions ? (
                  <p className="text-xs italic text-tan">Note: {item.special_instructions}</p>
                ) : null}
              </>
            );
            return (
              <li key={item.id}>
                {checklistMode ? (
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => toggleChecked(item.id)}
                      className="mt-1 h-4 w-4 shrink-0 accent-tan"
                    />
                    <span className="flex-1">{detail}</span>
                  </label>
                ) : (
                  detail
                )}
              </li>
            );
          })}
        </ul>

        <div className="mt-3 flex justify-between border-t border-[#e5e5e5] pt-2 text-sm">
          <span className="font-bold text-charcoal">Total</span>
          <span className="font-bold text-tan">₹{order.total_inr ?? order.subtotal_inr}</span>
        </div>
        {order.notes ? <p className="mt-2 text-sm italic text-muted">Order note: {order.notes}</p> : null}

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
              Issues a refund via the payment gateway. Adjust the amount for a partial refund.
            </p>
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

            {/* Mark payment (S7). */}
            <div className="mt-2 border-t border-[#e5e5e5] pt-3">
              <p className="text-xs text-muted">
                Payment: <span className="font-bold text-charcoal">{order.payment_status}{order.payment_method ? ` (${order.payment_method})` : ''}</span>
              </p>
              {order.payment_status !== 'paid' ? (
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
