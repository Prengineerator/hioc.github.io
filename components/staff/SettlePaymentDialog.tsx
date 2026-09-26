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

import { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { PosPaymentPanel } from '@/components/staff/PosPaymentModal';
import { describeOrderPayment } from '@/lib/orders/settleList';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { PaymentPart } from '@/lib/orders/payments';
import type { Order, OrderItem } from '@/lib/types';

export type SettleIntent = 'settle' | 'change';

type OrderWithItems = Order & { items: OrderItem[] };

export function SettlePaymentDialog({
  order,
  intent,
  onClose,
  onDone,
}: {
  order: OrderWithItems;
  intent: SettleIntent;
  onClose: () => void;
  /** The payment is recorded. `order` is the server's updated row. */
  onDone: (order: Order) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = order.total_inr ?? order.subtotal_inr;
  const bill = {
    subtotal_inr: order.subtotal_inr,
    tax_inr: order.tax_inr ?? 0,
    packaging_inr: order.packaging_inr ?? 0,
    discount_inr: order.discount_inr ?? 0,
    total_inr: total,
  };
  const itemCount = order.items.filter((i) => !i.voided).reduce((n, i) => n + i.quantity, 0);

  async function submit(parts: PaymentPart[] | null) {
    if (!parts || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/orders/${order.id}/payment`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parts }),
      });
      const data = (await res.json().catch(() => null)) as { order?: Order; error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? 'Could not record the payment. Try again.');
        return;
      }
      onDone(data?.order ?? { ...order, payment_status: 'paid' });
    } catch {
      setError('Could not record the payment. Check the connection and try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const title =
    intent === 'change'
      ? `Change payment · #${formatOrderNumber(order.order_number)}`
      : `Settle #${formatOrderNumber(order.order_number)}`;

  return (
    <Modal open onClose={submitting ? () => {} : onClose} title={title}>
      {intent === 'change' ? (
        <p className="mb-3 rounded-md bg-surface px-4 py-2 text-sm text-charcoal">
          Recorded as <span className="font-bold">{describeOrderPayment(order)}</span>. Choose how
          the ₹{total} was actually paid — this replaces it.
        </p>
      ) : null}
      <PosPaymentPanel
        mode="settle"
        bill={bill}
        orderType={order.order_type}
        tableLabel={order.table_label || null}
        itemCount={itemCount}
        phone=""
        onPhoneChange={() => {}}
        submitting={submitting}
        error={error}
        onSubmit={(parts) => void submit(parts)}
        onClose={onClose}
      />
    </Modal>
  );
}
