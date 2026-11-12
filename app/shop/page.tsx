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
import { FREE_SHIPPING_MIN_JARS, rupees, SHIPPING_FEE_INR } from '@/lib/shop/pricing';
import { loadShopProducts } from '@/lib/shop/server';

// /shop — HIOC. Premium Instant Coffee, delivered (docs/INSTANT-COFFEE-SHOP.md).
// A server shell: the flag, the products (live from shop_products, so a flavour
// the owner marks out of stock shows so at once), whether Razorpay is set up,
// and the static copy. Picking, the address and paying are the client part
// (components/shop/ShopExperience). Dynamic, for the stock and the flag.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Premium Instant Coffee — order online',
  description:
    'HIOC. Premium Instant Coffee: 100% Arabica, freeze-dried, in Signature Classic, Nutty Hazelnut and French Vanilla. ₹399 a 50 g jar, shipped across India — free shipping on 3 jars or more.',
};

export default async function ShopPage() {
  if (!flags.shop) notFound();

  const result = await loadShopProducts(createAdminSupabaseClient());
  const products = result.ok ? result.products : [];
  const price = products[0]?.price_inr ?? 399;

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 md:py-14">
      <header className="grid items-center gap-8 md:grid-cols-[1fr_minmax(0,24rem)]">
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
          <p className="mt-5 inline-flex flex-wrap items-baseline gap-x-2 rounded-md bg-surface px-3 py-2 text-sm text-charcoal">
            <strong className="font-mono text-base tabular-nums">{rupees(price)}</strong> a {PRODUCT_NET_QTY} jar
            <span aria-hidden="true">·</span>
            <span>
              {rupees(SHIPPING_FEE_INR)} shipping, <strong>free on {FREE_SHIPPING_MIN_JARS}+ jars</strong>
            </span>
          </p>
        </div>
        {/* The launch poster's top half (title and jars): its lower half carries
            the counter-only offer prices, which would contradict ₹399 here. */}
        <div className="relative mx-auto aspect-[1024/860] w-full max-w-[24rem] overflow-hidden rounded-md shadow-elevated">
          <Image
            src="/images/shop/hero.jpg"
            alt="Three 50 g jars of HIOC. Premium Instant Coffee — Nutty Hazelnut, French Vanilla and Classic — on a wooden board."
            fill
            priority
            sizes="(min-width: 768px) 384px, 100vw"
            className="object-cover"
          />
        </div>
      </header>

      {products.length > 0 ? (
        <ShopExperience products={products} paymentReady={isGatewayConfigured()} />
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
              The launch offer on our poster (1 jar ₹299, 2 for ₹499, 3 for ₹599) is for jars bought at the café counter.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
