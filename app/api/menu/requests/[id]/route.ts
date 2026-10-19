import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { failureResponse } from '@/lib/menu/applyMenuChange';
import { cancelChangeRequest, loadChangeRequest } from '@/lib/menu/changeRequests';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// DELETE /api/menu/requests/[id] — withdraw a request that is still pending.
// Allowed for the person who made it, a manager, or the owner (any signed-in
// counter actor passes the gate; the rest is checked against the row). A
// request the owner has already decided is a 409. -> 200 { request }.
export async function DELETE(_request: Request, { params }: RouteParams) {
  const actor = await getCounterActor();
  if (!actor) {
    return unauthorized();
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const admin = createAdminSupabaseClient();
  const loaded = await loadChangeRequest(admin, id);
  if (!loaded.ok) {
    return failureResponse(loaded);
  }
  const found = loaded.value;

  const mayCancel =
    found.requested_by === actor.user.id || actor.role === 'manager' || actor.role === 'owner';
  if (!mayCancel) {
    return errorResponse(403, 'Only the person who made this request, a manager or the owner can cancel it');
  }
  if (found.status !== 'pending') {
    return errorResponse(409, `This request was already ${found.status}.`);
  }

  const cancelled = await cancelChangeRequest(admin, id, actor.user.id);
  if (!cancelled.ok) {
    return failureResponse(cancelled);
  }

  return NextResponse.json({ request: cancelled.value });
}
