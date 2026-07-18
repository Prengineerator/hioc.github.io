import type { Metadata } from 'next';
import { PolicyLayout, PolicySection } from '@/components/legal/PolicyLayout';
import { BUSINESS } from '@/lib/legal';

export const metadata: Metadata = { title: 'Refund & Cancellation Policy' };

export default function RefundPage() {
  return (
    <PolicyLayout title="Refund & Cancellation Policy">
      <p>
        This policy explains when and how orders placed with {BUSINESS.name} can be cancelled and
        how refunds are handled. Because we prepare fresh food to order, timing matters — please
        read the cancellation windows below.
      </p>

      <PolicySection heading="1. Cancellation by you">
        <ul className="list-disc pl-5">
          <li>
            <strong>Before the order is accepted:</strong> you can cancel free of charge directly
            from your order status page. If you paid online, you receive a <strong>full refund</strong>.
          </li>
          <li>
            <strong>After the order is accepted / preparation has begun:</strong> the order cannot
            be cancelled from the app, as we may have already started making it. Please contact the
            counter at <a href={BUSINESS.phoneHref} className="text-tan hover:underline">{BUSINESS.phoneDisplay}</a>;
            any refund in this case is at our discretion based on how far preparation has progressed.
          </li>
        </ul>
      </PolicySection>

      <PolicySection heading="2. Cancellation / rejection by us">
        <p>
          If we cannot fulfil your order (for example, an item is out of stock, we are at capacity,
          or we are closing), we will cancel or reject it and notify you with the reason. If you paid
          online, you receive a <strong>full refund</strong> to your original payment method.
        </p>
      </PolicySection>

      <PolicySection heading="3. Refunds">
        <ul className="list-disc pl-5">
          <li>
            Refunds are issued to the <strong>original payment method</strong> via our payment
            gateway. Orders paid at the counter are refunded in cash at the counter where applicable.
          </li>
          <li>
            Once approved, online refunds are typically processed within{' '}
            <strong>5–7 business days</strong>, subject to your bank/UPI provider&apos;s timelines.
          </li>
          <li>
            <strong>Partial refunds</strong> may apply where only part of an order could not be
            fulfilled or was already partly prepared; the refundable amount is determined by our
            manager and communicated to you.
          </li>
        </ul>
      </PolicySection>

      <PolicySection heading="4. Quality issues">
        <p>
          If something is wrong with your order, please tell us at the counter at pickup or contact
          us the same day at{' '}
          <a href={BUSINESS.phoneHref} className="text-tan hover:underline">{BUSINESS.phoneDisplay}</a>{' '}
          or <a href={BUSINESS.emailHref} className="text-tan hover:underline">{BUSINESS.email}</a>.
          We will replace the item or issue a refund where appropriate.
        </p>
      </PolicySection>

      <PolicySection heading="5. Non-refundable situations">
        <ul className="list-disc pl-5">
          <li>Orders collected and consumed without a reported issue.</li>
          <li>No-shows where the order was prepared and held for pickup.</li>
          <li>Change of mind after preparation has begun.</li>
        </ul>
      </PolicySection>

      <PolicySection heading="6. How to request a refund">
        <p>
          Contact us with your order number (shown on your confirmation, e.g. HIOC-00XXXX) at{' '}
          <a href={BUSINESS.emailHref} className="text-tan hover:underline">{BUSINESS.email}</a> or{' '}
          <a href={BUSINESS.phoneHref} className="text-tan hover:underline">{BUSINESS.phoneDisplay}</a>.
          We aim to respond within 2 business days.
        </p>
      </PolicySection>
    </PolicyLayout>
  );
}
