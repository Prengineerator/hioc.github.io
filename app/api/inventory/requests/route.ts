import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getStaffSurface } from '@/lib/staff/surface';
import { requireInventoryActor, inventoryWriteFailure } from '@/lib/inventory/api';
import { INVENTORY_MIGRATION_HINT, loadAssignees, loadStockRequests } from '@/lib/inventory/server';
import { parseRequestLines } from '@/lib/inventory/rules';

export const dynamic = 'force-dynamic';

const MAX_NOTE = 300;

// Stock requests (docs/INVENTORY-SPEC.md, INV-3).
//
// GET  — every counter actor: open requests plus the recent closed ones, and
//        what the screen needs to decide which buttons to show (the caller's
//        id and role, whether this is the POS, and — for a manager — who a
//        request can be assigned to). The PATCH route re-checks everything.
// POST — every counter actor: the "Request stock" button.
//        Body: { lines: [{ itemId, qty }], note? }

export async function GET() {
  const gate = await requireInventoryActor();
  if ('response' in gate) return gate.response;

  const admin = createAdminSupabaseClient();
  const [{ requests, error }, surface, assignees] = await Promise.all([
    loadStockRequests(admin),
    getStaffSurface(),
    gate.actor.isManager ? loadAssignees(admin) : Promise.resolve([]),
  ]);
  if (error) return errorResponse(500, `Could not load stock requests — ${INVENTORY_MIGRATION_HINT}`);

  return NextResponse.json({
    requests,
    assignees,
    actorId: gate.actor.user.id,
    canManage: gate.actor.isManager,
    surface,
  });
}

export async function POST(request: Request) {
  const gate = await requireInventoryActor();
  if ('response' in gate) return gate.response;

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const parsed = parseRequestLines(body.lines, isUuid);
  if (!parsed.ok) return errorResponse(400, parsed.message);
  if (body.note !== undefined && typeof body.note !== 'string') return errorResponse(400, 'note must be text');
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > MAX_NOTE) return errorResponse(400, `Keep the note under ${MAX_NOTE} characters.`);

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.rpc('inventory_create_request', {
    p_actor: gate.actor.user.id,
    p_note: note,
    p_lines: parsed.lines.map((l) => ({ item_id: l.itemId, qty: l.qty })),
  });
  if (error) return inventoryWriteFailure(error, 'Sending the request');
  return NextResponse.json({ id: data }, { status: 201 });
}
