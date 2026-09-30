import type { Metadata } from 'next';
import { PolicyLayout, PolicySection } from '@/components/legal/PolicyLayout';
import { BUSINESS, RITUAL_POLICY_UPDATED } from '@/lib/legal';
import { flags } from '@/lib/flags';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';

export const metadata: Metadata = { title: 'Refund & Cancellation Policy' };

export default function RefundPage() {
  return (
    <PolicyLayout
      title="Refund & Cancellation Policy"
      updated={flags.coffeePass ? RITUAL_POLICY_UPDATED : undefined}
    >
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
            counter at <a href={BUSINESS.phoneHref} className="text-tan-dark hover:underline">{BUSINESS.phoneDisplay}</a>;
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
          <a href={BUSINESS.phoneHref} className="text-tan-dark hover:underline">{BUSINESS.phoneDisplay}</a>{' '}
          or <a href={BUSINESS.emailHref} className="text-tan-dark hover:underline">{BUSINESS.email}</a>.
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
          <a href={BUSINESS.emailHref} className="text-tan-dark hover:underline">{BUSINESS.email}</a> or{' '}
          <a href={BUSINESS.phoneHref} className="text-tan-dark hover:underline">{BUSINESS.phoneDisplay}</a>.
          We aim to respond within 2 business days.
        </p>
      </PolicySection>

      {/* HIOC Ritual (docs/COFFEE-PASS-SPEC.md CP-D2, CP-D5, CP-D14, CP-D15,
          CP-D18, CP-D19): shown only while the feature is on, like every other
          customer-facing piece of it. */}
      {flags.coffeePass ? (
        <PolicySection heading={`7. ${PASS_PROGRAM_NAME} (prepaid coffee plans)`} id="hioc-ritual">
          <p>
            {PASS_PROGRAM_NAME} is a prepaid plan of coffee cups, bought online or at the counter.
            These rules apply to it in addition to the sections above.
          </p>
          <ul className="list-disc pl-5">
            <li>
              <strong>Buying:</strong> a {PASS_PROGRAM_NAME} belongs to the account of the mobile
              number it was bought with, and is ready as soon as payment is confirmed. The plan,
              its number of cups, its validity and its price are shown before you pay.
            </li>
            <li>
              <strong>Validity:</strong> counted in calendar days in Indian Standard Time, starting
              on the day you buy it. A 7-day plan bought on a Monday can be used through Sunday
              night, and ends at midnight after that.
            </li>
            <li>
              <strong>Cup value and top-ups:</strong> each cup pays for one drink, up to the cup
              value shown on the plan (the size and any add-ons count towards it). Only drinks
              marked as covered can be paid with a cup. If a drink costs more than the cup value,
              you pay the difference.
            </li>
            <li>
              <strong>Sharing:</strong> the account holder&apos;s cups can be used for anyone in the
              holder&apos;s own order. At the counter, give the mobile number on your account so we
              can find your {PASS_PROGRAM_NAME}.
            </li>
            <li>
              <strong>Refunds:</strong> a {PASS_PROGRAM_NAME} can be refunded only if none of its
              cups has been used: at the counter, or to the original payment method for an online
              purchase. Once a cup has been used it cannot be refunded, and a refund cancels the
              whole {PASS_PROGRAM_NAME}.
            </li>
            <li>
              <strong>Expired cups:</strong> cups that are not used before the plan ends are not
              refunded and are not carried over to another plan.
            </li>
            <li>
              <strong>Cancelled orders:</strong> if an order paid with cups is cancelled, rejected
              or fully refunded, the cups go back to your {PASS_PROGRAM_NAME}, for the rest of its
              validity.
            </li>
            <li>
              <strong>Changes:</strong> we may change the price, the number of cups, the validity
              or the drinks covered, or stop selling a plan, for future purchases only. A{' '}
              {PASS_PROGRAM_NAME} you have already bought keeps the terms it was bought on.
            </li>
          </ul>
        </PolicySection>
      ) : null}
    </PolicyLayout>
  );
}
