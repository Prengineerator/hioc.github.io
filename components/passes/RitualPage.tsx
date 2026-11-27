import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { HowItWorks } from '@/components/passes/HowItWorks';
import { RitualExperience } from '@/components/passes/RitualExperience';
import { RitualTerms } from '@/components/passes/RitualTerms';

// The HIOC Ritual page body (docs/COFFEE-PASS-SPEC.md §8), shared by the public
// /ritual page (signed out) and /account/ritual (inside the account shell).
// Each page keeps its own wrapper, metadata and flag guard. Server component:
// the hero and static copy render here; the plans, the purchase and the
// customer's passes are the client parts in RitualExperience.
export function RitualPage({ signedIn }: { signedIn: boolean }) {
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

      <RitualExperience signedIn={signedIn} />
      <HowItWorks />
      <RitualTerms />
    </>
  );
}
