'use client';

// One unpaid bill, opened from the Settle list: what is on it, what it comes
// to, and — for a person the owner has allowed (`settle_edit_order`, Team →
// Permissions) — lowering it before it is settled: a quantity down, a line off,
// each with a reason. "Add items" hands over to the running-tab add flow (the
// kitchen gets a ticket for exactly what was added); "Settle" goes on to the
// payment step with whatever the bill now is.
//
// Edits only ever LOWER the bill (lib/orders/settleEdit.ts), so "+" here only
// undoes a reduction made in this same sheet. The rules — which orders and
// lines can be changed, what a change would do — are that file's, the same ones
// the amend route validates with; the sheet only decides what to OFFER. Money is
// never computed here beyond the preview: the saved bill is the server's.

import { useEffect, useId, useMemo, useState } from 'react';
import { SurfaceLink } from '@/components/SurfaceLink';
import { Modal } from '@/components/ui/Modal';
import { lineSizeSuffix } from '@/lib/menu/weight';
import {
  EDIT_REASONS,
  MAX_EDIT_REASON_LENGTH,
  canReduceLine,
  editReductionInr,
  planSettleEdit,
  settleEditBlockReason,
} from '@/lib/orders/settleEdit';
import { STATUS_LABELS } from '@/lib/orders/stateMachine';
import { PASS_SHORT_NAME } from '@/lib/passes/brand';
import { RITUAL_SALE_LABEL, cupsOnOrder, isRitualSale, ritualBillRow } from '@/lib/pos/ritual';
import { discountRows, offerLabelForLines } from '@/lib/orders/offers';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { Order, OrderItem } from '@/lib/types';

type OrderWithItems = Order & { items: OrderItem[] };

const NO_PERMISSION_NOTE =
  'Editing a bill before settling is off for your role — the owner can allow it on Team → Permissions.';

const rupees = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const totalOf = (o: Order) => o.total_inr ?? o.subtotal_inr;

/** Where the bill sits: the table, the pickup token, or how it leaves the café. */
export function whereOf(o: Order): string {
  // A HIOC Ritual sale has no table or pickup: name what it is.
  if (isRitualSale(o)) return RITUAL_SALE_LABEL;
  if (o.order_type === 'dine_in') return o.table_label ? `Table ${o.table_label}` : 'Dine-in';
  if (o.pickup_code) return `Token ${o.pickup_code}`;
  return o.order_type === 'delivery' ? 'Delivery' : 'Takeaway';
}

export function SettleOrderSheet({
  order,
  canEdit,
  canAddItems,
  onClose,
  onUpdated,
  onSettle,
}: {
  order: OrderWithItems;
  /** The `settle_edit_order` permission (the route re-checks it). */
  canEdit: boolean;
  /** The POS add flow is available to this person on this screen. */
  canAddItems: boolean;
  onClose: () => void;
  /** The edit is saved. `order` is the server's whole updated order. */
  onUpdated: (order: OrderWithItems) => void;
  /** Go on to the payment step for this bill. */
  onSettle: (order: OrderWithItems) => void;
}) {
  const reasonId = useId();
  // The edit in progress: line id → the quantity it would drop to (0 = remove).
  // Only lines that differ from the saved bill are in here, so "dirty" is just
  // "not empty".
  const [draft, setDraft] = useState<Record<string, number>>({});
  const [reasonChoice, setReasonChoice] = useState<string>(EDIT_REASONS[0]);
  const [reasonText, setReasonText] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ritualSale = isRitualSale(order);
  const blockReason = settleEditBlockReason(order);
  const editable = canEdit && blockReason === null;
  const canAdd = canAddItems && blockReason === null;

  // The bill refetches under the sheet (a 15 s poll, realtime). Keep the draft
  // only for lines that are still there, still on the bill, and still higher
  // than what the draft would drop them to — anything else is no longer a
  // reduction and the route would refuse it.
  useEffect(() => {
    setDraft((prev) => {
      let pruned = false;
      const next: Record<string, number> = {};
      for (const [id, qty] of Object.entries(prev)) {
        const line = order.items.find((i) => i.id === id);
        if (line && !line.voided && qty < line.quantity) next[id] = qty;
        else pruned = true;
      }
      return pruned ? next : prev;
    });
  }, [order.items]);

  const dirty = Object.keys(draft).length > 0;
  const changes = useMemo(
    () => Object.entries(draft).map(([item_id, quantity]) => ({ item_id, quantity })),
    [draft],
  );
  // The same validation the route runs, so Save is only offered for an edit it
  // will accept (and "would empty the order" is said before the tap, not after).
  const plan = useMemo(() => (changes.length > 0 ? planSettleEdit(order.items, changes) : null), [changes, order.items]);
  const planError = plan && !plan.ok ? plan.error : null;
  const reduction = plan?.ok ? editReductionInr(plan.changes, order.items) : 0;
  const reason = reasonChoice === 'Other' ? reasonText.trim() : reasonChoice;
  const canSave = dirty && !saving && plan?.ok === true && reason !== '';

  function setLineQty(item: OrderItem, quantity: number) {
    setSaved(false);
    setError(null);
    setDraft((prev) => {
      const next = { ...prev };
      if (quantity === item.quantity) delete next[item.id];
      else next[item.id] = quantity;
      return next;
    });
  }

  function discard() {
    setDraft({});
    setReasonChoice(EDIT_REASONS[0]);
    setReasonText('');
    setError(null);
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch(`/api/orders/${order.id}/amend`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: 'edit', changes, reason }),
      });
      const data = (await res.json().catch(() => null)) as { order?: OrderWithItems; error?: string } | null;
      if (!res.ok || !data?.order) {
        setError(data?.error ?? 'Could not save the changes. Please try again.');
        return;
      }
      setDraft({});
      setReasonChoice(EDIT_REASONS[0]);
      setReasonText('');
      setSaved(true);
      onUpdated(data.order);
    } catch {
      setError('Could not save the changes. Check the connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  const number = formatOrderNumber(order.order_number);
  const subtitle = [
    ritualSale ? null : whereOf(order),
    order.customer_name || null,
    ritualSale ? null : (STATUS_LABELS[order.status] ?? order.status),
  ]
    .filter(Boolean)
    .join(' · ');
  const ritualRow = ritualBillRow(order, cupsOnOrder(order.items));
  // Add items walks away from this sheet, so an unsaved edit would be lost.
  const busyWithEdit = dirty || saving;

  return (
    <Modal
      open
      // A save in flight is not abandoned by Escape or a stray tap on the backdrop.
      onClose={saving ? () => {} : onClose}
      title={ritualSale ? `${RITUAL_SALE_LABEL} #${number}` : `#${number}`}
      subtitle={subtitle || undefined}
      footer={
        <div className="flex flex-col gap-2">
          {dirty ? (
            <p className="text-center text-xs text-muted">Save or discard your changes first.</p>
          ) : null}
          <div className="flex gap-2">
            {canAdd ? (
              busyWithEdit ? (
                <button
                  type="button"
                  disabled
                  className="min-h-[44px] shrink-0 cursor-not-allowed rounded-md border border-line px-4 text-sm font-bold text-charcoal opacity-50"
                >
                  Add items
                </button>
              ) : (
                <SurfaceLink
                  href={`/staff/orders/new?add=${order.id}&back=settle`}
                  className="inline-flex min-h-[44px] shrink-0 items-center justify-center rounded-md border border-line px-4 text-sm font-bold text-charcoal hover:border-tan"
                >
                  Add items
                </SurfaceLink>
              )
            ) : null}
            <button
              type="button"
              onClick={() => onSettle(order)}
              disabled={busyWithEdit}
              className="min-h-[44px] flex-1 rounded-md bg-tan-dark px-5 text-sm font-bold text-cream hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-50"
            >
              Settle {rupees(totalOf(order))}
            </button>
          </div>
        </div>
      }
    >
      {editable ? (
        <p className="mb-2 text-xs text-muted">
          Lower a quantity or remove a line before settling.
          {canAdd ? ' To add more, use Add items.' : ''}
        </p>
      ) : null}

      <ul className="flex flex-col divide-y divide-line text-sm text-charcoal">
        {order.items.map((item) => {
          const target = draft[item.id];
          const changed = !item.voided && target !== undefined;
          const removing = changed && target === 0;
          const qty = changed && !removing ? target : item.quantity;
          const lineTotal = changed && !removing ? item.price_inr_snapshot * qty : item.line_total_inr;
          const struck = item.voided || removing;
          const reducible = editable && canReduceLine(item);
          return (
            <li key={item.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex justify-between gap-3">
                <span className={struck ? 'text-muted line-through' : ''}>
                  {qty}× {item.name_snapshot}
                  {lineSizeSuffix(item.variant_label_snapshot, item.weight_grams)}
                </span>
                <span className="shrink-0 font-mono tabular-nums">
                  {changed && !removing ? (
                    <span className="mr-2 text-xs text-muted line-through">{rupees(item.line_total_inr)}</span>
                  ) : null}
                  <span className={'font-bold' + (struck ? ' text-muted line-through' : '')}>{rupees(lineTotal)}</span>
                </span>
              </div>
              {item.voided ? (
                <p className="text-xs font-bold text-red-700">
                  Removed{item.void_reason ? ` — ${item.void_reason}` : ''}
                </p>
              ) : null}
              {removing ? <p className="text-xs font-bold text-red-700">Will be removed</p> : null}
              {/* HIOC Ritual cups that paid for part of this line. */}
              {!item.voided && (item.pass_drinks ?? 0) > 0 ? (
                <p className="text-xs font-bold text-tan-dark">
                  {PASS_SHORT_NAME} ×{item.pass_drinks} · {rupees(item.pass_covered_inr ?? 0)} covered
                  {editable && item.quantity > 1 ? ' · can only be removed whole' : ''}
                </p>
              ) : null}
              {item.addons.length > 0 ? (
                <p className="text-xs text-muted">+ {item.addons.map((a) => a.option_name_snapshot).join(', ')}</p>
              ) : null}
              {item.special_instructions ? (
                <p className="text-xs italic text-tan-dark">Note: {item.special_instructions}</p>
              ) : null}

              {editable && !item.voided ? (
                <div className="mt-2 flex items-center justify-end gap-2">
                  {reducible && !removing ? (
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        aria-label={`Decrease ${item.name_snapshot}`}
                        disabled={saving || qty <= 1}
                        onClick={() => setLineQty(item, qty - 1)}
                        className="flex h-11 w-11 items-center justify-center rounded-md border border-line text-lg font-bold text-charcoal hover:border-tan disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        −
                      </button>
                      <span className="w-8 text-center font-bold tabular-nums" aria-live="polite">
                        {qty}
                      </span>
                      <button
                        type="button"
                        aria-label={`Increase ${item.name_snapshot}`}
                        // Only undoes a reduction: more than was ordered goes
                        // through Add items, which gives the kitchen a ticket.
                        disabled={saving || qty >= item.quantity}
                        onClick={() => setLineQty(item, qty + 1)}
                        className="flex h-11 w-11 items-center justify-center rounded-md border border-line text-lg font-bold text-charcoal hover:border-tan disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        +
                      </button>
                    </div>
                  ) : null}
                  {removing ? (
                    <button
                      type="button"
                      aria-label={`Undo removing ${item.name_snapshot}`}
                      disabled={saving}
                      onClick={() => setLineQty(item, item.quantity)}
                      className="min-h-[44px] rounded-md border border-line px-4 text-sm font-bold text-charcoal hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Undo
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Remove ${item.name_snapshot}`}
                      disabled={saving}
                      onClick={() => setLineQty(item, 0)}
                      className="min-h-[44px] rounded-md border border-red-200 px-4 text-sm font-bold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {order.notes ? <p className="mt-3 text-sm italic text-muted">Order note: {order.notes}</p> : null}

      {dirty ? (
        <div className="mt-4 rounded-md border border-line bg-surface p-4">
          {plan?.ok ? (
            <>
              <p className="text-sm font-bold text-charcoal">
                <span className="font-mono tabular-nums">−{rupees(reduction)}</span> before tax
              </p>
              <p className="mt-0.5 text-xs text-muted">GST and the total are recalculated when you save.</p>
            </>
          ) : null}
          {planError ? (
            <p role="alert" className="text-sm font-bold text-red-700">
              {planError}
            </p>
          ) : null}

          <label htmlFor={reasonId} className="mt-3 block text-xs font-bold text-charcoal">
            Reason
          </label>
          <select
            id={reasonId}
            value={reasonChoice}
            disabled={saving}
            onChange={(e) => setReasonChoice(e.target.value)}
            className="mt-1 min-h-[44px] w-full rounded-md border border-line bg-white px-3 text-sm"
          >
            {EDIT_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {reasonChoice === 'Other' ? (
            <input
              value={reasonText}
              disabled={saving}
              onChange={(e) => setReasonText(e.target.value)}
              maxLength={MAX_EDIT_REASON_LENGTH}
              placeholder="Reason…"
              aria-label="Reason"
              className="mt-2 min-h-[44px] w-full rounded-md border border-line px-3 text-sm"
            />
          ) : null}

          {error ? (
            <div role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          ) : null}

          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={!canSave}
              className="min-h-[44px] flex-1 rounded-md bg-tan-dark px-4 text-sm font-bold text-cream hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save changes'}
            </button>
            <button
              type="button"
              onClick={discard}
              disabled={saving}
              className="min-h-[44px] rounded-md border border-line px-4 text-sm font-bold text-charcoal hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
            >
              Discard
            </button>
          </div>
        </div>
      ) : saved ? (
        <p role="status" className="mt-3 text-sm font-bold text-green-700">
          Saved
        </p>
      ) : null}

      {!editable ? (
        <p className="mt-3 rounded-md bg-surface px-4 py-2 text-xs text-muted">{blockReason ?? NO_PERMISSION_NOTE}</p>
      ) : null}

      <div className="mt-4 border-t border-line pt-3 text-sm text-charcoal">
        <BillRow label="Subtotal" value={order.subtotal_inr} />
        {order.tax_inr > 0 ? <BillRow label="GST" value={order.tax_inr} /> : null}
        {order.packaging_inr > 0 ? <BillRow label="Packaging" value={order.packaging_inr} /> : null}
        {discountRows(order, offerLabelForLines(order.items)).map((row) => (
          <BillRow key={row.label} label={row.label} value={-row.amountInr} />
        ))}
        {ritualRow ? <BillRow label={ritualRow.label} value={ritualRow.value} /> : null}
        <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
          <span className="font-bold text-charcoal">Total</span>
          <span className="text-lg font-bold tabular-nums text-tan-dark">{rupees(totalOf(order))}</span>
        </div>
      </div>
    </Modal>
  );
}

function BillRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span>{label}</span>
      <span className="tabular-nums">{value < 0 ? `-${rupees(Math.abs(value))}` : rupees(value)}</span>
    </div>
  );
}
