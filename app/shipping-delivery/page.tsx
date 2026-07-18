import type { Metadata } from 'next';
import { PolicyLayout, PolicySection } from '@/components/legal/PolicyLayout';
import { BUSINESS } from '@/lib/legal';

export const metadata: Metadata = { title: 'Shipping & Delivery Policy' };

export default function ShippingDeliveryPage() {
  return (
    <PolicyLayout title="Shipping & Delivery Policy">
      <p>
        {BUSINESS.name} is an <strong>order-ahead, counter-pickup</strong> café service. This page
        explains how your order is fulfilled. (Payment gateways require a shipping/delivery policy;
        for {BUSINESS.name}, fulfilment means in-store pickup.)
      </p>

      <PolicySection heading="1. Pickup, not shipping">
        <p>
          We do not ship products by courier and we do not currently offer home delivery. Every
          order is prepared fresh and made available for <strong>pickup at our counter</strong>:
        </p>
        <p className="text-muted">{BUSINESS.address}</p>
      </PolicySection>

      <PolicySection heading="2. Preparation & ready time">
        <p>
          After staff accept your order, you will see an estimated ready time on your order status
          page and receive a notification when it is ready to collect. Preparation times vary with
          the items ordered and how busy the café is.
        </p>
      </PolicySection>

      <PolicySection heading="3. Collecting your order">
        <p>
          Please collect your order at the counter during our opening hours and show the pickup code
          displayed on your order status page. Orders left uncollected for an extended period may be
          discarded, as they are freshly prepared food.
        </p>
      </PolicySection>

      <PolicySection heading="4. Delivery (future)">
        <p>
          Home/local delivery is not part of the current service. If we introduce delivery in
          future, this policy will be updated with delivery areas, charges, and timelines.
        </p>
      </PolicySection>

      <PolicySection heading="5. Questions">
        <p>
          For anything about your order or pickup, contact us at{' '}
          <a href={BUSINESS.phoneHref} className="text-tan hover:underline">{BUSINESS.phoneDisplay}</a>{' '}
          or <a href={BUSINESS.emailHref} className="text-tan hover:underline">{BUSINESS.email}</a>.
        </p>
      </PolicySection>
    </PolicyLayout>
  );
}
