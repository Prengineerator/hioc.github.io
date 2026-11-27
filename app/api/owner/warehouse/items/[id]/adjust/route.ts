import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { inventoryWriteFailure } from '@/lib/inventory/api';
import { parseQty } from '@/lib/inventory/rules';
import { requireWarehouseOwner } from '@/lib/inventory/warehouseServer';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

const MIN_REASON = 3;
const MAX_REASON = 200;

// POST /api/owner/warehouse/items/[id]/adjust — owner only. Corrections to the
// warehouse sheet, the same two the store has:
//   { kind: 'waste', qty, batchId?, reason }  thrown away (a batch, or earliest expiry first)
//   { kind: 'count', qty, reason? }           what is physically in the warehouse;
//                                             clears the item's warehouse "count needed"
export async function POST(request: Request, { params }: RouteParams) {
  const gate = await requireWarehouseOwner();
  if ('response' in gate) return gate.response;
  if (!isUuid(params.id)) return notFound();
  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const { kind } = body;
  if (kind !== 'waste' && kind !== 'count') return errorResponse(400, "kind must be 'waste' or 'count'");
  const qty = parseQty(body.qty, { allowZero: kind === 'count' });
  if (qty === null) return errorResponse(400, kind === 'waste' ? 'Enter how much was thrown away.' : 'Enter the quantity counted.');
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (kind === 'waste' && reason.length < MIN_REASON) return errorResponse(400, 'Say why it was thrown away.');
  if (reason.length > MAX_REASON) return errorResponse(400, `Keep the reason under ${MAX_REASON} characters.`);
  if (body.batchId !== undefined && body.batchId !== null && !isUuid(body.batchId)) return errorResponse(400, 'Unknown batch.');

  const { data, error } = await createAdminSupabaseClient().rpc('warehouse_adjust', {
    p_item_id: params.id,
    p_actor: gate.owner.id,
    p_kind: kind,
    p_qty: qty,
    p_batch_id: kind === 'waste' && isUuid(body.batchId) ? body.batchId : null,
    p_reason: reason,
  });
  if (error) return inventoryWriteFailure(error, kind === 'waste' ? 'Writing it off' : 'Saving the count');
  return NextResponse.json({ ok: true, onHand: Number((data as { on_hand?: number } | null)?.on_hand ?? qty) });
}
