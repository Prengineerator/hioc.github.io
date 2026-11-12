import type { Metadata } from 'next';
import { PolicyLayout, PolicySection } from '@/components/legal/PolicyLayout';
import { BUSINESS, SHOP_POLICY_UPDATED } from '@/lib/legal';
import { flags } from '@/lib/flags';
import { DELIVERY_TAKES, DISPATCH_WITHIN } from '@/lib/shop/catalog';
import { FREE_SHIPPING_MIN_JARS, rupees, SHIPPING_FEE_INR } from '@/lib/shop/pricing';

export const metadata: Metadata = { title: 'Shipping & Delivery Policy' };

// Café orders are collected at the counter. With the Instant Coffee shop
// switched on (NEXT_PUBLIC_FLAG_SHOP, docs/INSTANT-COFFEE-SHOP.md) packaged jars
// are also shipped by courier, and this page says how. While the shop is off it
// reads exactly as before: "we do not ship" stays true until the day it isn't.
export default function ShippingDeliveryPage() {
  const shop = flags.shop;
  // Café sections are numbered after the shop's when the shop section is shown.
  const n = (i: number) => (shop ? i + 1 : i);

  return (
    <PolicyLayout title="Shipping & Delivery Policy" updated={shop ? SHOP_POLICY_UPDATED : undefined}>
      {shop ? (
        <p>
          {BUSINESS.name} ships <strong>packaged Premium Instant Coffee</strong> across India, and
          runs an <strong>order-ahead, counter-pickup</strong> service for café food and drinks. This
          page explains how each is fulfilled.
        </p>
      ) : (
        <p>
          {BUSINESS.name} is an <strong>order-ahead, counter-pickup</strong> café service. This page
          explains how your order is fulfilled. (Payment gateways require a shipping/delivery policy;
          for {BUSINESS.name}, fulfilment means in-store pickup.)
        </p>
      )}

      {shop ? (
        <PolicySection heading="1. Instant Coffee jars — shipped to you" id="instant-coffee">
          <ul className="list-disc pl-5">
            <li>
              <strong>Where we ship:</strong> to serviceable pincodes across India, through courier
              partners booked via Shiprocket. If we cannot ship to your pincode, we will tell you and
              refund you in full.
            </li>
            <li>
              <strong>Shipping charges:</strong> {rupees(SHIPPING_FEE_INR)} per order for 1 or 2 jars;
              free for {FREE_SHIPPING_MIN_JARS} jars or more. The charge is shown before you pay.
            </li>
            <li>
              <strong>Dispatch:</strong> we pack your order and hand it to the courier within{' '}
              {DISPATCH_WITHIN} of payment.
            </li>
            <li>
              <strong>Delivery time:</strong> usually {DELIVERY_TAKES} after dispatch, depending on
              your pincode. Remote areas, public holidays and weather can add a few days.
            </li>
            <li>
              <strong>Tracking:</strong> once your parcel ships we email you the courier and the
              tracking number (AWB). Your order page shows the same.
            </li>
            <li>
              <strong>Payment:</strong> prepaid only (UPI, cards, netbanking). We do not offer cash
              on delivery.
            </li>
            <li>
              <strong>Delivery attempts:</strong> the courier may call the mobile number you gave.
              If the parcel cannot be delivered and comes back to us, we will contact you — see our
              Refund &amp; Cancellation Policy for what happens next, and for damaged parcels.
            </li>
          </ul>
        </PolicySection>
      ) : null}

      <PolicySection heading={`${n(1)}. ${shop ? 'Café orders: pickup, not shipping' : 'Pickup, not shipping'}`}>
        <p>
          {shop
            ? 'We do not ship café food and drinks by courier, and we do not offer home delivery of café orders. Every café order is prepared fresh and made available for '
            : 'We do not ship products by courier and we do not currently offer home delivery. Every order is prepared fresh and made available for '}
          <strong>pickup at our counter</strong>:
        </p>
        <p className="text-muted">{BUSINESS.address}</p>
      </PolicySection>

      <PolicySection heading={`${n(2)}. Preparation & ready time`}>
        <p>
          After staff accept your order, you will see an estimated ready time on your order status
          page and receive a notification when it is ready to collect. Preparation times vary with
          the items ordered and how busy the café is.
        </p>
      </PolicySection>

      <PolicySection heading={`${n(3)}. Collecting your order`}>
        <p>
          Please collect your order at the counter during our opening hours and show the pickup code
          displayed on your order status page. Orders left uncollected for an extended period may be
          discarded, as they are freshly prepared food.
        </p>
      </PolicySection>

      <PolicySection heading={`${n(4)}. Delivery (future)`}>
        <p>
          Home/local delivery {shop ? 'of café orders ' : ''}is not part of the current service. If
          we introduce delivery in future, this policy will be updated with delivery areas, charges,
          and timelines.
        </p>
      </PolicySection>

      <PolicySection heading={`${n(5)}. Questions`}>
        <p>
          For anything about your order{shop ? ', shipment' : ''} or pickup, contact us at{' '}
          <a href={BUSINESS.phoneHref} className="text-tan-dark hover:underline">{BUSINESS.phoneDisplay}</a>{' '}
          or <a href={BUSINESS.emailHref} className="text-tan-dark hover:underline">{BUSINESS.email}</a>.
        </p>
      </PolicySection>
    </PolicyLayout>
  );
}
