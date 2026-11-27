'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { cartTaxableSubtotal, useCart } from '@/lib/cart/CartContext';
import { collectPairingLines, collectSuggestionSessionIds } from '@/lib/cart/suggestionIds';
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
import { LOYALTY_UNIT, beaniesUnit } from '@/lib/loyalty/brand';
import { flags } from '@/lib/flags';
import { getTrafficAttribution } from '@/lib/traffic/client';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { useRitualOffer } from '@/components/passes/useRitualOffer';
import { Skeleton } from '@/components/ui/Skeleton';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { SurfaceLink } from '@/components/SurfaceLink';
import {
  passCupsToRequest,
  passCupsToSend,
  passHelperLine,
  passRowMode,
  passRowName,
  ritualBillLabel,
  ritualOnSale,
  stepPassCups,
  type PassQuote,
} from '@/lib/passes/ui';

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
  // HIOC Ritual preview (docs/COFFEE-PASS-SPEC.md §7): null when the feature is
  // off, no account is known, or the quote was asked without `items`.
  pass?: PassQuote | null;
}

export function CheckoutForm({
  settings,
  openState,
  orderType,
  onOrderTypeChange: setOrderType,
  summary,
  pairings,
}: {
  settings: StoreSettings | null;
  openState: StoreOpenState | null;
  // Owned by the checkout page so the cart summary shows the same bill.
  orderType: OrderType;
  onOrderTypeChange: (next: OrderType) => void;
  // Rendered by the page, placed by the form: the order summary goes in the
  // sidebar above the bill, the pairing suggestions under the fields.
  summary?: ReactNode;
  pairings?: ReactNode;
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
  // Coffey checkout pairings (COFFEY-ADDONS-PAIRINGS-SPEC §4.3): the lines added
  // from the "Pairs well with your order" card, and the cart item each was
  // suggested beside. Payload only; omitted entirely when there are none.
  const pairingLines = useMemo(() => collectPairingLines(items), [items]);
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
  const [nameError, setNameError] = useState<string | null>(null);
  // Set by the first tap on Place Order that finds something missing; from then
  // on the line in the sticky bar follows what is still missing.
  const [attempted, setAttempted] = useState(false);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [email, setEmail] = useState(''); // optional — for the e-bill by email
  const [emailError, setEmailError] = useState<string | null>(null);
  const [slotStart, setSlotStart] = useState<string | null>(null); // null = not yet picked
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [unavailableNames, setUnavailableNames] = useState<string[]>([]);
  // The error banner sits at the top of the form, but the button that
  // produces the error is at the bottom — on a phone the customer never saw
  // why "Place Order" did nothing. Bring the banner into view when it appears.
  const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (serverError || unavailableNames.length > 0) {
      errorRef.current?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center',
      });
    }
  }, [serverError, unavailableNames]);

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

  // HIOC Ritual (docs/COFFEE-PASS-SPEC.md CP-D10). Only for a signed-in customer
  // with the feature on: the quote then also prices the cart's cups. The stepper
  // opens at the most the cart can use (the first quote asks for the maximum and
  // the server says what it can apply) and follows the server after that.
  //   passQuote      the `pass` block of the latest quote (null: none yet / none known)
  //   passDrinks     the stepper: cups the customer is using
  //   passTouched    the customer has used − / +, so their number is what is asked for
  //   passSettled    the first pass-aware quote has come back (or failed), so the row
  //                  is known; Place Order waits for it so a cup is never left unused
  //                  by a customer who submitted a moment too soon
  const passEnabled = flags.coffeePass && Boolean(userId);
  const [passQuote, setPassQuote] = useState<PassQuote | null>(null);
  const [passDrinks, setPassDrinks] = useState(0);
  const passDrinksRef = useRef(0);
  const passTouched = useRef(false);
  const [passSettled, setPassSettled] = useState(false);
  const [passBusy, setPassBusy] = useState(false);
  // Only the newest quote may update the screen: with a stepper in play two can
  // be in flight, and a slow older answer must not overwrite a newer one.
  const quoteSeq = useRef(0);
  // "Save with HIOC Ritual" is offered only to someone with no usable cups, and
  // only while a plan is actually on sale (one shared read, see useRitualOffer).
  const noPassKnown = passEnabled && passSettled && passQuote !== null && passQuote.available <= 0;
  const ritualOffer = useRitualOffer({ enabled: noPassKnown });

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

  // The cart in the shape POST /api/orders takes it: the quote prices it
  // server-side (so it can see which drinks a Ritual cup could pay for) and the
  // order itself sends exactly the same lines.
  function orderItemsPayload() {
    return items.map((i) => ({
      menu_item_id: i.menuItemId,
      variant_id: i.variantId,
      quantity: i.qty,
      addon_option_ids: i.addons.map((a) => a.optionId),
      special_instructions: i.specialInstructions,
      ...(i.weightGrams != null ? { weight_grams: i.weightGrams } : {}),
    }));
  }

  // Live bill preview (PAY-1): re-quotes whenever the cart subtotal changes.
  // Coupon/points are (re-)applied explicitly via their Apply buttons, which
  // call the same function with the values being applied. `nextPassCups`
  // overrides how many Ritual cups to ask for (the stepper passes its new value).
  async function refreshQuote(
    nextCoupon: string,
    nextPoints: number,
    nextPassCups?: number,
  ): Promise<QuoteResponse | null> {
    const seq = ++quoteSeq.current;
    const withPass = passEnabled;
    const base = {
      subtotal_inr: totalPrice,
      taxable_subtotal_inr: cartTaxableSubtotal(items),
      coupon_code: nextCoupon || undefined,
      redeem_points: nextPoints || undefined,
      item_ids: items.map((i) => i.menuItemId),
      // Dine-in has no packaging charge (D5); the quote applies the same rule.
      order_type: orderType,
    };
    const post = (extra: Record<string, unknown>) =>
      fetch('/api/orders/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...base, ...extra }),
      });
    try {
      let res = await post(
        withPass
          ? {
              items: orderItemsPayload(),
              pass_drinks: nextPassCups ?? passCupsToRequest(passTouched.current, passDrinksRef.current),
            }
          : {},
      );
      let priced = withPass;
      // A cart the server cannot price (an item just went off the menu) still
      // gets its plain preview, as it did before the Ritual existed.
      if (!res.ok && withPass) {
        res = await post({});
        priced = false;
      }
      if (withPass && seq === quoteSeq.current) setPassSettled(true);
      if (!res.ok) return null;
      const data = (await res.json()) as QuoteResponse;
      if (seq !== quoteSeq.current) return data;
      setBill(data.bill);
      setBalance(data.balance);
      // Keep the itemized discount lines in sync with whatever was actually
      // requested this call — covers the subtotal-changed refresh path too,
      // not just the explicit Apply buttons.
      setCouponDiscountInr(nextCoupon && data.coupon?.ok ? data.coupon.discountInr : 0);
      setPointsDiscountInr(nextPoints > 0 && data.points?.ok ? data.points.discountInr : 0);
      if (withPass) {
        const pass = priced ? (data.pass ?? null) : null;
        setPassQuote(pass);
        // The server's answer is the truth for the stepper (CP-D10: opens at the
        // most the cart can use, and never shows more than was applied).
        const applied = pass?.applied ?? 0;
        passDrinksRef.current = applied;
        setPassDrinks(applied);
      }
      return data;
    } catch {
      if (withPass && seq === quoteSeq.current) setPassSettled(true);
      return null;
    }
  }

  // Re-quotes on a Takeaway/Dine-in switch too: dine-in drops the packaging.
  useEffect(() => {
    refreshQuote(couponApplied ?? '', pointsApplied ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPrice, orderType]);

  // The session is only known a moment after mount: once it is, and the customer
  // can have a Ritual, ask again with the cart's lines so the cups are priced.
  useEffect(() => {
    if (!passEnabled) return;
    refreshQuote(couponApplied ?? '', pointsApplied ?? 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passEnabled]);

  // The coupon and Beanies are worked out on what is left after the Ritual
  // (CP-D12), so changing the cups can make an applied one stop applying. Drop
  // such an offer (with the reason) instead of leaving the customer to place an
  // order the server would refuse.
  function dropOffersThatNoLongerApply(data: QuoteResponse | null) {
    if (!data) return;
    if (couponApplied && !data.coupon?.ok) {
      setCouponApplied(null);
      setCouponInput('');
      setCouponError(data.coupon?.reason ?? 'This coupon no longer applies to your order.');
    }
    if (pointsApplied && !data.points?.ok) {
      setPointsApplied(null);
      setPointsInput('');
      setPointsError(data.points?.reason ?? `Your ${LOYALTY_UNIT.many} no longer apply to your order.`);
    }
  }

  async function changePassCups(delta: 1 | -1) {
    if (!passQuote) return;
    const next = stepPassCups(passDrinksRef.current, delta, passQuote.max_usable);
    if (next === passDrinksRef.current) return;
    passTouched.current = true;
    passDrinksRef.current = next;
    setPassDrinks(next);
    setPassBusy(true);
    const data = await refreshQuote(couponApplied ?? '', pointsApplied ?? 0, next);
    dropOffersThatNoLongerApply(data);
    setPassBusy(false);
  }

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
      setPointsError(`Enter a valid number of ${LOYALTY_UNIT.many}.`);
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
      setPointsError(data?.points?.reason ?? `${LOYALTY_UNIT.many} could not be redeemed.`);
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

  const NAME_ERROR = 'Enter your name so we can call it out when your order is ready.';
  const EMAIL_ERROR = 'Enter a valid email address, or leave it blank.';

  function validateName(value: string): boolean {
    const ok = value.trim().length > 0;
    setNameError(ok ? null : NAME_ERROR);
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
      paymentSectionRef.current?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'center',
      });
    }
  }, [phoneVerified]);
  const phoneIsValid = normalizeIndianMobile(phone) !== null;

  // Single source of truth for "why can't this guest get an OTP yet" — shown
  // next to the Get OTP button so a faded/disabled control is never the only
  // signal. Anything it flags here is exactly what placeOrder() would also
  // reject, so once it returns null the OTP step is the only thing left.
  function guestReadinessBlocker(): string | null {
    if (!storeAcceptingOrders) return "We're not accepting orders right now. Please check back later.";
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

  // The first thing stopping an order, in form order, with the field to take the
  // customer to. Drives the sticky bar's line and where focus goes on a tap.
  type Problem = { field: 'unavailable' | 'name' | 'phone' | 'email'; message: string };
  function firstProblem(): Problem | null {
    if (unavailableNames.length > 0) {
      return { field: 'unavailable', message: `Remove ${unavailableNames.join(', ')} from your cart to place the order` };
    }
    if (!name.trim()) return { field: 'name', message: 'Add your name to place the order' };
    if (!isGuest && !phoneIsValid) {
      return { field: 'phone', message: 'Add a valid 10-digit mobile number to place the order' };
    }
    if (!isGuest && email.trim() && normalizeEmail(email) === null) {
      return { field: 'email', message: 'Fix your email address, or clear it, to place the order' };
    }
    return null;
  }

  // Known API messages in plain words, shown under the field they are about.
  // Anything else is shown as the server worded it.
  function showServerError(message: string) {
    if (/customer_name must be at most/i.test(message)) {
      setNameError('That name is too long. Please shorten it.');
    } else if (/customer_name/i.test(message)) {
      setNameError(NAME_ERROR);
    } else if (/customer_phone/i.test(message)) {
      setPhoneError('Please enter a valid 10-digit Indian mobile number (e.g. 98765 43210).');
    } else if (/customer_email/i.test(message)) {
      setEmailError(EMAIL_ERROR);
    } else if (/pickup_slot|pickup time/i.test(message)) {
      setServerError('Choose a pickup time and try again.');
    } else {
      setServerError(message);
      return;
    }
    setAttempted(true);
  }

  async function placeOrder() {
    const selectedSlot = slots.find((s) => s.start === slotStart) ?? slots[0];
    // Ritual cups ride along only when the latest quote applied them and that is
    // the number on screen — the same rule the coupon and Beanies follow, so the
    // order never asks for cups the customer did not see priced.
    const passToSend = passEnabled ? passCupsToSend(passQuote, passDrinksRef.current) : undefined;

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
          items: orderItemsPayload(),
          payment_mode: ONLINE_PAYMENT_AVAILABLE ? effectivePaymentMode : 'counter',
          require_online: isGuest,
          coupon_code: couponApplied ?? undefined,
          redeem_points: pointsApplied ?? undefined,
          ...(passToSend !== undefined ? { pass_drinks: passToSend } : {}),
          // Phase-7 (SUG-8): omitted entirely (not sent as []) when no cart
          // line came from a /suggest session.
          ...(suggestionSessionIds ? { suggestion_session_ids: suggestionSessionIds } : {}),
          // Coffey checkout pairings: same rule, omitted when no line came from the card.
          ...(pairingLines ? { pairing_lines: pairingLines } : {}),
          // Where this visit came from (docs/TRAFFIC-TRACKING.md). Undefined, so
          // left out, when tracking is off or the browser declines it.
          traffic: getTrafficAttribution(flags.trafficTracking),
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
      showServerError(data.error ?? 'Something went wrong. Please try again.');
      // The Ritual changed between the quote and the order (a cup spent on
      // another device, the pass expired): 409, or a 400 when fewer cups can be
      // applied than were asked for. The message says why; quote again so the
      // stepper and the bill show what is possible now.
      if (passToSend !== undefined && (res.status === 409 || res.status === 400)) {
        const requote = await refreshQuote(couponApplied ?? '', pointsApplied ?? 0, passDrinksRef.current);
        dropOffersThatNoLongerApply(requote);
      }
    } catch {
      setServerError('Network error. Please check your connection.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setServerError(null);

    if (!authChecked || !storeAcceptingOrders) return;

    // Validate everything at once so every problem shows under its field, then
    // take focus to the first one; the sticky bar says what to add.
    const problem = firstProblem();
    if (problem) {
      setAttempted(true);
      if (!name.trim()) setNameError(NAME_ERROR);
      if (!isGuest && !phoneIsValid) validatePhone(phone);
      if (!isGuest && email.trim() && normalizeEmail(email) === null) setEmailError(EMAIL_ERROR);
      const target = problem.field === 'unavailable' ? errorRef.current : document.getElementById(problem.field);
      target?.focus();
      return;
    }
    if (!canSubmit) return;

    // The number must be verified first — no submit button renders until it
    // is, but Enter in a text field can still trigger form submission in some
    // browsers.
    if (mustVerify) {
      setServerError('Please verify your mobile number (Get OTP) before placing the order.');
      return;
    }
    if (guestCannotPay) {
      setServerError("Online payment isn't available right now. Sign in to order and pay at the counter.");
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
  const problem = firstProblem();

  // What the Ritual takes off, from the latest quote (0 when no cups are used).
  const passApplied = passEnabled && passQuote ? passQuote.applied : 0;
  const passDiscountInr = passApplied > 0 && passQuote ? passQuote.discount_inr : 0;
  const savings = [passDiscountInr, couponDiscountInr, pointsDiscountInr].filter((n) => n > 0);
  const anySavings = savings.length >= 2;
  const rowMode = passEnabled ? passRowMode(passQuote) : 'hidden';
  const passHelper = passEnabled ? passHelperLine(passQuote, passTouched.current) : null;

  // The bar's one line of explanation: why ordering is closed, or (after a tap)
  // what is still missing. Always rendered so screen readers announce changes.
  const barMessage = !storeAcceptingOrders
    ? `We're not taking orders right now.${openState?.nextOpenLabel ? ` We open ${openState.nextOpenLabel}.` : ''}`
    : attempted && problem
      ? problem.message
      : null;

  return (
    <div className="flex flex-col gap-4 md:gap-5">
      <div ref={errorRef} tabIndex={-1} className="flex flex-col gap-4 outline-none empty:hidden md:gap-5">
      {serverError ? (
        <div
          role="alert"
          className="rounded-md border border-tan px-4 py-3 text-sm text-charcoal"
        >
          {serverError}
        </div>
      ) : null}

      {unavailableNames.length > 0 ? (
        <div
          role="alert"
          className="rounded-md border border-tan px-4 py-3 text-sm text-charcoal"
        >
          <p className="font-semibold">
            {unavailableNames.join(', ')} {unavailableNames.length === 1 ? 'is' : 'are'} no
            longer available.
          </p>
          <p className="mt-1">Please remove {unavailableNames.length === 1 ? 'it' : 'them'} from your cart to continue.</p>
        </div>
      ) : null}
      </div>

      {/* One form, two columns from lg: the fields on the left; on the right a
          sticky sidebar with the order summary, the one bill, payment and Place
          Order. Below lg it is a single column in DOM order (fields, summary,
          bill, payment) and the sidebar wrapper is `display: contents`, so the
          Place Order bar is a direct child of the form and stays pinned to the
          bottom of the screen for the whole length of it. */}
      <form
        onSubmit={handleSubmit}
        className="grid grid-cols-1 gap-4 md:gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)] lg:items-start lg:gap-8"
        noValidate
      >
        <div className="flex min-w-0 flex-col gap-4 md:gap-5">
          {/* The pay-online rule, stated before the guest reaches the payment step. */}
          {isGuest ? (
            <p className="text-sm text-charcoal">
              {ONLINE_PAYMENT_AVAILABLE ? 'Guests pay online. ' : "Online payment isn't available right now. "}
              <a href="/login?next=/checkout" className="font-semibold text-tan-dark underline">
                Sign in
              </a>{' '}
              {ONLINE_PAYMENT_AVAILABLE ? 'to pay at the counter.' : 'to order and pay at the counter.'}
            </p>
          ) : null}

          <Section title="Your details">
            <Input
              id="name"
              label="Name"
              type="text"
              required
              autoComplete="name"
              autoCapitalize="words"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
              onBlur={(e) => validateName(e.target.value)}
              placeholder="e.g. Ayush"
              error={nameError ?? undefined}
              hint={isGuest ? 'No phone or email needed. You can follow your order on the next page.' : undefined}
            />

            {isGuest ? null : (
              <>
                <Input
                  id="phone"
                  label="Phone"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel-national"
                  required
                  maxLength={16}
                  value={phone}
                  onChange={(e) => onPhoneChange(e.target.value)}
                  onBlur={(e) => validatePhone(e.target.value)}
                  placeholder="e.g. 98765 43210"
                  error={phoneError ?? undefined}
                  // The actual "Get OTP" control (ACC-4) lives at the bottom of the
                  // form now, as the last step before placing the order — see the
                  // submit area below. This just sets the expectation early.
                  hint={
                    accountPhoneMatches
                      ? undefined
                      : "We'll WhatsApp a verification code to this number as the last step, right before your order is placed."
                  }
                />

                <Input
                  id="email"
                  label={
                    <>
                      Email <span className="font-normal text-muted">(optional, for your bill)</span>
                    </>
                  }
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (emailError) setEmailError(null);
                  }}
                  placeholder="you@example.com"
                  error={emailError ?? undefined}
                />
              </>
            )}
          </Section>

          <Section title="Order details">
            <div>
              <span id="order-type" className="mb-1 block text-sm font-semibold text-charcoal">
                Order type
              </span>
              <div role="group" aria-labelledby="order-type" className="grid grid-cols-2 gap-2">
                {ORDER_TYPE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={orderType === opt.value}
                    onClick={() => setOrderType(opt.value)}
                    className={
                      'min-h-[44px] rounded-md border px-3 py-2 text-sm font-semibold transition-colors ' +
                      (orderType === opt.value
                        ? 'border-tan bg-surface text-tan-dark'
                        : 'border-muted/80 text-charcoal hover:border-tan')
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {slots.length === 0 ? (
              <div>
                <p className="mb-1 text-sm font-semibold text-charcoal">Pickup time</p>
                <p className="text-sm text-muted">
                  {settings ? 'No pickup slots available right now.' : 'Loading pickup times…'}
                </p>
              </div>
            ) : (
              <Select
                id="pickup"
                label="Pickup time"
                value={slotStart ?? ''}
                onChange={(e) => setSlotStart(e.target.value)}
                options={slots.map((slot) => ({ value: slot.start, label: slot.label }))}
              />
            )}

            <Textarea
              id="notes"
              label="Notes (optional)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Any special requests for the whole order"
              rows={2}
            />
          </Section>

          {/* Offers & rewards (FND-3/FND-4/LOY-1/LOY-2) — a coupon-like dashed tan
              border keeps it a distinct, discoverable perk. Its rows are plain
              (no filled panels inside the card). */}
          <div className="rounded-md border border-dashed border-tan bg-cream p-4 md:p-5">
            <h2 className="mb-3 text-sm font-semibold text-tan-dark">Offers &amp; rewards</h2>
            <div className="flex flex-col gap-4">
              {/* HIOC Ritual: signed-in customers with the feature on. With cups
                  to use it is a stepper pre-filled to the most this cart can use
                  (CP-D10); with none, nothing advertises an empty pass, at most a
                  quiet link to the plans. Above the coupon because the pass is
                  applied first (CP-D12). */}
              {passEnabled && !passSettled ? <Skeleton className="h-11 w-full" /> : null}
              {rowMode === 'stepper' && passQuote ? (
                <>
                  <div>
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 text-sm text-charcoal">
                      <p aria-live="polite" className="flex min-w-0 flex-1 basis-44 items-start gap-1.5">
                        <CupIcon className="mt-0.5" />
                        <span>
                          {passRowName(passQuote)}: using{' '}
                          <span className="font-bold tabular-nums">{passApplied}</span> of{' '}
                          <span className="tabular-nums">{passQuote.available}</span>{' '}
                          {passQuote.available === 1 ? 'cup' : 'cups'}
                          {passDiscountInr > 0 ? (
                            <>
                              {' '}
                              <span className="font-mono font-bold tabular-nums text-green-700">
                                (&minus;₹{passDiscountInr})
                              </span>
                            </>
                          ) : null}
                        </span>
                      </p>
                      <div role="group" aria-label={`${PASS_PROGRAM_NAME} cups to use`} className="flex items-center gap-1">
                        <button
                          type="button"
                          aria-label="Use one fewer cup"
                          onClick={() => void changePassCups(-1)}
                          disabled={passBusy || passApplied <= 0}
                          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-muted/80 bg-cream text-lg font-semibold text-charcoal hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          &minus;
                        </button>
                        <span className="min-w-[2ch] text-center font-bold tabular-nums text-charcoal">
                          {passDrinks}
                        </span>
                        <button
                          type="button"
                          aria-label="Use one more cup"
                          onClick={() => void changePassCups(1)}
                          disabled={passBusy || passApplied >= passQuote.max_usable}
                          className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md border border-muted/80 bg-cream text-lg font-semibold text-charcoal hover:border-tan disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          +
                        </button>
                      </div>
                    </div>
                    {passHelper ? <p className="mt-1 text-sm text-muted">{passHelper}</p> : null}
                  </div>
                  <div className="border-t border-dashed border-tan/50" />
                </>
              ) : null}
              {rowMode === 'unusable' && passQuote ? (
                <>
                  <p className="flex items-start gap-1.5 text-sm text-muted">
                    <CupIcon className="mt-0.5" />
                    <span>
                      <span className="font-semibold text-charcoal">{passRowName(passQuote)}</span>:{' '}
                      {passHelper ??
                        `you have ${passQuote.available} ${passQuote.available === 1 ? 'cup' : 'cups'} left, but none can be used on this order.`}
                    </span>
                  </p>
                  <div className="border-t border-dashed border-tan/50" />
                </>
              ) : null}
              {noPassKnown && ritualOnSale(ritualOffer.offer) ? (
                <>
                  <SurfaceLink
                    href="/ritual"
                    className="-my-1 inline-flex min-h-[44px] items-center gap-1.5 self-start text-sm font-semibold text-tan-dark hover:underline"
                  >
                    <CupIcon />
                    Save with {PASS_PROGRAM_NAME}
                  </SurfaceLink>
                  <div className="border-t border-dashed border-tan/50" />
                </>
              ) : null}

              {/* Coupon code. */}
              <div>
                {couponApplied ? (
                  <>
                    <div className="mb-1 flex items-center gap-1.5">
                      <TicketIcon />
                      <span className="text-sm font-semibold text-charcoal">Coupon</span>
                    </div>
                    <div className="flex min-h-[44px] items-center justify-between gap-2 text-sm text-green-700">
                      <span>
                        <span className="font-mono font-bold uppercase tabular-nums">{couponApplied}</span> applied. You
                        save <span className="font-mono tabular-nums">₹{couponDiscountInr}</span>.
                      </span>
                      <button type="button" onClick={removeCoupon} className="inline-flex min-h-[44px] shrink-0 items-center text-sm font-semibold text-muted underline">
                        Remove
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="flex items-end gap-2">
                    <div className="min-w-0 flex-1">
                      <Input
                        id="coupon"
                        label={
                          <span className="flex items-center gap-1.5">
                            <TicketIcon />
                            Have a coupon?
                          </span>
                        }
                        type="text"
                        autoComplete="off"
                        autoCapitalize="characters"
                        spellCheck={false}
                        enterKeyHint="done"
                        value={couponInput}
                        onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
                        placeholder="e.g. WELCOME10"
                        aria-invalid={couponError ? true : undefined}
                        aria-describedby={couponError ? 'coupon-error' : undefined}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={applyCoupon}
                      disabled={couponBusy || !couponInput.trim()}
                      className="min-h-[44px] shrink-0 rounded-md border border-muted/80 bg-cream px-4 py-2 text-sm font-semibold text-charcoal hover:border-tan disabled:opacity-50"
                    >
                      {couponBusy ? '…' : 'Apply'}
                    </button>
                  </div>
                )}
                {couponError ? <p id="coupon-error" role="alert" className="mt-1 text-sm text-red-700">{couponError}</p> : null}
              </div>

              {/* Points redemption: logged-in customers only (coupons need no
                  login, so guests still see the coupon block above). */}
              {userId ? (
                <>
                  <div className="border-t border-dashed border-tan/50" />
                  <div>
                    {pointsApplied ? (
                      <>
                        <div className="mb-1 flex items-center gap-1.5">
                          <StarIcon />
                          <span className="text-sm font-semibold text-charcoal">Redeem {LOYALTY_UNIT.many}</span>
                        </div>
                        <div className="flex min-h-[44px] items-center justify-between gap-2 text-sm text-green-700">
                          <span>
                            <span className="tabular-nums">{pointsApplied}</span> {beaniesUnit(pointsApplied)} applied. You save{' '}
                            <span className="font-mono tabular-nums">₹{pointsDiscountInr}</span>.
                          </span>
                          <button type="button" onClick={removePoints} className="inline-flex min-h-[44px] shrink-0 items-center text-sm font-semibold text-muted underline">
                            Remove
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        {balance !== null ? (
                          <p className="mb-1 text-sm text-muted">
                            Balance: <span className="font-semibold tabular-nums text-charcoal">{balance}</span> {beaniesUnit(balance)}
                          </p>
                        ) : null}
                        <div className="flex items-end gap-2">
                          <div className="min-w-0 flex-1">
                            <Input
                              id="points"
                              label={
                                <span className="flex items-center gap-1.5">
                                  <StarIcon />
                                  Redeem {LOYALTY_UNIT.many}
                                </span>
                              }
                              type="number"
                              min={0}
                              inputMode="numeric"
                              value={pointsInput}
                              onChange={(e) => setPointsInput(e.target.value)}
                              placeholder="e.g. 50"
                              aria-invalid={pointsError ? true : undefined}
                              aria-describedby={pointsError ? 'points-error' : undefined}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={applyPoints}
                            disabled={pointsBusy || !pointsInput.trim()}
                            className="min-h-[44px] shrink-0 rounded-md border border-muted/80 bg-cream px-4 py-2 text-sm font-semibold text-charcoal hover:border-tan disabled:opacity-50"
                          >
                            {pointsBusy ? '…' : 'Apply'}
                          </button>
                        </div>
                      </>
                    )}
                    {pointsError ? <p id="points-error" role="alert" className="mt-1 text-sm text-red-700">{pointsError}</p> : null}
                  </div>
                </>
              ) : null}

              {anySavings ? (
                <p className="border-t border-dashed border-tan/50 pt-3 text-sm font-bold text-tan-dark">
                  Total savings <span className="font-mono tabular-nums">₹{savings.reduce((sum, n) => sum + n, 0)}</span>
                </p>
              ) : null}
            </div>
          </div>

          {pairings}
        </div>

        <div className="contents lg:sticky lg:top-6 lg:z-10 lg:-m-1 lg:flex lg:max-h-[calc(100vh-2rem)] lg:flex-col lg:gap-5 lg:self-start lg:overflow-y-auto lg:p-1">
          {summary}

          {/* The one bill (C5/PAY-1): subtotal, GST, packaging, discounts and the
              total, priced by the server quote. The order summary above lists lines
              only, so the total is never shown twice with different figures. */}
          <Section title="Bill summary">
            <div className="flex flex-col text-sm text-charcoal">
              <BillRow label="Subtotal" value={displayBill.subtotal_inr} />
              {displayBill.tax_inr > 0 ? <BillRow label="GST" value={displayBill.tax_inr} /> : null}
              {displayBill.packaging_inr > 0 ? <BillRow label="Packaging" value={displayBill.packaging_inr} /> : null}
              {passDiscountInr > 0 ? (
                <BillRow label={ritualBillLabel(passApplied)} value={-passDiscountInr} tone="success" />
              ) : null}
              {couponDiscountInr > 0 ? (
                <BillRow label={`Coupon (${couponApplied})`} value={-couponDiscountInr} tone="success" />
              ) : null}
              {pointsDiscountInr > 0 ? (
                <BillRow label={`${LOYALTY_UNIT.many} redeemed (${pointsApplied})`} value={-pointsDiscountInr} tone="success" />
              ) : null}
              <div className="mt-2 flex items-center justify-between border-t border-line pt-2">
                <span className="font-bold text-charcoal">Total</span>
                <span className="font-mono font-bold tabular-nums text-tan-dark">₹{displayBill.total_inr}</span>
              </div>
              {displayBill.total_inr === 0 && passApplied > 0 ? (
                <p className="mt-2 text-sm text-muted">Fully covered by your {PASS_PROGRAM_NAME}. Nothing to pay.</p>
              ) : null}
            </div>
          </Section>

          {/* The verified-number confirmation, right above the payment choice it unlocked. */}
          {phoneVerified ? <PhoneOtpPanel otp={otp} /> : null}

          {/* Pay online / pay at counter (PAY-1). Hidden until the number is
              verified (see mustVerify). Guests get online payment only. */}
          {mustVerify ? null : isGuest ? (
            // A guest who can't pay online has the sentence at the top of the form
            // and a Sign in button in place of Place Order, so no card here.
            guestCannotPay ? null : (
              <Section title="Payment" sectionRef={paymentSectionRef}>
                <p className="text-sm text-charcoal">
                  Pay online by UPI, card or netbanking. Your order joins the kitchen queue as soon as
                  payment is confirmed.{' '}
                  <a href="/login?next=/checkout" className="font-semibold text-tan-dark underline">
                    Sign in
                  </a>{' '}
                  to pay at the counter instead.
                </p>
              </Section>
            )
          ) : ONLINE_PAYMENT_AVAILABLE ? (
            <Section title="Payment" sectionRef={paymentSectionRef}>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  aria-pressed={paymentMode === 'online'}
                  onClick={() => setPaymentMode('online')}
                  className={
                    'min-h-[44px] rounded-md border px-3 py-2 text-sm font-semibold transition-colors ' +
                    (paymentMode === 'online'
                      ? 'border-tan bg-surface text-tan-dark'
                      : 'border-muted/80 text-charcoal hover:border-tan')
                  }
                >
                  Pay online
                </button>
                <button
                  type="button"
                  aria-pressed={paymentMode === 'counter'}
                  onClick={() => setPaymentMode('counter')}
                  className={
                    'min-h-[44px] rounded-md border px-3 py-2 text-sm font-semibold transition-colors ' +
                    (paymentMode === 'counter'
                      ? 'border-tan bg-surface text-tan-dark'
                      : 'border-muted/80 text-charcoal hover:border-tan')
                  }
                >
                  Pay at counter
                </button>
              </div>
              <p className="text-sm text-muted">
                {paymentMode === 'online'
                  ? 'Pay now via UPI, card or netbanking. Your order joins the kitchen queue as soon as payment is confirmed.'
                  : 'Pay at the counter on pickup. No online payment required.'}
              </p>
            </Section>
          ) : (
            // Gateway not configured (e.g. a preview without Razorpay keys) or
            // switched off: there is nothing to choose, so say so in plain text
            // instead of a pressed button that does nothing.
            <Section title="Payment" sectionRef={paymentSectionRef}>
              <p className="text-sm text-charcoal">
                Pay at the counter on pickup. Online payment isn&apos;t available right now.
              </p>
            </Section>
          )}

          {/* DPDP transactional-consent notice (F3t/NFR-005). Order updates are
              transactional, not marketing, so no opt-in checkbox is required, but
              we disclose the use of the number at the point of entry. A guest gave
              no number, so for them the notice says where updates appear instead. */}
          {isGuest ? (
            <p className="text-sm text-muted">
              You&apos;ll follow your order on the page you land on after paying. We don&apos;t take a
              phone number or email from guests, so there are no messages.
            </p>
          ) : (
            <p className="text-sm text-muted">
              By placing this order you agree to receive order-status updates (accepted, ready,
              etc.) on this number via WhatsApp/SMS. We use it only for this order, never for
              marketing.
            </p>
          )}

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
            // Sticky on phones and tablets: the form is long (details, offers,
            // bill, payment) and the one action that matters shouldn't need a
            // scroll hunt. From lg it sits at the foot of the sticky sidebar.
            // The button is only disabled while something is in flight or the
            // store is closed: if a field is missing, a tap moves focus to it
            // and the line above the button says what to add.
            <div className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-cream/95 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 backdrop-blur lg:static lg:mx-0 lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
              <p
                role="status"
                aria-live="polite"
                className="mb-2 text-center text-sm font-semibold text-charcoal empty:hidden"
              >
                {barMessage}
              </p>
              {guestCannotPay ? (
                <a
                  href="/login?next=/checkout"
                  className="flex min-h-[48px] w-full items-center justify-center rounded-md bg-tan-dark px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-darker"
                >
                  Sign in to order
                </a>
              ) : (
                <button
                  type="submit"
                  aria-busy={submitting || undefined}
                  disabled={
                    submitting ||
                    otp.busy ||
                    !storeAcceptingOrders ||
                    (slots.length > 0 && slotStart === null) ||
                    !authChecked ||
                    // Wait for the Ritual row to be known (a moment after sign-in) and for a
                    // stepper tap to be priced, so the bill the customer sees is what is sent.
                    (passEnabled && !passSettled) ||
                    passBusy
                  }
                  className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-md bg-tan-dark px-4 py-3 font-semibold text-cream transition-colors hover:bg-tan-darker disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? (
                    <span
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70"
                    />
                  ) : null}
                  {submitting ? (
                    'Placing order…'
                  ) : !storeAcceptingOrders ? (
                    'Checkout unavailable'
                  ) : ONLINE_PAYMENT_AVAILABLE && effectivePaymentMode === 'online' && displayBill.total_inr > 0 ? (
                    <>
                      Pay <span className="font-mono tabular-nums">₹{displayBill.total_inr}</span> and place order
                    </>
                  ) : (
                    <>
                      Place order <span className="font-mono tabular-nums">₹{displayBill.total_inr}</span>
                    </>
                  )}
                </button>
              )}
            </div>
          )}
        </div>
      </form>
    </div>
  );
}

// A titled, bordered card: the basic unit the checkout form is built from, one
// level of containment (nothing filled sits inside it). Kept tiny on purpose:
// sections whose content needs special treatment (Offers & rewards' dashed card)
// build their own wrapper instead of forcing everything through one prop-heavy
// component.
function Section({
  title,
  children,
  sectionRef,
}: {
  title: string;
  children: ReactNode;
  sectionRef?: RefObject<HTMLDivElement>;
}) {
  return (
    <div ref={sectionRef} className="rounded-md border border-line bg-cream p-4 md:p-5">
      <h2 className="mb-3 text-sm font-semibold text-charcoal">{title}</h2>
      <div className="flex flex-col gap-4">{children}</div>
    </div>
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

function CupIcon({ className = '' }: { className?: string }) {
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
      className={'shrink-0 text-tan-dark ' + className}
    >
      <path d="M4 8h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z" />
      <path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16" />
      <path d="M8 3v2M12 3v2" />
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
