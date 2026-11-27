// Owner → Warehouse (docs/WAREHOUSE-SPEC.md). The owner layout + middleware gate
// /owner/** to role 'owner'; every API the screen calls (/api/owner/warehouse*)
// re-checks getOwnerUser() on each request. A thin server shell: the client
// screen keeps its tab in `?tab=`, which needs a <Suspense> boundary.

import { Suspense } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { flags } from '@/lib/flags';
import { WarehouseScreen } from '@/components/owner/warehouse/WarehouseScreen';

export const dynamic = 'force-dynamic';

export default function OwnerWarehousePage() {
  if (!flags.inventory || !flags.warehouse) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">The warehouse is not switched on</h1>
        <p className="mt-3 text-muted">
          Apply supabase/2026-11-warehouse.sql, then set NEXT_PUBLIC_FLAG_WAREHOUSE=true (with NEXT_PUBLIC_FLAG_INVENTORY) and
          redeploy. See docs/WAREHOUSE-SPEC.md.
        </p>
      </div>
    );
  }
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Warehouse</h1>
        <p className="text-sm text-muted">
          Your warehouse stock, the store’s requests, who is delivering what, and anything that arrived different from what
          was sent.
        </p>
      </div>
      <Suspense fallback={<Spinner label="Loading the warehouse…" />}>
        <WarehouseScreen />
      </Suspense>
    </div>
  );
}
