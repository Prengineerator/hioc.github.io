'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useCart } from '@/lib/cart/CartContext';
import { collectSuggestionSessionIds } from '@/lib/cart/suggestionIds';
import { postSuggestEvent } from '@/components/suggest/api';
import { normalizeIndianMobile } from '@/lib/phone';
import { usePhoneOtp } from '@/lib/hooks/usePhoneOtp';
import { GetOtpButton, PhoneOtpPanel } from '@/components/checkout/PhoneOtpPanel';
import { normalizeEmail } from '@/lib/email';
import { generatePickupSlots } from '@/lib/store/hours';
import type { BillBreakdown, StoreOpenState } from '@/lib/store/hours';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { createClient } from '@/lib/supabase';
import { openRazorpayCheckout, preloadRazorpay } from '@/lib/payments/razorpayCheckout';
import type { CreatedPaymentIntent } from '@/lib/payments/types';
import type { MenuItem, OrderType, StoreSettings } from '@/lib/types';

// Takeaway + dine-in for Phase-1. Both are pickup-at-counter flows (dine-in
// just means eating in), so they share the same checkout. 'delivery' stays out
// until Phase-2 adds an address/dispatch flow.
const ORDER_TYPE_OPTIONS: { value: OrderType; label: string }[] = [
  { value: 'takeaway', label: 'Takeaway' },
  { value: 'dine_in', label: 'Dine-in' },
];

// Online payment (PAY-1) is only offered when a public Razorpay key is
// configured — otherwise the toggle is hidden and every order is pay-at-
// counter, matching Phase-1 behavior exactly (FND-1 "gateway unset" fallback).
const ONLINE_PAYMENT_AVAILABLE = Boolean(process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID);

// Two ways to check out (owner rule, enforced by POST /api/orders too):
//  * Signed in — the order carries a WhatsApp-verified mobile. A mobile login
//    is already verified; an email login verifies (and links) it here. Pay
//    online or at the counter.
//  * Guest — name only: no mobile, no email, no code. Online payment only; the
//    order reaches the kitchen once paid, and is tracked on the order page.

// Guest-order claim (ACC-4). Fired once right after a guest verifies their
// number at checkout (which logs them in), so any past orders they placed as a
// guest with the same number link onto the now-authenticated account — matching
// what app/login/page.tsx does after every login path. Best-effort: a failure
// here must never block placing the order.
async function claimGuestOrders() {
  try {
    await fetch('/api/account/claim', { method: 'POST' });
  } catch {
    // best-effort — the order still gets placed under the new session.
  }
}

interface QuoteResponse {
  bill: BillBreakdown;
  coupon: { ok: boolean; discountInr: number; reason?: string } | null;
  points: { ok: boolean; points: number; discountInr: number; reason?: string } | null;
  balance: number | null;
}

export function CheckoutForm({
  settings,
  openState,
}: {
  settings: StoreSettings | null;
  openState: StoreOpenState | null;
}) {
  const router = useRouter();
  const { items, totalPrice, clearCart } = useCart();

  // Phase-7 (SUG-8/SUG-9): distinct suggestion session ids carried by the
  // cart lines currently in this order, capped and omitted-when-empty by the
  // shared helper. Fire 'checkout_started' once per session id the first time
  // it's seen on this checkout form (covers "mounts with suggested lines" —
  // and, since carts can change items while checkout is open, also a session
  // id that only shows up later, e.g. after navigating back to add another
  // suggested item).
  const suggestionSessionIds = useMemo(() => collectSuggestionSessionIds(items), [items]);
  const firedCheckoutStarted = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!suggestionSessionIds) return;
    for (const id of suggestionSessionIds) {
      if (!firedCheckoutStarted.current.has(id)) {
        firedCheckoutStarted.current.add(id);
        postSuggestEvent(id, 'checkout_started');
      }
    }
  }, [suggestionSessionIds]);

  const [name, setName] = useState('');
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [email, setEmail] = useState(''); // optional — for the e-bill by email
  const [emailError, setEmailError] = useState<string | null>(null);
  const [orderType, setOrderType] = useState<OrderType>('takeaway');
  const [slotStart, setSlotStart] = useState<string | null>(null); // null = not yet picked
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [unavailableNames, setUnavailableNames] = useState<string[]>([]);

  const [paymentMode, setPaymentMode] = useState<'online' | 'counter'>('counter');
  const [userId, setUserId] = useState<string | null>(null);
  // False until the session lookup below answers — the form must not pick the
  // guest or signed-in layout (or submit) before it knows which it is.
  const [authChecked, setAuthChecked] = useState(false);
  // The signed-in account's already-verified number ('+91…'), if any.
  const [verifiedAccountPhone, setVerifiedAccountPhone] = useState<string | null>(null);

  // Guest WhatsApp-OTP verification (ACC-4). The mechanics — including the
  // re-lock when the number is edited — live in usePhoneOtp(), shared with the
  // table-QR pad (VERIFY-2) so the two customer surfaces cannot drift into
  // enforcing different things.
  //
  // Verifying does NOT place the order: once the number is confirmed the
  // payment choice (Pay online / Pay at counter) is revealed and the guest
  // places the order with the normal submit button. `otp.verified` stays true
  // regardless of how placement turns out, so a failed placement never forces
  // a re-verify against a code that has since expired.
  const otp = usePhoneOtp({
    onVerified: () => {
      claimGuestOrders();
    },
    // A signed-in customer (e.g. email login) adds the number to THIS account
    // rather than being signed in as a separate phone account.
    linkToAccount: Boolean(userId),
  });
  const phone = otp.phone;
  const phoneVerified = otp.verified;
  // Destructured: the prefill effect below depends on this, and `otp` itself is
  // a fresh object every render.
  const prefill = otp.prefillPhone;

  const [couponInput, setCouponInput] = useState('');
  const [couponApplied, setCouponApplied] = useState<string | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);
  const [couponBusy, setCouponBusy] = useState(false);

  const [pointsInput, setPointsInput] = useState('');
  const [pointsApplied, setPointsApplied] = useState<number | null>(null);
  const [pointsError, setPointsError] = useState<string | null>(null);
  const [pointsBusy, setPointsBusy] = useState(false);
  const [balance, setBalance] = useState<number | null>(null);

  const [bill, setBill] = useState<BillBreakdown | null>(null);
  const [couponDiscountInr, setCouponDiscountInr] = useState(0);
  const [pointsDiscountInr, setPointsDiscountInr] = useState(0);

  const slots = useMemo(
    () => (settings ? generatePickupSlots(settings) : []),
    [settings],
  );

  // Default to the first slot (ASAP) once slots load; re-pick if the
  // previously-selected slot has scrolled out of the list (e.g. it's no
  // longer in the future after a slow checkout).
  useEffect(() => {
    if (slots.length === 0) {
      setSlotStart(null);
      return;
    }
    if (slotStart === null || !slots.some((s) => s.start === slotStart)) {
      setSlotStart(slots[0].start);
    }
  }, [slots, slotStart]);

  // Re-validate cart item availability at checkout (C3): an item can get 86'd
  // between being added to the cart and reaching this page. This is a
  // best-effort UX check — the POST /api/orders call is still the
  // authoritative gate and will reject with a clear error either way.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/menu?includeUnavailable=true')
      .then((res) => res.json())
      .then((data: { items?: MenuItem[] }) => {
        if (cancelled) return;
        const byId = new Map((data.items ?? []).map((i) => [i.id, i]));
        const names: string[] = [];
        for (const line of items) {
          const menuItem = byId.get(line.menuItemId);
          if (!menuItem || !isMenuItemAvailable(menuItem)) {
            names.push(line.name);
          }
        }
        setUnavailableNames(names);
      })
      .catch(() => {
        // Fail open on this best-effort check — the server still validates.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detect a logged-in session (ACC-1 prefill + FND-4 points eligibility).
  // Uses the browser Supabase client directly rather than depending on the
  // Accounts pillar's /api/account/me route being live yet.
  useEffect(() => {
    let cancelled = false;
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      const uid = data.user?.id ?? null;
      setUserId(uid);
      setAuthChecked(true);
      if (!uid) return;
      // Best-effort prefill (ACC-1/ACC-3 contract) — gracefully no-ops if the
      // Accounts pillar's route isn't built yet (404) or the shape differs.
      fetch('/api/account/me', { cache: 'no-store' })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: unknown) => {
          if (cancelled || !data || typeof data !== 'object') return;
          const profile =
            ('profile' in data ? (data as { profile?: unknown }).profile : data) ?? {};
          if (profile && typeof profile === 'object') {
            const p = profile as {
              name?: unknown;
              phone?: unknown;
              phone_verified?: unknown;
              prefill?: { name?: unknown; email?: unknown };
            };
            if (p.phone_verified === true && typeof p.phone === 'string' && p.phone.trim()) {
              setVerifiedAccountPhone(p.phone.trim());
            }
            // `prefill` falls back to the customer's most recent order when the
            // profile has no name / no verified email (most WhatsApp-code
            // logins) — see lib/account/prefill.ts.
            const fromPrefill = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
            const prefillName =
              fromPrefill(p.prefill?.name) || (typeof p.name === 'string' ? p.name.trim() : '');
            const prefillEmail = fromPrefill(p.prefill?.email);
            const prefillPhone = typeof p.phone === 'string' ? p.phone.trim() : '';
            if (prefillName) setName((n) => n || prefillName);
            if (prefillEmail) setEmail((e) => e || prefillEmail);
            // Only prefill an EMPTY field: someone who has already started
            // typing must not have it overwritten when the profile lands.
            if (prefillPhone) {
              prefill(normalizeIndianMobile(prefillPhone) ?? prefillPhone);
            }
          }
        })
        .catch(() => {
          // No prefill — the form is still fully usable manually.
        });
    });
    return () => {
      cancelled = true;
    };
  }, [prefill]);

  // Live bill preview (PAY-1): re-quotes whenever the cart subtotal changes.
  // Coupon/points are (re-)applied explicitly via their Apply buttons, which
  // call the same function with the values being applied.
  async function refreshQuote(nextCoupon: string, nextPoints: number): Promise<QuoteResponse | null> {
    try {
      const res = await fetch('/api/orders/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subtotal_inr: totalPrice,
          coupon_code: nextCoupon || undefined,
          redeem_points: nextPoints || undefined,
          item_ids: items.map((i) => i.menuItemId),
        }),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as QuoteResponse;
      setBill(data.bill);
      setBalance(data.balance);
      // Keep the itemized discount lines in sync with whatever was actually
      // requested this call — covers the subtotal-changed refresh path too,
      // not just the explicit Apply buttons.
      setCouponDiscountInr(nextCoupon && data.coupon?.ok ? data.coupon.discountInr : 0);
      setPointsDiscountInr(nextPoints > 0 && data.points?.ok ? data.points.discountInr : 0);
      return data;
    } catch {
      return null;
    }
  }

  useEffect(() => {
    refreshQuote(couponApplied ?? '', pointsApplied ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPrice]);

  async function applyCoupon() {
    const code = couponInput.trim();
    if (!code) return;
    setCouponBusy(true);
    setCouponError(null);
    const data = await refreshQuote(code, pointsApplied ?? 0);
    if (data?.coupon?.ok) {
      setCouponApplied(code);
      setCouponError(null);
    } else {
      setCouponApplied(null);
      setCouponError(data?.coupon?.reason ?? 'This coupon could not be applied.');
      await refreshQuote('', pointsApplied ?? 0);
    }
    setCouponBusy(false);
  }

  function removeCoupon() {
    setCouponApplied(null);
    setCouponInput('');
    setCouponError(null);
    refreshQuote('', pointsApplied ?? 0);
  }

  async function applyPoints() {
    const pts = parseInt(pointsInput, 10);
    if (!Number.isFinite(pts) || pts <= 0) {
      setPointsError('Enter a valid number of points.');
      return;
    }
    setPointsBusy(true);
    setPointsError(null);
    const data = await refreshQuote(couponApplied ?? '', pts);
    if (data?.points?.ok) {
      setPointsApplied(data.points.points);
      setPointsError(null);
    } else {
      setPointsApplied(null);
      setPointsError(data?.points?.reason ?? 'Points could not be redeemed.');
      await refreshQuote(couponApplied ?? '', 0);
    }
    setPointsBusy(false);
  }

  function removePoints() {
    setPointsApplied(null);
    setPointsInput('');
    setPointsError(null);
    refreshQuote(couponApplied ?? '', 0);
  }

  // The re-lock on edit (verify one number, type another, order against an
  // unverified one) is enforced inside usePhoneOtp, so this only has to clear
  // the format error.
  function onPhoneChange(value: string) {
    otp.setPhone(value);
    if (phoneError) setPhoneError(null);
  }

  function validatePhone(value: string): boolean {
    const ok = normalizeIndianMobile(value) !== null;
    setPhoneError(
      ok
        ? null
        : 'Please enter a valid 10-digit Indian mobile number (e.g. 98765 43210).',
    );
    return ok;
  }

  const storeAcceptingOrders = !openState || openState.acceptingOrders;
  const canSubmit =
    storeAcceptingOrders && unavailableNames.length === 0 && (slots.length === 0 || slotStart !== null);

  // WhatsApp-OTP gating. The number is confirmed when it is the signed-in
  // account's own verified number (a mobile login), or once verified here. Until
  // then the "Get OTP" step replaces the payment choice and Place Order button.
  const accountPhoneMatches = Boolean(
    userId &&
      verifiedAccountPhone &&
      normalizeIndianMobile(phone) === verifiedAccountPhone.replace(/^\+91/, ''),
  );
  // A guest — not signed in — gives no number, so there is nothing to verify.
  const isGuest = authChecked && !userId;
  const mustVerify = authChecked && !isGuest && !accountPhoneMatches && !phoneVerified;

  const effectivePaymentMode: 'online' | 'counter' = isGuest ? 'online' : paymentMode;
  const guestCannotPay = isGuest && !ONLINE_PAYMENT_AVAILABLE;

  // Perf: start downloading Razorpay's Checkout.js as soon as "online" becomes
  // the effective payment choice, instead of only starting when the order is
  // actually placed — so by the time placeOrder() opens the modal, the script
  // is already loaded (or loading) rather than the customer watching a blank
  // pause while it downloads. Safe to call repeatedly (memoized internally).
  useEffect(() => {
    if (ONLINE_PAYMENT_AVAILABLE && effectivePaymentMode === 'online') {
      preloadRazorpay();
    }
  }, [effectivePaymentMode]);

  // Bring the newly revealed payment choice into view right after a number is
  // verified — the OTP box they were typing in sits below it.
  const paymentSectionRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phoneVerified) {
      paymentSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [phoneVerified]);
  const phoneIsValid = normalizeIndianMobile(phone) !== null;

  // Single source of truth for "why can't this guest get an OTP yet" — shown
  // next to the Get OTP button so a faded/disabled control is never the only
  // signal. Anything it flags here is exactly what placeOrder() would also
  // reject, so once it returns null the OTP step is the only thing left.
  function guestReadinessBlocker(): string | null {
    if (!storeAcceptingOrders) return "We're not accepting orders right now — please check back later.";
    if (unavailableNames.length > 0) {
      return `Remove ${unavailableNames.join(', ')} from your cart to continue.`;
    }
    if (slots.length > 0 && slotStart === null) return 'Select a pickup time above.';
    if (!name.trim()) return 'Enter your name above.';
    if (!phoneIsValid) return 'Enter a valid 10-digit mobile number above.';
    if (email.trim() && normalizeEmail(email) === null) {
      return 'Enter a valid email address above, or leave it blank.';
    }
    return null;
  }

  async function placeOrder() {
    const selectedSlot = slots.find((s) => s.start === slotStart) ?? slots[0];

    setSubmitting(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customer_name: name,
          // A guest gives no contact details (the server ignores any anyway).
          customer_phone: isGuest ? '' : phone,
          customer_email: isGuest ? undefined : email.trim() || undefined,
          order_type: orderType,
          pickup_slot_label: selectedSlot?.label ?? 'ASAP',
          pickup_slot_start:
            selectedSlot && !selectedSlot.isAsap ? selectedSlot.start : undefined,
          notes,
          items: items.map((i) => ({
            menu_item_id: i.menuItemId,
            variant_id: i.variantId,
            quantity: i.qty,
            addon_option_ids: i.addons.map((a) => a.optionId),
            special_instructions: i.specialInstructions,
          })),
          payment_mode: ONLINE_PAYMENT_AVAILABLE ? effectivePaymentMode : 'counter',
          require_online: isGuest,
          coupon_code: couponApplied ?? undefined,
          redeem_points: pointsApplied ?? undefined,
          // Phase-7 (SUG-8): omitted entirely (not sent as []) when no cart
          // line came from a /suggest session.
          ...(suggestionSessionIds ? { suggestion_session_ids: suggestionSessionIds } : {}),
        }),
      });

      if (res.status === 201) {
        const data: {
          order: { id: string };
          payment: CreatedPaymentIntent | null;
          payment_unavailable?: boolean;
        } = await res.json();
        clearCart();

        if (data.payment) {
          // Online payment intent created — open Razorpay's hosted checkout.
          // Every outcome lands on the status page, which server-reconciles
          // the real payment_status (verify + webhook + poll); the `payment`
          // flag just tells it which message to show on arrival.
          const statusUrl = `/order/${data.order.id}`;
          openRazorpayCheckout(data.payment, {
            name,
            phone,
            description: 'HIOC order payment',
            onSuccess: () => router.push(statusUrl),
            onDismiss: (lastFailure) =>
              router.push(`${statusUrl}?payment=${lastFailure ? 'failed' : 'cancelled'}`),
            onFailure: () => router.push(`${statusUrl}?payment=failed`),
          });
          return;
        }

        // Redirect to the live order-status page (not just the confirmation
        // page) so the customer can track accept/prep/ready in real time. If
        // they chose to pay online but the gateway failed, the server placed it
        // as pay-at-counter — the flag makes the status page say so.
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

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerError(null);

    if (!authChecked || !canSubmit) return;
    if (!isGuest && !validatePhone(phone)) return;

    // Email is optional, but if given it must be valid (it's where the e-bill goes).
    if (!isGuest && email.trim() && normalizeEmail(email) === null) {
      setEmailError('Enter a valid email address, or leave it blank.');
      return;
    }

    // The number must be verified first — no submit button renders until it
    // is, but Enter in a text field can still trigger form submission in some
    // browsers.
    if (mustVerify) {
      setServerError('Please verify your mobile number (Get OTP) before placing the order.');
      return;
    }
    if (guestCannotPay) {
      setServerError('Online payment is unavailable right now. Please log in to order and pay at the counter.');
      return;
    }
    await placeOrder();
  }

  const displayBill: BillBreakdown = bill ?? {
    subtotal_inr: totalPrice,
    tax_inr: 0,
    packaging_inr: 0,
    discount_inr: 0,
    total_inr: totalPrice,
  };

  const guestBlocker = mustVerify ? guestReadinessBlocker() : null;

  const anySavings = couponDiscountInr > 0 && pointsDiscountInr > 0;

  return (
    <div className="flex flex-col gap-4 md:gap-5">
      {serverError ? (
        <div
          role="alert"
          className="rounded-md border border-tan bg-surface px-4 py-3 text-sm text-charcoal"
        >
          {serverError}
        </div>
      ) : null}

      {unavailableNames.length > 0 ? (
        <div
          role="alert"
          className="rounded-md border border-tan bg-surface px-4 py-3 text-sm text-charcoal"
        >
          <p className="font-semibold">
            {unavailableNames.join(', ')} {unavailableNames.length === 1 ? 'is' : 'are'} no
            longer available.
          </p>
          <p className="mt-1">Please remove {unavailableNames.length === 1 ? 'it' : 'them'} from your cart to continue.</p>
        </div>
      ) : null}

      {/* No single outer card any more (that's what made coupons and points
          read as just two more rows in one long list) — each concern below is
          its own titled, bordered card, so contact details, order details,
          offers/rewards, the bill, and payment are all visually distinct. */}
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 md:gap-5" noValidate>
        <Section title="1 · Your details">
          <div>
            <label htmlFor="name" className="mb-1 block text-sm font-semibold text-charcoal">
              Name
            </label>
            <input
              id="name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Ayush"
              className="w-full rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
          </div>

          {isGuest ? (
            <p className="rounded-md bg-surface px-4 py-3 text-sm text-charcoal">
              Ordering as a guest — no phone or email needed. You&apos;ll pay online and can
              follow your order on the next page.{' '}
              <a href="/login?next=/checkout" className="font-semibold text-tan underline">
                Log in
              </a>{' '}
              to get WhatsApp updates or pay at the counter.
            </p>
          ) : (
            <>
              <div>
                <label htmlFor="phone" className="mb-1 block text-sm font-semibold text-charcoal">
                  Phone
                </label>
                <input
                  id="phone"
                  type="tel"
                  required
                  maxLength={16}
                  value={phone}
                  onChange={(e) => onPhoneChange(e.target.value)}
                  onBlur={(e) => validatePhone(e.target.value)}
                  placeholder="e.g. 98765 43210"
                  className="w-full rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan"
                />
                {phoneError ? (
                  <p className="mt-1 text-sm text-charcoal">{phoneError}</p>
                ) : null}
                {/* The actual "Get OTP" control (ACC-4) lives at the bottom of the
                    form now, as the last step before placing the order — see the
                    submit area below. This just sets the expectation early. */}
                {!accountPhoneMatches ? (
                  <p className="mt-1 text-sm text-muted">
                    We&apos;ll WhatsApp a verification code to this number as the last step, right
                    before your order is placed.
                  </p>
                ) : null}
              </div>

              <div>
                <label htmlFor="email" className="mb-1 block text-sm font-semibold text-charcoal">
                  Email <span className="font-normal text-muted">(optional — for your bill)</span>
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (emailError) setEmailError(null);
                  }}
                  placeholder="you@example.com"
                  className="w-full rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan"
                />
                {emailError ? <p className="mt-1 text-sm text-charcoal">{emailError}</p> : null}
              </div>
            </>
          )}
        </Section>

        <Section title="2 · Order details">
          <div>
            <span id="order-type" className="mb-1 block text-sm font-semibold text-charcoal">
              Order Type
            </span>
            <div role="group" aria-labelledby="order-type" className="grid grid-cols-2 gap-2">
              {ORDER_TYPE_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  aria-pressed={orderType === opt.value}
                  onClick={() => setOrderType(opt.value)}
                  className={
                    'rounded-md border px-3 py-2 text-sm font-semibold transition-colors ' +
                    (orderType === opt.value
                      ? 'border-tan bg-surface text-tan-dark'
                      : 'border-line text-charcoal hover:border-tan')
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label htmlFor="pickup" className="mb-1 block text-sm font-semibold text-charcoal">
              Pickup Time
            </label>
            {slots.length === 0 ? (
              <p className="text-sm text-muted">
                {settings ? 'No pickup slots available right now.' : 'Loading pickup times…'}
              </p>
            ) : (
              <select
                id="pickup"
                value={slotStart ?? ''}
                onChange={(e) => setSlotStart(e.target.value)}
                className="w-full rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan"
              >
                {slots.map((slot) => (
                  <option key={slot.start || 'asap'} value={slot.start}>
                    {slot.label}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div>
            <label htmlFor="notes" className="mb-1 block text-sm font-semibold text-charcoal">
              Notes (optional)
            </label>
            <textarea
              id="notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any special requests for the whole order"
              rows={2}
              className="w-full rounded-md border border-line px-3 py-2 text-charcoal outline-none focus:border-tan"
            />
          </div>
        </Section>

        {/* Offers & rewards (FND-3/FND-4/LOY-1/LOY-2) — deliberately called out
            with a coupon-like dashed tan border so it reads as a distinct,
            discoverable perk rather than blending into the rest of the form. */}
        <div className="rounded-md border border-dashed border-tan bg-surface p-4 md:p-5">
          <h2 className="mb-3 text-sm font-semibold text-tan-dark">Offers &amp; rewards</h2>
          <div className="flex flex-col gap-4">
            {/* Coupon code. */}
            <div>
              <div className="mb-1 flex items-center gap-1.5">
                <TicketIcon />
                <label htmlFor="coupon" className="text-sm font-semibold text-charcoal">
                  Have a coupon?
                </label>
              </div>
              {couponApplied ? (
                <div className="flex min-h-[40px] items-center justify-between gap-2 rounded-md border border-green-700/30 bg-green-50 px-3 py-2 text-sm text-charcoal">
                  <span>
                    <span className="font-mono font-bold uppercase tabular-nums">{couponApplied}</span> applied · You
                    save <span className="font-mono tabular-nums">₹{couponDiscountInr}</span>
                  </span>
                  <button type="button" onClick={removeCoupon} className="shrink-0 text-sm font-semibold text-muted underline">
                    Remove
                  </button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <input
                    id="coupon"
                    type="text"
                    value={couponInput}
                    onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                    placeholder="e.g. WELCOME10"
                    className="w-full rounded-md border border-line bg-cream px-3 py-2 text-charcoal outline-none focus:border-tan"
                  />
                  <button
                    type="button"
                    onClick={applyCoupon}
                    disabled={couponBusy || !couponInput.trim()}
                    className="shrink-0 rounded-md border border-line bg-cream px-4 py-2 text-sm font-semibold text-charcoal hover:border-tan disabled:opacity-50"
                  >
                    {couponBusy ? '…' : 'Apply'}
                  </button>
                </div>
              )}
              {couponError ? <p className="mt-1 text-sm text-red-700">{couponError}</p> : null}
            </div>

            {/* Points redemption — logged-in customers only (coupons need no
                login, so guests still see the coupon block above). */}
            {userId ? (
              <>
                <div className="border-t border-dashed border-tan/50" />
                <div>
                  <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <div className="flex items-center gap-1.5">
                      <StarIcon />
                      <label htmlFor="points" className="text-sm font-semibold text-charcoal">
                        Redeem points
                      </label>
                    </div>
                    {balance !== null ? (
                      <span className="rounded-full border border-tan/50 bg-cream px-2 py-0.5 text-xs font-semibold text-tan-dark">
                        Balance: <span className="font-mono tabular-nums">{balance}</span> pts
                      </span>
                    ) : null}
                  </div>
                  {pointsApplied ? (
                    <div className="flex min-h-[40px] items-center justify-between gap-2 rounded-md border border-green-700/30 bg-green-50 px-3 py-2 text-sm text-charcoal">
                      <span>
                        <span className="font-mono tabular-nums">{pointsApplied}</span> pts applied · You save{' '}
                        <span className="font-mono tabular-nums">₹{pointsDiscountInr}</span>
                      </span>
                      <button type="button" onClick={removePoints} className="shrink-0 text-sm font-semibold text-muted underline">
                        Remove
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        id="points"
                        type="number"
                        min={0}
                        inputMode="numeric"
                        value={pointsInput}
                        onChange={(e) => setPointsInput(e.target.value)}
                        placeholder="e.g. 50"
                        className="w-full rounded-md border border-line bg-cream px-3 py-2 text-charcoal outline-none focus:border-tan"
                      />
                      <button
                        type="button"
                        onClick={applyPoints}
                        disabled={pointsBusy || !pointsInput.trim()}
                        className="shrink-0 rounded-md border border-line bg-cream px-4 py-2 text-sm font-semibold text-charcoal hover:border-tan disabled:opacity-50"
                      >
                        {pointsBusy ? '…' : 'Apply'}
                      </button>
                    </div>
                  )}
                  {pointsError ? <p className="mt-1 text-sm text-red-700">{pointsError}</p> : null}
                </div>
              </>
            ) : null}

            {anySavings ? (
              <p className="border-t border-dashed border-tan/50 pt-3 text-sm font-bold text-tan-dark">
                Total savings <span className="font-mono tabular-nums">₹{couponDiscountInr + pointsDiscountInr}</span>
              </p>
            ) : null}
          </div>
        </div>

        {/* Bill breakup (C5/PAY-1) — subtotal, GST, packaging, coupon,
            points, grand total, each a labeled line, its own card. */}
        <Section title="Bill summary">
          <div className="flex flex-col text-sm text-charcoal">
            <BillRow label="Subtotal" value={displayBill.subtotal_inr} />
            {displayBill.tax_inr > 0 ? <BillRow label="GST" value={displayBill.tax_inr} /> : null}
            {displayBill.packaging_inr > 0 ? <BillRow label="Packaging" value={displayBill.packaging_inr} /> : null}
            {couponDiscountInr > 0 ? (
              <BillRow label={`Coupon (${couponApplied})`} value={-couponDiscountInr} tone="success" />
            ) : null}
            {pointsDiscountInr > 0 ? (
              <BillRow label={`Points (${pointsApplied} pts)`} value={-pointsDiscountInr} tone="success" />
            ) : null}
            <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
              <span className="font-bold text-charcoal">Total</span>
              <span className="font-mono font-bold tabular-nums text-tan">₹{displayBill.total_inr}</span>
            </div>
          </div>
        </Section>

        {/* The verified-number confirmation, right above the payment choice it unlocked. */}
        {phoneVerified ? <PhoneOtpPanel otp={otp} /> : null}

        {/* Pay online / pay at counter (PAY-1). Hidden until the number is
            verified — see mustVerify. Guests get online payment only. */}
        {mustVerify ? null : isGuest ? (
          <div ref={paymentSectionRef} className="rounded-md border border-line bg-cream p-4 md:p-5">
            <p className="mb-1 text-sm font-semibold text-charcoal">Payment</p>
            {guestCannotPay ? (
              <div className="mb-2">
                <PayOnlineUnavailableButton />
              </div>
            ) : null}
            <p className="rounded-md bg-surface px-4 py-3 text-sm text-charcoal">
              {guestCannotPay ? (
                <>Online payment is unavailable right now. </>
              ) : (
                <>
                  Guest orders are paid online (UPI, card, or netbanking) — your order joins the
                  kitchen queue as soon as payment is confirmed.{' '}
                </>
              )}
              <a href="/login?next=/checkout" className="font-semibold text-tan underline">
                Log in
              </a>{' '}
              to pay at the counter instead.
            </p>
          </div>
        ) : ONLINE_PAYMENT_AVAILABLE ? (
          <div ref={paymentSectionRef} className="rounded-md border border-line bg-cream p-4 md:p-5">
            <p className="mb-1 text-sm font-semibold text-charcoal">Payment</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setPaymentMode('online')}
                className={
                  'rounded-md border px-3 py-2 text-sm font-semibold transition-colors ' +
                  (paymentMode === 'online'
                    ? 'border-tan bg-surface text-tan-dark'
                    : 'border-line text-charcoal hover:border-tan')
                }
              >
                Pay online
              </button>
              <button
                type="button"
                onClick={() => setPaymentMode('counter')}
                className={
                  'rounded-md border px-3 py-2 text-sm font-semibold transition-colors ' +
                  (paymentMode === 'counter'
                    ? 'border-tan bg-surface text-tan-dark'
                    : 'border-line text-charcoal hover:border-tan')
                }
              >
                Pay at counter
              </button>
            </div>
            <p className="mt-2 rounded-md bg-surface px-4 py-3 text-sm text-charcoal">
              {paymentMode === 'online'
                ? 'Pay now via UPI, card, or netbanking — your order joins the kitchen queue as soon as payment is confirmed.'
                : 'Pay at the counter on pickup — no online payment required.'}
            </p>
          </div>
        ) : (
          // Gateway not configured (e.g. a preview without Razorpay keys) or
          // switched off: keep online payment VISIBLE but greyed out, so it
          // reads as "temporarily unavailable" rather than as a missing feature.
          <div ref={paymentSectionRef} className="rounded-md border border-line bg-cream p-4 md:p-5">
            <p className="mb-1 text-sm font-semibold text-charcoal">Payment</p>
            <div className="grid grid-cols-2 gap-2">
              <PayOnlineUnavailableButton />
              <button
                type="button"
                aria-pressed="true"
                className="rounded-md border border-tan bg-surface px-3 py-2 text-sm font-semibold text-tan-dark"
              >
                Pay at counter
              </button>
            </div>
            <p className="mt-2 rounded-md bg-surface px-4 py-3 text-sm text-charcoal">
              Online payment is temporarily unavailable — pay at the counter on pickup.
            </p>
          </div>
        )}

        {/* DPDP transactional-consent notice (F3t/NFR-005). Order updates are
            transactional, not marketing, so no opt-in checkbox is required —
            but we disclose the use of the number clearly at the point of entry. */}
        <p className="text-sm text-muted">
          By placing this order you agree to receive order-status updates (accepted, ready,
          etc.) on this number via WhatsApp/SMS. We use it only for this order — never for
          marketing.
        </p>

        {mustVerify ? (
          // An unverified number's next step: get a code and enter it. That
          // reveals the payment choice and the Place Order button above.
          // GetOtpButton/PhoneOtpPanel self-hide based on otp.step, so exactly
          // one of them is visible at a time.
          <div className="flex flex-col gap-2">
            <GetOtpButton
              otp={otp}
              variant="primary"
              extraDisabled={guestBlocker !== null}
              onBeforeSend={() => validatePhone(phone)}
            />
            {otp.step === 'idle' ? (
              <p className="text-center text-sm text-muted">
                {guestBlocker ?? "You'll choose how to pay after verifying your number."}
              </p>
            ) : null}
            <PhoneOtpPanel otp={otp} />
          </div>
        ) : (
          <button
            type="submit"
            disabled={submitting || otp.busy || !canSubmit || guestCannotPay || !authChecked}
            className="w-full rounded-md bg-tan px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-dark disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              'Placing Order…'
            ) : !storeAcceptingOrders ? (
              'Checkout Unavailable'
            ) : ONLINE_PAYMENT_AVAILABLE && effectivePaymentMode === 'online' ? (
              <>
                Pay <span className="font-mono tabular-nums">₹{displayBill.total_inr}</span> & Place Order
              </>
            ) : (
              'Place Order'
            )}
          </button>
        )}
      </form>
    </div>
  );
}

// A titled, bordered card — the basic unit the checkout form is built from
// now, instead of one long flat list inside a single outer card. Kept tiny on
// purpose: sections whose content needs special treatment (Offers & rewards'
// highlighted tan card, Payment's ref + three variants) build their own
// wrapper instead of forcing everything through one prop-heavy component.
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-cream p-4 md:p-5">
      <h2 className="mb-3 text-sm font-semibold text-charcoal">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
  );
}

// Shown in place of the live "Pay online" choice while the gateway is not
// configured — disabled, so the option stays visible without being usable.
function PayOnlineUnavailableButton() {
  return (
    <button
      type="button"
      disabled
      aria-disabled="true"
      className="w-full cursor-not-allowed rounded-md border border-dashed border-line px-3 py-2 text-sm font-semibold text-muted opacity-60"
    >
      Pay online
      <span className="block text-sm font-normal">Temporarily unavailable</span>
    </button>
  );
}

// `tone="success"` is used for an applied coupon/points line in the bill —
// green rather than the plain charcoal every other row uses, so a discount
// that's actually in effect is visually obvious at a glance.
function BillRow({ label, value, tone }: { label: string; value: number; tone?: 'success' }) {
  const toneClass = tone === 'success' ? 'font-bold text-green-700' : '';
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className={toneClass}>{label}</span>
      <span className={`font-mono tabular-nums ${toneClass}`}>
        {value < 0 ? `-₹${Math.abs(value)}` : `₹${value}`}
      </span>
    </div>
  );
}

// Small inline icons for the Offers & rewards card — a ticket for the coupon
// block, a star for points — so the two sub-sections are distinguishable at a
// glance even before reading their labels.
function TicketIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0 text-tan-dark"
    >
      <path d="M3 9a2 2 0 0 0 0 4v3a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3a2 2 0 0 1 0-4V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v3Z" />
      <path d="M9 4v16" strokeDasharray="2.5 2.5" />
    </svg>
  );
}

function StarIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className="shrink-0 text-tan-dark"
    >
      <path d="M12 2.5l2.9 6.06 6.6.77-4.86 4.6 1.28 6.57L12 17.9l-5.92 3.6 1.28-6.57-4.86-4.6 6.6-.77L12 2.5Z" />
    </svg>
  );
}
