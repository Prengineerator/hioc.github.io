'use client';

import { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { normalizeIndianMobile } from '@/lib/phone';
import type { BillBreakdown } from '@/lib/store/hours';
import type { OrderType, PaymentMethod } from '@/lib/types';

// The POS-1 "Collect payment" step. Shows the SERVER-computed bill breakup (from
// POST /api/orders/quote — never recomputed here) and the counter-settlement
// choices: one tap on Cash / UPI / Card creates the order and immediately
// settles it via PATCH /api/orders/[id]/payment; the "Collect later" escape
// creates it unpaid for POS-2 to settle from the order detail. All actions are
// disabled while a submit is in flight (double-submit guard lives in the parent).
//
// BILL-2: the phone lives HERE, at the top, focused — not collapsed under the
// cart. The WhatsApp bill (RCT-1/BILL-1) can only send to a number we captured,
// and the moment staff take the money is the one moment the customer is standing
// there to give it. Skipping stays one tap, but it's now a deliberate choice with
// its consequence stated rather than the silent default.

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
  phone,
  onPhoneChange,
  submitting,
  error,
  onSubmit,
  onClose,
}: {
  bill: BillBreakdown | null;
  orderType: OrderType;
  tableLabel: string | null;
  itemCount: number;
  // Owned by the parent (same state the customer-details block edits) so the two
  // inputs can never disagree about the number we're about to bill.
  phone: string;
  onPhoneChange: (value: string) => void;
  submitting: boolean;
  error: string | null;
  // method === null → create unpaid (collect later); otherwise settle now.
  onSubmit: (method: PaymentMethod | null) => void;
  onClose: () => void;
}) {
  const isDineIn = orderType === 'dine_in';
  const phoneRef = useRef<HTMLInputElement>(null);

  // A settle held back for the "no number" confirm. `null` is a valid method
  // (collect later), so the pending state is an object, not a bare method.
  const [pending, setPending] = useState<{ method: PaymentMethod | null } | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // Phone-first: focus it on open so a staffer can type the number straight away.
  useEffect(() => {
    phoneRef.current?.focus();
  }, []);

  // One funnel for every settle button, so the validate → confirm → submit rule
  // can't differ between "Cash" and "Collect later".
  function attemptSubmit(method: PaymentMethod | null) {
    const trimmed = phone.trim();
    if (trimmed) {
      if (normalizeIndianMobile(trimmed) === null) {
        setPhoneError('Enter a valid 10-digit Indian mobile number, or clear it.');
        phoneRef.current?.focus();
        return;
      }
      setPhoneError(null);
      onSubmit(method);
      return;
    }
    // No number: ask once, inline. Never a blocking dialog — the counter can
    // always proceed in one more tap.
    setPending({ method });
  }

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

        {/* Phone first — this is what the WhatsApp bill sends to. */}
        <div>
          <label htmlFor="pos-bill-phone" className="mb-1 block text-sm font-bold text-charcoal">
            Bill on WhatsApp
          </label>
          <input
            id="pos-bill-phone"
            ref={phoneRef}
            value={phone}
            onChange={(e) => {
              onPhoneChange(e.target.value);
              if (phoneError) setPhoneError(null);
              if (pending) setPending(null);
            }}
            inputMode="numeric"
            autoComplete="tel"
            placeholder="10-digit mobile number"
            disabled={submitting}
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-3 text-base outline-none focus:border-tan disabled:opacity-50"
          />
          {phoneError ? (
            <p role="alert" className="mt-1 text-xs text-red-700">
              {phoneError}
            </p>
          ) : (
            <p className="mt-1 text-xs text-muted">Optional — leave blank to skip the WhatsApp bill.</p>
          )}
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

        {/* The one-tap "are you sure" for settling with no number. Replaces the
            buttons rather than stacking on top of them, so there's exactly one
            thing to do next. */}
        {pending ? (
          <div className="rounded-md border border-[#e5e5e5] bg-surface px-4 py-3">
            <p className="text-sm font-bold text-charcoal">No number — the customer gets no WhatsApp bill.</p>
            <p className="mt-0.5 text-xs text-muted">You can still print the bill from the order.</p>
            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => {
                  setPending(null);
                  phoneRef.current?.focus();
                }}
                className="rounded-md bg-tan px-3 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-dark disabled:opacity-50"
              >
                Add number
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={() => {
                  const { method } = pending;
                  setPending(null);
                  onSubmit(method);
                }}
                className="rounded-md border border-[#e5e5e5] px-3 py-3 text-sm font-bold text-charcoal transition-colors hover:border-tan disabled:opacity-50"
              >
                Continue anyway
              </button>
            </div>
          </div>
        ) : (
          <>
            <div>
              <p className="mb-2 text-sm font-bold text-charcoal">Collect now</p>
              <div className="grid grid-cols-3 gap-2">
                {COLLECT_METHODS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    disabled={submitting || !bill}
                    onClick={() => attemptSubmit(m.value)}
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
              onClick={() => attemptSubmit(null)}
              className="rounded-md border border-line px-4 py-3 text-sm font-bold text-charcoal transition-colors hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
            >
              Collect later — place unpaid
            </button>
          </>
        )}

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
