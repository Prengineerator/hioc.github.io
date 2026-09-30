'use client';

// The confirm sheet before a HIOC Ritual is sold (POST /api/passes/sell): who it
// is for, which plan, what it comes to. Confirming creates the sale ORDER, unpaid;
// the payment step (the same one Settle uses) follows, and the pass is issued by
// the database the moment that order is paid (CP-D6).
//
// The Idempotency-Key is made by the caller ONCE per sale attempt and handed in,
// and every retry from this sheet reuses it: a lost response then returns the
// first sale (`replayed`), never a second one. It is only replaced once a sale
// exists or the customer/plan changes.

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { formatIndianMobileDisplay } from '@/lib/phone';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import type { CoffeePassPlan } from '@/lib/passes/types';
import type { OrderResponse } from '@/lib/api/orders';
import { planSummaryLabel, salePreview, type PlanGst, type RitualSale } from '@/lib/pos/ritual';

export interface CreatedSale {
  order: OrderResponse;
  /** The account's own name (what the staffer should read back), and whether this sale opened it. */
  customer: { name: string; created: boolean };
  replayed: boolean;
}

export function SellConfirmDialog({
  plan,
  gst,
  customerName,
  phone,
  idempotencyKey,
  unpaidSame,
  onCancel,
  onCreated,
}: {
  plan: CoffeePassPlan;
  gst: PlanGst | null;
  customerName: string;
  /** The 10-digit number. */
  phone: string;
  idempotencyKey: string;
  /** An unpaid sale of this same plan already waiting for this number, if any. */
  unpaidSame: RitualSale | null;
  onCancel: () => void;
  onCreated: (sale: CreatedSale) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const preview = salePreview(plan, gst);

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/passes/sell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify({ plan_id: plan.id, customer_phone: phone, customer_name: customerName.trim() }),
      });
      const data = (await res.json().catch(() => null)) as
        | { order?: OrderResponse; customer?: { name?: string; created?: boolean }; replayed?: boolean; error?: string }
        | null;
      if (res.status !== 201 || !data?.order) {
        setError(data?.error ?? 'Could not start the sale. Try again.');
        return;
      }
      onCreated({
        order: data.order,
        customer: { name: data.customer?.name ?? customerName.trim(), created: data.customer?.created === true },
        replayed: data.replayed === true,
      });
    } catch {
      // The request may or may not have reached the server. The same key is used
      // on the retry, so it cannot make a second sale either way.
      setError('Could not reach the server. Nothing has been charged — check the connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => {} : onCancel}
      title={`Sell ${plan.name}`}
      subtitle={`${PASS_PROGRAM_NAME} · ${planSummaryLabel(plan)}`}
      size="sm"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={() => void confirm()} loading={busy}>
            {error ? 'Try again' : 'Sell and take payment'}
          </Button>
        </div>
      }
    >
      <dl className="flex flex-col gap-3 text-sm">
        <div className="flex items-start justify-between gap-4">
          <dt className="text-muted">Customer</dt>
          <dd className="text-right font-bold text-charcoal">
            {customerName.trim()}
            <span className="block font-mono text-xs font-normal tabular-nums text-muted">
              {formatIndianMobileDisplay(phone) ?? phone}
            </span>
          </dd>
        </div>
        <div className="flex items-start justify-between gap-4">
          <dt className="text-muted">Plan</dt>
          <dd className="text-right font-bold text-charcoal">
            {plan.name}
            <span className="block text-xs font-normal text-muted">{planSummaryLabel(plan)}</span>
          </dd>
        </div>
        <div className="flex items-start justify-between gap-4 border-t border-line pt-3">
          <dt className="font-bold text-charcoal">Total</dt>
          <dd className="text-right">
            <span className="font-mono text-xl font-bold tabular-nums text-tan-dark">₹{preview.total_inr}</span>
            {preview.tax_inr > 0 ? (
              <span className="block text-xs text-muted">
                {gst?.inclusive ? 'includes' : '₹' + preview.subtotal_inr + ' +'} ₹{preview.tax_inr} GST
              </span>
            ) : null}
          </dd>
        </div>
      </dl>

      <p className="mt-4 text-xs text-muted">
        The Ritual starts the moment it is paid. If payment isn&rsquo;t taken now, the sale waits under Unpaid Ritual sales
        (and in Settle).
      </p>

      {unpaidSame ? (
        <p role="status" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
          There is already an unpaid {plan.name}
          {unpaidSame.order_number != null ? ` (#${unpaidSame.order_number})` : ''} for this number. Cancel and collect
          that one instead, unless this is a second Ritual.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm font-bold text-red-800">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
