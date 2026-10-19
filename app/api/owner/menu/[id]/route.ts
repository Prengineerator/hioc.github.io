import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import {
  applyMenuDelete,
  applyMenuUpdate,
  failureResponse,
  validateUpdateBody,
} from '@/lib/menu/applyMenuChange';
import { cancelOrphanedRequests } from '@/lib/menu/changeRequests';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/owner/menu/[id] — owner only. Partial update from the owner app:
// same body as PATCH /api/menu/[id] (including the sold-out / snooze bodies),
// same write — `variants` and `addon_group_ids`, if present, fully replace the
// item's sizes and add-on links — applied at once. -> 200 { item }.
//
// getOwnerUser() ONLY (rule D6-6).
export async function PATCH(request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const { id } = params;
  if (!isUuid(id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const checked = validateUpdateBody(body);
  if (!checked.ok) return failureResponse(checked);

  const updated = await applyMenuUpdate(createAdminSupabaseClient(), id, checked.value);
  if (!updated.ok) return failureResponse(updated);

  return NextResponse.json({ item: updated.value });
}

// DELETE /api/owner/menu/[id] — owner only. Hard delete (variants and add-on
// links cascade via FK; order_items keep a snapshot, so past orders are
// unaffected). Requests still waiting on the item are cancelled with it.
// -> 200 { ok: true }.
export async function DELETE(_request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const { id } = params;
  if (!isUuid(id)) return notFound();

  const admin = createAdminSupabaseClient();
  const deleted = await applyMenuDelete(admin, id);
  if (!deleted.ok) return failureResponse(deleted);
  await cancelOrphanedRequests(admin);

  return NextResponse.json({ ok: true });
}
