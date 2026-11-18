'use client';

// The /shop page's interactive part (docs/SHOP-V2-SPEC.md E8): the whole
// purchase on one page, in three steps that never reload:
//
//   Choose      Instant Coffee and Home Blend, a sticky segmented control that
//               deep-links to #instant and #home-blend, a cart drawer
//   Deliver to  a saved address as a summary card, or the address form (E3)
//   Pay         the bill, Beanies, "Have a code?", then Pay ₹X
//
// A sticky bar always shows the item count, the total and the page's ONE
// primary action. This file is the orchestrator: it owns the cart (persisted on
// every change under hioc_shop_cart_v2, so it survives a reload and the
// /login?next=/shop round trip), the step, the quote and the checkout request.
// The rules live in lib/shop/checkoutFlow.ts (pure, tested); the price comes
// from lib/shop/useShopQuote.ts (local figure at once, the server's figure wins).
//
// Paying: one Idempotency-Key per attempt, kept in a ref and sessionStorage and
// reused for retries (a double tap or a dropped connection finds the same
// order); it is rotated only when the order changed or the server refused the
// key. The server prices everything. A 409 swaps in the server's quote
// ("Prices changed: here's the new total") without losing the cart, the address
// or the code. Prices, offers and Beanies shown here are never trusted by the
// route: expected_total_inr is only compared.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CartDrawer } from '@/components/shop/CartDrawer';
import { addressSummary, DeliverToStep, useDelivery } from '@/components/shop/DeliverToStep';
import { HomeBlendCard } from '@/components/shop/HomeBlendCard';
import { InstantSection } from '@/components/shop/InstantSection';
import { PayStep } from '@/components/shop/PayStep';
import { StickyCheckoutBar } from '@/components/shop/StickyCheckoutBar';
import { openRazorpayCheckout, preloadRazorpay } from '@/lib/payments/razorpayCheckout';
import type { CreatedPaymentIntent } from '@/lib/payments/types';
import { flags } from '@/lib/flags';
import { getTrafficAttribution } from '@/lib/traffic/client';
import { normalizeAddressLabel } from '@/lib/shop/address';
import { PRODUCT_LINES } from '@/lib/shop/catalog';
import { cartUnits, clearShopCart, readShopCart, setCartItemQuantity, addCartItem, removeCartItem, writeShopCart } from '@/lib/shop/cart';
import {
  attemptFingerprint,
  buildCartLines,
  canAdvance,
  checkDelivery,
  initialStep,
  isAddressField,
  isCouponBlocked,
  nextStep,
  pickDisplayQuote,
  prevStep,
  SHOP_STEPS,
  shouldRotateKey,
  STEP_TITLES,
  type ShopStep,
} from '@/lib/shop/checkoutFlow';
import { cartItemKey, MAX_UNITS_PER_ORDER, unitsLabel, type CartItem, type ShopQuoteV2 } from '@/lib/shop/pricing';
import { useShopQuote } from '@/lib/shop/useShopQuote';
import type { ShopProduct, ShopSettings } from '@/lib/shop/types';

const ATTEMPT_KEY = 'hioc_shop_checkout_attempt';
/** A Razorpay intent is reused locally only this long; after it the server decides (same key). */
const INTENT_REUSE_MS = 10 * 60 * 1000;

interface Status {
  tone: 'error' | 'info';
  text: string;
  orderLink?: string;
}

interface Attempt {
  key: string;
  fingerprint: string;
  /** The last answer's code, for shouldRotateKey. */
  lastCode: string | null;
}

interface PendingIntent {
  fingerprint: string;
  orderId: string;
  payment: CreatedPaymentIntent;
  at: number;
}

/** A random v4 uuid (crypto.randomUUID where there is one). */
function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  } catch {
    // No crypto at all: a uuid-shaped random string still passes the route's check.
    const r = () => Math.floor(Math.random() * 16).toString(16);
    const part = (n: number) => Array.from({ length: n }, r).join('');
    return `${part(8)}-${part(4)}-4${part(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${part(3)}-${part(12)}`;
  }
}

function readAttempt(): Attempt | null {
  try {
    const raw = window.sessionStorage.getItem(ATTEMPT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Attempt>;
    return typeof v.key === 'string' && typeof v.fingerprint === 'string' ? { key: v.key, fingerprint: v.fingerprint, lastCode: null } : null;
  } catch {
    return null;
  }
}

function writeAttempt(a: Attempt | null): void {
  try {
    if (a) window.sessionStorage.setItem(ATTEMPT_KEY, JSON.stringify({ key: a.key, fingerprint: a.fingerprint }));
    else window.sessionStorage.removeItem(ATTEMPT_KEY);
  } catch {
    // Private mode: the key lives in the ref for this page view.
  }
}

export function ShopExperience({
  products,
  settings,
  introEligible,
  signedIn,
  paymentReady,
}: {
  /** Listed products only (the server page filters; unlisted ones never reach the browser). */
  products: ShopProduct[];
  settings: ShopSettings;
  introEligible: boolean;
  signedIn: boolean;
  paymentReady: boolean;
}) {
  const router = useRouter();
  const instant = useMemo(() => products.filter((p) => p.listed && (p.line ?? 'instant') === 'instant'), [products]);
  const homeBlend = useMemo(() => products.filter((p) => p.listed && p.line === 'home_blend'), [products]);

  const [items, setItems] = useState<CartItem[]>([]);
  const [step, setStep] = useState<ShopStep>('choose');
  const [hydrated, setHydrated] = useState(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [appliedCode, setAppliedCode] = useState<string | null>(null);
  const [useBeanies, setUseBeanies] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [priceNote, setPriceNote] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'instant' | 'home-blend'>('instant');

  const delivery = useDelivery({ signedIn });
  const { seed } = delivery;
  const storedRef = useRef<ReturnType<typeof readShopCart>>(null);
  const queryRef = useRef<string | null>(null);
  const attemptRef = useRef<Attempt | null>(null);
  const pendingRef = useRef<PendingIntent | null>(null);
  const doneRef = useRef(false);
  const stepFocusRef = useRef<HTMLDivElement>(null);
  const firstStep = useRef(true);

  // ---- read the stored cart once, after hydration ----
  useEffect(() => {
    const stored = readShopCart();
    storedRef.current = stored;
    try {
      queryRef.current = new URLSearchParams(window.location.search).get('step');
    } catch {
      queryRef.current = null;
    }
    attemptRef.current = readAttempt();
    if (stored) {
      setItems(stored.items);
      setNotice(stored.notice);
      seed(stored.address, stored.address_id);
    }
    setHydrated(true);
    // Runs once; `seed` is stable enough for a one-time hand-off.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- decide the opening step: a signed-in customer's address book has to be known first ----
  useEffect(() => {
    if (!hydrated || ready) return;
    if (signedIn && delivery.loadStatus === 'loading') return;
    setStep(
      initialStep({
        stored: storedRef.current,
        query: queryRef.current,
        // A saved address must be the one in play: a seeded one-off address (a reorder to an
        // address not in the book, or one a guest typed) opens Deliver to in form mode instead,
        // so the customer sees it, and the "Save to account" choice, before paying.
        hasDefaultAddress: signedIn && delivery.loadStatus === 'ready' && delivery.addresses.length > 0 && delivery.mode === 'saved',
      }),
    );
    setReady(true);
  }, [hydrated, ready, signedIn, delivery.loadStatus, delivery.addresses.length, delivery.mode]);

  // ---- who is buying, for the quote (offer eligibility and phone-locked codes) ----
  const sel = delivery.selection;
  const buyerPhone = sel.mode === 'saved' ? (delivery.selected?.phone ?? '') : String(sel.form.phone ?? '');
  const buyerEmail = sel.mode === 'saved' ? sel.email : String(sel.form.email ?? '');

  const q = useShopQuote({
    products,
    settings,
    introEligible,
    items,
    couponCode: appliedCode,
    useBeanies,
    phone: buyerPhone,
    email: buyerEmail,
  });
  const { adopt } = q;
  const units = cartUnits(items);
  // Pay keeps the last server figure on screen while a refresh is pending (pickDisplayQuote).
  const shownQuote = pickDisplayQuote({ step, quote: q.quote, fromServer: q.fromServer, lastServerQuote: q.lastServerQuote, loading: q.loading });
  const couponBlocked = isCouponBlocked({ appliedCode, couponError: q.couponError, fromServer: q.fromServer });
  const totalInr = shownQuote ? shownQuote.total_inr : null;
  const lines = useMemo(() => buildCartLines(products, items), [products, items]);

  // ---- persist the cart on every change (not before the stored one has been read) ----
  const storedAddress = useMemo(() => {
    const c = checkDelivery(sel);
    return c.ok && c.mode === 'form' ? c.address : null;
  }, [sel]);
  const storedAddressKey = JSON.stringify(storedAddress);
  useEffect(() => {
    if (!hydrated || doneRef.current) return;
    if (items.length === 0) {
      if (ready) clearShopCart();
      return;
    }
    if (!ready) return;
    writeShopCart({
      items,
      address_id: sel.mode === 'saved' ? sel.addressId : null,
      address: storedAddress,
      notice,
      step,
    });
    // storedAddressKey stands for storedAddress.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, ready, items, step, notice, sel.mode, sel.addressId, storedAddressKey]);

  useEffect(() => {
    if (paymentReady && units > 0) preloadRazorpay();
  }, [paymentReady, units]);

  // ---- Pay needs a usable address: back to Deliver to when it isn't ----
  useEffect(() => {
    if (!ready || step !== 'pay' || delivery.loadStatus === 'loading') return;
    if (!canAdvance({ step: 'deliver', itemCount: units, delivery: sel }).ok) setStep('deliver');
  }, [ready, step, delivery.loadStatus, units, sel]);

  // ---- a new step gets focus and the top of the page ----
  useEffect(() => {
    if (firstStep.current) {
      firstStep.current = false;
      return;
    }
    stepFocusRef.current?.focus({ preventScroll: true });
    stepFocusRef.current?.scrollIntoView({ block: 'start' });
  }, [step]);

  // ---- which section the segmented control marks ----
  const showTabs = instant.length > 0 && homeBlend.length > 0;
  useEffect(() => {
    if (!showTabs || step !== 'choose' || typeof IntersectionObserver === 'undefined') return;
    const targets = ['instant', 'home-blend'].map((id) => document.getElementById(id)).filter((el): el is HTMLElement => el !== null);
    if (targets.length < 2) return;
    const seen = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
        const best = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
        if (best && best[1] > 0) setActiveSection(best[0] === 'home-blend' ? 'home-blend' : 'instant');
      },
      { rootMargin: '-30% 0px -50% 0px', threshold: [0, 0.25, 0.5, 1] },
    );
    targets.forEach((t) => io.observe(t));
    return () => io.disconnect();
  }, [showTabs, step]);
  useEffect(() => {
    // Deep links and the product-line cards' CTAs (#instant / #home-blend).
    const fromHash = () => {
      if (window.location.hash === '#home-blend') setActiveSection('home-blend');
      else if (window.location.hash === '#instant') setActiveSection('instant');
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  // ---- cart edits ----
  const touchCart = useCallback(() => {
    setStatus(null);
    setPriceNote(null);
    if (paymentReady) preloadRazorpay();
  }, [paymentReady]);

  const instantQty = useMemo(() => {
    const out: Record<string, number> = {};
    for (const i of items) if (!i.grind) out[i.product_id] = (out[i.product_id] ?? 0) + i.quantity;
    return out;
  }, [items]);

  const setInstantQuantity = useCallback(
    (productId: string, quantity: number) => {
      touchCart();
      setItems((cur) => {
        const key = cartItemKey({ product_id: productId, quantity: 0 });
        return cur.some((i) => cartItemKey(i) === key) ? setCartItemQuantity(cur, key, quantity) : addCartItem(cur, { product_id: productId, quantity });
      });
    },
    [touchCart],
  );
  const addItem = useCallback(
    (item: CartItem) => {
      touchCart();
      setItems((cur) => addCartItem(cur, item));
    },
    [touchCart],
  );
  const setLineQuantity = useCallback(
    (key: string, quantity: number) => {
      touchCart();
      setItems((cur) => setCartItemQuantity(cur, key, quantity));
    },
    [touchCart],
  );
  const removeLine = useCallback(
    (key: string) => {
      touchCart();
      setItems((cur) => removeCartItem(cur, key));
    },
    [touchCart],
  );
  const canAddMore = units < MAX_UNITS_PER_ORDER;

  // ---- moving between steps ----
  function showFieldProblem(focus: string | undefined, reason: string) {
    if (focus && (isAddressField(focus) || focus === 'label')) delivery.setFieldError({ field: focus, error: reason });
    else setStatus({ tone: 'error', text: reason });
  }

  function goBack() {
    setStatus(null);
    setPriceNote(null);
    setStep(prevStep({ step, delivery: sel }));
  }

  function onPrimary() {
    if (step === 'pay') {
      void pay();
      return;
    }
    setStatus(null);
    const flow = { step, itemCount: units, delivery: sel };
    const can = canAdvance(flow);
    if (!can.ok) {
      showFieldProblem(can.focus, can.reason);
      return;
    }
    if (step === 'choose' && q.cartProblem) {
      setStatus({ tone: 'error', text: q.cartProblem });
      setCartOpen(true);
      return;
    }
    setStep(nextStep(flow));
  }

  // ---- paying ----
  async function pay() {
    if (busy) return;
    setStatus(null);
    setPriceNote(null);

    const can = canAdvance({ step: 'pay', itemCount: units, delivery: sel });
    if (!can.ok) {
      if (can.focus === 'products') setStatus({ tone: 'error', text: can.reason });
      else {
        if (sel.mode === 'form') setStep('deliver');
        showFieldProblem(can.focus, can.reason);
      }
      return;
    }
    const dc = checkDelivery(sel);
    if (!dc.ok) return;
    if (!q.quote) {
      setStatus({ tone: 'error', text: q.cartProblem ?? 'Add something to your order to continue.' });
      return;
    }

    const saveLabel =
      signedIn && dc.mode === 'form' && delivery.saveToAccount && delivery.addresses.length < delivery.max ? normalizeAddressLabel(delivery.label) : null;
    const fingerprint = attemptFingerprint(
      {
        items,
        address: dc.mode === 'form' ? dc.address : { email: dc.email },
        address_id: dc.mode === 'saved' ? dc.addressId : null,
        coupon_code: appliedCode,
        use_beanies: useBeanies,
        save_address_label: saveLabel,
      },
      dc.mode === 'form' ? delivery.pin : null,
    );

    // One key per attempt; a retry of the same order reuses it.
    const prev = attemptRef.current;
    if (shouldRotateKey(prev?.fingerprint, fingerprint, prev?.lastCode)) {
      attemptRef.current = { key: newIdempotencyKey(), fingerprint, lastCode: null };
      pendingRef.current = null;
      writeAttempt(attemptRef.current);
    }
    const attempt = attemptRef.current as Attempt;

    const contact =
      dc.mode === 'form'
        ? { name: dc.address.customer_name, phone: dc.address.phone, email: dc.address.email }
        : { name: delivery.selected?.customer_name ?? '', phone: delivery.selected?.phone ?? '', email: dc.email };

    setBusy(true);
    let pending = pendingRef.current;
    if (!pending || pending.fingerprint !== fingerprint || Date.now() - pending.at > INTENT_REUSE_MS) {
      pending = null;
      let res: Response;
      let data: Record<string, unknown> = {};
      try {
        res = await fetch('/api/shop/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': attempt.key },
          body: JSON.stringify({
            items: items.map((i) => (i.grind ? { product_id: i.product_id, quantity: i.quantity, grind: i.grind } : { product_id: i.product_id, quantity: i.quantity })),
            ...(dc.mode === 'saved' ? { address_id: dc.addressId, address: { email: dc.email } } : { address: delivery.form }),
            save_address: saveLabel ? { label: saveLabel } : null,
            location: dc.mode === 'form' ? delivery.pin : null,
            coupon_code: appliedCode ?? undefined,
            use_beanies: useBeanies,
            expected_total_inr: q.quote.total_inr,
            // Where this visit came from (docs/TRAFFIC-TRACKING.md); left out when off or declined.
            traffic: getTrafficAttribution(flags.trafficTracking),
          }),
        });
        data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      } catch {
        setBusy(false);
        attempt.lastCode = 'network';
        setStatus({ tone: 'error', text: 'Network error. Check your connection and tap Pay to try again.' });
        return;
      }
      const code = typeof data.code === 'string' ? data.code : null;
      const message = typeof data.error === 'string' ? data.error : 'Could not start your order. Please try again.';

      if (!res.ok) {
        setBusy(false);
        attempt.lastCode = code ?? `http_${res.status}`;
        if (res.status === 409 && (code === 'price_changed' || code === 'coupon' || code === 'beanies_changed')) {
          // The server's number replaces ours; the cart, the address and the code stay.
          if (data.quote && typeof data.quote === 'object') adopt(data.quote as ShopQuoteV2, code === 'coupon' ? message : null);
          setPriceNote(code === 'price_changed' ? "Prices changed: here's the new total" : message);
          return;
        }
        if (res.status === 409 && (code === 'idempotency_mismatch' || code === 'idempotency_expired')) {
          // Take a new key next time (shouldRotateKey reads lastCode).
          setStatus({ tone: 'error', text: message });
          return;
        }
        const field = data.field;
        if (field === 'location') {
          if (sel.mode === 'form') setStep('deliver');
          delivery.setPinError(message);
        } else if (field === 'address_id') {
          delivery.setChoosing(true);
          setStatus({ tone: 'error', text: message });
        } else if (field === 'save_address') {
          if (sel.mode === 'form') setStep('deliver');
          delivery.setFieldError({ field: 'label', error: message });
        } else if (isAddressField(field)) {
          if (sel.mode === 'form') setStep('deliver');
          delivery.setFieldError({ field, error: message });
        } else {
          setStatus({ tone: 'error', text: message });
        }
        return;
      }

      if (data.already_paid) {
        doneRef.current = true;
        clearShopCart();
        writeAttempt(null);
        router.push(`/shop/order/${String(data.order_id)}`);
        return;
      }
      attempt.lastCode = null;
      pending = { fingerprint, orderId: String(data.order_id), payment: data.payment as CreatedPaymentIntent, at: Date.now() };
      pendingRef.current = pending;
    }

    const orderPath = `/shop/order/${pending.orderId}`;
    await openRazorpayCheckout(pending.payment, {
      name: contact.name,
      phone: contact.phone.replace(/^\+91/, ''),
      email: contact.email,
      description: `HIOC. order: ${unitsLabel(units)}`,
      verifyPath: '/api/shop/verify',
      onSuccess: () => {
        doneRef.current = true;
        clearShopCart();
        writeAttempt(null);
        router.push(orderPath);
      },
      onDismiss: (lastFailure) => {
        setBusy(false);
        setStatus({
          tone: 'info',
          text: lastFailure
            ? `Payment not completed (${lastFailure}). You can try again.`
            : 'Payment not completed — you can try again',
        });
      },
      onFailure: (description) => {
        setBusy(false);
        setStatus({
          tone: 'error',
          text: `${description} If money has left your account, your order page will update within a few minutes.`,
          orderLink: orderPath,
        });
      },
    });
  }

  // ---- render ----
  const stepNo = SHOP_STEPS.indexOf(step) + 1;
  const loadingAddresses = signedIn && delivery.loadStatus === 'loading';
  const primaryDisabled =
    !ready ||
    (step === 'choose' && units === 0) ||
    (step !== 'choose' && loadingAddresses) ||
    (step === 'pay' && (!paymentReady || !q.quote || q.loading || couponBlocked));

  return (
    <div className="pb-32">
      <nav aria-label="Checkout steps" className="mt-8">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          {SHOP_STEPS.map((s, i) => (
            <li key={s} aria-current={s === step ? 'step' : undefined} className="flex items-center gap-2">
              {i > 0 ? <span aria-hidden="true" className="text-muted">/</span> : null}
              <span className={s === step ? 'font-bold text-charcoal underline decoration-tan decoration-2 underline-offset-4' : 'text-muted'}>
                <span className="font-mono tabular-nums">{i + 1}</span> {STEP_TITLES[s]}
              </span>
            </li>
          ))}
        </ol>
      </nav>

      <div aria-live="polite" className="mt-4 space-y-3">
        {notice ? (
          <div className="flex items-start justify-between gap-2 rounded-md border border-line bg-surface p-3 text-sm text-charcoal">
            <p>{notice}</p>
            <button
              type="button"
              aria-label="Dismiss message"
              onClick={() => setNotice(null)}
              className="-mr-1 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-xl hover:bg-cream focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan"
            >
              <span aria-hidden="true">&times;</span>
            </button>
          </div>
        ) : null}
        {status ? (
          <p role={status.tone === 'error' ? 'alert' : 'status'} className={`text-sm font-semibold ${status.tone === 'error' ? 'text-red-700' : 'text-charcoal'}`}>
            {status.text}{' '}
            {status.orderLink ? (
              <a href={status.orderLink} className="underline">
                View your order
              </a>
            ) : null}
          </p>
        ) : null}
      </div>

      <div
        ref={stepFocusRef}
        tabIndex={-1}
        role="group"
        aria-label={`Step ${stepNo} of ${SHOP_STEPS.length}: ${STEP_TITLES[step]}`}
        className="mt-4 scroll-mt-24 outline-none"
      >
        {ready && step !== 'choose' ? (
          <button
            type="button"
            onClick={goBack}
            disabled={busy}
            className="mb-4 inline-flex min-h-[44px] items-center gap-1 rounded-md pr-3 text-sm font-semibold text-tan-dark hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan disabled:opacity-50"
          >
            <span aria-hidden="true">←</span> Back
          </button>
        ) : null}

        {/* Choose stays mounted (hidden) on later steps, so a half-picked Home Blend isn't lost on Back. */}
        <div hidden={step !== 'choose'} data-step="choose">
          {showTabs ? (
            <nav aria-label="Product lines" className="sticky top-[68px] z-30 -mx-4 border-b border-line bg-cream/95 px-4 py-2 backdrop-blur">
              <ul className="flex gap-2">
                {(['instant', 'home_blend'] as const).map((line) => {
                  const anchor = PRODUCT_LINES[line].anchor;
                  const active = activeSection === anchor;
                  return (
                    <li key={line} className="flex-1 md:flex-none">
                      <a
                        href={`#${anchor}`}
                        aria-current={active ? 'true' : undefined}
                        onClick={() => setActiveSection(anchor)}
                        className={[
                          'flex min-h-[44px] items-center justify-center rounded-full border-2 px-5 text-sm font-semibold transition-colors',
                          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan',
                          active ? 'border-tan-dark bg-tan-dark text-cream' : 'border-muted/80 bg-cream text-charcoal hover:bg-surface',
                        ].join(' ')}
                      >
                        {PRODUCT_LINES[line].title}
                      </a>
                    </li>
                  );
                })}
              </ul>
            </nav>
          ) : null}

          <div id="products" tabIndex={-1} className="mt-6 space-y-12 outline-none">
            <InstantSection
              products={instant}
              quantities={instantQty}
              onSetQuantity={setInstantQuantity}
              canAddMore={canAddMore}
              settings={settings}
              introEligible={introEligible}
            />
            <HomeBlendCard products={homeBlend} unitsInCart={units} onAdd={addItem} />
          </div>
          {!canAddMore ? (
            <p className="mt-4 text-sm text-muted">That&apos;s the most we take online ({MAX_UNITS_PER_ORDER} items). For more, call or email us.</p>
          ) : null}
          {q.cartProblem ? (
            <p role="alert" className="mt-4 text-sm font-semibold text-red-700">
              {q.cartProblem}
            </p>
          ) : null}
        </div>

        {step === 'deliver' ? <DeliverToStep delivery={delivery} signedIn={signedIn} /> : null}

        {step === 'pay' ? (
          <PayStep
            quote={shownQuote}
            loading={q.loading}
            quoteError={q.error}
            cartProblem={q.cartProblem}
            couponError={q.couponError}
            couponBlocked={couponBlocked}
            appliedCode={appliedCode}
            onApplyCode={(code) => {
              setPriceNote(null);
              setAppliedCode(code);
            }}
            onRemoveCode={() => {
              setPriceNote(null);
              setAppliedCode(null);
            }}
            useBeanies={useBeanies}
            onToggleBeanies={(v) => {
              setPriceNote(null);
              setUseBeanies(v);
            }}
            signedIn={signedIn}
            priceNote={priceNote}
            paymentReady={paymentReady}
            deliverySlot={<DeliverToStepSlot delivery={delivery} signedIn={signedIn} />}
            deliveryRecap={sel.mode === 'form' ? { text: addressSummary(delivery), onChange: () => setStep('deliver') } : null}
          />
        ) : null}
      </div>

      <CartDrawer
        open={cartOpen}
        onClose={() => setCartOpen(false)}
        lines={lines}
        canAddMore={canAddMore}
        onSetQuantity={setLineQuantity}
        onRemove={removeLine}
        problem={q.cartProblem}
      />

      <StickyCheckoutBar
        step={step}
        itemCount={units}
        totalInr={totalInr}
        refreshing={q.loading}
        busy={busy}
        disabled={primaryDisabled}
        onOpenCart={() => setCartOpen(true)}
        onPrimary={onPrimary}
      />
    </div>
  );
}

/** The saved-address summary shown at the top of Pay (nothing when the address is typed). */
function DeliverToStepSlot({ delivery, signedIn }: { delivery: ReturnType<typeof useDelivery>; signedIn: boolean }) {
  return (
    <div className="mt-4">
      <DeliverToStep delivery={delivery} signedIn={signedIn} compact />
    </div>
  );
}
