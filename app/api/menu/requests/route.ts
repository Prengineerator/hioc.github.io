import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { failureResponse } from '@/lib/menu/applyMenuChange';
import { listChangeRequests } from '@/lib/menu/changeRequests';

export const dynamic = 'force-dynamic';

const ALL_LIMIT = 50;
const PENDING_LIMIT = 200;

// GET /api/menu/requests?status=pending|all — any signed-in counter actor
// (staff, manager, owner; session or enrolled-device operator). The menu
// changes waiting for the owner's approval (default), or the latest 50 of any
// status so a staff member can see what became of theirs. Newest first.
//
// Not surface-gated: it is a read, and the staff website lists them too.
export async function GET(request: Request) {
  const actor = await getCounterActor();
  if (!actor) {
    return unauthorized();
  }

  const status = new URL(request.url).searchParams.get('status') ?? 'pending';
  if (status !== 'pending' && status !== 'all') {
    return errorResponse(400, 'status must be pending or all');
  }

  const listed = await listChangeRequests(
    createAdminSupabaseClient(),
    status,
    status === 'all' ? ALL_LIMIT : PENDING_LIMIT,
  );
  if (!listed.ok) {
    return failureResponse(listed);
  }

  return NextResponse.json({ requests: listed.value });
}
