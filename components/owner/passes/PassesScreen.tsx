'use client';

// Owner → HIOC Ritual (docs/COFFEE-PASS-SPEC.md §8 "Owner", ticket CP-9): the
// prepaid coffee plans, from what the cafe sells to what it still owes.
//
//   setup checklist   what is left before customers can rely on it (§9 B)
//   summary           sold / refunded / served / lapsed, and the liability
//   plans             the table, and the edit / new dialog
//   eligible drinks   which menu items a cup can pay for
//
// This component loads the plans and the menu once (GET /api/owner/passes) and holds
// them, so the checklist, the plans and the picker stay in step as the owner saves. The
// summary loads on its own (SummarySection), so one failing never blanks the other.
// The page itself (app/owner/passes/page.tsx) is a server component that returns 404
// while the flag is off; the API routes 404 too.

import { useCallback, useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/Skeleton';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { sortPlans, type PickerItem } from '@/lib/passes/ownerUi';
import type { CoffeePassPlan } from '@/lib/passes/types';
import { callOwnerApi } from './api';
import { EligibleDrinks } from './EligibleDrinks';
import { PlansSection } from './PlansSection';
import { SetupChecklist } from './SetupChecklist';
import { InlineError } from './shared';
import { SummarySection } from './SummarySection';

interface OwnerPassesPayload {
  plans: CoffeePassPlan[];
  eligible_ids: string[];
  menu: PickerItem[];
}

export function PassesScreen() {
  const [data, setData] = useState<OwnerPassesPayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const res = await callOwnerApi<OwnerPassesPayload>('/api/owner/passes');
    if (res.ok) setData(res.data);
    else setError(res.error);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // A saved plan replaces its old self, or joins the list; the order is the server's.
  const planSaved = (plan: CoffeePassPlan) =>
    setData((d) => (d ? { ...d, plans: sortPlans([...d.plans.filter((p) => p.id !== plan.id), plan]) } : d));

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">{PASS_PROGRAM_NAME}</h1>
        <p className="text-sm text-muted">
          Prepaid coffee plans: what you sell, what customers still owe in cups, and which drinks a cup can pay for.
        </p>
      </div>

      {data ? <SetupChecklist plans={data.plans} eligibleCount={data.eligible_ids.length} /> : null}

      <SummarySection />

      {error ? (
        <InlineError message={error} onRetry={() => void load()} />
      ) : !data ? (
        <div aria-busy={loading} aria-label="Loading plans and drinks" className="flex flex-col gap-5">
          <Skeleton className="h-48" />
          <Skeleton className="h-72" />
        </div>
      ) : (
        <>
          <PlansSection plans={data.plans} onPlanSaved={planSaved} />
          <EligibleDrinks
            menu={data.menu}
            eligibleIds={data.eligible_ids}
            plans={data.plans}
            onSaved={(ids) => setData((d) => (d ? { ...d, eligible_ids: ids } : d))}
          />
        </>
      )}
    </div>
  );
}
