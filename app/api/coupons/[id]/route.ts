import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { isUuid } from '@/lib/api/constants';
import { parseCouponInput } from '@/lib/promotions/validate';
import type { Coupon, CouponChannel } from '@/lib/types';

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

  const admin = createAdminSupabaseClient();
  // M9: fetch the current discount_type so a PATCH that only changes
  // discount_value still enforces the percent<=100 cap (type may not be in body).
  // The stored channel too, so a scope-only PATCH is checked against it. A database without the
  // column fails that read; retry for the type alone (every coupon there is café-only).
  let { data: existing, error: existingError } = await admin
    .from('coupons')
    .select('discount_type, channel')
    .eq('id', id)
    .maybeSingle();
  if (existingError && isMissingColumnError(existingError)) {
    ({ data: existing } = (await admin
      .from('coupons')
      .select('discount_type')
      .eq('id', id)
      .maybeSingle()) as { data: typeof existing });
  }

  const parsed = parseCouponInput(body, {
    partial: true,
    existingType: existing?.discount_type as 'percent' | 'flat' | undefined,
    existingChannel: (existing as { channel?: CouponChannel } | null)?.channel,
  });
  if (typeof parsed === 'string') {
    return errorResponse(400, parsed);
  }
  if (Object.keys(parsed).length === 0) {
    return errorResponse(400, 'No writable fields provided');
  }

  const update = (fields: typeof parsed) =>
    admin.from('coupons').update(fields).eq('id', id).select('*').maybeSingle();
  let { data, error } = await update(parsed);
  if (error && isMissingColumnError(error) && parsed.channel !== undefined) {
    // Migration not applied: only a café coupon can be saved, and it needs no channel column.
    if (parsed.channel !== 'cafe') return errorResponse(503, 'Apply supabase/2026-11-shop-v2.sql to use shop coupons');
    const { channel: _channel, ...withoutChannel } = parsed;
    ({ data, error } = await update(withoutChannel));
  }

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
