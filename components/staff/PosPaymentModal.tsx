'use client';

import { Modal } from '@/components/ui/Modal';
import type { BillBreakdown } from '@/lib/store/hours';
import type { OrderType, PaymentMethod } from '@/lib/types';

// The POS-1 "Collect payment" step. Shows the SERVER-computed bill breakup (from
// POST /api/orders/quote — never recomputed here) and the counter-settlement
// choices: one tap on Cash / UPI / Card creates the order and immediately
// settles it via PATCH /api/orders/[id]/payment; the "Collect later" escape
// creates it unpaid for POS-2 to settle from the order detail. All actions are
// disabled while a submit is in flight (double-submit guard lives in the parent).

const COLLECT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
];

export function PosPaymentModal({
  bill,
  orderType,
  tableLabel,
  itemCount,
  submitting,
  error,
  onSubmit,
  onClose,
}: {
  bill: BillBreakdown | null;
  orderType: OrderType;
  tableLabel: string | null;
  itemCount: number;
  submitting: boolean;
  error: string | null;
  // method === null → create unpaid (collect later); otherwise settle now.
  onSubmit: (method: PaymentMethod | null) => void;
  onClose: () => void;
}) {
  const isDineIn = orderType === 'dine_in';

  return (
    <Modal open onClose={onClose} title="Collect payment">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between rounded-md bg-surface px-4 py-3 text-sm">
          <span className="font-bold text-charcoal">
            {isDineIn ? `Dine-in · ${tableLabel ?? '—'}` : 'Takeaway'}
          </span>
          <span className="text-muted">
            {itemCount} item{itemCount === 1 ? '' : 's'}
          </span>
        </div>

        {/* Bill breakup — every line is the quote endpoint's number. */}
        <div className="rounded-md border border-line px-4 py-3 text-sm text-charcoal">
          {bill ? (
            <>
              <BillRow label="Subtotal" value={bill.subtotal_inr} />
              {bill.tax_inr > 0 ? <BillRow label="GST" value={bill.tax_inr} /> : null}
              {bill.packaging_inr > 0 ? <BillRow label="Packaging" value={bill.packaging_inr} /> : null}
              {bill.discount_inr > 0 ? <BillRow label="Discount" value={-bill.discount_inr} /> : null}
              <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
                <span className="font-bold text-charcoal">Total</span>
                <span className="text-lg font-bold text-tan">₹{bill.total_inr}</span>
              </div>
            </>
          ) : (
            <p className="text-muted">Calculating bill…</p>
          )}
        </div>

        {error ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-sm font-bold text-charcoal">Collect now</p>
          <div className="grid grid-cols-3 gap-2">
            {COLLECT_METHODS.map((m) => (
              <button
                key={m.value}
                type="button"
                disabled={submitting || !bill}
                onClick={() => onSubmit(m.value)}
                className="rounded-md bg-tan px-3 py-4 text-base font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-50"
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          disabled={submitting || !bill}
          onClick={() => onSubmit(null)}
          className="rounded-md border border-line px-4 py-3 text-sm font-bold text-charcoal transition-colors hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
        >
          Collect later — place unpaid
        </button>

        {submitting ? (
          <p className="text-center text-sm text-muted">Placing order…</p>
        ) : null}
      </div>
    </Modal>
  );
}

function BillRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span>{label}</span>
      <span>{value < 0 ? `-₹${Math.abs(value)}` : `₹${value}`}</span>
    </div>
  );
}
