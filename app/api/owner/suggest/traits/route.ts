import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getTraitsOverview } from '@/lib/suggest/queries';
import { validateTraitPatch } from '@/lib/suggest/traitsValidate';

export const dynamic = 'force-dynamic';

// Phase 7 · SUG-2 — owner review of Opus-tagged menu traits.
// GET  — every menu item with its traits row (or null) plus the "N
//        unconfirmed / M missing" banner counts (Traits tab).
// PATCH { id, ...fields } — edits one item's traits. Any content field
//        present makes this an edit: source becomes 'owner' and the row is
//        marked confirmed, per SUG-2's AC ("owner edits caffeine to none →
//        source='owner' and confirmed=true"). With no content field and
//        `confirm: true`, it just confirms the row as Opus tagged it.
// PATCH { confirmIds: string[] } — "Confirm all visible": marks existing rows
//        confirmed without touching their content or source.

const MAX_BULK_CONFIRM = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const overview = await getTraitsOverview();
  return NextResponse.json(overview);
}

export async function PATCH(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const admin = createAdminSupabaseClient();

  // Bulk confirm: { confirmIds: string[] }.
  if (Array.isArray(body.confirmIds)) {
    const ids = body.confirmIds.filter((id): id is string => typeof id === 'string' && UUID_RE.test(id));
    if (ids.length === 0) return errorResponse(400, 'confirmIds must be a non-empty array of item ids');
    if (ids.length > MAX_BULK_CONFIRM) return errorResponse(400, `confirmIds must have ${MAX_BULK_CONFIRM} or fewer ids`);

    const { data, error } = await admin
      .from('menu_item_traits')
      .update({ confirmed: true })
      .in('menu_item_id', ids)
      .select('menu_item_id');
    if (error) return errorResponse(500, error.message);
    return NextResponse.json({ confirmed: (data ?? []).length });
  }

  // Single-row edit/confirm: { id, ...fields, confirm? }.
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id || !UUID_RE.test(id)) return errorResponse(400, 'A valid item id is required');

  const { id: _id, confirm, confirmIds: _confirmIds, ...rest } = body;
  const { patch, error: validationError } = validateTraitPatch(rest);
  if (validationError) return errorResponse(400, validationError);

  const hasContentEdit = Object.keys(patch).length > 0;
  if (!hasContentEdit && confirm !== true) {
    return errorResponse(400, 'Nothing to update — send trait fields to edit, or confirm: true');
  }

  const update: Record<string, unknown> = hasContentEdit
    ? { ...patch, source: 'owner', confirmed: true, updated_at: new Date().toISOString() }
    : { confirmed: true };

  const { data, error } = await admin.from('menu_item_traits').update(update).eq('menu_item_id', id).select().maybeSingle();
  if (error) return errorResponse(500, error.message);
  if (!data) return errorResponse(404, 'No traits row for that item yet — generate traits first');

  return NextResponse.json({ traits: data });
}
