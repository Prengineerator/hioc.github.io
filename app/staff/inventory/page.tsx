import Link from 'next/link';
import { flags } from '@/lib/flags';
import { InventoryWorkspace } from '@/components/staff/inventory/InventoryWorkspace';

export const dynamic = 'force-dynamic';

// Stock (docs/INVENTORY-SPEC.md). The /staff/** layout already gates this
// route behind getCounterActor(); every action is re-checked by
// /api/inventory/**. Dark-launched behind NEXT_PUBLIC_FLAG_INVENTORY
// (default OFF): when off it renders a clear "not enabled" state, like the
// Cash page does for its flag.
export default function InventoryPage() {
  if (!flags.inventory) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-center">
        <h1 className="text-2xl font-bold text-charcoal">Stock is not enabled</h1>
        <p className="mt-3 text-muted">Inventory is turned off for this environment.</p>
        <Link
          href="/staff"
          className="mt-6 inline-flex rounded-md bg-tan px-5 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
        >
          Back to Orders
        </Link>
      </div>
    );
  }
  return <InventoryWorkspace />;
}
