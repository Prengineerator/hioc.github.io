import type { Metadata } from 'next';
import { PolicyLayout, PolicySection } from '@/components/legal/PolicyLayout';
import { BUSINESS } from '@/lib/legal';

export const metadata: Metadata = { title: 'Privacy Policy' };

export default function PrivacyPage() {
  return (
    <PolicyLayout title="Privacy Policy">
      <p>
        This Privacy Policy explains how {BUSINESS.legalName} (&ldquo;{BUSINESS.name}&rdquo;,
        &ldquo;we&rdquo;) collects, uses, and protects your personal data when you use our website
        and order-ahead service, in line with India&apos;s Digital Personal Data Protection Act,
        2023 (DPDP).
      </p>

      <PolicySection heading="1. Information we collect">
        <ul className="list-disc pl-5">
          <li><strong>Contact details</strong> you provide at checkout or sign-up: name, mobile number, and (if you create an account) email.</li>
          <li><strong>Order information</strong>: items ordered, pickup time, order notes, and order history.</li>
          <li><strong>Payment references</strong>: transaction identifiers from our payment gateway. We do <em>not</em> collect or store your card number, CVV, or UPI PIN.</li>
          <li><strong>Usage data</strong>: basic, privacy-friendly analytics about how the site is used.</li>
        </ul>
      </PolicySection>

      <PolicySection heading="2. How we use your data">
        <ul className="list-disc pl-5">
          <li>To take, prepare, and fulfil your orders.</li>
          <li>To send you <strong>transactional</strong> updates about your order (accepted, ready, cancelled) via SMS/WhatsApp — these are essential to the service.</li>
          <li>To operate accounts, order history, loyalty points, and reviews.</li>
          <li>To send <strong>marketing</strong> messages only if you have given consent, which you can withdraw at any time.</li>
          <li>To comply with legal and tax obligations.</li>
        </ul>
      </PolicySection>

      <PolicySection heading="3. Payment data & PCI">
        <p>
          Online payments are processed by a third-party, PCI-DSS compliant payment gateway. Your
          card/UPI details are entered directly with the gateway and are never stored on our
          servers. We only retain gateway references needed to reconcile and, if required, refund
          your payment.
        </p>
      </PolicySection>

      <PolicySection heading="4. Sharing your data">
        <p>We share data only as needed to run the service:</p>
        <ul className="list-disc pl-5">
          <li>Our <strong>payment gateway</strong> to process payments and refunds.</li>
          <li>Our <strong>SMS/WhatsApp provider</strong> to deliver order notifications.</li>
          <li>Where required by law or to protect our rights.</li>
        </ul>
        <p>We do not sell your personal data.</p>
      </PolicySection>

      <PolicySection heading="5. Data retention">
        <p>
          We keep order and account data for as long as needed to provide the service and to meet
          legal, accounting, and tax requirements, after which it is deleted or anonymised.
        </p>
      </PolicySection>

      <PolicySection heading="6. Your rights (DPDP)">
        <p>
          You may request access to, correction of, or deletion of your personal data, and withdraw
          marketing consent at any time. To exercise these rights or raise a grievance, contact us
          at <a href={BUSINESS.emailHref} className="text-tan hover:underline">{BUSINESS.email}</a>.
        </p>
      </PolicySection>

      <PolicySection heading="7. Security">
        <p>
          We use reasonable technical and organisational measures to protect your data, including
          encrypted connections and access controls. No method of transmission is fully secure, but
          we work to safeguard your information.
        </p>
      </PolicySection>

      <PolicySection heading="8. Contact / grievance officer">
        <p>
          For any privacy question or grievance, contact {BUSINESS.name} at{' '}
          <a href={BUSINESS.emailHref} className="text-tan hover:underline">{BUSINESS.email}</a> or{' '}
          <a href={BUSINESS.phoneHref} className="text-tan hover:underline">{BUSINESS.phoneDisplay}</a>.
        </p>
      </PolicySection>
    </PolicyLayout>
  );
}
