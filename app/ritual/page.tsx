import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getAuthUser } from '@/lib/api/auth';
import { flags } from '@/lib/flags';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { HowItWorks } from '@/components/passes/HowItWorks';
import { RitualExperience } from '@/components/passes/RitualExperience';
import { RitualTerms } from '@/components/passes/RitualTerms';

// HIOC Ritual — prepaid coffee plans (docs/COFFEE-PASS-SPEC.md §8). A server
// shell: the flag guard, the session (so the page knows whether to offer Buy or
// Log in, and whether to read "Your Ritual"), the static copy (hero, how it
// works, terms). The plans, the purchase and the customer's passes are client
// parts (components/passes/RitualExperience), read from /api/passes/*.
//
// Dynamic because it depends on the session and on the flag; while the flag is
// off (the default) the page does not exist.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  // The root layout's template turns this into "HIOC Ritual — prepaid coffee | HIOC."
  title: `${PASS_PROGRAM_NAME} — prepaid coffee`,
  description: 'Prepay your coffee and save with a weekly or monthly Ritual at HIOC, Kamla Nagar, Agra.',
};

export default async function RitualPage() {
  if (!flags.coffeePass) notFound();
  const user = await getAuthUser();

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 md:py-14">
      <header>
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-tan-dark">Prepaid coffee plans</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-charcoal md:text-4xl">{PASS_PROGRAM_NAME}</h1>
        <p className="mt-3 max-w-xl text-muted">
          Your daily cup, sorted. Prepay your coffee and save — then just order as usual and we&apos;ll
          count the cups for you.
        </p>
      </header>

      <RitualExperience signedIn={user !== null} />
      <HowItWorks />
      <RitualTerms />
    </div>
  );
}
