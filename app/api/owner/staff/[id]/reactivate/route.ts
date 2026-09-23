import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { performReactivate } from '../../_lib';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// POST /api/owner/staff/[id]/reactivate — unbans and restores
// role_before_deactivation (default 'staff'). Idempotent on an already-active
// account; 404 if there's no staff_accounts row at all.
export async function POST(_request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  const { id } = params;
  if (!isUuid(id)) return notFound();

  const admin = createAdminSupabaseClient();
  const result = await performReactivate(admin, id);
  return NextResponse.json(result.body, { status: result.status });
}
