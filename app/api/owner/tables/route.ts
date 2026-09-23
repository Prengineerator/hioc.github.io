import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

// Owner-only tables registry (FND3-1). Dine-in orders pin to a table; the tables
// board (POS-3) and table-QR (QR-1) read from here. Every method is gated by
// getOwnerUser() and writes go through the service-role admin client.
//
// SECURITY: `qr_token` is column-sensitive (it's the QR-1 order link) and is
// NEVER returned by this endpoint — QR-2 will add a dedicated token/QR-image
// route. We select an explicit column list that excludes it.
const TABLE_COLUMNS = 'id, label, zone, capacity, is_active, sort_order, created_at, updated_at';

const MAX_LABEL_LEN = 40;
const MAX_ZONE_LEN = 40;
// Statuses that still hold a table (anything non-terminal). Deactivating a table
// with an order in one of these is blocked (FND3-1 AC).
const OPEN_STATUSES = ['placed', 'received', 'accepted', 'preparing', 'ready'];

// GET — list every table (incl. inactive) for the owner, in display order.
export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('tables')
    .select(TABLE_COLUMNS)
    .order('sort_order', { ascending: true })
    .order('label', { ascending: true });
  if (error) return errorResponse(500, error.message);

  return NextResponse.json({ tables: data ?? [] });
}

// POST { label, zone?, capacity?, sort_order? } — add a table.
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const label = typeof body.label === 'string' ? body.label.trim() : '';
  if (!label) return errorResponse(400, 'A table label is required');
  if (label.length > MAX_LABEL_LEN) return errorResponse(400, `Label must be ${MAX_LABEL_LEN} characters or fewer`);

  const zone = typeof body.zone === 'string' ? body.zone.trim().slice(0, MAX_ZONE_LEN) : '';
  const capacity = Number.isInteger(body.capacity) && (body.capacity as number) >= 0 ? (body.capacity as number) : 0;
  const sortOrder = Number.isInteger(body.sort_order) ? (body.sort_order as number) : 0;

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('tables')
    .insert({ label, zone, capacity, sort_order: sortOrder })
    .select(TABLE_COLUMNS)
    .single();
  if (error) {
    // 23505 = unique_violation on the case-insensitive label index.
    if (error.code === '23505') return errorResponse(409, `A table labelled "${label}" already exists`);
    return errorResponse(500, error.message);
  }
  return NextResponse.json({ table: data });
}

// PATCH { id, label?, zone?, capacity?, sort_order?, is_active? } — edit a table
// or (de)activate it. Deactivating a table with an open order is blocked.
export async function PATCH(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return errorResponse(400, 'id is required');

  const admin = createAdminSupabaseClient();

  // Guard: block deactivation while the table still holds an open order.
  if (body.is_active === false) {
    const { count, error: countErr } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('table_id', id)
      .in('status', OPEN_STATUSES);
    if (countErr) return errorResponse(500, countErr.message);
    if ((count ?? 0) > 0) {
      return errorResponse(409, 'This table has an open order — settle it before deactivating');
    }
  }

  const patch: Record<string, unknown> = {};
  if (typeof body.label === 'string') {
    const label = body.label.trim();
    if (!label) return errorResponse(400, 'A table label is required');
    if (label.length > MAX_LABEL_LEN) return errorResponse(400, `Label must be ${MAX_LABEL_LEN} characters or fewer`);
    patch.label = label;
  }
  if (typeof body.zone === 'string') patch.zone = body.zone.trim().slice(0, MAX_ZONE_LEN);
  if (Number.isInteger(body.capacity) && (body.capacity as number) >= 0) patch.capacity = body.capacity;
  if (Number.isInteger(body.sort_order)) patch.sort_order = body.sort_order;
  if (typeof body.is_active === 'boolean') patch.is_active = body.is_active;
  // Regenerate the QR token (FND3-1 AC): old /t/<token> links die immediately.
  // Same format as the DB default (uuid, hyphens stripped). Never returned.
  if (body.regenerate_token === true) patch.qr_token = crypto.randomUUID().replace(/-/g, '');
  if (Object.keys(patch).length === 0) return errorResponse(400, 'Nothing to update');

  const { data, error } = await admin
    .from('tables')
    .update(patch)
    .eq('id', id)
    .select(TABLE_COLUMNS)
    .single();
  if (error) {
    if (error.code === '23505') return errorResponse(409, 'A table with that label already exists');
    return errorResponse(500, error.message);
  }
  if (!data) return errorResponse(404, 'Table not found');
  return NextResponse.json({ table: data });
}
