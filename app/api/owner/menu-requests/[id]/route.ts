import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { failureResponse } from '@/lib/menu/applyMenuChange';
import {
  approveChangeRequest,
  loadChangeRequest,
  MAX_NOTE_LENGTH,
  rejectChangeRequest,
} from '@/lib/menu/changeRequests';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/owner/menu-requests/[id] — owner only. Body
// { action: 'approve' | 'reject', note?: string }.
//
//  - Only a PENDING request can be decided; a decided one is a 409, and so is
//    losing a race with another click (the claim is a conditional update).
//  - approve applies the change with the menu routes' own write logic (sizes and
//    add-on links are replaced whole, a code already in use is a 409…). If it
//    cannot be applied the request stays PENDING and the error is returned: a
//    4xx for a validation or code conflict, a 409 when the item has since been
//    deleted, a 500 otherwise.
//  - reject just closes it; the note is optional.
//
// -> 200 { request, item? } (item = the item as it now stands, for a create or
// an edit).
//
// getOwnerUser() ONLY (rule D6-6).
export async function PATCH(request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const { id } = params;
  if (!isUuid(id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const action = body.action;
  if (action !== 'approve' && action !== 'reject') {
    return errorResponse(400, 'action must be approve or reject');
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    return errorResponse(400, 'note must be a string');
  }
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > MAX_NOTE_LENGTH) {
    return errorResponse(400, `note must be ${MAX_NOTE_LENGTH} characters or fewer`);
  }

  const admin = createAdminSupabaseClient();

  if (action === 'approve') {
    const approved = await approveChangeRequest(admin, id, owner.id, note || null);
    if (!approved.ok) return failureResponse(approved);
    return NextResponse.json(approved.value);
  }

  const loaded = await loadChangeRequest(admin, id);
  if (!loaded.ok) return failureResponse(loaded);
  if (loaded.value.status !== 'pending') {
    return errorResponse(409, `This request was already ${loaded.value.status}.`);
  }
  const rejected = await rejectChangeRequest(admin, id, owner.id, note || null);
  if (!rejected.ok) return failureResponse(rejected);

  return NextResponse.json({ request: rejected.value });
}
