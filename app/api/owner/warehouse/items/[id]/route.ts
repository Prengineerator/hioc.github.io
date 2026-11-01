import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { inventoryWriteFailure } from '@/lib/inventory/api';
import { parseQty } from '@/lib/inventory/rules';
import { requireWarehouseOwner } from '@/lib/inventory/warehouseServer';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/owner/warehouse/items/[id] — owner only. The item's warehouse low
// level: { parLevel } (0 = never low). The item itself (name, unit, perishable,
// the store's own low level) is edited on the Stock screen, as before.
export async function PATCH(request: Request, { params }: RouteParams) {
  const gate = await requireWarehouseOwner();
  if ('response' in gate) return gate.response;
  if (!isUuid(params.id)) return notFound();
  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parLevel = parseQty(body.parLevel, { allowZero: true });
  if (parLevel === null) return errorResponse(400, 'The low level must be 0 or more.');

  const admin = createAdminSupabaseClient();
  const { data: item, error: itemError } = await admin.from('inventory_items').select('id').eq('id', params.id).maybeSingle();
  if (itemError) return inventoryWriteFailure(itemError, 'Loading the item');
  if (!item) return notFound();

  const { error } = await admin
    .from('warehouse_items')
    .upsert(
      { item_id: params.id, par_level: parLevel, updated_by: gate.owner.id, updated_at: new Date().toISOString() },
      { onConflict: 'item_id' },
    );
  if (error) return inventoryWriteFailure(error, 'Saving the low level');
  return NextResponse.json({ ok: true, parLevel });
}
