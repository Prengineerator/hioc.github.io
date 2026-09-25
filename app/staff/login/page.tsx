import { redirect } from 'next/navigation';
import { getEnrolledDevice } from '@/lib/api/device';
import { operatorFeatureConfigured } from '@/lib/api/operator';
import { flags } from '@/lib/flags';
import { shouldRedirectClassicLogin } from '@/lib/staff/pinUi';
import { StaffLoginForm } from '@/components/staff/StaffLoginForm';

export const dynamic = 'force-dynamic';

// PIN-2 — the owner's report: staff kept landing on this classic form
// instead of the PIN lock screen on an enrolled counter. A Server Component
// so it can check, before ever rendering the form, whether this request is
// coming from a PIN-capable counter — the same `getEnrolledDevice()` +
// flags.pinSwitch + operatorFeatureConfigured() facts app/staff/layout.tsx
// itself uses to decide whether to show the lock screen. See
// shouldRedirectClassicLogin()'s own comment for why this can never loop
// with that layout redirect.
//
// `?classic=1` (LockScreen's "Sign in the classic way" link) opts out, for
// the person who genuinely isn't the operator standing at this counter —
// e.g. the owner checking something from the till.
export default async function StaffLoginPage({
  searchParams,
}: {
  searchParams: { classic?: string | string[] };
}) {
  const pinEligible = flags.pinSwitch && operatorFeatureConfigured();
  const device = pinEligible ? await getEnrolledDevice() : null;

  if (
    shouldRedirectClassicLogin({
      pinEligible,
      deviceEnrolled: Boolean(device),
      classicParam: searchParams.classic,
    })
  ) {
    redirect('/staff');
  }

  return <StaffLoginForm />;
}
