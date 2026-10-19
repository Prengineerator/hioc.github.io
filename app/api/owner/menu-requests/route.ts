import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse } from '@/lib/api/http';
import { failureResponse } from '@/lib/menu/applyMenuChange';
import { countPendingRequests, listChangeRequests } from '@/lib/menu/changeRequests';
import type { MenuChangeStatus } from '@/lib/menu/changeRequestTypes';

export const dynamic = 'force-dynamic';

const STATUSES: readonly string[] = ['pending', 'approved', 'rejected', 'cancelled', 'all'];
const LIMIT = 100;

// GET /api/owner/menu-requests?status=pending|approved|rejected|cancelled|all
// — owner only. The menu changes staff and managers have asked for, newest
// first (default pending; at most the latest 100). `pendingCount` is always the
// number still waiting, whatever the filter, for the owner nav badge.
// -> 200 { requests, pendingCount }.
//
// getOwnerUser() ONLY (rule D6-6).
export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const status = new URL(request.url).searchParams.get('status') ?? 'pending';
  if (!STATUSES.includes(status)) {
    return errorResponse(400, 'status must be pending, approved, rejected, cancelled or all');
  }

  const admin = createAdminSupabaseClient();
  const [listed, pending] = await Promise.all([
    listChangeRequests(admin, status as MenuChangeStatus | 'all', LIMIT),
    countPendingRequests(admin),
  ]);
  if (!listed.ok) return failureResponse(listed);
  if (!pending.ok) return failureResponse(pending);

  return NextResponse.json({ requests: listed.value, pendingCount: pending.value });
}
