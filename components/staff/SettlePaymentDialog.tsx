'use client';

// Record how an EXISTING order was paid — the same payment step as New order
// (cash with change, UPI, card, a two-way split), in 'settle' mode.
//
//   intent 'settle'  an unpaid order (the Settle screen, or the order detail)
//   intent 'change'  an order already paid, recorded again with the right
//                    tenders — the customer said cash, then paid by UPI
//
// Both are the same PATCH /api/orders/[id]/payment with `parts`, which the
// server validates against the order's own total and uses to REPLACE any
// earlier parts, so the cash drawer counts only what was finally taken.
//
// The server's settle is guarded (lib/orders/settlePayment.ts): it writes only
// from the payment status and version it read, so a settle racing a refund, a
// capture or a bill change loses with a 409 instead of overwriting it. This
// dialog sends ONE request at a time (components/staff/submitMachine.ts:
// idle → submitting → done | error) and never retries by itself; a retry the
// staffer makes after a lost answer reaches a bill already paid, where the
// same tenders are recorded again in place of themselves (nothing doubles).
// A bill settled or cancelled elsewhere while this is open (`goneReason`) can't
// be settled from here any more — unless this dialog's own request is the one
// in flight, whose answer then decides.

import { useEffect } from 'react';
import { Modal } from '@/components/ui/Modal';
import { PosPaymentPanel, type SettleAdjustmentInput } from '@/components/staff/PosPaymentModal';
import { describeOrderPayment } from '@/lib/orders/settleList';
import { RITUAL_SALE_LABEL, cupsOnOrder, isRitualSale, type PosBill } from '@/lib/pos/ritual';
import { orderOfferLabel } from '@/lib/orders/offers';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { PaymentPart } from '@/lib/orders/payments';
import type { Order, OrderItem } from '@/lib/types';
import { isSubmitting, submitMessage, useSubmitMachine } from '@/components/staff/submitMachine';

export type SettleIntent = 'settle' | 'change';

type OrderWithItems = Order & { items: OrderItem[] };

export function SettlePaymentDialog({
  order,
  intent,
  goneReason = null,
  onClose,
  onDone,
}: {
  order: OrderWithItems;
  intent: SettleIntent;
  /**
   * Set by the screen when its fresh data shows this bill can no longer be
   * settled here (settled on another till, cancelled): why, for the staffer.
   */
  goneReason?: string | null;
  onClose: () => void;
  /** The payment is recorded. `order` is the server's updated row. */
  onDone: (order: Order) => void;
}) {
  const { state, send } = useSubmitMachine();
  const submitting = isSubmitting(state);
  const error = submitMessage(state);
  // Refused by the machine while this dialog's own request is in flight (its
  // answer decides) — and asked again once that request has failed, so a bill
  // settled elsewhere meanwhile can't be re-recorded over by a retry.
  useEffect(() => {
    if (goneReason) send({ type: 'gone', message: goneReason });
  }, [goneReason, state.phase, send]);
  const gone = state.phase === 'gone';

  const total = order.total_inr ?? order.subtotal_inr;
  const bill: PosBill = {
    subtotal_inr: order.subtotal_inr,
    tax_inr: order.tax_inr ?? 0,
    packaging_inr: order.packaging_inr ?? 0,
    discount_inr: order.discount_inr ?? 0,
    // HIOC Ritual cups already spent on this bill (absent before the migration = 0).
    pass_discount_inr: order.pass_discount_inr ?? 0,
    // The multi-buy offer part of the discount, shown as its own row (absent = 0).
    offer_discount_inr: order.offer_discount_inr ?? 0,
    offer_label: orderOfferLabel(order),
    total_inr: total,
  };
  const itemCount = order.items.filter((i) => !i.voided).reduce((n, i) => n + i.quantity, 0);
  // The sale of a pass isn't a food order: say what it is, and name the plan, in
  // place of the "Takeaway · 1 item" header a menu order gets.
  const ritualSale = isRitualSale(order);
  const saleLine = order.items.find((i) => !i.voided);
  const saleDetail = saleLine
    ? [saleLine.name_snapshot, saleLine.variant_label_snapshot].filter(Boolean).join(' · ')
    : undefined;

  async function submit(parts: PaymentPart[] | null, adjustment?: SettleAdjustmentInput) {
    // The one in-flight guard: refused while a request is out, once done, and
    // once the bill is gone.
    if (!parts || !send({ type: 'submit' })) return;
    let res: Response;
    try {
      res = await fetch(`/api/orders/${order.id}/payment`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // The adjustment (short = settlement discount, extra = tip) rides along
        // with the amounts actually received; the server re-validates all of it
        // and enforces the manager rule for a big shortfall (403 shown below).
        body: JSON.stringify(adjustment ? { parts, adjustment } : { parts }),
      });
    } catch {
      send({ type: 'failed', message: 'Could not record the payment. Check the connection and try again.' });
      return;
    }
    const data = (await res.json().catch(() => null)) as { order?: Order; error?: string } | null;
    if (!res.ok) {
      send({ type: 'failed', message: data?.error ?? 'Could not record the payment. Try again.' });
      return;
    }
    send({ type: 'succeeded' });
    onDone(data?.order ?? { ...order, payment_status: 'paid' });
  }

  const number = formatOrderNumber(order.order_number);
  const title = ritualSale
    ? intent === 'change'
      ? `Change payment · ${RITUAL_SALE_LABEL} #${number}`
      : `Collect payment · ${RITUAL_SALE_LABEL} #${number}`
    : intent === 'change'
      ? `Change payment · #${number}`
      : `Settle #${number}`;

  return (
    <Modal open onClose={submitting ? () => {} : onClose} title={title}>
      {intent === 'change' ? (
        <p className="mb-3 rounded-md bg-surface px-4 py-2 text-sm text-charcoal">
          Recorded as <span className="font-bold">{describeOrderPayment(order)}</span>. Choose how
          the ₹{total} was actually paid — this replaces it.
        </p>
      ) : null}
      {gone ? (
        // Settled or cancelled elsewhere while this was open: say so, and only
        // offer the way out — the payment step would only be refused.
        <div className="flex flex-col gap-3">
          <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </p>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] rounded-md border border-line px-4 text-sm font-bold text-charcoal hover:border-tan"
          >
            Close
          </button>
        </div>
      ) : (
        <PosPaymentPanel
          mode="settle"
          bill={bill}
          passCups={cupsOnOrder(order.items)}
          contextLabel={ritualSale ? RITUAL_SALE_LABEL : undefined}
          contextDetail={ritualSale ? saleDetail : undefined}
          orderType={order.order_type}
          tableLabel={order.table_label || null}
          itemCount={itemCount}
          phone=""
          onPhoneChange={() => {}}
          // A pass is issued in full, so its sale can't be settled short (the
          // server refuses it); the round-off keeps only its plus side there.
          allowShort={!ritualSale}
          // Done: the dialog is closing, nothing more can be sent from it.
          submitting={submitting || state.phase === 'done'}
          error={error}
          onSubmit={(parts, adjustment) => void submit(parts, adjustment)}
          onClose={onClose}
        />
      )}
    </Modal>
  );
}
