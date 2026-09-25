import { StoreControls } from '@/components/staff/StoreControls';

// SET-1 — Store controls, moved out of the `#store` section on the Menu page
// (app/staff/menu/page.tsx used to render this inline) and into its own
// settings section. StoreControls itself is unchanged — same
// GET/PATCH /api/store-settings calls, same 'hioc:store-changed' event the
// header badge listens for.
export default function StaffSettingsStorePage() {
  return (
    <div>
      <h1 className="sr-only">Store</h1>
      <StoreControls />
    </div>
  );
}
