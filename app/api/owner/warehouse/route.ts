import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { loadWarehouse, requireWarehouseOwner } from '@/lib/inventory/warehouseServer';

export const dynamic = 'force-dynamic';

// GET /api/owner/warehouse — owner only (docs/WAREHOUSE-SPEC.md). Everything the
// Warehouse page shows: the stock sheet (warehouse and store side by side, with
// what is in transit and what is still to dispatch), every warehouse transfer
// that is open or waiting to be settled plus the recent closed ones, who can
// deliver, and what is waiting on the owner. 404 while the warehouse is off.
// getOwnerUser() ONLY (rule D6-6): never a counter PIN.
export async function GET() {
  const gate = await requireWarehouseOwner();
  if ('response' in gate) return gate.response;
  const result = await loadWarehouse(createAdminSupabaseClient(), gate.owner.id);
  if ('error' in result) return errorResponse(500, result.error);
  return NextResponse.json(result.payload);
}
