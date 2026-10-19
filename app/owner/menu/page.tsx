// Owner → Menu. The owner layout + middleware gate /owner/** to role 'owner';
// every API the client screen calls (/api/owner/menu*, /api/owner/menu-requests*)
// re-checks getOwnerUser() on each request. The page is a thin server shell: it
// gives the client screen the <Suspense> boundary Next requires around
// useSearchParams (the Items / Approvals tabs live in `?tab=`).

import { Suspense } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { OwnerMenuScreen } from '@/components/owner/menu/OwnerMenuScreen';

export const dynamic = 'force-dynamic';

export default function OwnerMenuPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Menu</h1>
        <p className="text-sm text-muted">
          Edit the menu directly, and approve or reject the changes staff and managers ask for on the POS.
        </p>
      </div>
      <Suspense fallback={<Spinner label="Loading menu…" />}>
        <OwnerMenuScreen />
      </Suspense>
    </div>
  );
}
