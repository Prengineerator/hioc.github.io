'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart/CartContext';
import { normalizeIndianMobile } from '@/lib/phone';
import { flags } from '@/lib/flags';
import { createClient } from '@/lib/supabase';
import { usePhoneOtp } from '@/lib/hooks/usePhoneOtp';
import { GetOtpButton, PhoneOtpPanel } from '@/components/checkout/PhoneOtpPanel';
import { normalizeEmail } from '@/lib/email';
import { openRazorpayCheckout } from '@/lib/payments/razorpayCheckout';
import type { CreatedPaymentIntent } from '@/lib/payments/types';
import type { BillBreakdown, StoreOpenState } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';
import type { ResolvedQrTable } from '@/lib/tables/resolveTableByToken';

// Dine-in bill preview (QR-1). Always calls the quote endpoint with
// order_type='dine_in' so packaging shows as ₹0 — the client NEVER computes
// money; POST /api/orders re-derives everything authoritatively at submit.
interface QuoteResponse {
  bill: BillBreakdown;
}

export function QrCheckout({
  token,
  table,
  settings,
  openState,
  onBackToMenu,
}: {
  token: string;
  table: ResolvedQrTable;
  settings: StoreSettings | null;
  openState: StoreOpenState | null;
  onBackToMenu: () => void;
}) {
  const router = useRouter();
  const { items, totalPrice, increment, decrement, removeItem, clearCart } = useCart();

  const [name, setName] = useState('');
  // VERIFY-2 — this pad had NO verification at all: the number was an optional
  // field, so a table-QR order could be placed against any number or none, and
  // the WhatsApp bill went wherever it said. Same hook as the web checkout, so
  // the two customer surfaces cannot enforce different rules.
  const otp = usePhoneOtp();
  const phone = otp.phone;
  const prefill = otp.prefillPhone;
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [bill, setBill] = useState<BillBreakdown | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Who is scanning. Only needed to decide whether the OTP step applies — a
  // signed-in customer has already verified a number, and the server will check
  // the order carries THAT one, so their number is prefilled rather than asked
  // for again. Best-effort throughout: a failed read leaves an anonymous diner,
  // which is the stricter of the two paths.
  useEffect(() => {
    let cancelled = false;
    void createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (cancelled) return;
        const uid = data.user?.id ?? null;
        setUserId(uid);
        if (!uid) return;
        return fetch('/api/account/me', { cache: 'no-store' })
          .then((res) => (res.ok ? res.json() : null))
          .then((body: unknown) => {
            if (cancelled || !body || typeof body !== 'object') return;
            const profile =
              ('profile' in body ? (body as { profile?: unknown }).profile : body) ?? {};
            const p = profile as { phone?: unknown };
            if (typeof p.phone === 'string' && p.phone.trim()) {
              prefill(normalizeIndianMobile(p.phone) ?? p.phone.trim());
            }
          })
          .catch(() => {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [prefill]);

  // The number is mandatory once the rule is on — for a guest because they must
  // verify it, and for a signed-in customer because the server checks the order
  // names their verified number (an empty field would read as a mismatch).
  const verifyRequired = flags.verifiedOrders && !userId;
  const phoneRequired = flags.verifiedOrders;
  const mustVerify = verifyRequired && !otp.verified;

  // Live dine-in bill preview — re-quotes whenever the cart subtotal changes.
  useEffect(() => {
    let cancelled = false;
    if (items.length === 0) {
      setBill(null);
      return;
    }
    fetch('/api/orders/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subtotal_inr: totalPrice,
        order_type: 'dine_in',
        item_ids: items.map((i) => i.menuItemId),
      }),
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: QuoteResponse | null) => {
        if (cancelled || !data) return;
        setBill(data.bill);
      })
      .catch(() => {
        // Best-effort preview; the server bill is authoritative at submit.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPrice, items.length]);

  const storeAcceptingOrders = !openState || openState.acceptingOrders;

  const displayBill: BillBreakdown = bill ?? {
    subtotal_inr: totalPrice,
    tax_inr: 0,
    packaging_inr: 0,
    discount_inr: 0,
    total_inr: totalPrice,
  };

  async function placeOrder() {
    setServerError(null);

    // Contact was optional when a QR diner could stay anonymous. Once the
    // verified-number rule is on it is not: the server refuses an order whose
    // number nobody confirmed, and refusing here says so before the round trip.
    if (phoneRequired && !phone.trim()) {
      setPhoneError('Enter the mobile number your bill should go to.');
      return;
    }
    if (phone.trim() && normalizeIndianMobile(phone) === null) {
      setPhoneError(
        phoneRequired
          ? 'Enter a valid 10-digit Indian mobile number.'
          : 'Enter a valid 10-digit Indian mobile number, or leave it blank.',
      );
      return;
    }
    if (mustVerify) {
      setPhoneError('Verify this number first — tap "Get OTP" and enter the code from WhatsApp.');
      return;
    }
    if (email.trim() && normalizeEmail(email) === null) {
      setEmailError('Enter a valid email address, or leave it blank.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The scanned token is the ONLY table proof sent — resolved
          // server-side; order_type is forced dine_in there too (belt + braces).
          qr_token: token,
          order_type: 'dine_in',
          customer_name: name.trim() || undefined,
          customer_phone: phone.trim() || undefined,
          customer_email: email.trim() || undefined,
          notes: notes.trim() || undefined,
          items: items.map((i) => ({
            menu_item_id: i.menuItemId,
            variant_id: i.variantId,
            quantity: i.qty,
            addon_option_ids: i.addons.map((a) => a.optionId),
            special_instructions: i.specialInstructions,
          })),
        }),
      });

      if (res.status === 201) {
        const data: {
          order: { id: string };
          payment: CreatedPaymentIntent | null;
          payment_unavailable?: boolean;
        } = await res.json();
        clearCart();

        // Pay online first (D6): open Razorpay's hosted checkout for the intent
        // the server created. Both success and dismiss land on the live order
        // page, which server-reconciles the real payment_status. If the gateway
        // is unconfigured or failing the server falls back to pay-at-counter
        // (payment null, payment_unavailable set) and the order page says so.
        if (data.payment) {
          openRazorpayCheckout(data.payment, {
            name,
            phone,
            description: `HIOC · Table ${table.label}`,
            onSuccess: () => router.push(`/order/${data.order.id}`),
            onDismiss: () => router.push(`/order/${data.order.id}`),
            onFailure: () => router.push(`/order/${data.order.id}`),
          });
          return;
        }

        router.push(
          `/order/${data.order.id}${data.payment_unavailable ? '?payment=unavailable' : ''}`,
        );
        return;
      }

      const data = await res.json().catch(() => ({ error: 'Unknown error' }));
      setServerError(data.error ?? 'Unknown error');
    } catch {
      setServerError('Network error — please check your connection.');
    } finally {
      setSubmitting(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <p className="text-muted">Your order is empty.</p>
        <button
          type="button"
          onClick={onBackToMenu}
          className="mt-5 rounded-md bg-tan px-5 py-2.5 text-sm font-semibold text-cream transition-colors hover:bg-tan-dark"
        >
          Back to the menu
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md px-4 py-8">
      <div className="mb-6 flex items-center justify-between">
        <button
          type="button"
          onClick={onBackToMenu}
          className="text-sm font-semibold text-tan hover:underline"
        >
          &larr; Add more
        </button>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f6efe9] px-3 py-1 text-xs font-semibold text-charcoal">
          <span aria-hidden>🍽️</span> Table {table.label}
        </span>
      </div>

      <h1 className="mb-4 text-xl font-bold text-charcoal">Your order</h1>

      {serverError ? (
        <div
          role="alert"
          className="mb-4 rounded-md border border-tan bg-[#f6efe9] px-4 py-3 text-sm text-charcoal"
        >
          {serverError}
        </div>
      ) : null}

      {/* Editable cart — qty steppers reuse the shared cart state (not forked). */}
      <ul className="mb-4 flex flex-col gap-3 rounded-md border border-[#e5e5e5] bg-cream p-4">
        {items.map((item) => (
          <li key={item.key} className="flex flex-col gap-2 border-b border-[#e5e5e5] pb-3 last:border-b-0 last:pb-0">
            <div className="flex items-start justify-between gap-2">
              <div>
                <span className="font-semibold text-charcoal">{item.name}</span>
                <span className="ml-1 text-sm text-muted">({item.variantLabel})</span>
                {item.addons.length > 0 ? (
                  <p className="mt-0.5 text-sm text-muted">
                    {item.addons.map((a) => a.optionName).join(', ')}
                  </p>
                ) : null}
                {item.specialInstructions ? (
                  <p className="mt-0.5 text-sm italic text-muted">Note: {item.specialInstructions}</p>
                ) : null}
              </div>
              <button
                type="button"
                aria-label={`Remove ${item.name}`}
                onClick={() => removeItem(item.key)}
                className="shrink-0 text-sm text-muted hover:text-charcoal"
              >
                Remove
              </button>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 rounded-md border border-[#e5e5e5] px-3 py-1">
                <button
                  type="button"
                  aria-label="Decrease quantity"
                  onClick={() => decrement(item.key)}
                  className="flex h-5 w-5 items-center justify-center rounded-full bg-charcoal text-xs text-cream"
                >
                  &minus;
                </button>
                <span className="min-w-[1.25rem] text-center text-sm font-mono font-semibold tabular-nums text-charcoal">
                  {item.qty}
                </span>
                <button
                  type="button"
                  aria-label="Increase quantity"
                  onClick={() => increment(item.key)}
                  className="flex h-5 w-5 items-center justify-center rounded-full bg-tan text-xs text-cream"
                >
                  +
                </button>
              </div>
              <span className="font-mono font-bold tabular-nums text-charcoal">₹{item.unitPriceInr * item.qty}</span>
            </div>
          </li>
        ))}
      </ul>

      {/* Optional contact — all skippable (server allows an anonymous QR order). */}
      <div className="mb-4 flex flex-col gap-3">
        <div>
          <label htmlFor="qr-name" className="mb-1 block text-sm font-semibold text-charcoal">
            Name <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id="qr-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Ayush"
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          />
        </div>
        <div>
          <label htmlFor="qr-phone" className="mb-1 block text-sm font-semibold text-charcoal">
            Phone{' '}
            <span className="font-normal text-muted">
              {phoneRequired
                ? '(we send your bill here on WhatsApp)'
                : '(optional — for your bill on WhatsApp)'}
            </span>
          </label>
          <div className="flex gap-2">
            <input
              id="qr-phone"
              type="tel"
              inputMode="numeric"
              required={phoneRequired}
              maxLength={16}
              value={phone}
              onChange={(e) => {
                otp.setPhone(e.target.value);
                if (phoneError) setPhoneError(null);
              }}
              placeholder="e.g. 98765 43210"
              className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
            {verifyRequired ? (
              <GetOtpButton
                otp={otp}
                onBeforeSend={() => {
                  if (normalizeIndianMobile(phone) !== null) return true;
                  setPhoneError('Enter a valid 10-digit Indian mobile number.');
                  return false;
                }}
              />
            ) : null}
          </div>
          {phoneError ? <p className="mt-1 text-sm text-red-700">{phoneError}</p> : null}
          {verifyRequired ? <PhoneOtpPanel otp={otp} /> : null}
        </div>
        <div>
          <label htmlFor="qr-email" className="mb-1 block text-sm font-semibold text-charcoal">
            Email <span className="font-normal text-muted">(optional — for your bill)</span>
          </label>
          <input
            id="qr-email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (emailError) setEmailError(null);
            }}
            placeholder="you@example.com"
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          />
          {emailError ? <p className="mt-1 text-sm text-red-700">{emailError}</p> : null}
        </div>
        <div>
          <label htmlFor="qr-notes" className="mb-1 block text-sm font-semibold text-charcoal">
            Notes <span className="font-normal text-muted">(optional)</span>
          </label>
          <textarea
            id="qr-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Any special requests"
            rows={2}
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          />
        </div>
      </div>

      {/* Bill breakup (from the quote endpoint) — packaging is ₹0 for dine-in. */}
      <div className="mb-4 rounded-md border border-[#e5e5e5] px-4 py-3 text-sm text-charcoal">
        <BillRow label="Subtotal" value={displayBill.subtotal_inr} />
        {displayBill.tax_inr > 0 ? <BillRow label="GST" value={displayBill.tax_inr} /> : null}
        {displayBill.discount_inr > 0 ? (
          <BillRow label="Discount" value={-displayBill.discount_inr} />
        ) : null}
        <div className="mt-2 flex items-center justify-between border-t border-[#e5e5e5] pt-2">
          <span className="font-bold text-charcoal">Total</span>
          <span className="font-mono font-bold tabular-nums text-tan">₹{displayBill.total_inr}</span>
        </div>
      </div>

      <p className="mb-4 rounded-md bg-[#f6efe9] px-4 py-3 text-sm text-charcoal">
        Pay securely now — your order joins the kitchen queue as soon as payment is confirmed, and
        we&apos;ll bring it to table {table.label}.
      </p>

      <p className="mb-4 text-sm text-muted">
        If you share your number, you agree to receive your bill and order updates on it via
        WhatsApp/SMS. We use it only for this order — never for marketing.
      </p>

      <button
        type="button"
        onClick={placeOrder}
        disabled={submitting || otp.busy || !storeAcceptingOrders || mustVerify}
        className="w-full rounded-md bg-tan px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting ? (
          'Placing order…'
        ) : !storeAcceptingOrders ? (
          'Ordering unavailable right now'
        ) : mustVerify ? (
          'Verify your number to order'
        ) : (
          <>
            Pay <span className="font-mono tabular-nums">₹{displayBill.total_inr}</span> & place order
          </>
        )}
      </button>
    </div>
  );
}

function BillRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span>{label}</span>
      <span className="font-mono tabular-nums">{value < 0 ? `-₹${Math.abs(value)}` : `₹${value}`}</span>
    </div>
  );
}
