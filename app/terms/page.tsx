import type { Metadata } from 'next';
import { PolicyLayout, PolicySection } from '@/components/legal/PolicyLayout';
import { BUSINESS } from '@/lib/legal';

export const metadata: Metadata = { title: 'Terms & Conditions' };

export default function TermsPage() {
  return (
    <PolicyLayout title="Terms & Conditions">
      <p>
        These Terms &amp; Conditions (&ldquo;Terms&rdquo;) govern your use of the {BUSINESS.name}{' '}
        website and order-ahead service, operated by {BUSINESS.legalName}. By placing an order or
        using this website, you agree to these Terms. Please read them carefully.
      </p>

      <PolicySection heading="1. About our service">
        <p>
          {BUSINESS.name} is a café offering an order-ahead service: you browse our menu, place an
          order online, and collect it at our counter at {BUSINESS.address}. Orders are prepared for
          pickup; we do not currently offer delivery.
        </p>
      </PolicySection>

      <PolicySection heading="2. Eligibility">
        <p>
          You must be capable of forming a legally binding contract under applicable Indian law to
          place an order. You are responsible for providing accurate contact details (name and
          mobile number) so we can update you about your order.
        </p>
      </PolicySection>

      <PolicySection heading="3. Orders, pricing & taxes">
        <p>
          All prices are listed in Indian Rupees (₹) and are inclusive or exclusive of applicable
          GST as indicated at checkout. We reserve the right to correct pricing errors and to update
          menu items and availability at any time. Your order total shown at checkout — item
          subtotal, taxes, packaging, any discounts, and the grand total — is the amount payable.
        </p>
      </PolicySection>

      <PolicySection heading="4. Order acceptance">
        <p>
          Placing an order is an offer to purchase. An order is confirmed only when our staff
          accept it, after which you will receive an estimated ready time. We may decline or cancel
          an order (for example, if an item is unavailable, we are at capacity, or we are closing),
          in which case any amount paid online is refunded per our{' '}
          <a href="/refund-cancellation" className="text-tan hover:underline">Refund &amp; Cancellation Policy</a>.
        </p>
      </PolicySection>

      <PolicySection heading="5. Payments">
        <p>
          You may pay online through our payment gateway partner (UPI, cards, wallets, and
          net-banking) or at our counter on pickup. Online payments are processed by a PCI-DSS
          compliant third-party gateway; {BUSINESS.name} does not store your card or UPI
          credentials. Failed or incomplete online payments will not place an order into our queue.
        </p>
      </PolicySection>

      <PolicySection heading="6. Pickup">
        <p>
          Please collect your order at the counter during our opening hours, showing the pickup code
          shown on your order status page. Orders not collected within a reasonable time may be
          discarded without refund, at our discretion.
        </p>
      </PolicySection>

      <PolicySection heading="7. Acceptable use">
        <p>
          You agree not to misuse the website, place fraudulent orders, or attempt to disrupt the
          service. We may suspend access for misuse.
        </p>
      </PolicySection>

      <PolicySection heading="8. Intellectual property">
        <p>
          The {BUSINESS.name} name, logo, menu content, and website design are our property and may
          not be copied or used without permission.
        </p>
      </PolicySection>

      <PolicySection heading="9. Limitation of liability">
        <p>
          To the extent permitted by law, {BUSINESS.name} is not liable for indirect or
          consequential losses arising from use of the service. Nothing in these Terms limits
          liability that cannot be excluded under applicable law, including in respect of food
          safety.
        </p>
      </PolicySection>

      <PolicySection heading="10. Governing law">
        <p>
          These Terms are governed by the laws of India, and any disputes are subject to the
          exclusive jurisdiction of the courts at {BUSINESS.jurisdiction}.
        </p>
      </PolicySection>

      <PolicySection heading="11. Changes to these Terms">
        <p>
          We may update these Terms from time to time. The current version is always available on
          this page with its &ldquo;Last updated&rdquo; date.
        </p>
      </PolicySection>
    </PolicyLayout>
  );
}
