import { SurfaceLink } from '@/components/SurfaceLink';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';

// The short version, in plain words. The full wording is on the Refund &
// Cancellation page (app/refund-cancellation), and the two say the same things
// (CP-D15, CP-D18, CP-D19, CP-D22, CP-D23).
const TERMS = [
  "You choose your drink and size when you buy. The price is the cups you pay for × that size's menu price, with GST where it applies. A later change to the menu price doesn't change a Ritual you have already bought.",
  `Once a cup is used it can't be refunded. A ${PASS_PROGRAM_NAME} with no cups used can be refunded, at the counter or to your original payment method.`,
  "Cups that expire aren't refunded or carried over.",
  'Cups can be shared: use them for anyone in your order.',
  "Each cup covers a drink up to your drink's price. For pricier drinks, or add-ons that take it over, you just pay the difference.",
  'At the counter, give the phone number on your account so we can find your Ritual.',
] as const;

/** The terms on /ritual. Static, so it renders on the server. */
export function RitualTerms() {
  return (
    <section aria-labelledby="ritual-terms" className="mt-10">
      <h2 id="ritual-terms" className="text-xl font-bold text-charcoal">
        Terms
      </h2>
      <ul className="mt-4 flex flex-col gap-2 text-sm text-charcoal">
        {TERMS.map((line) => (
          <li key={line} className="flex gap-2">
            <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-tan" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-muted">
        The full wording is in our{' '}
        <SurfaceLink href="/refund-cancellation#hioc-ritual" className="font-semibold text-tan-dark hover:underline">
          Refund &amp; Cancellation Policy
        </SurfaceLink>
        .
      </p>
    </section>
  );
}
