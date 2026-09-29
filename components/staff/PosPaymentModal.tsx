'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { normalizeIndianMobile } from '@/lib/phone';
import {
  changeDueInr,
  COUNTER_PAYMENT_METHODS,
  isAppPaymentMethod,
  parsePaymentReference,
  PAYMENT_REFERENCE_LABEL,
  shortNeedsManager,
  STAFF_SETTLE_SHORT_LIMIT_INR,
  type PaymentPart,
} from '@/lib/orders/payments';
import { PAYMENT_METHOD_LABEL } from '@/lib/print/labels';
import { openDrawerIfCash } from '@/lib/desktop/drawer';
import { CustomerSuggestionList, useCustomerSuggestions } from '@/components/staff/CustomerPhoneSuggestions';
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

const COLLECT_METHODS: { value: PaymentMethod; label: string }[] = COUNTER_PAYMENT_METHODS.map((m) => ({
  value: m,
  label: PAYMENT_METHOD_LABEL[m] ?? m,
}));

// The "Collect now" step shows the money the counter takes itself first, and
// the dining apps (Swiggy Dineout, Zomato District — the diner already paid in
// the app) as their own row, so a staffer can't mistake one for UPI.
const IN_HAND_METHODS = COLLECT_METHODS.filter((m) => !isAppPaymentMethod(m.value));
const APP_METHODS = COLLECT_METHODS.filter((m) => isAppPaymentMethod(m.value));

const methodLabel = (m: PaymentMethod): string => PAYMENT_METHOD_LABEL[m] ?? m;

// Notes an Indian counter actually sees. "Exact" fills the bill total.
const TENDER_CHIPS = [100, 200, 500, 2000];

// Settle mode only: recording a bill as paid for less (settlement discount) or
// more (tip) than its total. Quick reasons a counter actually gives; "Other"
// clears the field so the staffer types their own.
const SETTLE_REASON_CHIPS = ['Rounded off', 'No change', 'Customer short', 'Tip', 'Other'];

/** The `adjustment` body the settle route takes — see PATCH /api/orders/[id]/payment. */
export interface SettleAdjustmentInput {
  short_inr?: number;
  tip_inr?: number;
  reason: string;
}

type Step = 'choose' | 'cash' | 'split' | 'custom' | 'app';

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
  // `adjustment` is only ever passed in settle mode ("Different amount…"); the
  // place-mode caller can keep ignoring the second argument.
  onSubmit: (parts: PaymentPart[] | null, adjustment?: SettleAdjustmentInput) => void;
  onClose: () => void;
  /**
   * 'place' (default): taking a new order — phone for the bill, and "Collect
   * later". 'settle': recording payment on an order that already exists (the
   * Settle screen, or changing how a bill was paid) — no phone (the order
   * already has its customer) and no "collect later" (it already is unpaid).
   */
  mode?: 'place' | 'settle';
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
  mode = 'place',
}: PaymentStepProps & { docked?: boolean }) {
  const isDineIn = orderType === 'dine_in';
  const settling = mode === 'settle';
  const phoneRef = useRef<HTMLInputElement>(null);
  const total = bill?.total_inr ?? 0;

  // Every button that would COMMIT money is gated on both. Navigation (Back,
  // "Back to order") and the phone field stay live: a stale quote is a reason to
  // wait a beat, not to trap the staffer inside the step.
  const busy = submitting || stale;

  const [step, setStep] = useState<Step>('choose');
  // DRW-1: the drawer opens on the Cash tap, before anything is placed; a
  // drawer that didn't open is a small note here, never a blocked sale.
  const [drawerNote, setDrawerNote] = useState<string | null>(null);
  function openDrawerFor(parts: PaymentPart[]) {
    setDrawerNote(null);
    void openDrawerIfCash(parts).then((err) => {
      if (err) setDrawerNote(err);
    });
  }
  const [pending, setPending] = useState<{ parts: PaymentPart[] | null } | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const phoneMatches = useCustomerSuggestions(phone, !settling);

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
  const [firstRef, setFirstRef] = useState('');
  const [secondRef, setSecondRef] = useState('');
  const firstNum = Number.parseInt(firstAmount, 10);
  const firstValid = Number.isFinite(firstNum) && firstNum > 0 && firstNum < total;
  const remainder = firstValid ? total - firstNum : 0;

  // Custom step (settle only) — the amount actually received, which may differ
  // from the bill: short → settlement discount, extra → tip.
  const [customMethod, setCustomMethod] = useState<PaymentMethod>('cash');
  const [customAmount, setCustomAmount] = useState('');
  const [customTendered, setCustomTendered] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [customRef, setCustomRef] = useState('');
  const customNum = Number.parseInt(customAmount, 10);
  const customAmountValid = Number.isFinite(customNum) && customNum > 0;
  const customDiff = customAmountValid ? customNum - total : 0;
  const customShort = customDiff < 0 ? -customDiff : 0;
  const customTip = customDiff > 0 ? customDiff : 0;
  const customReasonValid = customDiff === 0 || customReason.trim().length >= 3;
  const customTenderedNum = Number.parseInt(customTendered, 10);
  const customCashShort =
    customMethod === 'cash' &&
    customTendered.trim().length > 0 &&
    (!Number.isFinite(customTenderedNum) || customTenderedNum < customNum);

  // Dining-app step — the whole bill on one app, with its booking ID.
  const [appMethod, setAppMethod] = useState<PaymentMethod>('swiggy_dineout');
  const [appRef, setAppRef] = useState('');
  const appRefParsed = parsePaymentReference(appRef);

  // A dining-app tender can't be taken without its booking ID; anything else
  // needs none. `null` reference = not needed.
  const refFor = (method: PaymentMethod, raw: string): string | null | false => {
    if (!isAppPaymentMethod(method)) return null;
    const parsed = parsePaymentReference(raw);
    return parsed.ok ? parsed.reference : false;
  };
  const customRefValue = refFor(customMethod, customRef);

  useEffect(() => {
    phoneRef.current?.focus();
  }, []);

  // Settling an existing order: nothing to ask about a phone.
  const submitParts = (parts: PaymentPart[] | null, adjustment?: SettleAdjustmentInput) => {
    if (stale) return;
    onSubmit(parts, adjustment);
  };

  // One funnel for every settle, so the phone rule can't differ per path.
  function attempt(parts: PaymentPart[] | null, adjustment?: SettleAdjustmentInput) {
    // The last line of defence for the stale-quote race: the buttons are already
    // disabled, but a tap can land in the same frame the cart changes in.
    if (stale) return;
    if (settling) {
      submitParts(parts, adjustment);
      return;
    }
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
    const refA = refFor(firstMethod, firstRef);
    const refB = refFor(secondMethod, secondRef);
    if (refA === false || refB === false) return null;
    const a: PaymentPart = {
      method: firstMethod,
      amount_inr: firstNum,
      tendered_inr:
        firstMethod === 'cash' && splitTendered.trim()
          ? Number.parseInt(splitTendered, 10)
          : null,
      ...(refA ? { reference: refA } : {}),
    };
    const b: PaymentPart = {
      method: secondMethod,
      amount_inr: remainder,
      tendered_inr: null,
      ...(refB ? { reference: refB } : {}),
    };
    return [a, b];
    // refFor is a pure helper recreated each render; its inputs are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstValid, firstMethod, firstNum, secondMethod, remainder, splitTendered, firstRef, secondRef]);

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

        {settling ? null : (
        <div>
          <label htmlFor="pos-bill-phone" className="mb-1 block text-sm font-bold text-charcoal">
            Bill on WhatsApp
          </label>
          <div className="relative">
          <input
            id="pos-bill-phone"
            ref={phoneRef}
            value={phone}
            onFocus={() => setSuggestOpen(true)}
            onBlur={() => setSuggestOpen(false)}
            onChange={(e) => {
              onPhoneChange(e.target.value);
              setSuggestOpen(true);
              if (phoneError) setPhoneError(null);
              if (pending) setPending(null);
            }}
            inputMode="numeric"
            // Our own suggestions replace the browser's autofill list here.
            autoComplete="off"
            placeholder="10-digit mobile number"
            disabled={submitting}
            className="w-full rounded-md border border-line px-3 py-3 text-base outline-none focus:border-tan disabled:opacity-50"
          />
          {/* Customer suggestions while the number is typed (4+ digits). */}
          <CustomerSuggestionList
            matches={suggestOpen ? phoneMatches : []}
            onPick={(c) => {
              onPhoneChange(c.phone);
              setSuggestOpen(false);
              if (phoneError) setPhoneError(null);
              if (pending) setPending(null);
            }}
          />
          </div>
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
        )}

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
                  <span className="text-lg font-bold text-tan-dark">₹{bill.total_inr}</span>
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
          <div className="rounded-md border border-line bg-surface px-4 py-3">
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
                className="rounded-md bg-tan-dark px-3 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-darker disabled:opacity-50"
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
                className="rounded-md border border-line px-3 py-3 text-sm font-bold text-charcoal transition-colors hover:border-tan disabled:opacity-50"
              >
                Continue anyway
              </button>
            </div>
          </div>
        ) : step === 'cash' ? (
          /* ---- Cash: tendered → change ------------------------------------ */
          <div className="rounded-md border border-line px-4 py-3">
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
              className="mt-1 w-full rounded-md border border-line px-3 py-3 text-lg font-bold outline-none focus:border-tan"
            />
            <div className="mt-2 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setTendered(String(total))}
                className="rounded-md border border-line px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
              >
                Exact ₹{total}
              </button>
              {TENDER_CHIPS.filter((c) => c >= total).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setTendered(String(c))}
                  className="rounded-md border border-line px-3 py-1.5 text-xs font-bold text-charcoal hover:border-tan"
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

            <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
              <span className="text-sm font-bold text-charcoal">Change due</span>
              <span className="text-2xl font-bold text-tan-dark">₹{change}</span>
            </div>

            <button
              type="button"
              disabled={busy || !tenderedValid}
              onClick={() =>
                attempt([{ method: 'cash', amount_inr: total, tendered_inr: tenderedNum }])
              }
              className="mt-3 w-full rounded-md bg-tan-dark px-3 py-3 text-base font-bold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-50"
            >
              Take ₹{total} cash
            </button>
          </div>
        ) : step === 'custom' ? (
          /* ---- Different amount: short = discount, extra = tip ------------ */
          <div className="rounded-md border border-line px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-charcoal">Different amount — bill ₹{total}</p>
              <button
                type="button"
                onClick={() => {
                  setStep('choose');
                  setCustomAmount('');
                  setCustomTendered('');
                  setCustomReason('');
                  setCustomRef('');
                }}
                className="text-xs font-bold text-muted underline"
              >
                Back
              </button>
            </div>

            <p className="mt-3 text-xs font-bold uppercase tracking-wide text-muted">Paid by</p>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {COLLECT_METHODS.map((m) => (
                <MethodChip
                  key={m.value}
                  label={m.label}
                  active={customMethod === m.value}
                  onClick={() => {
                    setCustomMethod(m.value);
                    setCustomTendered('');
                  }}
                />
              ))}
            </div>

            {isAppPaymentMethod(customMethod) ? (
              <ReferenceField id="pos-custom-ref" method={customMethod} value={customRef} onChange={setCustomRef} />
            ) : null}

            <label htmlFor="pos-custom-amount" className="mt-3 block text-xs font-bold uppercase tracking-wide text-muted">
              Amount received
            </label>
            <input
              id="pos-custom-amount"
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value.replace(/[^0-9]/g, ''))}
              inputMode="numeric"
              placeholder={String(total)}
              autoFocus
              className="mt-1 w-full rounded-md border border-line px-3 py-3 text-lg font-bold outline-none focus:border-tan"
            />

            {customAmountValid ? (
              customShort > 0 ? (
                <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm font-bold text-amber-900">
                  Short ₹{customShort} — settlement discount
                  {shortNeedsManager(customShort) ? (
                    <p className="mt-0.5 text-xs font-normal">
                      Above ₹{STAFF_SETTLE_SHORT_LIMIT_INR} — needs a manager or the owner to approve.
                    </p>
                  ) : null}
                </div>
              ) : customTip > 0 ? (
                <div className="mt-2 rounded-md bg-green-50 px-3 py-2 text-sm font-bold text-green-800">
                  Extra ₹{customTip} — tip
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted">Matches the bill — no adjustment.</p>
              )
            ) : null}

            {customMethod === 'cash' && customAmountValid ? (
              <>
                <input
                  value={customTendered}
                  onChange={(e) => setCustomTendered(e.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric"
                  placeholder={`Cash handed over, if change is given (₹${customNum})`}
                  className="mt-2 w-full rounded-md border border-line px-3 py-2 text-base outline-none focus:border-tan"
                />
                {customCashShort ? (
                  <p role="alert" className="mt-1 text-xs text-red-700">
                    Less than the ₹{customNum} received.
                  </p>
                ) : customTendered.trim() ? (
                  <p className="mt-1 text-xs text-muted">
                    Change due ₹{changeDueInr(customTenderedNum, customNum)}
                  </p>
                ) : null}
              </>
            ) : null}

            {customDiff !== 0 ? (
              <>
                <p className="mt-3 text-xs font-bold uppercase tracking-wide text-muted">Reason (required)</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {SETTLE_REASON_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => setCustomReason(chip === 'Other' ? '' : chip)}
                      className={
                        'rounded-md border px-3 py-1.5 text-xs font-bold transition-colors ' +
                        (customReason === chip
                          ? 'border-tan bg-tan-dark text-cream'
                          : 'border-line text-charcoal hover:border-tan')
                      }
                    >
                      {chip}
                    </button>
                  ))}
                </div>
                <input
                  value={customReason}
                  onChange={(e) => setCustomReason(e.target.value)}
                  maxLength={200}
                  placeholder="Reason"
                  aria-label="Reason for the difference"
                  className="mt-2 w-full rounded-md border border-line px-3 py-2 text-base outline-none focus:border-tan"
                />
              </>
            ) : null}

            <button
              type="button"
              disabled={
                busy || !customAmountValid || !customReasonValid || customCashShort || customRefValue === false
              }
              onClick={() => {
                if (!customAmountValid || stale || customRefValue === false) return;
                const part: PaymentPart = {
                  method: customMethod,
                  amount_inr: customNum,
                  tendered_inr:
                    customMethod === 'cash' && customTendered.trim() ? customTenderedNum : null,
                  ...(customRefValue ? { reference: customRefValue } : {}),
                };
                if (customMethod === 'cash') openDrawerFor([part]);
                attempt(
                  [part],
                  customDiff === 0
                    ? undefined
                    : {
                        ...(customShort > 0 ? { short_inr: customShort } : { tip_inr: customTip }),
                        reason: customReason.trim(),
                      },
                );
              }}
              className="mt-4 w-full rounded-md bg-tan-dark px-3 py-3 text-base font-bold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-50"
            >
              {customAmountValid
                ? `Take ₹${customNum} ${methodLabel(customMethod)}` +
                  (customShort > 0 ? ` (₹${customShort} short)` : customTip > 0 ? ` (₹${customTip} tip)` : '')
                : 'Enter the amount received'}
            </button>
          </div>
        ) : step === 'app' ? (
          /* ---- Paid on a dining app: booking ID, then settle --------------- */
          <div className="rounded-md border border-line px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-charcoal">
                {methodLabel(appMethod)} — ₹{total}
              </p>
              <button
                type="button"
                onClick={() => {
                  setStep('choose');
                  setAppRef('');
                }}
                className="text-xs font-bold text-muted underline"
              >
                Back
              </button>
            </div>

            <ReferenceField id="pos-app-ref" method={appMethod} value={appRef} onChange={setAppRef} autoFocus />

            <button
              type="button"
              disabled={busy || !appRefParsed.ok}
              onClick={() => {
                if (!appRefParsed.ok || stale) return;
                attempt([{ method: appMethod, amount_inr: total, tendered_inr: null, reference: appRefParsed.reference }]);
              }}
              className="mt-4 w-full rounded-md bg-tan-dark px-3 py-3 text-base font-bold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-50"
            >
              {appRefParsed.ok ? `Settle ₹${total} on ${methodLabel(appMethod)}` : 'Enter the booking ID'}
            </button>
          </div>
        ) : step === 'split' ? (
          /* ---- Split across two methods ----------------------------------- */
          <div className="rounded-md border border-line px-4 py-3">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold text-charcoal">Split ₹{total}</p>
              <button
                type="button"
                onClick={() => {
                  setStep('choose');
                  setFirstAmount('');
                  setSplitTendered('');
                  setFirstRef('');
                  setSecondRef('');
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
              className="mt-2 w-full rounded-md border border-line px-3 py-2 text-base outline-none focus:border-tan"
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
                  className="mt-2 w-full rounded-md border border-line px-3 py-2 text-base outline-none focus:border-tan"
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

            {isAppPaymentMethod(firstMethod) ? (
              <ReferenceField id="pos-split-ref-1" method={firstMethod} value={firstRef} onChange={setFirstRef} />
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
                {isAppPaymentMethod(secondMethod) ? (
                  <ReferenceField id="pos-split-ref-2" method={secondMethod} value={secondRef} onChange={setSecondRef} />
                ) : null}
              </>
            ) : null}

            <button
              type="button"
              disabled={busy || !firstValid || splitCashShort || !splitParts}
              onClick={() => {
                if (!splitParts || stale) return;
                // A cash part goes in the drawer, so it opens with this tap.
                openDrawerFor(splitParts);
                attempt(splitParts);
              }}
              className="mt-4 w-full rounded-md bg-tan-dark px-3 py-3 text-base font-bold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-50"
            >
              {firstValid
                ? `Take ₹${firstNum} ${methodLabel(firstMethod)} + ₹${remainder} ${methodLabel(secondMethod)}`
                : 'Enter the first amount'}
            </button>
          </div>
        ) : (
          /* ---- Method choice ---------------------------------------------- */
          <>
            <div>
              <p className="mb-2 text-sm font-bold text-charcoal">Collect now</p>
              <div className="grid grid-cols-3 gap-2">
                {IN_HAND_METHODS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    disabled={busy || !bill}
                    onClick={() => {
                      // Cash gets the tendered/change step; the others are exact.
                      // DRW-1: the drawer opens now, so the staffer can take the
                      // notes and count change while the step is on screen.
                      if (m.value === 'cash') {
                        openDrawerFor([{ method: 'cash', amount_inr: total, tendered_inr: null }]);
                        setStep('cash');
                      } else {
                        attempt([{ method: m.value, amount_inr: total, tendered_inr: null }]);
                      }
                    }}
                    className="rounded-md bg-tan-dark px-3 py-4 text-base font-bold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-2 text-sm font-bold text-charcoal">Paid on a dining app</p>
              <div className="grid grid-cols-2 gap-2">
                {APP_METHODS.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    disabled={busy || !bill}
                    // Exact, like UPI/card: the app took the whole bill — but
                    // never without its booking ID, so this opens a step for it.
                    onClick={() => {
                      setAppMethod(m.value);
                      setAppRef('');
                      setStep('app');
                    }}
                    className="rounded-md border-2 border-tan-dark px-3 py-3 text-sm font-bold text-tan-dark transition-colors hover:bg-tan-dark hover:text-cream disabled:cursor-not-allowed disabled:opacity-50"
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

            {settling ? (
              // Short = settlement discount, extra = tip — always with a reason.
              <button
                type="button"
                disabled={busy || !bill}
                onClick={() => setStep('custom')}
                className="rounded-md border border-line px-4 py-2.5 text-sm font-bold text-charcoal transition-colors hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
              >
                Different amount…
              </button>
            ) : null}

            {settling ? null : (
            <button
              type="button"
              disabled={busy || !bill}
              onClick={() => attempt(null)}
              className="rounded-md border border-line px-4 py-3 text-sm font-bold text-charcoal transition-colors hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
            >
              Collect later — place unpaid
            </button>
            )}
          </>
        )}

        {drawerNote ? <p className="text-center text-xs font-bold text-red-700">{drawerNote}</p> : null}
        {submitting ? (
          <p className="text-center text-sm text-muted">{settling ? 'Recording payment…' : 'Placing order…'}</p>
        ) : null}
      </div>
  );
}

// The booking / transaction ID for a dining-app tender. Normalised as it will
// be stored (spaces dropped, upper-case) only for validation — the staffer's
// typing is left alone.
function ReferenceField({
  id,
  method,
  value,
  onChange,
  autoFocus = false,
}: {
  id: string;
  method: PaymentMethod;
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  const parsed = parsePaymentReference(value);
  return (
    <div className="mt-3">
      <label htmlFor={id} className="block text-xs font-bold uppercase tracking-wide text-muted">
        {methodLabel(method)} {PAYMENT_REFERENCE_LABEL}
      </label>
      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        maxLength={60}
        placeholder="From the diner's booking screen"
        aria-invalid={value.trim() !== '' && !parsed.ok}
        className="mt-1 w-full rounded-md border border-line px-3 py-3 text-lg font-bold uppercase tracking-wide outline-none focus:border-tan"
      />
      {value.trim() && !parsed.ok ? (
        <p role="alert" className="mt-1 text-xs text-red-700">
          {parsed.error}
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted">
          Check it on the diner&rsquo;s app or the partner app — it&rsquo;s how the payout is matched.
        </p>
      )}
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
        (active ? 'border-tan bg-tan-dark text-cream' : 'border-line text-charcoal hover:border-tan')
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
