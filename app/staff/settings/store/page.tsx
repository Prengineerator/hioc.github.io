import { StoreControls } from '@/components/staff/StoreControls';
import { getCounterActor } from '@/lib/api/auth';

// SET-1 — Store controls, moved out of the `#store` section on the Menu page
// (app/staff/menu/page.tsx used to render this inline) and into its own
// settings section. StoreControls itself is unchanged — same
// GET/PATCH /api/store-settings calls, same 'hioc:store-changed' event the
// header badge listens for.
export default async function StaffSettingsStorePage() {
  // Whether the staff website may take orders is a manager/owner switch (the
  // PATCH route enforces it; this only decides whether to offer the toggle).
  const actor = await getCounterActor();
  const canManageOrdering = actor?.role === 'manager' || actor?.role === 'owner';
  return (
    <div>
      <h1 className="sr-only">Store</h1>
      <StoreControls canManageOrdering={canManageOrdering} />
    </div>
  );
}
