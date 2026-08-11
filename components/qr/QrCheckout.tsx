'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart/CartContext';
import { normalizeIndianMobile } from '@/lib/phone';
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
  const [phone, setPhone] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [bill, setBill] = useState<BillBreakdown | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

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

    // Contact is optional (a QR diner may stay anonymous), but if given it must
    // be valid — the phone is where the WhatsApp bill lands and unlocks loyalty.
    if (phone.trim() && normalizeIndianMobile(phone) === null) {
      setPhoneError('Enter a valid 10-digit Indian mobile number, or leave it blank.');
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
        const data: { order: { id: string }; payment: CreatedPaymentIntent | null } =
          await res.json();
        clearCart();

        // Pay online first (D6): open Razorpay's hosted checkout for the intent
        // the server created. Both success and dismiss land on the live order
        // page, which server-reconciles the real payment_status. If the gateway
        // is unconfigured the server falls back to pay-at-counter (payment null)
        // and we go straight to the order page.
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

        router.push(`/order/${data.order.id}`);
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
          className="mt-5 rounded-md bg-tan px-5 py-2.5 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
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
          className="text-sm font-bold text-tan hover:underline"
        >
          &larr; Add more
        </button>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f6efe9] px-3 py-1 text-xs font-bold text-charcoal">
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
                <span className="font-bold text-charcoal">{item.name}</span>
                <span className="ml-1 text-sm text-muted">({item.variantLabel})</span>
                {item.addons.length > 0 ? (
                  <p className="mt-0.5 text-xs text-muted">
                    {item.addons.map((a) => a.optionName).join(', ')}
                  </p>
                ) : null}
                {item.specialInstructions ? (
                  <p className="mt-0.5 text-xs italic text-muted">Note: {item.specialInstructions}</p>
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
                <span className="min-w-[1.25rem] text-center text-sm font-bold text-charcoal">
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
              <span className="font-bold text-charcoal">₹{item.unitPriceInr * item.qty}</span>
            </div>
          </li>
        ))}
      </ul>

      {/* Optional contact — all skippable (server allows an anonymous QR order). */}
      <div className="mb-4 flex flex-col gap-3">
        <div>
          <label htmlFor="qr-name" className="mb-1 block text-sm font-bold text-charcoal">
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
          <label htmlFor="qr-phone" className="mb-1 block text-sm font-bold text-charcoal">
            Phone <span className="font-normal text-muted">(optional — for your bill on WhatsApp)</span>
          </label>
          <input
            id="qr-phone"
            type="tel"
            inputMode="numeric"
            maxLength={16}
            value={phone}
            onChange={(e) => {
              setPhone(e.target.value);
              if (phoneError) setPhoneError(null);
            }}
            placeholder="e.g. 98765 43210"
            className="w-full rounded-md border border-[#e5e5e5] px-3 py-2 text-charcoal outline-none focus:border-tan"
          />
          {phoneError ? <p className="mt-1 text-xs text-red-700">{phoneError}</p> : null}
        </div>
        <div>
          <label htmlFor="qr-email" className="mb-1 block text-sm font-bold text-charcoal">
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
          {emailError ? <p className="mt-1 text-xs text-red-700">{emailError}</p> : null}
        </div>
        <div>
          <label htmlFor="qr-notes" className="mb-1 block text-sm font-bold text-charcoal">
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
          <span className="font-bold text-tan">₹{displayBill.total_inr}</span>
        </div>
      </div>

      <p className="mb-4 rounded-md bg-[#f6efe9] px-4 py-3 text-sm text-charcoal">
        Pay securely now — your order joins the kitchen queue as soon as payment is confirmed, and
        we&apos;ll bring it to table {table.label}.
      </p>

      <p className="mb-4 text-xs text-muted">
        If you share your number, you agree to receive your bill and order updates on it via
        WhatsApp/SMS. We use it only for this order — never for marketing.
      </p>

      <button
        type="button"
        onClick={placeOrder}
        disabled={submitting || !storeAcceptingOrders}
        className="w-full rounded-md bg-tan px-4 py-3 font-bold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
      >
        {submitting
          ? 'Placing order…'
          : !storeAcceptingOrders
            ? 'Ordering unavailable right now'
            : `Pay ₹${displayBill.total_inr} & place order`}
      </button>
    </div>
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
