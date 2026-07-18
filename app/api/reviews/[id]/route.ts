import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import type { Review } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_RESPONSE_LENGTH = 1000;

type RouteParams = { params: { id: string } };

// PATCH /api/reviews/[id] — staff/owner only. Owner moderation: post a
// response and/or hide abusive content (LOY-3 edge case).
export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getStaffUser();
  if (!user) {
    return unauthorized();
  }

  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const patch: Record<string, unknown> = {};
  if (body.staff_response !== undefined) {
    if (typeof body.staff_response !== 'string') {
      return errorResponse(400, 'staff_response must be a string');
    }
    patch.staff_response = body.staff_response.trim().slice(0, MAX_RESPONSE_LENGTH);
    patch.responded_at = new Date().toISOString();
  }
  if (body.hidden !== undefined) {
    if (typeof body.hidden !== 'boolean') {
      return errorResponse(400, 'hidden must be a boolean');
    }
    patch.hidden = body.hidden;
  }
  if (Object.keys(patch).length === 0) {
    return errorResponse(400, 'No writable fields provided (staff_response, hidden)');
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('reviews')
    .update(patch)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) {
    console.error('reviews update failed', error);
    return errorResponse(500, 'Failed to update review');
  }
  if (!data) {
    return notFound();
  }

  return NextResponse.json({ review: data as Review });
}
