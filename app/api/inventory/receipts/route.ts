import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getEnrolledDevice } from '@/lib/api/device';
import { istBusinessDate } from '@/lib/cash/date';
import { requireInventoryActor, inventoryWriteFailure } from '@/lib/inventory/api';
import { parseReceiveLines, RECEIVE_POS_ONLY_MESSAGE, type ReceivableItem } from '@/lib/inventory/rules';

export const dynamic = 'force-dynamic';

// POST /api/inventory/receipts — manager/owner, at the POS (INV-4b).
// A supplier delivery with no stock request behind it, counted in the same
// way: quantity and expiry date per item. Body:
//   { lines: [{ itemId, qty, expiryDate }] }
export async function POST(request: Request) {
  const gate = await requireInventoryActor({ managerOnly: true });
  if ('response' in gate) return gate.response;

  const device = await getEnrolledDevice();
  if (!device) return errorResponse(403, RECEIVE_POS_ONLY_MESSAGE);

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  if (!Array.isArray(body.lines)) return errorResponse(400, 'Nothing to receive.');

  const ids = (body.lines as unknown[])
    .map((l) => (l && typeof l === 'object' ? (l as Record<string, unknown>).itemId : undefined))
    .filter(isUuid);

  const admin = createAdminSupabaseClient();
  const { data: itemRows, error: itemsError } = ids.length
    ? await admin.from('inventory_items').select('id, name, tracks_expiry').in('id', ids).eq('is_active', true)
    : { data: [], error: null };
  if (itemsError) return inventoryWriteFailure(itemsError, 'Loading the items');
  const items = new Map(((itemRows ?? []) as ReceivableItem[]).map((i) => [i.id, i]));

  const parsed = parseReceiveLines(body.lines, items, istBusinessDate());
  if (!parsed.ok) return errorResponse(400, parsed.message);

  const { error } = await admin.rpc('inventory_receive', {
    p_request_id: null,
    p_actor: gate.actor.user.id,
    p_device_id: device.id,
    p_lines: parsed.lines.filter((l) => l.qty > 0).map((l) => ({ item_id: l.itemId, qty: l.qty, expiry_date: l.expiryDate })),
  });
  if (error) return inventoryWriteFailure(error, 'Receiving the delivery');
  return NextResponse.json({ ok: true }, { status: 201 });
}
