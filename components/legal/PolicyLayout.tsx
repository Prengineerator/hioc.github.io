import Link from 'next/link';
import { BUSINESS } from '@/lib/legal';

// Shared wrapper for the policy pages (Terms, Privacy, Refund, Shipping) — a
// consistent, readable container with the title, last-updated date, a small
// cross-nav between the policies, and the contact block every gateway expects.

const POLICIES = [
  { href: '/terms', label: 'Terms & Conditions' },
  { href: '/privacy', label: 'Privacy Policy' },
  { href: '/refund-cancellation', label: 'Refund & Cancellation' },
  { href: '/shipping-delivery', label: 'Shipping & Delivery' },
  { href: '/contact', label: 'Contact' },
];

export function PolicyLayout({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold text-charcoal">{title}</h1>
      <p className="mt-1 text-sm text-muted">Last updated: {BUSINESS.lastUpdated}</p>

      <nav className="mt-4 flex flex-wrap gap-x-4 gap-y-1 border-b border-[#e5e5e5] pb-4 text-xs">
        {POLICIES.map((p) => (
          <Link key={p.href} href={p.href} className="text-tan hover:underline">
            {p.label}
          </Link>
        ))}
      </nav>

      <article className="policy-prose mt-6 flex flex-col gap-4 text-sm leading-relaxed text-charcoal">
        {children}
      </article>

      <div className="mt-10 rounded-md border border-[#e5e5e5] bg-cream p-5 text-sm">
        <h2 className="font-bold text-charcoal">Contact us</h2>
        <p className="mt-2 text-muted">{BUSINESS.legalName} (operating {BUSINESS.name})</p>
        <p className="text-muted">{BUSINESS.address}</p>
        {BUSINESS.gstin ? <p className="text-muted">GSTIN: {BUSINESS.gstin}</p> : null}
        <p className="mt-1">
          <a href={BUSINESS.phoneHref} className="text-tan hover:underline">{BUSINESS.phoneDisplay}</a>
          {' · '}
          <a href={BUSINESS.emailHref} className="text-tan hover:underline">{BUSINESS.email}</a>
        </p>
      </div>
    </div>
  );
}

// A section heading used inside policy bodies.
export function PolicySection({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="mt-2 text-lg font-bold text-charcoal">{heading}</h2>
      {children}
    </section>
  );
}
