import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { getAuthUser } from '@/lib/api/auth';
import { flags } from '@/lib/flags';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { RitualPage } from '@/components/passes/RitualPage';

// HIOC Ritual — prepaid coffee plans (docs/COFFEE-PASS-SPEC.md §8). The public,
// signed-out version of the page: the flag guard, then the shared body
// (components/passes/RitualPage). A signed-in customer is sent to
// /account/ritual so they land inside the account shell, whichever link they
// followed.
//
// Dynamic because it depends on the session and on the flag; while the flag is
// off (the default) the page does not exist.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  // The root layout's template turns this into "HIOC Ritual — prepaid coffee | HIOC."
  title: `${PASS_PROGRAM_NAME} — prepaid coffee`,
  description: 'Prepay your coffee and save with a weekly or monthly Ritual at HIOC, Kamla Nagar, Agra.',
};

export default async function RitualRoute() {
  if (!flags.coffeePass) notFound();
  const user = await getAuthUser();
  if (user) redirect('/account/ritual');

  return (
    <div className="mx-auto max-w-3xl px-4 py-10 md:py-14">
      <RitualPage signedIn={false} />
    </div>
  );
}
