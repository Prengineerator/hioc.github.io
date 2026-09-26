import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { istBusinessDate } from '@/lib/cash/date';
import { requireInventoryActor, inventoryWriteFailure } from '@/lib/inventory/api';
import { INVENTORY_MIGRATION_HINT, ITEM_COLUMNS, loadAutoHide, loadInventoryItems } from '@/lib/inventory/server';
import { parseItemFields } from '@/lib/inventory/itemFields';

export const dynamic = 'force-dynamic';

// Stock items (docs/INVENTORY-SPEC.md, INV-2).
//
// GET  — every counter actor: all items with stock on hand, batches and
//        their expiry, low/expired/count-needed flags, open requests, and
//        which menu items are hidden because an ingredient ran out.
// POST — manager/owner: add a stock item.

export async function GET() {
  const gate = await requireInventoryActor();
  if ('response' in gate) return gate.response;

  const today = istBusinessDate();
  const admin = createAdminSupabaseClient();
  const [{ items, error }, autoHide] = await Promise.all([loadInventoryItems(admin, today), loadAutoHide(admin)]);
  if (error) return errorResponse(500, `Could not load stock — ${INVENTORY_MIGRATION_HINT}`);
  return NextResponse.json({ items, today, autoHide, canManage: gate.actor.isManager });
}

export async function POST(request: Request) {
  const gate = await requireInventoryActor({ managerOnly: true });
  if ('response' in gate) return gate.response;

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = parseItemFields(body, { requireAll: true });
  if (!parsed.ok) return errorResponse(400, parsed.message);

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('inventory_items').insert(parsed.fields).select(ITEM_COLUMNS).single();
  if (error?.code === '23505') return errorResponse(409, 'There is already a stock item with that name.');
  if (error || !data) return inventoryWriteFailure(error, 'Adding the item');
  return NextResponse.json({ item: data }, { status: 201 });
}
