import { notFound } from 'next/navigation';
import { flags } from '@/lib/flags';
import { PassesScreen } from '@/components/owner/passes/PassesScreen';

// Owner → HIOC Ritual (docs/COFFEE-PASS-SPEC.md §8, ticket CP-9): the prepaid coffee
// plans, their numbers, and the drinks a cup can pay for. /owner/** is already gated
// to the owner by middleware and the owner layout; every /api/owner/passes route
// checks the owner again, and answers 404 while the flag is off. So does this page:
// with NEXT_PUBLIC_FLAG_COFFEE_PASS off there is no trace of the feature here (the
// nav link is hidden too, in OwnerHeader).
export const dynamic = 'force-dynamic';

export default function OwnerPassesPage() {
  if (!flags.coffeePass) notFound();
  return <PassesScreen />;
}
