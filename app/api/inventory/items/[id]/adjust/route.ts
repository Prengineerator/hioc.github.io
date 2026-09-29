import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { requireInventoryActor, inventoryWriteFailure } from '@/lib/inventory/api';
import { parseQty } from '@/lib/inventory/rules';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

const MIN_REASON = 3;
const MAX_REASON = 200;

// POST /api/inventory/items/[id]/adjust — manager/owner (INV-6).
// Body:
//   { kind: 'waste', qty, batchId?, reason }  thrown away — an expired batch
//                                             (batchId) or earliest-expiry first
//   { kind: 'count', qty, reason? }           what is physically on the shelf;
//                                             clears the item's "count needed"
// Both land in inventory_movements with who and why.
export async function POST(request: Request, { params }: RouteParams) {
  const gate = await requireInventoryActor({ managerOnly: true });
  if ('response' in gate) return gate.response;
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const { kind } = body;
  if (kind !== 'waste' && kind !== 'count') return errorResponse(400, "kind must be 'waste' or 'count'");

  const qty = parseQty(body.qty, { allowZero: kind === 'count' });
  if (qty === null) {
    return errorResponse(400, kind === 'waste' ? 'Enter how much was thrown away.' : 'Enter the quantity counted (0 or more).');
  }

  let batchId: string | null = null;
  if (kind === 'waste' && body.batchId !== undefined && body.batchId !== null) {
    if (!isUuid(body.batchId)) return errorResponse(400, 'batchId must be a batch id');
    batchId = body.batchId;
  }

  const rawReason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const reason = rawReason || (kind === 'count' ? 'Stock count' : '');
  if (reason.length < MIN_REASON) return errorResponse(400, 'Say why it was thrown away (e.g. expired, spilt).');
  if (reason.length > MAX_REASON) return errorResponse(400, `Keep the reason under ${MAX_REASON} characters.`);

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.rpc('inventory_adjust', {
    p_item_id: params.id,
    p_actor: gate.actor.user.id,
    p_kind: kind,
    p_qty: qty,
    p_batch_id: batchId,
    p_reason: reason,
  });
  if (error) return inventoryWriteFailure(error, 'Recording the adjustment');
  const onHand = Number((data as { on_hand?: unknown } | null)?.on_hand);
  return NextResponse.json({ ok: true, onHand: Number.isFinite(onHand) ? onHand : null });
}
