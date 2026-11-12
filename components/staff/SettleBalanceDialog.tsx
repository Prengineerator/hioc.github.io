'use client';

// Settle the BALANCE of a paid dine-in bill that was changed after it was paid
// (lib/orders/paidChange.ts) — POST /api/orders/[id]/balance.
//
//   balance > 0  "Collect ₹130": the same payment step as any settle (cash with
//                change, UPI, card, a dining app, a split, the round-off), for
//                the balance only. The tenders are added beside the ones the
//                bill was paid with. "Let it go…" writes it off with a reason
//                (a manager for more than ₹50, as for a short settle).
//   balance < 0  "Give back ₹105": choose which tender it goes back on (you
//                can't hand back more cash than came in as cash), optionally
//                why. Needs the refund permission — the server says so if not.
//
// Money is never decided here: the balance and what each tender took are the
// server's, and every rule is re-checked by the route.
//
// Retry safety: every request carries `expected_version`, the version of the
// order this dialog opened on (components/staff/orderWrite.ts). A collect or a
// give-back whose answer was lost has already moved the version, so tapping
// again is refused (409 stale_version) instead of collecting — or handing the
// money back — twice; the screen then refetches and says "This order changed —
// check it and try again" (`onStale`). One request at a time
// (components/staff/submitMachine.ts), never retried by itself. The drawer
// opens only once the server has recorded the money.

import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { PosPaymentPanel, type SettleAdjustmentInput } from '@/components/staff/PosPaymentModal';
import { openDrawerIfCash } from '@/lib/desktop/drawer';
import { balanceOf, settledInr } from '@/lib/orders/paidChange';
import { STAFF_SETTLE_SHORT_LIMIT_INR, type PaymentPart } from '@/lib/orders/payments';
import { PAYMENT_METHOD_LABEL } from '@/lib/print/labels';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { Order, OrderItem } from '@/lib/types';
import { sendOrderWrite, withExpectedVersion } from '@/components/staff/orderWrite';
import { isSubmitting, submitMessage, useSubmitMachine } from '@/components/staff/submitMachine';

type OrderWithItems = Order & { items: OrderItem[] };

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

const LET_GO_REASONS = ['Customer left', 'Service recovery', 'Other'] as const;

export function SettleBalanceDialog({
  order,
  onClose,
  onDone,
  onStale,
}: {
  order: OrderWithItems;
  onClose: () => void;
  /** Settled. `order` is the server's updated order; `message` says what happened, for a toast. */
  onDone: (order: OrderWithItems, message: string) => void;
  /**
   * The order moved on since this dialog opened (409 stale_version — possibly
   * this very settlement, its answer lost): the screen closes the dialog,
   * refetches and shows `message`. Without it the dialog shows the message
   * itself and stays open.
   */
  onStale?: (message: string) => void;
}) {
  const balance = balanceOf(order);
  const billInr = order.total_inr ?? order.subtotal_inr;
  const paidInr = settledInr(order);
  const number = formatOrderNumber(order.order_number);

  const { state, send: sendEvent } = useSubmitMachine();
  // Done = closing: nothing more is sent from here.
  const submitting = isSubmitting(state) || state.phase === 'done';
  const error = submitMessage(state);
  const clearError = () => sendEvent({ type: 'edit' });
  const [drawerNote, setDrawerNote] = useState<string | null>(null);

  async function send(body: Record<string, unknown>): Promise<{ order: OrderWithItems; change_due_inr?: number } | null> {
    // The one in-flight guard (a second tap in the same frame is refused here).
    if (!sendEvent({ type: 'submit' })) return null;
    const result = await sendOrderWrite<{ order?: OrderWithItems; change_due_inr?: number }>(
      `/api/orders/${order.id}/balance`,
      withExpectedVersion(body, order.version),
      'Could not settle the balance. Try again.',
    );
    if (result.kind === 'stale') {
      sendEvent({ type: 'stale', message: result.message });
      onStale?.(result.message);
      return null;
    }
    if (result.kind === 'network') {
      sendEvent({ type: 'failed', message: 'Could not settle the balance. Check the connection and try again.' });
      return null;
    }
    if (result.kind === 'error' || !result.data.order) {
      sendEvent({
        type: 'failed',
        message: result.kind === 'error' ? result.message : 'Could not settle the balance. Try again.',
      });
      return null;
    }
    sendEvent({ type: 'succeeded' });
    return { order: result.data.order, change_due_inr: result.data.change_due_inr };
  }

  // --- Collect -------------------------------------------------------------
  const [letGo, setLetGo] = useState(false);
  const [letGoChoice, setLetGoChoice] = useState<string>(LET_GO_REASONS[0]);
  const [letGoText, setLetGoText] = useState('');
  const letGoReason = letGoChoice === 'Other' ? letGoText.trim() : letGoChoice;

  async function collect(parts: PaymentPart[] | null, adjustment?: SettleAdjustmentInput) {
    if (!parts) return;
    const done = await send(adjustment ? { action: 'collect', parts, adjustment } : { action: 'collect', parts });
    if (!done) return;
    // Recorded: the drawer opens for the notes and the change (the payment
    // step's own Cash tap may already have opened it).
    void openDrawerIfCash(parts, { orderId: order.id }).then((err) => setDrawerNote(err));
    const change = done.change_due_inr ?? 0;
    onDone(done.order, `#${number} balance collected${change > 0 ? ` · give ${rupees(change)} change` : ''}`);
  }

  async function writeOff() {
    if (letGoReason.length < 3) return;
    const done = await send({ action: 'write_off', amount_inr: balance, reason: letGoReason });
    if (done) onDone(done.order, `#${number} · ${rupees(balance)} balance let go`);
  }

  // --- Give back -----------------------------------------------------------
  const owed = -balance;
  const [tenders, setTenders] = useState<{ method: string; amount_inr: number }[]>([]);
  const [method, setMethod] = useState('');
  const [note, setNote] = useState('');
  useEffect(() => {
    if (balance >= 0) return undefined;
    let cancelled = false;
    fetch(`/api/orders/${order.id}/payment`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { tenders: [] }))
      .then((d: { tenders?: { method: string; amount_inr: number }[] }) => {
        if (cancelled) return;
        // One row per method, as the refund rule counts them.
        const byMethod = new Map<string, number>();
        for (const t of d.tenders ?? []) byMethod.set(t.method, (byMethod.get(t.method) ?? 0) + t.amount_inr);
        const list = [...byMethod.entries()].map(([m, amount_inr]) => ({ method: m, amount_inr }));
        setTenders(list);
        // Preselect when there's no real choice, or cash when it can cover it.
        const cash = list.find((t) => t.method === 'cash' && t.amount_inr >= owed);
        if (list.length === 1) setMethod(list[0].method);
        else if (cash) setMethod('cash');
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [balance, order.id, owed]);

  async function giveBack() {
    if (!method) return;
    const done = await send({ action: 'give_back', amount_inr: owed, method, ...(note.trim() ? { reason: note.trim() } : {}) });
    if (!done) return;
    // Only once the server has recorded it does the drawer open to hand it
    // back — never for a give-back that was refused or never arrived.
    if (method === 'cash') {
      void openDrawerIfCash([{ method: 'cash' }], { orderId: order.id }).then((err) => setDrawerNote(err));
    }
    const how = method === 'cash' ? 'from the drawer' : `on ${PAYMENT_METHOD_LABEL[method] ?? method}`;
    onDone(done.order, `#${number} · ${rupees(owed)} given back ${how}`);
  }

  const itemCount = order.items.filter((i) => !i.voided).reduce((n, i) => n + i.quantity, 0);

  return (
    <Modal
      open
      onClose={submitting ? () => {} : onClose}
      title={balance > 0 ? `Collect balance · #${number}` : `Give back · #${number}`}
      subtitle={order.table_label ? `Table ${order.table_label}` : undefined}
    >
      {balance > 0 ? (
        letGo ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-charcoal">
              Let the <span className="font-bold">{rupees(balance)}</span> balance go — it is recorded as a settlement
              discount with your reason.
              {balance > STAFF_SETTLE_SHORT_LIMIT_INR ? ` More than ₹${STAFF_SETTLE_SHORT_LIMIT_INR} needs a manager.` : ''}
            </p>
            <label className="text-xs font-bold text-charcoal" htmlFor="balance-let-go">
              Reason
            </label>
            <select
              id="balance-let-go"
              value={letGoChoice}
              disabled={submitting}
              onChange={(e) => setLetGoChoice(e.target.value)}
              className="min-h-[44px] w-full rounded-md border border-line bg-white px-3 text-sm"
            >
              {LET_GO_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            {letGoChoice === 'Other' ? (
              <input
                value={letGoText}
                disabled={submitting}
                onChange={(e) => setLetGoText(e.target.value)}
                maxLength={200}
                placeholder="Reason…"
                aria-label="Reason"
                className="min-h-[44px] w-full rounded-md border border-line px-3 text-sm"
              />
            ) : null}
            {error ? (
              <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
                {error}
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void writeOff()}
                disabled={submitting || letGoReason.length < 3}
                className="min-h-[44px] flex-1 rounded-md bg-charcoal px-4 text-sm font-bold text-cream disabled:cursor-not-allowed disabled:opacity-50"
              >
                {submitting ? 'Saving…' : `Let ${rupees(balance)} go`}
              </button>
              <button
                type="button"
                onClick={() => {
                  setLetGo(false);
                  clearError();
                }}
                disabled={submitting}
                className="min-h-[44px] rounded-md border border-line px-4 text-sm font-bold text-charcoal"
              >
                Back
              </button>
            </div>
          </div>
        ) : (
          <>
            <PosPaymentPanel
              mode="settle"
              bill={{
                subtotal_inr: balance,
                tax_inr: 0,
                packaging_inr: 0,
                discount_inr: 0,
                pass_discount_inr: 0,
                offer_discount_inr: 0,
                total_inr: balance,
              }}
              balanceOf={{ billInr, paidInr }}
              contextLabel="Balance after a change"
              contextDetail={`${itemCount} item${itemCount === 1 ? '' : 's'} on the bill`}
              orderType={order.order_type}
              tableLabel={order.table_label || null}
              itemCount={itemCount}
              phone=""
              onPhoneChange={() => {}}
              submitting={submitting}
              error={error}
              onSubmit={(parts, adjustment) => void collect(parts, adjustment)}
              onClose={onClose}
            />
            <button
              type="button"
              onClick={() => {
                setLetGo(true);
                clearError();
              }}
              disabled={submitting}
              className="mt-3 w-full text-center text-xs font-bold text-muted underline disabled:opacity-50"
            >
              Customer can’t pay it? Let it go…
            </button>
          </>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <div className="rounded-md border border-line px-4 py-3 text-sm text-charcoal">
            <Row label="Paid" value={rupees(paidInr)} />
            <Row label="Bill now" value={rupees(billInr)} />
            <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
              <span className="font-bold">To give back</span>
              <span className="text-lg font-bold text-tan-dark">{rupees(owed)}</span>
            </div>
          </div>

          <p className="text-xs font-bold text-charcoal">Give it back on</p>
          {tenders.length === 0 ? (
            <p className="text-xs text-muted">Loading how the bill was paid…</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tenders.map((t) => {
                const short = t.amount_inr < owed;
                return (
                  <button
                    key={t.method}
                    type="button"
                    disabled={submitting || short}
                    onClick={() => setMethod(t.method)}
                    title={short ? `Only ${rupees(t.amount_inr)} was paid by ${PAYMENT_METHOD_LABEL[t.method] ?? t.method}` : undefined}
                    className={
                      'min-h-[44px] rounded-md border px-3 text-sm font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ' +
                      (method === t.method ? 'border-tan bg-tan-dark text-cream' : 'border-line text-charcoal hover:border-tan')
                    }
                  >
                    {PAYMENT_METHOD_LABEL[t.method] ?? t.method} · paid {rupees(t.amount_inr)}
                  </button>
                );
              })}
            </div>
          )}
          <p className="text-xs text-muted">
            {method === 'cash'
              ? 'Hand it back from the drawer.'
              : method
                ? 'Reverse it on the terminal or the app it was paid with.'
                : 'Choose the tender the money goes back on.'}
          </p>

          <label htmlFor="give-back-note" className="text-xs font-bold text-charcoal">
            Note <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id="give-back-note"
            value={note}
            disabled={submitting}
            onChange={(e) => setNote(e.target.value)}
            maxLength={200}
            placeholder="e.g. Brownie taken off"
            className="min-h-[44px] w-full rounded-md border border-line px-3 text-sm"
          />

          {error ? (
            <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void giveBack()}
              disabled={submitting || !method}
              className="min-h-[44px] flex-1 rounded-md bg-tan-dark px-4 text-sm font-bold text-cream hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Recording…' : `Give back ${rupees(owed)}`}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className="min-h-[44px] rounded-md border border-line px-4 text-sm font-bold text-charcoal"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {drawerNote ? <p className="mt-2 text-xs font-bold text-red-700">{drawerNote}</p> : null}
    </Modal>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
