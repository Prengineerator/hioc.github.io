import type { Metadata } from 'next';
import Image from 'next/image';
import { notFound } from 'next/navigation';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { ShopExperience } from '@/components/shop/ShopExperience';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { flags } from '@/lib/flags';
import { BUSINESS } from '@/lib/legal';
import { isGatewayConfigured } from '@/lib/payments/gateway';
import { DELIVERY_TAKES, DISPATCH_WITHIN, PRODUCT_HIGHLIGHTS, PRODUCT_NET_QTY, SHOP_PRODUCT_NAME } from '@/lib/shop/catalog';
import { FREE_SHIPPING_MIN_JARS, jarsLabel, offerDeals, rupees, SHIPPING_FEE_INR } from '@/lib/shop/pricing';
import { loadShopOffer, loadShopProducts } from '@/lib/shop/server';

// /shop — HIOC. Premium Instant Coffee, delivered (docs/INSTANT-COFFEE-SHOP.md).
// A server shell: the flag, the products (live from shop_products, so a flavour
// the owner marks out of stock shows so at once), the online offer (the
// introductory "2 for ₹599 · 3 for ₹749" while the owner has it on), whether
// Razorpay is set up, and the static copy. Picking, the address and paying are
// the client part (components/shop/ShopExperience). Dynamic, for stock and offer.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Premium Instant Coffee — order online',
  description:
    'HIOC. Premium Instant Coffee: 100% Arabica, freeze-dried, in Signature Classic, Nutty Hazelnut and French Vanilla. 50 g jars shipped across India — introductory offer and free shipping on 3 jars.',
};

export default async function ShopPage() {
  if (!flags.shop) notFound();

  const admin = createAdminSupabaseClient();
  const [result, offer] = await Promise.all([loadShopProducts(admin), loadShopOffer(admin)]);
  const products = result.ok ? result.products : [];
  const price = products.length ? Math.min(...products.map((p) => p.price_inr)) : 399;
  const deals = offer ? offerDeals(offer.tier_prices, price) : [];

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 md:py-14">
      <header className="grid items-center gap-8 md:grid-cols-[1fr_minmax(0,28rem)]">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-tan-dark">New launch · delivered to your door</p>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-charcoal md:text-4xl">Premium Instant Coffee</h1>
          <p className="mt-3 max-w-xl text-muted">
            Café-quality coffee, instantly. 100% Arabica, freeze-dried to lock in the aroma, in three flavours.
          </p>
          <ul className="mt-5 grid gap-2 text-sm text-charcoal sm:grid-cols-2">
            {PRODUCT_HIGHLIGHTS.map((h) => (
              <li key={h} className="flex gap-2">
                <span aria-hidden="true" className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-tan" />
                {h}
              </li>
            ))}
          </ul>

          {deals.length > 0 && offer ? (
            <section aria-label={offer.name} className="mt-6 rounded-md border border-line bg-surface p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.15em] text-tan-dark">{offer.name} · any flavours</p>
              <ul className="mt-3 grid grid-cols-3 gap-2 text-center">
                <li className="rounded-md bg-cream px-2 py-3 shadow-sm">
                  <p className="text-xs text-muted">1 jar</p>
                  <p className="mt-0.5 font-mono text-lg font-bold tabular-nums text-charcoal">{rupees(price)}</p>
                </li>
                {deals.slice(0, 2).map((d) => (
                  <li key={d.jars} className="rounded-md bg-cream px-2 py-3 shadow-sm ring-1 ring-tan">
                    <p className="text-xs font-semibold text-tan-dark">{jarsLabel(d.jars)}</p>
                    <p className="mt-0.5 font-mono text-lg font-bold tabular-nums text-charcoal">{rupees(d.price)}</p>
                    <p className="text-xs text-muted">
                      <s>{rupees(d.was)}</s>
                    </p>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-muted">
                {rupees(SHIPPING_FEE_INR)} shipping on 1–2 jars · <strong className="text-charcoal">free shipping on {FREE_SHIPPING_MIN_JARS}+ jars</strong>
              </p>
            </section>
          ) : (
            <p className="mt-5 inline-flex flex-wrap items-baseline gap-x-2 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
              <strong className="font-mono text-base tabular-nums">{rupees(price)}</strong> a {PRODUCT_NET_QTY} jar
              <span aria-hidden="true">·</span>
              <span>
                {rupees(SHIPPING_FEE_INR)} shipping, <strong>free on {FREE_SHIPPING_MIN_JARS}+ jars</strong>
              </span>
            </p>
          )}
        </div>

        {/* The three jars, cut out of the launch poster, on a soft warm light. */}
        <div
          className="relative overflow-hidden rounded-2xl px-2 pb-2 pt-8 md:pt-10"
          style={{ background: 'radial-gradient(ellipse at 50% 35%, #ffffff 0%, #f6efe9 60%, #efe3d6 100%)' }}
        >
          {deals.length > 0 && offer ? (
            <span className="absolute left-4 top-4 rounded-full bg-tan-dark px-3 py-1 text-xs font-semibold text-cream shadow-sm">
              {offer.name}
            </span>
          ) : null}
          <Image
            src="/images/shop/hero-jars.png"
            alt="Three 50 g jars of HIOC. Premium Instant Coffee — Nutty Hazelnut, French Vanilla and Classic — tied with black ribbons."
            width={880}
            height={476}
            priority
            sizes="(min-width: 768px) 448px, 100vw"
            className="h-auto w-full"
          />
        </div>
      </header>

      {products.length > 0 ? (
        <ShopExperience products={products} offer={offer} paymentReady={isGatewayConfigured()} />
      ) : (
        <p className="mt-10 rounded-md border border-line bg-surface p-6 text-center text-charcoal">
          Online orders open soon. Meanwhile, you can buy jars at the café.
        </p>
      )}

      <section aria-labelledby="facts-heading" className="mt-14 grid gap-8 border-t border-line pt-10 md:grid-cols-2">
        <div>
          <h2 id="facts-heading" className="text-lg font-bold text-charcoal">
            Product details
          </h2>
          <dl className="mt-3 space-y-2 text-sm">
            {[
              ['Product', `${SHOP_PRODUCT_NAME} (freeze-dried, 100% Arabica)`],
              ['Net quantity', `${PRODUCT_NET_QTY} per jar`],
              ['MRP', `${rupees(price)} per jar (inclusive of all taxes)`],
              ['Sold by', `${BUSINESS.legalName} (${BUSINESS.name}), ${BUSINESS.address}`],
              ['Customer care', `${BUSINESS.phoneDisplay} · ${BUSINESS.email}`],
            ].map(([k, v]) => (
              <div key={k} className="grid grid-cols-[8rem_1fr] gap-2">
                <dt className="text-muted">{k}</dt>
                <dd className="text-charcoal">{v}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h2 className="text-lg font-bold text-charcoal">Shipping &amp; returns</h2>
          <ul className="mt-3 space-y-2 text-sm text-charcoal">
            {deals.length > 0 && offer ? (
              <li>
                {offer.name}: {deals.map((d) => `${d.jars} jars for ${rupees(d.price)}`).join(', ')}, any mix of flavours.
                More jars are priced as groups of {offer.tier_prices.length} plus the rest.
              </li>
            ) : null}
            <li>
              Shipping is {rupees(SHIPPING_FEE_INR)} an order for 1 or 2 jars, and free on {FREE_SHIPPING_MIN_JARS} jars or more.
            </li>
            <li>
              We pack and hand your order to our courier within {DISPATCH_WITHIN}; delivery usually takes {DELIVERY_TAKES} after that, depending on your pincode.
            </li>
            <li>Prepaid only (UPI, cards, netbanking). No cash on delivery.</li>
            <li>
              Arrived damaged? Tell us within 48 hours with a photo and we&apos;ll replace it or refund you. See our{' '}
              <Link href="/shipping-delivery" className="text-tan-dark underline">
                Shipping &amp; Delivery
              </Link>{' '}
              and{' '}
              <Link href="/refund-cancellation" className="text-tan-dark underline">
                Refund &amp; Cancellation
              </Link>{' '}
              policies.
            </li>
            <li className="text-muted">
              The café counter runs its own launch offer (on our poster) for jars bought there; the prices on this page are for
              online orders.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
