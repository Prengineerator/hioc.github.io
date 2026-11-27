import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { toCsv } from '@/lib/reports/csv';
import { warehouseSheetTable } from '@/lib/inventory/warehouse';
import { loadWarehouse, requireWarehouseOwner } from '@/lib/inventory/warehouseServer';

export const dynamic = 'force-dynamic';

// GET /api/owner/warehouse/sheet — owner only. The warehouse stock sheet as a
// CSV for Excel: every item with what the warehouse holds, its low level and
// expiry, what is on the road each way, what the store holds, and what the
// store has asked for that isn't dispatched yet.
export async function GET() {
  const gate = await requireWarehouseOwner();
  if ('response' in gate) return gate.response;
  const result = await loadWarehouse(createAdminSupabaseClient(), gate.owner.id);
  if ('error' in result) return errorResponse(500, result.error);
  const csv = toCsv(warehouseSheetTable(result.payload.items));
  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="hioc-warehouse-sheet-${result.payload.today}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
