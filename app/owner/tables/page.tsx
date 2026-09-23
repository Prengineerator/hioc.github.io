// Owner-only Tables registry (FND3-1). The owner layout + middleware gate
// /owner/** to role 'owner'; the API this page calls re-checks getOwnerUser()
// on every request. Dine-in orders pin to these tables (POS/QR).

import { TableManager } from '@/components/owner/TableManager';

export const dynamic = 'force-dynamic';

export default function OwnerTablesPage() {
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Tables</h1>
        <p className="text-sm text-muted">
          Define your dine-in tables. Staff pin orders to them at the counter, and each carries a QR code
          for scan-to-order.
        </p>
      </div>
      <TableManager />
    </div>
  );
}
