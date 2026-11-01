import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { countOwnerWaiting, requireWarehouseOwner } from '@/lib/inventory/warehouseServer';

export const dynamic = 'force-dynamic';

// GET /api/owner/warehouse/waiting — owner only. What is waiting on the owner
// (requests to assign or dispatch, returns to count in, differences to settle),
// as counts: the owner header's Warehouse badge.
export async function GET() {
  const gate = await requireWarehouseOwner();
  if ('response' in gate) return gate.response;
  return NextResponse.json({ waiting: await countOwnerWaiting(createAdminSupabaseClient()) });
}
