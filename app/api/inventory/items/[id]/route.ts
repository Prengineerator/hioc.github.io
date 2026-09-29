import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { requireInventoryActor, inventoryWriteFailure } from '@/lib/inventory/api';
import { ITEM_COLUMNS } from '@/lib/inventory/server';
import { parseItemFields } from '@/lib/inventory/itemFields';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/inventory/items/[id] — manager/owner: edit a stock item.
//
// The unit is locked once the item has any stock history or recipe: every
// stored quantity (batches, requests, recipes) is in that unit, so changing
// "kg" to "g" would silently turn 5 kg into 5 g. Retire the item and add a
// new one instead.
export async function PATCH(request: Request, { params }: RouteParams) {
  const gate = await requireInventoryActor({ managerOnly: true });
  if ('response' in gate) return gate.response;
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = parseItemFields(body, { requireAll: false });
  if (!parsed.ok) return errorResponse(400, parsed.message);

  const admin = createAdminSupabaseClient();
  const { data: current, error: readError } = await admin
    .from('inventory_items')
    .select('id, unit')
    .eq('id', params.id)
    .maybeSingle();
  if (readError) return inventoryWriteFailure(readError, 'Loading the item');
  if (!current) return notFound();

  if (parsed.fields.unit && parsed.fields.unit !== (current as { unit: string }).unit) {
    const [moves, recipes] = await Promise.all([
      admin.from('inventory_movements').select('id', { count: 'exact', head: true }).eq('item_id', params.id),
      admin.from('recipe_lines').select('id', { count: 'exact', head: true }).eq('item_id', params.id),
    ]);
    if (moves.error || recipes.error) return inventoryWriteFailure(moves.error ?? recipes.error, 'Checking the item');
    if ((moves.count ?? 0) > 0 || (recipes.count ?? 0) > 0) {
      return errorResponse(
        409,
        'The unit can’t change once the item has stock history or is in a recipe — retire it and add a new item.',
      );
    }
  }

  const { data, error } = await admin
    .from('inventory_items')
    .update({ ...parsed.fields, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .select(ITEM_COLUMNS)
    .maybeSingle();
  if (error?.code === '23505') return errorResponse(409, 'There is already a stock item with that name.');
  if (error) return inventoryWriteFailure(error, 'Saving the item');
  if (!data) return notFound();
  return NextResponse.json({ item: data });
}
