import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { performDeactivate } from '../../_lib';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// POST /api/owner/staff/[id]/deactivate — blocks login immediately, keeps
// history, and can be reactivated (SA-D2). Refuses self and owner targets;
// idempotent on an account already deactivated.
export async function POST(_request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  const { id } = params;
  if (!isUuid(id)) return notFound();

  const admin = createAdminSupabaseClient();
  const result = await performDeactivate(admin, owner.id, id);
  return NextResponse.json(result.body, { status: result.status });
}
