'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { normalizeIndianMobile } from '@/lib/phone';
import { changeDueInr, type PaymentPart } from '@/lib/orders/payments';
import type { Feedback } from '@/lib/pos/loyalty';
import type { BillBreakdown } from '@/lib/store/hours';
import type { OrderType, PaymentMethod } from '@/lib/types';

// The POS-1 "Collect payment" step, extended by POS4-1 with cash tendered/change
// and a two-way split.
//
// Everything here is DISPLAY of server numbers: the bill comes from
// /api/orders/quote and the split is re-validated against the order's
// authoritative total server-side before anything is stored. The arithmetic
// below (change, remainder) exists so the counter doesn't do mental maths — it
// is never what gets persisted.
//
// BILL-2: the phone sits at the top, focused — the WhatsApp bill can only reach
// a number we captured, and this is the moment the customer is standing there.
//
// FLOW-1 — the step itself is `PosPaymentPanel`, and it is mounted two ways:
// docked into the order pane (POS_V2), or inside this modal (the pre-V2 path,
// alive until the owner signs the docked one off at Gate 6B). ONE implementation
// on purpose: the split-tender rules below decide what the counter hands over,
// and a forked copy of them is how two screens start disagreeing about money.

const COLLECT_METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'upi', label: 'UPI' },
  { value: 'card', label: 'Card' },
];

// Notes an Indian counter actually sees. "Exact" fills the bill total.
const TENDER_CHIPS = [100, 200, 500, 2000];

type Step = 'choose' | 'cash' | 'split';

interface PaymentStepProps {
  bill: BillBreakdown | null;
  orderType: OrderType;
  tableLabel: string | null;
  itemCount: number;
  phone: string;
  onPhoneChange: (value: string) => void;
  /**
   * VAL-1: who this number belongs to and what they can spend. Shown here
   * because the phone is most often typed at this moment — a staffer who only
   * learns about 240 available points after the money is taken can't use them.
   */
  customerNote?: Feedback | null;
  submitting: boolean;
  error: string | null;
  /**
   * FLOW-1: the cart has changed and `bill` is the price of the PREVIOUS cart.
   *
   * This cannot happen in the modal — it covers the menu. Docked, the grid stays
   * tappable on purpose, so between an item tap and the quote landing (a 250 ms
   * debounce plus a round-trip) every rupee in this panel belongs to a cart that
   * is no longer on screen: the cash step offers "Take ₹480 cash" and submits
   * 480 for an order the server will price at 560. The server's exact-sum
   * validator rejects it, and `placeOrder` then swallows that into "Payment not
   * recorded — settle it from Orders" with the cash already in the drawer.
   */
  stale?: boolean;
  // null → create unpaid (collect later); otherwise settle with these parts.
  onSubmit: (parts: PaymentPart[] | null) => void;
  onClose: () => void;
}

/** The pre-FLOW-1 takeover. Kept until POS_V2 is verified at Gate 6B (spec E10). */
export function PosPaymentModal(props: PaymentStepProps) {
  return (
    <Modal open onClose={props.onClose} title="Collect payment">
      <PosPaymentPanel {...props} />
    </Modal>
  );
}

/**
 * FLOW-1 — `docked` drops the context header and the bill box: docked into the
 * order pane, both are already on screen an inch above, and a second copy of the
 * total is how a staffer ends up reading the wrong one.
 */
export function PosPaymentPanel({
  bill,
  orderType,
  tableLabel,
  itemCount,
  phone,
  onPhoneChange,
  customerNote = null,
  submitting,
  error,
  stale = false,
  onSubmit,
  onClose,
  docked = false,
}: PaymentStepProps & { docked?: boolean }) {
  const isDineIn = orderType === 'dine_in';
  const phoneRef = useRef<HTMLInputElement>(null);
  const total = bill?.total_inr ?? 0;

  // Every button that would COMMIT money is gated on both. Navigation (Back,
  // "Back to order") and the phone field stay live: a stale quote is a reason to
  // wait a beat, not to trap the staffer inside the step.
  const busy = submitting || stale;

  const [step, setStep] = useState<Step>('choose');
  const [pending, setPending] = useState<{ parts: PaymentPart[] | null } | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);

  // Cash step
  const [tendered, setTendered] = useState('');
  const tenderedNum = Number.parseInt(tendered, 10);
  const tenderedValid = Number.isFinite(tenderedNum) && tenderedNum >= total;
  const change = tenderedValid ? changeDueInr(tenderedNum, total) : 0;

  // Split step — two parts: a first method for a chosen amount, the rest on a second.
  const [firstMethod, setFirstMethod] = useState<PaymentMethod>('cash');
  const [firstAmount, setFirstAmount] = useState('');
  const [secondMethod, setSecondMethod] = useState<PaymentMethod>('upi');
  const [splitTendered, setSplitTendered] = useState('');
  const firstNum = Number.parseInt(firstAmount, 10);
  const firstValid = Number.isFinite(firstNum) && firstNum > 0 && firstNum < total;
  const remainder = firstValid ? total - firstNum : 0;

  useEffect(() => {
    phoneRef.current?.focus();
  }, []);

  // One funnel for every settle, so the phone rule can't differ per path.
  function attempt(parts: PaymentPart[] | null) {
    // The last line of defence for the stale-quote race: the buttons are already
    // disabled, but a tap can land in the same frame the cart changes in.
    if (stale) return;
    const trimmed = phone.trim();
    if (trimmed) {
      if (normalizeIndianMobile(trimmed) === null) {
        setPhoneError('Enter a valid 10-digit Indian mobile number, or clear it.');
        phoneRef.current?.focus();
        return;
      }
      setPhoneError(null);
      onSubmit(parts);
      return;
    }
    setPending({ parts });
  }

  const splitParts = useMemo((): PaymentPart[] | null => {
    if (!firstValid) return null;
    const a: PaymentPart = {
      method: firstMethod,
      amount_inr: firstNum,
      tendered_inr:
        firstMethod === 'cash' && splitTendered.trim()
          ? Number.parseInt(splitTendered, 10)
          : null,
    };
    const b: PaymentPart = { method: secondMethod, amount_inr: remainder, tendered_inr: null };
    return [a, b];
  }, [firstValid, firstMethod, firstNum, secondMethod, remainder, splitTendered]);

  const splitCashShort =
    firstMethod === 'cash' &&
    splitTendered.trim().length > 0 &&
    Number.parseInt(splitTendered, 10) < firstNum;

  return (
      <div className="flex flex-col gap-4">
        {docked ? (
          // The docked step needs its own title bar — the modal's chrome (title
          // + dismiss) isn't there to provide one, and the way back to a
          // pure-ordering screen must always be one obvious tap.
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-charcoal">Collect payment</p>
            <button
              type="button"
              disabled={submitting}
              onClick={onClose}
              className="text-xs font-bold text-muted underline disabled:opacity-50"
            >
              Back to order
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between rounded-md bg-surface px-4 py-3 text-sm">
            <span className="font-bold text-charcoal">
              {isDineIn ? `Dine-in · ${tableLabel ?? '—'}` : 'Takeaway'}
            </span>
            <span className="text-muted">
              {itemCount} item{itemCount === 1 ? '' : 's'}
            </span>
          </div>
        )}

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
          {customerNote?.ok ? (
            <p className="mt-1 text-xs font-bold text-green-700">
              {customerNote.text} · close this to use them
            </p>
          ) : null}
        </div>

        {docked ? null : (
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
        )}

        {error ? (
          <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        {stale ? (
          // Says WHY the buttons went quiet. A step that silently stops
          // responding for a second reads as a frozen till, and the staffer
          // taps harder.
          <div
            role="status"
            className="rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-bold text-amber-900"
          >
            Cart changed — re-pricing…
          </div>
        ) : null}

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
                disabled={busy}
                onClick={() => {
                  if (stale) return;
                  const { parts } = pending;
                  setPending(null);
                  onSubmit(parts);
                }}
                className="rounded-md border border-[#e5e5e5] px-3 py-3 text-sm font-bold text-charcoal transition-colors hover:border-tan disabled:opacity-50"
              >
                Continue anyway
              </button>
            </div>
          </div>
        ) : step === 'cash' ? (
          /* ---- Cash: tendered → change ------------------------------------ */
          <div className="rounded-md border border-[#e5e5e5] px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-charcoal">Cash — ₹{total}</p>
              <button
                type="button"
                onClick={() => {
                  setStep('choose');
                  setTendered('');
                }}
                className="text-xs font-bold text-muted underline"
              >
                Back
              </button>
            </div>

            <label htmlFor="pos-tendered" className="mt-3 block text-xs font-bold uppercase tracking-wide text-muted">
              Cash received
            </label>
            <input
              id="pos-tendered"
              value={tendered}
              onChange={(e) => setTendered(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              placeholder={String(total)}
              autoFocus
              className="mt-1 w-full rounded-md border border-[#e5e5e5] px-3 py-3 text-lg font-bold outline-none focus:border-tan"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setTendered(String(total))}
                className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
              >
                Exact ₹{total}
              </button>
              {TENDER_CHIPS.filter((c) => c >= total).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setTendered(String(c))}
                  className="rounded-md border border-[#e5e5e5] px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
                >
                  ₹{c}
                </button>
              ))}
            </div>

            {tendered.trim() && !tenderedValid ? (
              <p role="alert" className="mt-2 text-xs text-red-700">
                That&rsquo;s less than the bill of ₹{total}.
              </p>
            ) : null}

            <div className="mt-3 flex items-center justify-between border-t border-[#e5e5e5] pt-3">
              <span className="text-sm font-bold text-charcoal">Change due</span>
              <span className="text-2xl font-bold text-tan">₹{change}</span>
            </div>

            <button
              type="button"
              disabled={busy || !tenderedValid}
              onClick={() =>
                attempt([{ method: 'cash', amount_inr: total, tendered_inr: tenderedNum }])
              }
              className="mt-3 w-full rounded-md bg-tan px-3 py-3 text-base font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              Take ₹{total} cash
            </button>
          </div>
        ) : step === 'split' ? (
          /* ---- Split across two methods ----------------------------------- */
          <div className="rounded-md border border-[#e5e5e5] px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-charcoal">Split ₹{total}</p>
              <button
                type="button"
                onClick={() => {
                  setStep('choose');
                  setFirstAmount('');
                  setSplitTendered('');
                }}
                className="text-xs font-bold text-muted underline"
              >
                Back
              </button>
            </div>

            <p className="mt-3 text-xs font-bold uppercase tracking-wide text-muted">First payment</p>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {COLLECT_METHODS.map((m) => (
                <MethodChip
                  key={m.value}
                  label={m.label}
                  active={firstMethod === m.value}
                  onClick={() => setFirstMethod(m.value)}
                />
              ))}
            </div>
            <input
              value={firstAmount}
              onChange={(e) => setFirstAmount(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              placeholder="Amount"
              className="mt-2 w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-base outline-none focus:border-tan"
            />
            {firstAmount.trim() && !firstValid ? (
              <p role="alert" className="mt-1 text-xs text-red-700">
                Enter an amount between ₹1 and ₹{total - 1}.
              </p>
            ) : null}

            {firstMethod === 'cash' && firstValid ? (
              <>
                <input
                  value={splitTendered}
                  onChange={(e) => setSplitTendered(e.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric"
                  placeholder={`Cash received (₹${firstNum})`}
                  className="mt-2 w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-base outline-none focus:border-tan"
                />
                {splitCashShort ? (
                  <p role="alert" className="mt-1 text-xs text-red-700">
                    Less than the ₹{firstNum} cash part.
                  </p>
                ) : splitTendered.trim() ? (
                  <p className="mt-1 text-xs text-muted">
                    Change due ₹{changeDueInr(Number.parseInt(splitTendered, 10), firstNum)}
                  </p>
                ) : null}
              </>
            ) : null}

            {firstValid ? (
              <>
                <p className="mt-4 text-xs font-bold uppercase tracking-wide text-muted">
                  Remaining ₹{remainder} on
                </p>
                <div className="mt-1 grid grid-cols-3 gap-2">
                  {COLLECT_METHODS.map((m) => (
                    <MethodChip
                      key={m.value}
                      label={m.label}
                      active={secondMethod === m.value}
                      onClick={() => setSecondMethod(m.value)}
                    />
                  ))}
                </div>
              </>
            ) : null}

            <button
              type="button"
              disabled={busy || !firstValid || splitCashShort || !splitParts}
              onClick={() => splitParts && attempt(splitParts)}
              className="mt-4 w-full rounded-md bg-tan px-3 py-3 text-base font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-50"
            >
              {firstValid
                ? `Take ₹${firstNum} ${firstMethod.toUpperCase()} + ₹${remainder} ${secondMethod.toUpperCase()}`
                : 'Enter the first amount'}
            </button>
          </div>
        ) : (
          /* ---- Method choice ---------------------------------------------- */
          <>
            <div>
              <p className="mb-2 text-sm font-bold text-charcoal">Collect now</p>
              <div className="grid grid-cols-3 gap-2">
                {COLLECT_METHODS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    disabled={busy || !bill}
                    onClick={() =>
                      // Cash gets the tendered/change step; the others are exact.
                      m.value === 'cash'
                        ? setStep('cash')
                        : attempt([{ method: m.value, amount_inr: total, tendered_inr: null }])
                    }
                    className="rounded-md bg-tan px-3 py-4 text-base font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              disabled={busy || !bill || total <= 1}
              onClick={() => setStep('split')}
              className="rounded-md border border-line px-4 py-2.5 text-sm font-bold text-charcoal transition-colors hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
            >
              Split across two methods
            </button>

            <button
              type="button"
              disabled={busy || !bill}
              onClick={() => attempt(null)}
              className="rounded-md border border-line px-4 py-3 text-sm font-bold text-charcoal transition-colors hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
            >
              Collect later — place unpaid
            </button>
          </>
        )}

        {submitting ? <p className="text-center text-sm text-muted">Placing order…</p> : null}
      </div>
  );
}

function MethodChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'rounded-md border px-3 py-2 text-sm font-bold transition-colors ' +
        (active ? 'border-tan bg-tan text-cream' : 'border-[#e5e5e5] text-charcoal hover:border-tan')
      }
    >
      {label}
    </button>
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
