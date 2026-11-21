// /account/ritual — HIOC Ritual inside the account shell (ACC nav stays visible).
// The one real Ritual page for signed-in customers: /ritual redirects here. The
// /account layout guards the session (and 404s signed-out visitors while the
// flag is off); the flag guard is repeated here for signed-in ones.

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getAuthUser } from '@/lib/api/auth';
import { flags } from '@/lib/flags';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { RitualPage } from '@/components/passes/RitualPage';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: `${PASS_PROGRAM_NAME} — prepaid coffee`,
  description: 'Prepay your coffee and save with a weekly or monthly Ritual at HIOC, Kamla Nagar, Agra.',
};

export default async function AccountRitualPage() {
  if (!flags.coffeePass) notFound();
  // The layout already gates the session; read it here too (request-cached, so
  // no extra round trip) rather than assume it.
  const user = await getAuthUser();
  return <RitualPage signedIn={user !== null} />;
}
