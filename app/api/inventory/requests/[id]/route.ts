import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getEnrolledDevice } from '@/lib/api/device';
import { getStaffSurface } from '@/lib/staff/surface';
import { istBusinessDate } from '@/lib/cash/date';
import { requireInventoryActor, inventoryWriteFailure } from '@/lib/inventory/api';
import { loadAssignees } from '@/lib/inventory/server';
import { sendStockAssignedEmail } from '@/lib/inventory/notify';
import {
  canAssign,
  canCancel,
  canPick,
  canReceive,
  OPEN_REQUEST_STATUSES,
  parsePickLines,
  parseReceiveLines,
  type ReceivableItem,
  type RequestActor,
  type RequestFacts,
  type Verdict,
} from '@/lib/inventory/rules';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

const MAX_REASON = 200;

// PATCH /api/inventory/requests/[id] — moves a stock request along
// (docs/INVENTORY-SPEC.md, INV-3/4). Body is one of:
//
//   { action: 'assign',  assigneeId }                 manager/owner
//   { action: 'pick',    lines: [{ itemId, qty }] }   the assignee (or a manager)
//   { action: 'receive', lines: [{ itemId, qty, expiryDate }] }
//                                                      at the POS, not the picker
//   { action: 'cancel',  reason? }                     requester before assignment,
//                                                      or a manager/owner
//
// Who-may-do-what is lib/inventory/rules.ts; the database functions re-check
// the status under a row lock, so two phones racing the same request can't
// both win.
export async function PATCH(request: Request, { params }: RouteParams) {
  const gate = await requireInventoryActor();
  if ('response' in gate) return gate.response;
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const { action } = body;
  if (action !== 'assign' && action !== 'pick' && action !== 'receive' && action !== 'cancel') {
    return errorResponse(400, "action must be 'assign', 'pick', 'receive' or 'cancel'");
  }

  const admin = createAdminSupabaseClient();
  const { data: row, error: readError } = await admin
    .from('stock_requests')
    .select('id, status, requested_by, assigned_to, picked_by, stock_request_lines(item_id)')
    .eq('id', params.id)
    .maybeSingle();
  if (readError) return inventoryWriteFailure(readError, 'Loading the request');
  if (!row) return notFound();

  const req = row as unknown as RequestFacts & { stock_request_lines: { item_id: string }[] | null };
  const lineItemIds = (req.stock_request_lines ?? []).map((l) => l.item_id);
  const surface = action === 'receive' ? await getStaffSurface() : 'web';
  const actor: RequestActor = { userId: gate.actor.user.id, role: gate.actor.role, surface };
  const refuse = (v: Verdict) => (v.ok ? null : errorResponse(v.status, v.message));

  if (action === 'assign') {
    const denied = refuse(canAssign(req, actor));
    if (denied) return denied;
    const assigneeId = body.assigneeId;
    if (!isUuid(assigneeId)) return errorResponse(400, 'Pick who should pick this request.');
    const team = await loadAssignees(admin);
    if (!team.some((p) => p.id === assigneeId)) return errorResponse(400, 'That person is not on the active team.');

    const { data: updated, error } = await admin
      .from('stock_requests')
      .update({
        status: 'assigned',
        assigned_to: assigneeId,
        assigned_by: actor.userId,
        assigned_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', params.id)
      .in('status', ['requested', 'assigned'])
      .select('id')
      .maybeSingle();
    if (error) return inventoryWriteFailure(error, 'Assigning the request');
    if (!updated) return errorResponse(409, 'This request moved on — refresh and try again.');

    // Tell the picker (INV-9). Skipped when a manager assigns it to
    // themselves — they already know. Never fails the assignment.
    let emailed: 'sent' | 'failed' | 'skipped' = 'skipped';
    if (assigneeId !== actor.userId) {
      const assignedByName = team.find((p) => p.id === actor.userId)?.name ?? 'A manager';
      emailed = (await sendStockAssignedEmail(admin, { requestId: params.id, assigneeId, assignedByName })).status;
    }
    return NextResponse.json({ ok: true, emailed });
  }

  if (action === 'pick') {
    const denied = refuse(canPick(req, actor));
    if (denied) return denied;
    const parsed = parsePickLines(body.lines, lineItemIds);
    if (!parsed.ok) return errorResponse(400, parsed.message);
    const { error } = await admin.rpc('inventory_pick', {
      p_request_id: params.id,
      p_actor: actor.userId,
      p_is_manager: gate.actor.isManager,
      p_lines: parsed.lines.map((l) => ({ item_id: l.itemId, qty: l.qty })),
    });
    if (error) return inventoryWriteFailure(error, 'Recording the pick');
    return NextResponse.json({ ok: true });
  }

  if (action === 'receive') {
    const denied = refuse(canReceive(req, actor));
    if (denied) return denied;
    const { data: itemRows, error: itemsError } = await admin
      .from('inventory_items')
      .select('id, name, tracks_expiry')
      .in('id', lineItemIds);
    if (itemsError) return inventoryWriteFailure(itemsError, 'Loading the items');
    const items = new Map(((itemRows ?? []) as ReceivableItem[]).map((i) => [i.id, i]));
    const parsed = parseReceiveLines(body.lines, items, istBusinessDate(), lineItemIds);
    if (!parsed.ok) return errorResponse(400, parsed.message);

    const device = await getEnrolledDevice();
    const { data, error } = await admin.rpc('inventory_receive', {
      p_request_id: params.id,
      p_actor: actor.userId,
      p_device_id: device?.id ?? null,
      p_lines: parsed.lines.map((l) => ({ item_id: l.itemId, qty: l.qty, expiry_date: l.expiryDate })),
    });
    if (error) return inventoryWriteFailure(error, 'Receiving the stock');
    const result = (data ?? {}) as { has_discrepancy?: boolean };
    return NextResponse.json({ ok: true, hasDiscrepancy: result.has_discrepancy === true });
  }

  // cancel
  const denied = refuse(canCancel(req, actor));
  if (denied) return denied;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  const ownUnassigned = req.requested_by === actor.userId && req.status === 'requested';
  if (!ownUnassigned && reason.length < 3) return errorResponse(400, 'Say why it is being cancelled.');
  if (reason.length > MAX_REASON) return errorResponse(400, `Keep the reason under ${MAX_REASON} characters.`);

  const { data: cancelled, error } = await admin
    .from('stock_requests')
    .update({
      status: 'cancelled',
      cancelled_by: actor.userId,
      cancel_reason: reason,
      updated_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .in('status', ownUnassigned && !gate.actor.isManager ? ['requested'] : (OPEN_REQUEST_STATUSES as string[]))
    .select('id')
    .maybeSingle();
  if (error) return inventoryWriteFailure(error, 'Cancelling the request');
  if (!cancelled) return errorResponse(409, 'This request moved on — refresh and try again.');
  return NextResponse.json({ ok: true });
}
