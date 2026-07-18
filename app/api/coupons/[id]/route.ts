import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { parseCouponInput } from '@/lib/promotions/validate';
import type { Coupon } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/coupons/[id] — staff/owner only. Partial update (including
// toggling `active`, editing limits/dates/scope). Code uniqueness is
// enforced by the DB constraint.
export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getManagerUser();
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

  const parsed = parseCouponInput(body, { partial: true });
  if (typeof parsed === 'string') {
    return errorResponse(400, parsed);
  }
  if (Object.keys(parsed).length === 0) {
    return errorResponse(400, 'No writable fields provided');
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('coupons')
    .update(parsed)
    .eq('id', id)
    .select('*')
    .maybeSingle();

  if (error) {
    if (error.code === '23505') {
      return errorResponse(409, 'A coupon with this code already exists');
    }
    console.error('coupons update failed', error);
    return errorResponse(500, 'Failed to update coupon');
  }
  if (!data) {
    return notFound();
  }

  return NextResponse.json({ coupon: data as Coupon });
}
