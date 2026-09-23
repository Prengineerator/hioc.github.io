import { flags } from '@/lib/flags';
import { resolveTableByToken } from '@/lib/tables/resolveTableByToken';
import { TableQrOrder } from '@/components/qr/TableQrOrder';
import { TableQrUnavailable } from '@/components/qr/TableQrUnavailable';

// The token maps to live table state (active/inactive, regenerated), so this
// must never be statically cached.
export const dynamic = 'force-dynamic';

// QR-1 scan-to-order. A seated diner scanning the table QR lands here; the token
// is resolved to its active table SERVER-SIDE (the qr_token never reaches the
// client), then the normal customer menu opens in dine-in context. Flag-gated
// (NEXT_PUBLIC_FLAG_TABLE_QR) and dark by default — an off flag or an
// invalid/inactive/regenerated token both render the same friendly "ask staff"
// screen, never a broken cart.
export default async function TableQrPage({
  params,
}: {
  params: { token: string };
}) {
  if (!flags.tableQr) {
    return <TableQrUnavailable />;
  }

  const table = await resolveTableByToken(params.token);
  if (!table) {
    return <TableQrUnavailable />;
  }

  // Only the customer's own URL token + the id/label the client needs to submit
  // are passed down — nothing else about the table registry leaks.
  return <TableQrOrder token={params.token} table={table} />;
}
