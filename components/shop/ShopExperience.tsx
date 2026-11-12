'use client';

// The /shop page's interactive part: pick flavours, see the total (₹49
// shipping below 3 jars, free from 3), enter the delivery address, pay with
// Razorpay. Prices come from the server (shop_products); the same pure
// functions the checkout route uses compute what is shown here, and the route
// re-prices anyway (lib/shop/pricing.ts).

import { useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { LocationPin } from '@/components/shop/LocationPin';
import { openRazorpayCheckout, preloadRazorpay } from '@/lib/payments/razorpayCheckout';
import type { CreatedPaymentIntent } from '@/lib/payments/types';
import { INDIAN_STATES, validateShopAddress, type AddressField } from '@/lib/shop/address';
import { FALLBACK_FLAVOUR_STYLE, FLAVOUR_STYLE } from '@/lib/shop/catalog';
import type { ShopLocation } from '@/lib/shop/location';
import {
  FREE_SHIPPING_MIN_JARS,
  jarsLabel,
  MAX_JARS_PER_ORDER,
  offerDeals,
  priceShopCart,
  rupees,
  shippingForJars,
  totalForJars,
} from '@/lib/shop/pricing';
import type { ShopOffer, ShopProduct } from '@/lib/shop/types';

type Form = Record<AddressField, string>;

const EMPTY_FORM: Form = {
  customer_name: '',
  phone: '',
  email: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  pincode: '',
};

const STATE_OPTIONS = INDIAN_STATES.map((s) => ({ value: s, label: s }));

interface PendingPayment {
  key: string;
  orderId: string;
  payment: CreatedPaymentIntent;
}

function Stepper({
  label,
  value,
  onChange,
  canAdd,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  canAdd: boolean;
}) {
  if (value === 0) {
    return (
      <Button variant="secondary" size="sm" onClick={() => onChange(1)} disabled={!canAdd} aria-label={`Add ${label}`}>
        Add
      </Button>
    );
  }
  const btn =
    'flex h-11 w-11 items-center justify-center rounded-md text-xl font-semibold text-tan-dark transition-colors hover:bg-surface disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-tan';
  return (
    <div className="flex items-center rounded-md border border-line" role="group" aria-label={`${label} quantity`}>
      <button type="button" className={btn} onClick={() => onChange(value - 1)} aria-label={`One fewer ${label}`}>
        −
      </button>
      <span className="min-w-[2ch] text-center font-mono text-base tabular-nums text-charcoal" aria-live="polite">
        {value}
      </span>
      <button type="button" className={btn} onClick={() => onChange(value + 1)} disabled={!canAdd} aria-label={`One more ${label}`}>
        +
      </button>
    </div>
  );
}

/**
 * The nudge under the total: what one more jar costs, and what it unlocks
 * (the next offer tier, free shipping). Null when nothing more is unlocked.
 */
function nextJarNudge(jarCount: number, unitPrice: number, offer: ShopOffer | null): string | null {
  if (jarCount <= 0 || jarCount >= MAX_JARS_PER_ORDER) return null;
  const next = jarCount + 1;
  const tier = offer ? offerDeals(offer.tier_prices, unitPrice).find((d) => d.jars === next) : undefined;
  const freesShipping = shippingForJars(jarCount) > 0 && shippingForJars(next) === 0;
  if (!tier && !freesShipping) return null;
  const more = totalForJars(unitPrice, next, offer) - totalForJars(unitPrice, jarCount, offer);
  const unlocks = [tier ? `${next} for ${rupees(tier.price)}` : null, freesShipping ? 'free shipping' : null].filter(Boolean).join(' + ');
  return `Add ${next === 2 ? 'another' : `a ${next === 3 ? '3rd' : `${next}th`}`} jar for just ${rupees(more)} more: ${unlocks}.`;
}

export function ShopExperience({
  products,
  offer,
  paymentReady,
}: {
  products: ShopProduct[];
  offer: ShopOffer | null;
  paymentReady: boolean;
}) {
  const router = useRouter();
  const [qty, setQty] = useState<Record<string, number>>({});
  const [form, setForm] = useState<Form>(EMPTY_FORM);
  const [fieldError, setFieldError] = useState<{ field: AddressField; error: string } | null>(null);
  const [pin, setPin] = useState<ShopLocation | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [orderLink, setOrderLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<PendingPayment | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  const items = useMemo(
    () => Object.entries(qty).filter(([, n]) => n > 0).map(([product_id, quantity]) => ({ product_id, quantity })),
    [qty],
  );
  const jarCount = items.reduce((n, i) => n + i.quantity, 0);
  const quote = useMemo(() => (items.length ? priceShopCart(products, items, offer) : null), [products, items, offer]);
  const unitPrice = Math.min(...products.map((p) => p.price_inr));
  const nudge = nextJarNudge(jarCount, unitPrice, offer);
  const deals = offer ? offerDeals(offer.tier_prices, unitPrice) : [];
  const canAddMore = jarCount < MAX_JARS_PER_ORDER;

  function setQuantity(id: string, n: number) {
    setQty((q) => ({ ...q, [id]: Math.max(0, n) }));
    setError(null);
    if (paymentReady) preloadRazorpay();
  }

  function setField(field: AddressField, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    if (fieldError?.field === field) setFieldError(null);
  }

  function focusField(field: AddressField) {
    const el = formRef.current?.querySelector<HTMLElement>(`[name="${field}"]`);
    el?.focus();
  }

  async function pay(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setOrderLink(null);
    if (!quote || !quote.ok) {
      setError(quote && !quote.ok ? quote.error : 'Add at least one jar to your order.');
      return;
    }
    const checked = validateShopAddress(form);
    if (!checked.ok) {
      setFieldError({ field: checked.field, error: checked.error });
      focusField(checked.field);
      return;
    }

    setBusy(true);
    setPinError(null);
    const key = JSON.stringify({ items, address: checked.address, pin });
    let current = pending.current;
    if (!current || current.key !== key) {
      let res: Response;
      let data: Record<string, unknown> = {};
      try {
        res = await fetch('/api/shop/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, address: form, location: pin, expected_total_inr: quote.total_inr }),
        });
        data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      } catch {
        setBusy(false);
        setError('Network error — check your connection and try again.');
        return;
      }
      if (!res.ok) {
        setBusy(false);
        const message = typeof data.error === 'string' ? data.error : 'Could not start your order — please try again.';
        const field = data.field as AddressField | 'location' | undefined;
        if (field === 'location') {
          setPinError(message);
        } else if (field && field in EMPTY_FORM) {
          setFieldError({ field, error: message });
          focusField(field);
        } else {
          setError(message);
        }
        // Prices or stock changed since the page loaded: load them again.
        if (res.status === 409 || (res.status === 400 && !field)) router.refresh();
        return;
      }
      current = { key, orderId: String(data.order_id), payment: data.payment as CreatedPaymentIntent };
      pending.current = current;
    }

    const orderPath = `/shop/order/${current.orderId}`;
    await openRazorpayCheckout(current.payment, {
      name: checked.address.customer_name,
      phone: checked.address.phone.replace(/^\+91/, ''),
      email: checked.address.email,
      description: `Instant Coffee — ${jarsLabel(quote.jar_count)}`,
      verifyPath: '/api/shop/verify',
      onSuccess: () => router.push(orderPath),
      onDismiss: (lastFailure) => {
        setBusy(false);
        setError(
          lastFailure
            ? `The payment didn't go through (${lastFailure}). You can try again.`
            : 'Payment not completed, so nothing was charged. You can try again.',
        );
      },
      onFailure: (description) => {
        setBusy(false);
        setError(`${description} If money has left your account, your order page will update within a few minutes.`);
        setOrderLink(orderPath);
      },
    });
  }

  const err = (f: AddressField) => (fieldError?.field === f ? fieldError.error : undefined);

  return (
    <>
      <section aria-labelledby="flavours-heading" className="mt-10">
        <h2 id="flavours-heading" className="text-xl font-bold text-charcoal">
          Choose your flavours
        </h2>
        <p className="mt-1 text-sm text-muted">
          {deals.length > 0 && offer
            ? `${offer.name}: ${deals.map((d) => `${d.jars} for ${rupees(d.price)}`).join(' · ')} — any flavours · free shipping on ${FREE_SHIPPING_MIN_JARS} or more`
            : `${rupees(unitPrice)} a jar · mix any flavours · free shipping on ${FREE_SHIPPING_MIN_JARS} or more`}
        </p>
        <ul className="mt-5 grid gap-4 md:grid-cols-3">
          {products.map((p) => {
            const style = FLAVOUR_STYLE[p.id] ?? FALLBACK_FLAVOUR_STYLE;
            const n = qty[p.id] ?? 0;
            return (
              <li
                key={p.id}
                className="flex gap-4 overflow-hidden rounded-md border border-line bg-cream shadow-card md:flex-col md:gap-0"
                style={{ borderTop: `4px solid ${style.accent}` }}
              >
                {style.image ? (
                  // The jar (a cut-out with its own soft shadow) on a wash of its
                  // flavour colour, so the three cards read like a product line.
                  <div
                    className="relative w-28 shrink-0 md:aspect-[5/4] md:w-full"
                    style={{ background: `radial-gradient(ellipse at 50% 40%, #ffffff 0%, ${style.accent}1f 100%)` }}
                  >
                    <Image
                      src={style.image}
                      alt={`${p.name} jar, ${p.net_qty}`}
                      fill
                      sizes="(min-width: 768px) 33vw, 112px"
                      className={`object-contain p-2 md:p-3 ${p.in_stock ? '' : 'opacity-50 grayscale'}`}
                    />
                  </div>
                ) : null}
                <div className="flex flex-1 flex-col py-3 pr-3 md:p-4">
                  <h3 className="text-lg font-bold text-charcoal">{p.name}</h3>
                  {style.tagline ? <p className="mt-0.5 text-sm text-muted">{style.tagline}</p> : null}
                  <p className="mt-2 text-sm text-charcoal">
                    <span className="font-mono font-semibold tabular-nums">{rupees(p.price_inr)}</span>
                    <span className="text-muted"> · {p.net_qty} jar</span>
                  </p>
                  <div className="mt-auto pt-3">
                    {p.in_stock ? (
                      <Stepper label={p.name} value={n} onChange={(v) => setQuantity(p.id, v)} canAdd={canAddMore} />
                    ) : (
                      <span className="inline-flex rounded-full bg-surface px-3 py-1 text-xs font-semibold text-muted">
                        Out of stock
                      </span>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {!canAddMore ? (
          <p className="mt-3 text-sm text-muted">
            That&apos;s the most we take online ({MAX_JARS_PER_ORDER} jars). For more, call or email us.
          </p>
        ) : null}
      </section>

      <form ref={formRef} onSubmit={pay} noValidate className="mt-10 grid gap-8 md:grid-cols-[1fr_minmax(0,22rem)]">
        <section aria-labelledby="address-heading">
          <h2 id="address-heading" className="text-xl font-bold text-charcoal">
            Delivery address
          </h2>
          <p className="mt-1 text-sm text-muted">We ship anywhere in India. The courier may call this number.</p>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Input label="Full name" name="customer_name" autoComplete="name" value={form.customer_name} onChange={(e) => setField('customer_name', e.target.value)} error={err('customer_name')} maxLength={60} />
            </div>
            <Input label="Mobile number" name="phone" type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="10-digit mobile" value={form.phone} onChange={(e) => setField('phone', e.target.value)} error={err('phone')} maxLength={14} />
            <Input label="Email" name="email" type="email" autoComplete="email" hint="For your receipt and tracking link" value={form.email} onChange={(e) => setField('email', e.target.value)} error={err('email')} maxLength={254} />
            <div className="sm:col-span-2">
              <Input label="House / flat, street" name="address_line1" autoComplete="address-line1" value={form.address_line1} onChange={(e) => setField('address_line1', e.target.value)} error={err('address_line1')} maxLength={120} />
            </div>
            <div className="sm:col-span-2">
              <Input label="Area, landmark (optional)" name="address_line2" autoComplete="address-line2" value={form.address_line2} onChange={(e) => setField('address_line2', e.target.value)} error={err('address_line2')} maxLength={120} />
            </div>
            <Input label="Town / city" name="city" autoComplete="address-level2" value={form.city} onChange={(e) => setField('city', e.target.value)} error={err('city')} maxLength={50} />
            <Input label="Pincode" name="pincode" inputMode="numeric" autoComplete="postal-code" value={form.pincode} onChange={(e) => setField('pincode', e.target.value.replace(/\D/g, '').slice(0, 6))} error={err('pincode')} maxLength={6} />
            <div className="sm:col-span-2">
              <Select label="State" name="state" autoComplete="address-level1" placeholder="Choose a state" options={STATE_OPTIONS} value={form.state} onChange={(e) => setField('state', e.target.value)} error={err('state')} />
            </div>
          </div>
          <LocationPin
            value={pin}
            onChange={(loc) => {
              setPin(loc);
              setPinError(null);
            }}
            error={pinError ?? undefined}
          />
        </section>

        <aside aria-labelledby="summary-heading" className="md:sticky md:top-24 md:self-start">
          <div className="rounded-md border border-line bg-cream p-5 shadow-card">
            <h2 id="summary-heading" className="text-lg font-bold text-charcoal">
              Your order
            </h2>
            {quote && quote.ok ? (
              <dl className="mt-4 space-y-2 text-sm">
                {quote.lines.map((l) => (
                  <div key={l.product_id} className="flex justify-between gap-3">
                    <dt className="text-charcoal">
                      {l.name} × {l.quantity}
                    </dt>
                    <dd className="font-mono tabular-nums text-charcoal">{rupees(l.line_total_inr)}</dd>
                  </div>
                ))}
                {quote.discount_inr > 0 ? (
                  <div className="flex justify-between gap-3">
                    <dt className="font-semibold text-green-800">{quote.offer_name}</dt>
                    <dd className="font-mono tabular-nums text-green-800">−{rupees(quote.discount_inr)}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-3 border-t border-line pt-2">
                  <dt className="text-muted">Shipping</dt>
                  <dd className="font-mono tabular-nums text-charcoal">
                    {quote.shipping_inr === 0 ? <span className="font-sans font-semibold text-green-700">Free</span> : rupees(quote.shipping_inr)}
                  </dd>
                </div>
                <div className="flex justify-between gap-3 border-t border-line pt-2 text-base font-bold">
                  <dt className="text-charcoal">Total</dt>
                  <dd className="font-mono tabular-nums text-charcoal">{rupees(quote.total_inr)}</dd>
                </div>
              </dl>
            ) : (
              <p className="mt-3 text-sm text-muted">No jars yet — add a flavour above.</p>
            )}

            {nudge ? <p className="mt-4 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">{nudge}</p> : null}
            {quote && quote.ok && quote.discount_inr > 0 ? (
              <p className="mt-3 text-center text-sm font-semibold text-green-800">You save {rupees(quote.discount_inr)}</p>
            ) : null}

            {error ? (
              <p role="alert" className="mt-4 text-sm font-semibold text-red-700">
                {error}{' '}
                {orderLink ? (
                  <a href={orderLink} className="underline">
                    View your order
                  </a>
                ) : null}
              </p>
            ) : null}

            {paymentReady ? (
              <Button type="submit" size="lg" fullWidth className="mt-5" loading={busy} disabled={!quote || !quote.ok}>
                {quote && quote.ok ? `Pay ${rupees(quote.total_inr)}` : 'Pay'}
              </Button>
            ) : (
              <p className="mt-5 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
                Online payment isn&apos;t available right now. Please check back soon, or buy jars at the café.
              </p>
            )}
            <p className="mt-3 text-center text-xs text-muted">Secure payment by Razorpay · UPI, cards, netbanking · prepaid only</p>
          </div>
        </aside>
      </form>
    </>
  );
}
