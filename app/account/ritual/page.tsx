// /account/ritual — HIOC Ritual inside the account shell (ACC nav stays visible).
// The /account layout already guards the session; this page just mirrors
// the standalone /ritual page, with the flag guard still in place.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getAuthUser } from '@/lib/api/auth';
import { flags } from '@/lib/flags';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { HowItWorks } from '@/components/passes/HowItWorks';
import { RitualExperience } from '@/components/passes/RitualExperience';
import { RitualTerms } from '@/components/passes/RitualTerms';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${PASS_PROGRAM_NAME} — prepaid coffee`,
  description: 'Prepay your coffee and save with a weekly or monthly Ritual at HIOC, Kamla Nagar, Agra.',
};

export default async function AccountRitualPage() {
  if (!flags.coffeePass) notFound();
  const user = await getAuthUser();

  return (
    <>
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
    </>
  );
}
