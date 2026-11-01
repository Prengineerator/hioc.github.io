import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { runAfterResponse } from '@/lib/api/background';
import { flags } from '@/lib/flags';
import { requireInventoryActor, inventoryWriteFailure } from '@/lib/inventory/api';
import { loadAssignees } from '@/lib/inventory/server';
import { sendStockAssignedEmail } from '@/lib/inventory/notify';
import { sendOwnerAlert } from '@/lib/inventory/ownerAlerts';
import { parseRequestLines } from '@/lib/inventory/rules';
import { parseDeliverer } from '@/lib/inventory/warehouse';
import { WAREHOUSE_OFF_MESSAGE } from '@/lib/inventory/warehouseServer';

export const dynamic = 'force-dynamic';

const MAX_NOTE = 300;

// POST /api/inventory/returns — "Send back to warehouse" (docs/WAREHOUSE-SPEC.md,
// WH-D6). Manager or owner, on any screen (like a write-off: it takes stock off
// the store's shelf). Body:
//   { lines: [{ itemId, qty }], note?, assigneeId }              a team member carries it
//   { lines: [{ itemId, qty }], note?, deliverer: { name, phone? } }  someone without a login
// It leaves the store at once (warehouse_create_return) and is in transit until
// the owner counts it in at the warehouse. The owner is alerted after the reply.
export async function POST(request: Request) {
  const gate = await requireInventoryActor({ managerOnly: true });
  if ('response' in gate) return gate.response;
  if (!flags.warehouse) return errorResponse(404, WAREHOUSE_OFF_MESSAGE);

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const lines = parseRequestLines(body.lines, isUuid);
  if (!lines.ok) return errorResponse(400, lines.message.replace('to the request', 'to send back'));
  const who = parseDeliverer(body, isUuid);
  if (!who.ok) return errorResponse(400, who.message);
  if (body.note !== undefined && typeof body.note !== 'string') return errorResponse(400, 'note must be text');
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > MAX_NOTE) return errorResponse(400, `Keep the note under ${MAX_NOTE} characters.`);

  const admin = createAdminSupabaseClient();
  const team = who.deliverer.kind === 'member' ? await loadAssignees(admin) : [];
  if (who.deliverer.kind === 'member' && !team.some((p) => p.id === (who.deliverer as { userId: string }).userId)) {
    return errorResponse(400, 'That person is not on the active team.');
  }

  const { data, error } = await admin.rpc('warehouse_create_return', {
    p_actor: gate.actor.user.id,
    p_note: note,
    p_assignee: who.deliverer.kind === 'member' ? who.deliverer.userId : null,
    p_deliverer_name: who.deliverer.kind === 'outside' ? who.deliverer.name : '',
    p_deliverer_phone: who.deliverer.kind === 'outside' ? who.deliverer.phone : '',
    p_lines: lines.lines.map((l) => ({ item_id: l.itemId, qty: l.qty })),
  });
  if (error) return inventoryWriteFailure(error, 'Sending it back');
  const id = typeof data === 'string' ? data : null;

  let emailed: 'sent' | 'failed' | 'skipped' = 'skipped';
  if (id && who.deliverer.kind === 'member' && who.deliverer.userId !== gate.actor.user.id) {
    const assignedByName = team.find((p) => p.id === gate.actor.user.id)?.name ?? 'A manager';
    emailed = (
      await sendStockAssignedEmail(admin, { requestId: id, assigneeId: who.deliverer.userId, assignedByName, delivery: 'to_warehouse' })
    ).status;
  }
  if (id) runAfterResponse(sendOwnerAlert(admin, 'return_sent', id));
  return NextResponse.json({ id, emailed }, { status: 201 });
}
