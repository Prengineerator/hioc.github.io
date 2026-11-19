'use client';

// Owner → Shop orders → New order (docs/SHOP-OWNER-ORDERS-SPEC.md, "What the owner sees").
// One page, phone first, in this order: customer (phone, saved addresses, address), items, the
// bill, the owner discount, payment, Create order, then a success screen.
//
// The server prices everything: this page only shows POST /api/owner/shop/quote's answer and
// sends the total it showed as expected_total_inr, so a price that moved in between comes back as
// a 409 with the new total to confirm. Pure parts (cart lines, the idempotency key, the WhatsApp
// text, bill rows, error wording) live in lib/shop/ownerNewOrder.ts.

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { AddressForm, emptyAddressForm, focusAddressField, type FormValues } from '@/components/shop/AddressForm';
import { Stepper } from '@/components/shop/InstantSection';
import { Badge } from '@/components/ui/Badge';
import { Button, buttonVariants } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { GRINDS, packLabel } from '@/lib/shop/catalog';
import { validateShopAddress } from '@/lib/shop/address';
import { OFFLINE_METHOD_LABELS, OFFLINE_METHODS } from '@/lib/shop/ownerOrders';
import {
  attemptFingerprintOf,
  cleanPhoneInput,
  formFieldFor,
  nextAttemptKey,
  ownerCartLines,
  parseDiscountInput,
  quoteBillRows,
  readCreateFailure,
  readLinkPending,
  readProductsAnswer,
  readRetryAnswer,
  setInstantQuantity,
  spendKey,
  unitsOfProduct,
  whatsappShareUrl,
  type AttemptKeyState,
  type OwnerQuote,
} from '@/lib/shop/ownerNewOrder';
import { addCartItem, removeCartItem, setCartItemQuantity } from '@/lib/shop/cart';
import { MAX_UNITS_PER_ORDER, rupees, type CartItem } from '@/lib/shop/pricing';
import { normalizeIndianMobile } from '@/lib/phone';
import { shopOrderRef } from '@/lib/shop/status';
import type { GrindCode, ShopOfflineMethod, ShopProduct } from '@/lib/shop/types';

const QUOTE_DEBOUNCE_MS = 300;
const ID = 'on';
const fid = (f: string) => `${ID}-${f}`;

interface SavedAddress {
  label: string;
  customer_name: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  landmark: string;
  city: string;
  state: string;
  pincode: string;
  source: 'saved' | 'last_order';
}
type Lookup =
  | { phone: string; status: 'loading' }
  | { phone: string; status: 'error' }
  | { phone: string; status: 'done'; name: string; email: string; accountLinked: boolean; addresses: SavedAddress[] };

interface QuoteState {
  key: string;
  quote: OwnerQuote | null;
  error: string | null;
  accountLinked: boolean;
}

interface Created {
  order_id: string;
  order_number: number;
  status: string;
  total_inr: number;
  payment_link_url: string | null;
  payment_link_expires_at: string | null;
  kind: 'link' | 'offline';
}

const CARD = 'rounded-md border border-line bg-cream p-4 shadow-card';
const CHIP =
  'flex min-h-[44px] cursor-pointer flex-col justify-center rounded-md border-2 px-4 py-2 text-left text-sm font-semibold transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-tan';
const chipTone = (checked: boolean) => (checked ? 'border-tan-dark bg-tan-dark text-cream' : 'border-muted/80 bg-cream text-charcoal hover:bg-surface');

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  const hid = `on-h-${n}`;
  return (
    <section aria-labelledby={hid} className={CARD}>
      <h2 id={hid} className="flex items-center gap-2 text-lg font-bold text-charcoal">
        <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-tan-dark text-sm text-cream">
          {n}
        </span>
        {title}
      </h2>
      {hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function inIst(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

const looksLikeEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

export function OwnerNewOrderForm() {
  // ---- the products, from GET /api/owner/shop/products ----
  const [loaded, setLoaded] = useState<{ status: 'loading' } | { status: 'ok'; products: ShopProduct[] } | { status: 'setup' | 'error'; message: string }>({ status: 'loading' });
  const [loadTry, setLoadTry] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setLoaded({ status: 'loading' });
    fetch('/api/owner/shop/products', { signal: ctl.signal })
      .then(async (res) => {
        const a = readProductsAnswer(res.status, await res.json().catch(() => null));
        setLoaded(a.kind === 'ok' ? { status: 'ok', products: a.products } : { status: a.kind, message: a.message });
      })
      .catch((err) => {
        if ((err as { name?: string }).name === 'AbortError') return;
        setLoaded({ status: 'error', message: "Couldn't load the products. Check the connection and try again." });
      });
    return () => ctl.abort();
  }, [loadTry]);

  if (loaded.status === 'loading') {
    return (
      <p role="status" className="mt-6 rounded-md border border-line bg-surface p-6 text-center text-sm text-muted">
        Loading the products…
      </p>
    );
  }
  if (loaded.status !== 'ok') {
    return (
      <div role="alert" className="mt-6 rounded-md border border-amber-300 bg-amber-50 p-4 text-sm text-charcoal">
        <p className="font-semibold">{loaded.message}</p>
        {loaded.status === 'error' ? (
          <Button className="mt-3" variant="secondary" onClick={() => setLoadTry((n) => n + 1)}>
            Retry
          </Button>
        ) : null}
      </div>
    );
  }
  if (loaded.products.length === 0) {
    return (
      <p className="mt-6 rounded-md border border-line bg-surface p-6 text-center text-sm text-charcoal">
        No products are listed and in stock. List them on{' '}
        <Link href="/owner/shop" className="font-semibold text-tan-dark underline">
          Shop orders → Products
        </Link>
        .
      </p>
    );
  }
  return <NewOrderBody products={loaded.products} />;
}

function NewOrderBody({ products }: { products: ShopProduct[] }) {
  const instant = useMemo(() => products.filter((p) => p.line === 'instant'), [products]);
  const packs = useMemo(() => products.filter((p) => p.line === 'home_blend').sort((a, b) => a.pack_grams - b.pack_grams), [products]);

  // ---- customer ----
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState<FormValues>(() => emptyAddressForm());
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [pickedAddress, setPickedAddress] = useState<number | null>(null);
  const [showForm, setShowForm] = useState(false);
  // ---- items / coupon / discount / payment ----
  const [items, setItems] = useState<CartItem[]>([]);
  const [coupon, setCoupon] = useState('');
  const [discount, setDiscount] = useState('');
  const [discountReason, setDiscountReason] = useState('');
  const [payKind, setPayKind] = useState<'link' | 'offline'>('link');
  const [method, setMethod] = useState<ShopOfflineMethod | null>(null);
  const [reference, setReference] = useState('');
  // ---- home blend picker ----
  const [packId, setPackId] = useState<string | null>(packs[0]?.id ?? null);
  const [grind, setGrind] = useState<GrindCode | null>(null);
  const [grindPrompt, setGrindPrompt] = useState(false);
  const [packQty, setPackQty] = useState(1);
  // ---- quote / submit ----
  const [quoteState, setQuoteState] = useState<QuoteState | null>(null);
  const [retry, setRetry] = useState(0);
  const [priceNotice, setPriceNotice] = useState<{ key: string; text: string } | null>(null);
  const [fieldError, setFieldError] = useState<{ field: string; error: string } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const [pendingLink, setPendingLink] = useState<{ order_id: string; order_number: number } | null>(null);
  const [retrying, setRetrying] = useState(false);
  const keyRef = useRef<AttemptKeyState | null>(null);
  const lastCodeRef = useRef<string | null>(null);
  const doneRef = useRef<HTMLHeadingElement>(null);

  const phoneValid = phone.length === 10 && normalizeIndianMobile(phone) !== null;
  const discountAmount = parseDiscountInput(discount);
  const units = items.reduce((n, i) => n + i.quantity, 0);
  const lines = useMemo(() => ownerCartLines(products, items), [products, items]);
  const hbLines = lines.filter((l) => l.grind !== null);

  // ---- saved addresses for the typed phone ----
  useEffect(() => {
    if (!phoneValid) {
      setLookup(null);
      return;
    }
    const ctl = new AbortController();
    setLookup({ phone, status: 'loading' });
    fetch(`/api/owner/shop/customer?phone=${encodeURIComponent(phone)}`, { signal: ctl.signal })
      .then(async (res) => {
        const data = (await res.json().catch(() => null)) as { name?: string; email?: string; account_linked?: boolean; addresses?: SavedAddress[] } | null;
        if (!res.ok || !data) throw new Error('lookup');
        const addresses = Array.isArray(data.addresses) ? data.addresses : [];
        setLookup({ phone, status: 'done', name: data.name ?? '', email: data.email ?? '', accountLinked: Boolean(data.account_linked), addresses });
        // Name and email come along; what the owner has already typed stays.
        if (data.name) setAddress((a) => (a.customer_name ? a : { ...a, customer_name: data.name as string }));
        if (data.email) setEmail((e) => (e ? e : (data.email as string)));
        setPickedAddress(null);
        setShowForm(false);
      })
      .catch((err) => {
        if ((err as { name?: string }).name === 'AbortError') return;
        setLookup({ phone, status: 'error' });
      });
    return () => ctl.abort();
  }, [phone, phoneValid]);

  function pickSaved(i: number, a: SavedAddress) {
    setPickedAddress(i);
    setShowForm(true);
    setAddress((cur) => ({
      ...cur,
      customer_name: a.customer_name || cur.customer_name,
      address_line1: a.address_line1,
      address_line2: a.address_line2,
      landmark: a.landmark,
      city: a.city,
      state: a.state,
      pincode: a.pincode,
    }));
    setFieldError(null);
  }

  // ---- the bill: the server's quote, 300 ms after the last change ----
  const emailForQuote = looksLikeEmail(email) ? email.trim() : '';
  const payload = useMemo(() => {
    if (!phoneValid || items.length === 0 || discountAmount === null) return null;
    return {
      phone,
      ...(emailForQuote ? { email: emailForQuote } : {}),
      items,
      ...(coupon.trim() ? { coupon_code: coupon.trim() } : {}),
      owner_discount_inr: discountAmount,
    };
  }, [phoneValid, phone, items, discountAmount, emailForQuote, coupon]);
  const payloadKey = payload ? JSON.stringify(payload) : null;

  useEffect(() => {
    if (!payload || !payloadKey) return;
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch('/api/owner/shop/quote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payloadKey,
          signal: ctl.signal,
        });
        const data = (await res.json().catch(() => ({}))) as { quote?: OwnerQuote; account_linked?: boolean; error?: string };
        if (ctl.signal.aborted) return;
        if (res.ok && data.quote) setQuoteState({ key: payloadKey, quote: data.quote, error: null, accountLinked: Boolean(data.account_linked) });
        else setQuoteState({ key: payloadKey, quote: null, error: data.error || `Couldn't work out the bill (HTTP ${res.status}).`, accountLinked: false });
      } catch (err) {
        if ((err as { name?: string }).name === 'AbortError') return;
        setQuoteState({ key: payloadKey, quote: null, error: "Couldn't work out the bill. Check the connection and try again.", accountLinked: false });
      }
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // payload is derived from payloadKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payloadKey, retry]);

  const settled = payloadKey !== null && quoteState?.key === payloadKey;
  const billLoading = payloadKey !== null && !settled;
  const quote = settled ? quoteState?.quote ?? null : null;
  const shownQuote = quote ?? (payloadKey !== null ? quoteState?.quote ?? null : null);
  const quoteError = settled ? quoteState?.error ?? null : null;
  const discountServerError = quoteError && /discount/i.test(quoteError) ? quoteError : null;
  const billError = quoteError && !discountServerError ? quoteError : null;
  const notice = priceNotice && priceNotice.key === payloadKey ? priceNotice.text : null;
  const accountLinked = settled && Boolean(quoteState?.accountLinked);

  // ---- submit ----
  const paymentBody = payKind === 'link' ? { kind: 'link' as const } : { kind: 'offline' as const, method, reference: reference.replace(/\s+/g, ' ').trim() };

  function fail(field: string, error: string) {
    setFieldError({ field, error });
    setFormError(null);
    const id = formFieldFor(field);
    requestAnimationFrame(() => {
      if (!focusAddressField(ID, id)) document.getElementById(fid(id === 'payment' && payKind === 'offline' ? 'reference' : id))?.focus();
    });
  }

  function validate(): { ok: true; addressBody: Record<string, unknown> } | { ok: false } {
    if (!phoneValid) {
      fail('phone', 'Enter a 10-digit Indian mobile number');
      return { ok: false };
    }
    if (email.trim() && !looksLikeEmail(email)) {
      fail('email', 'Enter a valid email address, or leave it empty');
      return { ok: false };
    }
    const checked = validateShopAddress({ ...address, phone, email: email.trim() }, { emailOptional: true });
    if (!checked.ok) {
      setShowForm(true);
      fail(checked.field, checked.error);
      return { ok: false };
    }
    if (items.length === 0) {
      fail('items', 'Add at least one item to the order');
      return { ok: false };
    }
    if (discountAmount === null) {
      fail('owner_discount_inr', 'Enter the discount in whole rupees, like 100');
      return { ok: false };
    }
    if (discountAmount > 0 && discountReason.trim().length < 3) {
      fail('owner_discount_reason', 'Give a reason for the discount (3 to 80 characters)');
      return { ok: false };
    }
    if (payKind === 'offline') {
      if (!method) {
        fail('payment', 'Choose how it was paid: UPI to café, cash or bank transfer');
        return { ok: false };
      }
      const ref = reference.replace(/\s+/g, ' ').trim();
      if (ref.length < 3 || ref.length > 60) {
        fail('payment', 'Add a payment reference (3 to 60 characters)');
        return { ok: false };
      }
    }
    return { ok: true, addressBody: { ...checked.address } };
  }

  async function submit() {
    if (pending) return;
    setFieldError(null);
    setFormError(null);
    const v = validate();
    if (!v.ok) return;
    if (!quote) {
      setFormError(
        billError ? `The bill couldn't be worked out: ${billError}` : billLoading ? 'The bill is still updating. Wait a moment, then tap Create order.' : "The bill isn't ready. Check the phone number and items.",
      );
      return;
    }
    const fingerprint = attemptFingerprintOf({
      address: v.addressBody,
      items,
      couponCode: coupon,
      ownerDiscountInr: discountAmount ?? 0,
      ownerDiscountReason: discountReason,
      payment: paymentBody,
    });
    const state = nextAttemptKey(keyRef.current, fingerprint, lastCodeRef.current, () => crypto.randomUUID());
    keyRef.current = state;
    setPending(true);
    try {
      const res = await fetch('/api/owner/shop/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idempotency_key: state.key,
          address: v.addressBody,
          items,
          ...(coupon.trim() ? { coupon_code: coupon.trim() } : {}),
          owner_discount_inr: discountAmount ?? 0,
          ...((discountAmount ?? 0) > 0 ? { owner_discount_reason: discountReason.trim() } : {}),
          payment: paymentBody,
          expected_total_inr: quote.total_inr,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      lastCodeRef.current = typeof data.code === 'string' ? data.code : null;
      const lp = readLinkPending(res.status, data);
      if (lp) {
        keyRef.current = spendKey(state);
        lastCodeRef.current = null;
        setPendingLink({ order_id: lp.order_id, order_number: lp.order_number });
        setCreated({ order_id: lp.order_id, order_number: lp.order_number, status: 'payment_pending', total_inr: quote.total_inr, payment_link_url: null, payment_link_expires_at: null, kind: 'link' });
        window.scrollTo({ top: 0 });
        return;
      }
      if (res.ok) {
        keyRef.current = spendKey(state);
        lastCodeRef.current = null;
        setCreated({
          order_id: String(data.order_id),
          order_number: Number(data.order_number),
          status: String(data.status),
          total_inr: Number(data.total_inr),
          payment_link_url: typeof data.payment_link_url === 'string' ? data.payment_link_url : null,
          payment_link_expires_at: typeof data.payment_link_expires_at === 'string' ? data.payment_link_expires_at : null,
          kind: payKind,
        });
        window.scrollTo({ top: 0 });
        return;
      }
      const f = readCreateFailure(res.status, data);
      if (f.kind === 'price_changed' && payloadKey) {
        setQuoteState({ key: payloadKey, quote: f.quote, error: null, accountLinked: quoteState?.accountLinked ?? false });
        setPriceNotice({ key: payloadKey, text: f.message });
        setFormError(null);
      } else if (f.kind === 'field') {
        fail(f.field, f.message);
      } else {
        setFormError(f.message);
      }
    } catch {
      setFormError("Couldn't reach the server. Nothing was lost: check the connection, then tap Create order again. It won't make a second order.");
    } finally {
      setPending(false);
    }
  }

  useEffect(() => {
    if (created) doneRef.current?.focus();
  }, [created]);

  const reset = useCallback(() => {
    setPhone('');
    setEmail('');
    setAddress(emptyAddressForm());
    setLookup(null);
    setPickedAddress(null);
    setShowForm(false);
    setItems([]);
    setCoupon('');
    setDiscount('');
    setDiscountReason('');
    setPayKind('link');
    setMethod(null);
    setReference('');
    setGrind(null);
    setPackQty(1);
    setQuoteState(null);
    setPriceNotice(null);
    setFieldError(null);
    setFormError(null);
    setCreated(null);
    setPendingLink(null);
    setCopied(false);
    keyRef.current = null;
    lastCodeRef.current = null;
    window.scrollTo({ top: 0 });
  }, []);

  async function copyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      setFormError('Could not copy. Select the link and copy it by hand.');
    }
  }

  async function retryLink() {
    if (!created || retrying) return;
    setRetrying(true);
    setFormError(null);
    try {
      const res = await fetch(`/api/owner/shop/orders/${created.order_id}/payment-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'retry' }),
      });
      const out = readRetryAnswer(res.status, await res.json().catch(() => ({})));
      if (out.kind === 'link') {
        setCreated({ ...created, payment_link_url: out.url, payment_link_expires_at: out.expiresAt });
        setPendingLink(null);
      } else if (out.kind === 'paid') {
        setCreated({ ...created, kind: 'offline', status: 'paid' });
        setPendingLink(null);
      } else setFormError(out.message);
    } catch {
      setFormError("Couldn't reach the server. Nothing was changed. Try again.");
    } finally {
      setRetrying(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Success
  // ---------------------------------------------------------------------------
  if (created) {
    const ref = shopOrderRef(created.order_number);
    const url = created.payment_link_url;
    if (pendingLink) {
      return (
        <div className="mt-6 rounded-md border-2 border-amber-400 bg-amber-50 p-4 shadow-card" data-testid="link-pending">
          <h2 ref={doneRef} tabIndex={-1} className="text-xl font-bold text-charcoal outline-none">
            <span aria-hidden="true">⚠ </span>Order {ref} is saved
          </h2>
          <p className="mt-1 text-sm text-charcoal">
            Order {ref} is saved under Awaiting payment, but the payment link isn&apos;t confirmed yet. The customer may not have received it. Tap Retry link
            to check with Razorpay. Don&apos;t add the order again.
          </p>
          {formError ? (
            <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
              {formError}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap gap-2">
            <Button loading={retrying} onClick={() => void retryLink()}>
              Retry link
            </Button>
            <Link href="/owner/shop?tab=awaiting_payment" className={buttonVariants({ variant: 'secondary' })}>
              View order
            </Link>
          </div>
        </div>
      );
    }
    return (
      <div className={`${CARD} mt-6`} data-testid="success">
        {created.kind === 'link' ? (
          <>
            <h2 ref={doneRef} tabIndex={-1} className="text-xl font-bold text-charcoal outline-none">
              Order {ref} created
            </h2>
            <p className="mt-1 text-sm text-charcoal">
              Waiting for the customer to pay <span className="font-mono font-semibold tabular-nums">{rupees(created.total_inr)}</span>. Razorpay has
              sent them the link{email.trim() ? ' by text and email' : ' by text'}. The order moves to To ship when it is paid.
            </p>
            {url ? (
              <div className="mt-4">
                <Input label="Payment link" readOnly value={url} onFocus={(e) => e.currentTarget.select()} className="font-mono text-sm" />
                {created.payment_link_expires_at ? <p className="mt-1 text-sm text-muted">Expires {inIst(created.payment_link_expires_at)} IST.</p> : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => void copyLink(url)}>
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                  <a
                    href={whatsappShareUrl({ orderRef: ref, totalInr: created.total_inr, url })}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({ variant: 'secondary' })}
                  >
                    Share on WhatsApp
                  </a>
                </div>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted">The link is on the order card under Awaiting payment.</p>
            )}
          </>
        ) : (
          <>
            <h2 ref={doneRef} tabIndex={-1} className="text-xl font-bold text-charcoal outline-none">
              Paid, ready to ship: {ref}
            </h2>
            <p className="mt-1 text-sm text-charcoal">
              <span className="font-mono font-semibold tabular-nums">{rupees(created.total_inr)}</span> recorded. It is in the To ship list.
            </p>
          </>
        )}
        {formError ? (
          <p role="alert" className="mt-3 text-sm font-semibold text-red-700">
            {formError}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap gap-2 border-t border-line pt-4">
          <Link href={`/owner/shop?tab=${created.kind === 'link' ? 'awaiting_payment' : 'to_ship'}`} className={buttonVariants({})}>
            View order
          </Link>
          <Button variant="secondary" onClick={reset}>
            Add another order
          </Button>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // The form
  // ---------------------------------------------------------------------------
  const err = (f: string) => (fieldError && fieldError.field === f ? fieldError.error : undefined);
  const rows = shownQuote ? quoteBillRows(shownQuote) : [];
  const pack = packs.find((p) => p.id === packId) ?? packs[0] ?? null;
  const canAddMore = units < MAX_UNITS_PER_ORDER;
  const addresses = lookup?.status === 'done' ? lookup.addresses : [];
  const formVisible = showForm || addresses.length === 0;
  const hbLinePrefix = 'home blend';

  function addPack() {
    if (!pack) return;
    if (!grind) {
      setGrindPrompt(true);
      document.getElementById(fid('grind'))?.focus();
      return;
    }
    if (!canAddMore) return;
    setItems((cur) => addCartItem(cur, { product_id: pack.id, quantity: packQty, grind }));
    setGrindPrompt(false);
    setPackQty(1);
  }

  return (
    <form
      className="mt-6 space-y-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {/* 1. Customer */}
      <Section n={1} title="Customer">
        <Input
          id={fid('phone')}
          label="Customer phone"
          type="tel"
          inputMode="numeric"
          autoComplete="off"
          maxLength={14}
          value={phone}
          onChange={(e) => {
            setPhone(cleanPhoneInput(e.target.value));
            setFieldError(null);
          }}
          hint="10-digit mobile. Saved addresses show up once it is complete."
          error={err('phone') ?? (phone.length === 10 && !phoneValid ? 'Enter a 10-digit Indian mobile number (it starts with 6, 7, 8 or 9)' : undefined)}
        />

        <div className="mt-3" aria-live="polite">
          {lookup?.status === 'loading' ? <p className="text-sm text-muted">Looking for this customer…</p> : null}
          {lookup?.status === 'error' ? <p className="text-sm text-muted">Couldn&apos;t look up saved addresses. Enter the address below.</p> : null}
          {lookup?.status === 'done' && addresses.length === 0 ? (
            <p className="text-sm text-muted">No saved address for this number. Enter it below.</p>
          ) : null}
        </div>

        {addresses.length > 0 ? (
          <ul className="mt-2 space-y-3" aria-label="Saved addresses">
            {addresses.map((a, i) => (
              <li key={`${a.source}-${a.pincode}-${a.address_line1}`} className={`rounded-md border-2 p-3 ${pickedAddress === i ? 'border-tan-dark bg-surface' : 'border-line'}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <Badge variant="outline">{a.source === 'saved' ? 'Saved' : 'Last order'}{a.source === 'saved' && a.label ? ` · ${a.label}` : ''}</Badge>
                  <Button
                    size="sm"
                    variant={pickedAddress === i ? 'ghost' : 'secondary'}
                    aria-pressed={pickedAddress === i}
                    onClick={() => pickSaved(i, a)}
                  >
                    {pickedAddress === i ? 'Using this' : 'Use this'}
                  </Button>
                </div>
                <p className="mt-2 text-sm text-charcoal">
                  <strong>{a.customer_name}</strong>
                  <br />
                  {[a.address_line1, a.address_line2, a.landmark].filter(Boolean).join(', ')}
                  <br />
                  {a.city}, {a.state} {a.pincode}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
        {addresses.length > 0 && !showForm ? (
          <Button variant="ghost" className="mt-2" onClick={() => setShowForm(true)}>
            Use a different address
          </Button>
        ) : null}

        <div className="mt-4 flex flex-col gap-4">
          <Input
            id={fid('email')}
            label="Email (optional), for receipts and the payment link"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            hint="Without an email the customer gets no receipt, and the payment link goes by text only."
            error={err('email')}
          />
          {formVisible ? (
            <AddressForm
              idPrefix={ID}
              value={address}
              onChange={(patch) => {
                setAddress((a) => ({ ...a, ...patch }));
                setFieldError(null);
              }}
              errors={fieldError}
              hidePhone
            />
          ) : null}
        </div>
      </Section>

      {/* 2. Items */}
      <Section n={2} title="Items" hint={`Listed products that are in stock. Up to ${MAX_UNITS_PER_ORDER} in one order.`}>
        <div id={fid('items')} tabIndex={-1} className="outline-none" aria-describedby={err('items') ? fid('items-error') : undefined}>
          {instant.length > 0 ? (
            <div>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Instant Coffee</h3>
              <ul className="mt-2 divide-y divide-line">
                {instant.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-charcoal">{p.name}</p>
                      <p className="text-sm text-muted">
                        <span className="font-mono tabular-nums">{rupees(p.price_inr)}</span> · {p.net_qty}
                      </p>
                    </div>
                    <Stepper
                      label={p.name}
                      value={unitsOfProduct(items, p.id)}
                      onChange={(n) => setItems((cur) => setInstantQuantity(cur, p.id, n))}
                      canAdd={canAddMore}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {packs.length > 0 ? (
            <div className={instant.length > 0 ? 'mt-6' : ''}>
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted">Home Blend</h3>
              <fieldset className="mt-2">
                <legend className="text-sm font-semibold text-charcoal">Pack size</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {packs.map((p) => (
                    <label key={p.id} className={`${CHIP} ${chipTone(pack?.id === p.id)}`}>
                      <input type="radio" name={fid('pack')} className="sr-only" checked={pack?.id === p.id} onChange={() => setPackId(p.id)} />
                      {packLabel(p.pack_grams)}
                      <span className="font-mono text-xs font-normal tabular-nums">{rupees(p.price_inr)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className="mt-4" aria-describedby={grindPrompt ? fid('grind-error') : undefined}>
                <legend className="text-sm font-semibold text-charcoal">How should it be ground? (required)</legend>
                <div className="mt-2 flex flex-wrap gap-2">
                  {GRINDS.map((g, i) => (
                    <label key={g.code} className={`${CHIP} ${chipTone(grind === g.code)}`}>
                      <input
                        id={i === 0 ? fid('grind') : undefined}
                        type="radio"
                        name={fid('grind-choice')}
                        className="sr-only"
                        checked={grind === g.code}
                        onChange={() => {
                          setGrind(g.code);
                          setGrindPrompt(false);
                        }}
                      />
                      {g.short}
                    </label>
                  ))}
                </div>
                {grind ? <p className="mt-1 text-sm text-muted">{GRINDS.find((g) => g.code === grind)?.hint}</p> : null}
                {grindPrompt ? (
                  <p id={fid('grind-error')} role="alert" className="mt-1 text-sm font-semibold text-red-700">
                    Choose how it should be ground first
                  </p>
                ) : null}
              </fieldset>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Stepper label="Home Blend" value={packQty} min={1} onChange={(n) => setPackQty(Math.max(1, n))} canAdd={units + packQty < MAX_UNITS_PER_ORDER} />
                <Button variant="secondary" onClick={addPack} disabled={!canAddMore}>
                  Add to order
                </Button>
              </div>

              {hbLines.length > 0 ? (
                <ul className="mt-4 divide-y divide-line rounded-md border border-line" aria-label={`${hbLinePrefix} in this order`}>
                  {hbLines.map((l) => (
                    <li key={l.key} className="flex flex-wrap items-center justify-between gap-2 p-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-charcoal">{l.title}</p>
                        <p className="font-mono text-sm tabular-nums text-muted">{rupees(l.line_total_inr)}</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Stepper
                          label={l.title}
                          value={l.quantity}
                          min={1}
                          canAdd={canAddMore}
                          onChange={(n) => setItems((cur) => setCartItemQuantity(cur, l.key, n))}
                        />
                        <Button size="sm" variant="ghost" className="text-red-700" onClick={() => setItems((cur) => removeCartItem(cur, l.key))} aria-label={`Remove ${l.title}`}>
                          Remove
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </div>
        {err('items') ? (
          <p id={fid('items-error')} role="alert" className="mt-2 text-sm font-semibold text-red-700">
            {err('items')}
          </p>
        ) : null}
        {!canAddMore ? <p className="mt-2 text-sm text-muted">That is the most one order can hold ({MAX_UNITS_PER_ORDER} units).</p> : null}
      </Section>

      {/* 3. Bill */}
      <Section n={3} title="Bill">
        <div aria-live="polite" aria-busy={billLoading}>
          {payloadKey === null ? (
            <p className="text-sm text-muted">
              {discountAmount === null
                ? 'Fix the discount amount to see the bill.'
                : 'Enter the customer’s phone and add items to see the bill. The prices come from the server, the same as the website.'}
            </p>
          ) : billError && !shownQuote ? (
            <div>
              <p role="alert" className="text-sm font-semibold text-red-700">
                {billError}
              </p>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => setRetry((n) => n + 1)}>
                Try again
              </Button>
            </div>
          ) : shownQuote ? (
            <div className={billLoading ? 'opacity-60' : ''}>
              <dl className="space-y-1 text-sm text-charcoal">
                {rows.map((r) =>
                  r.key === 'total' ? (
                    <div key={r.key} className="flex justify-between gap-3 border-t border-line pt-2 text-lg font-bold">
                      <dt>{r.label}</dt>
                      <dd className="font-mono tabular-nums" data-testid="bill-total">
                        {r.value}
                      </dd>
                    </div>
                  ) : (
                    <div key={r.key} className="flex justify-between gap-3">
                      <dt>{r.label}</dt>
                      <dd className="font-mono tabular-nums">{r.value}</dd>
                    </div>
                  ),
                )}
              </dl>
              {shownQuote.notes.length > 0 ? (
                <ul className="mt-3 space-y-1 text-sm text-muted">
                  {shownQuote.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              ) : null}
              {accountLinked ? <p className="mt-2 text-sm text-muted">This customer has an account: the order will show there, and earn Beanies once delivered.</p> : null}
            </div>
          ) : (
            <p className="text-sm text-muted">Working out the bill…</p>
          )}
          {billLoading && shownQuote ? <p className="mt-2 text-sm text-muted">Updating the bill…</p> : null}
          {notice ? (
            <p role="status" className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm font-semibold text-charcoal">
              {notice} Check it, then tap the button again to confirm.
            </p>
          ) : null}
        </div>

        <details className="mt-4 rounded-md border border-line">
          <summary className="flex min-h-[44px] cursor-pointer items-center px-3 text-sm font-semibold text-tan-dark">Coupon code</summary>
          <div className="px-3 pb-3">
            <Input
              id={fid('coupon')}
              label="Coupon code (optional)"
              autoComplete="off"
              autoCapitalize="characters"
              maxLength={40}
              value={coupon}
              onChange={(e) => setCoupon(e.target.value)}
              hint="The bill uses the introductory offer or the coupon, whichever saves more."
            />
          </div>
        </details>
      </Section>

      {/* 4. Owner discount */}
      <Section n={4} title="Owner discount" hint="Optional. At most 50% of the goods after offers, and never below ₹1 in total.">
        <div className="flex flex-col gap-4">
          <Input
            id={fid('owner-discount')}
            label="Discount in ₹"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            placeholder="0"
            maxLength={6}
            value={discount}
            onChange={(e) => {
              setDiscount(e.target.value.replace(/\D/g, '').slice(0, 6));
              setFieldError(null);
            }}
            error={err('owner-discount') ?? discountServerError ?? undefined}
          />
          {(discountAmount ?? 0) > 0 ? (
            <Input
              id={fid('owner-discount-reason')}
              label="Reason for the discount (required)"
              autoComplete="off"
              maxLength={80}
              placeholder="e.g. regular customer"
              value={discountReason}
              onChange={(e) => {
                setDiscountReason(e.target.value);
                setFieldError(null);
              }}
              error={err('owner-discount-reason')}
            />
          ) : null}
        </div>
      </Section>

      {/* 5. Payment */}
      <Section n={5} title="Payment">
        <div id={fid('payment')} tabIndex={-1} className="outline-none">
          <fieldset aria-describedby={err('payment') ? fid('payment-error') : undefined}>
            <legend className="sr-only">How the customer pays</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label
                className={`flex min-h-[44px] cursor-pointer gap-3 rounded-md border-2 p-4 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-tan ${payKind === 'link' ? 'border-tan-dark bg-surface' : 'border-line hover:bg-surface'}`}
              >
                <input type="radio" name={fid('pay')} className="mt-1 h-5 w-5 shrink-0 accent-tan-dark" checked={payKind === 'link'} onChange={() => { setPayKind('link'); setFieldError(null); }} />
                <span>
                  <span className="block font-bold text-charcoal">Send payment link</span>
                  <span className="mt-1 block text-sm text-muted">
                    Razorpay texts it to the customer (and emails it if you added an email). You can also copy it or share it on WhatsApp. It expires in 48 hours.
                  </span>
                </span>
              </label>
              <label
                className={`flex min-h-[44px] cursor-pointer gap-3 rounded-md border-2 p-4 focus-within:outline focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-tan ${payKind === 'offline' ? 'border-tan-dark bg-surface' : 'border-line hover:bg-surface'}`}
              >
                <input type="radio" name={fid('pay')} className="mt-1 h-5 w-5 shrink-0 accent-tan-dark" checked={payKind === 'offline'} onChange={() => { setPayKind('offline'); setFieldError(null); }} />
                <span>
                  <span className="block font-bold text-charcoal">Already paid</span>
                  <span className="mt-1 block text-sm text-muted">The money has come to you by UPI, cash or bank transfer. The order goes straight to To ship.</span>
                </span>
              </label>
            </div>
          </fieldset>
        </div>

        {payKind === 'offline' ? (
          <div className="mt-4 flex flex-col gap-4">
            <fieldset>
              <legend className="text-sm font-semibold text-charcoal">How was it paid?</legend>
              <div className="mt-2 flex flex-wrap gap-2">
                {OFFLINE_METHODS.map((m) => (
                  <label key={m} className={`${CHIP} ${chipTone(method === m)}`}>
                    <input type="radio" name={fid('method')} className="sr-only" checked={method === m} onChange={() => { setMethod(m); setFieldError(null); }} />
                    {OFFLINE_METHOD_LABELS[m]}
                  </label>
                ))}
              </div>
            </fieldset>
            <Input
              id={fid('reference')}
              label="Reference"
              autoComplete="off"
              maxLength={60}
              placeholder="UPI transaction id or a note"
              value={reference}
              onChange={(e) => { setReference(e.target.value); setFieldError(null); }}
              hint="3 to 60 characters. It is kept on the order."
            />
          </div>
        ) : null}
        {err('payment') ? (
          <p id={fid('payment-error')} role="alert" className="mt-2 text-sm font-semibold text-red-700">
            {err('payment')}
          </p>
        ) : null}
      </Section>

      {/* 6. Create */}
      <div className={CARD}>
        {formError ? (
          <p role="alert" className="mb-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm font-semibold text-red-800">
            {formError}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-charcoal">
            Total{' '}
            <span className="font-mono text-lg font-bold tabular-nums">{quote ? rupees(quote.total_inr) : '—'}</span>
          </p>
          <Button type="submit" size="lg" loading={pending} disabled={billLoading} className="w-full sm:w-auto">
            {pending ? 'Creating…' : notice ? 'Confirm and create order' : 'Create order'}
          </Button>
        </div>
      </div>
    </form>
  );
}
