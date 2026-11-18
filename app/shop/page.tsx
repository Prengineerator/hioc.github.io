import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { ProductLineCards } from '@/components/shop/ProductLineCards';
import { ShopExperience } from '@/components/shop/ShopExperience';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { verifiedEmailOf } from '@/lib/account/history';
import { flags } from '@/lib/flags';
import { BUSINESS } from '@/lib/legal';
import { normalizeIndianMobile } from '@/lib/phone';
import { isGatewayConfigured } from '@/lib/payments/gateway';
import { loadAutoShopCoupons } from '@/lib/promotions/shopCoupons';
import {
  DELIVERY_TAKES,
  DISPATCH_WITHIN,
  HOME_BLEND_NAME,
  PRODUCT_NET_QTY,
  SHOP_PRODUCT_NAME,
  packLabel,
} from '@/lib/shop/catalog';
import { offerDeals, rupees } from '@/lib/shop/pricing';
import { isIntroOfferEligible, isRepeatCustomer, loadShopPricingSettings, loadShopProducts } from '@/lib/shop/server';
import type { ShopCouponTerms } from '@/lib/shop/types';

// /shop: HIOC. coffee, delivered (docs/SHOP-V2-SPEC.md E8). A server shell: the
// flag, the products the owner has LISTED (an unlisted product never reaches
// the browser), the pricing settings (introductory offer, shipping, Beanies
// cap), whether Razorpay is set up, who is looking (for the offer's ribbon) and
// the static copy. Choosing, the address and paying are the client part
// (components/shop/ShopExperience). Dynamic, for stock, offer and viewer.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Shop HIOC. coffee: order online',
  description: 'HIOC. coffee, delivered across India. Order online, pay securely and track your parcel.',
};

/** What a coupon is worth on a ₹1,000 basket: only used to pick the headline one, never to price an order. */
function couponWorth(t: ShopCouponTerms): number {
  const raw = t.discount_type === 'percent' ? Math.floor((1000 * t.discount_value) / 100) : Math.floor(t.discount_value);
  return t.max_discount_inr > 0 ? Math.min(raw, t.max_discount_inr) : raw;
}

function couponHeadline(t: ShopCouponTerms): string {
  const what = t.discount_type === 'percent' ? `${t.discount_value}% off` : `${rupees(t.discount_value)} off`;
  const min = t.min_order_inr > 0 ? ` on orders of ${rupees(t.min_order_inr)}+` : '';
  return `${what}${min}, applied automatically at checkout`;
}

export default async function ShopPage() {
  if (!flags.shop) notFound();

  const admin = createAdminSupabaseClient();
  const [result, settings] = await Promise.all([loadShopProducts(admin), loadShopPricingSettings(admin)]);
  // Unlisted products (the owner hasn't priced or listed them) never leave the server.
  const products = result.ok ? result.products.filter((p) => p.listed) : [];
  const instant = products.filter((p) => (p.line ?? 'instant') === 'instant');
  const homeBlend = products.filter((p) => p.line === 'home_blend');
  const price = instant.length ? Math.min(...instant.map((p) => p.price_inr)) : 399;
  const offer = settings.offer;

  // Who is looking: a signed-in customer who has had the introductory offer sees
  // "Welcome back" and their best live offer instead. They are never told "no".
  let signedIn = false;
  let introEligible = true;
  let welcomeBack: string | null = null;
  try {
    const user = await getAuthUser();
    if (user) {
      signedIn = true;
      let phone: string | null = null;
      try {
        const { data: profile } = await admin.from('profiles').select('phone, phone_verified').eq('id', user.id).maybeSingle();
        const p = profile as { phone?: string | null; phone_verified?: boolean | null } | null;
        const digits = p?.phone_verified && p.phone ? normalizeIndianMobile(p.phone) : null;
        phone = digits ? `+91${digits}` : null;
      } catch {
        phone = null; // no verified phone to go by
      }
      const email = verifiedEmailOf(user);
      if (offer) {
        introEligible = await isIntroOfferEligible(admin, { userId: user.id, phone, email });
        if (!introEligible) {
          const [coupons, repeat] = await Promise.all([
            loadAutoShopCoupons(admin, { userId: user.id, phone, email }),
            isRepeatCustomer(admin, user.id),
          ]);
          const best = [...coupons].sort((a, b) => couponWorth(b) - couponWorth(a))[0];
          welcomeBack = best
            ? couponHeadline(best)
            : repeat || settings.beanies_max_redeem_pct > 0
              ? `Use your Beanies for up to ${settings.beanies_max_redeem_pct}% off`
              : 'Free shipping on bigger orders';
        }
      }
    }
  } catch {
    // Not signed in, or the session can't be read: the page is the guest's.
    signedIn = false;
    introEligible = true;
    welcomeBack = null;
  }

  const deals = offer && introEligible ? offerDeals(offer.tier_prices, price) : [];
  const showIntro = deals.length > 0 && offer !== null;
  const shippingCopy = `${rupees(settings.shipping_fee_inr)} shipping, free on orders of ${rupees(settings.free_shipping_min_inr)}+`;
  const homeBlendPacks = [...homeBlend].sort((a, b) => a.pack_grams - b.pack_grams);
  const homeBlendDescription = homeBlend.find((p) => p.description)?.description ?? '';

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:py-14">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-tan-dark">Delivered to your door</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-charcoal md:text-4xl">Shop HIOC. coffee</h1>
        <p className="mt-3 max-w-xl text-muted">Instant coffee or our Signature Home Blend, delivered across India.</p>
      </header>

      <ProductLineCards
        instantCount={instant.length}
        homeBlendPacks={homeBlendPacks}
        price={price}
        intro={showIntro && offer ? { name: offer.name, deals: deals.slice(0, 2) } : null}
        welcomeBack={welcomeBack}
        shippingCopy={shippingCopy}
      />

      {products.length > 0 ? (
        <ShopExperience products={products} settings={settings} introEligible={introEligible} signedIn={signedIn} paymentReady={isGatewayConfigured()} />
      ) : (
        <p className="mt-10 rounded-md border border-line bg-surface p-6 text-center text-charcoal">
          Online orders open soon. Meanwhile, you can buy at the café.
        </p>
      )}

      <section aria-labelledby="facts-heading" className="mt-14 grid gap-8 border-t border-line pt-10 md:grid-cols-2">
        <div>
          <h2 id="facts-heading" className="text-lg font-bold text-charcoal">
            Product details
          </h2>
          <dl className="mt-3 space-y-2 text-sm">
            {[
              ...(instant.length > 0
                ? [
                    ['Instant Coffee', `${SHOP_PRODUCT_NAME} (freeze-dried, 100% Arabica)`],
                    ['Net quantity', `${PRODUCT_NET_QTY} per jar`],
                    ['MRP', `${rupees(price)} per jar (inclusive of all taxes)`],
                  ]
                : []),
              ...(homeBlendPacks.length > 0
                ? [
                    ['Home Blend', `${HOME_BLEND_NAME}${homeBlendDescription ? `. ${homeBlendDescription}` : ''}`],
                    ['Pack sizes', homeBlendPacks.map((p) => `${packLabel(p.pack_grams)} ${rupees(p.price_inr)}`).join(' · ') + ' (inclusive of all taxes)'],
                    ['Grind', 'Whole bean, or ground to order for Espresso, Moka pot, Pour-over / Filter or French press'],
                  ]
                : []),
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
            {showIntro && offer ? (
              <li>
                {offer.name}: {deals.map((d) => `${d.jars} jars for ${rupees(d.price)}`).join(', ')}, any mix of instant flavours, for your first
                online order. More jars are priced as groups of {offer.tier_prices.length} plus the rest.
              </li>
            ) : null}
            <li>Shipping is {shippingCopy.replace(' shipping,', ' an order,')}.</li>
            <li>
              We pack and hand your order to our courier within {DISPATCH_WITHIN}; delivery usually takes {DELIVERY_TAKES} after that, depending on your pincode.
              {homeBlendPacks.length > 0 ? ' Home Blend is ground to order.' : ''}
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
              The café counter runs its own offers for items bought there; the prices on this page are for online orders.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}
