import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { parseCouponInput } from '@/lib/promotions/validate';
import type { Coupon } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_COUPONS = 200;

// GET /api/coupons — staff/owner only. Lists coupons for the owner promotions
// UI (newest first).
export async function GET() {
  const user = await getManagerUser();
  if (!user) {
    return unauthorized();
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('coupons')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(MAX_COUPONS);

  if (error) {
    return errorResponse(500, 'Failed to load coupons');
  }

  return NextResponse.json({ coupons: (data ?? []) as Coupon[] });
}

// POST /api/coupons — staff/owner only. Creates a coupon (LOY-5 owner tools).
export async function POST(request: Request) {
  const user = await getManagerUser();
  if (!user) {
    return unauthorized();
  }

  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const parsed = parseCouponInput(body, { partial: false });
  if (typeof parsed === 'string') {
    return errorResponse(400, parsed);
  }

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('coupons')
    .insert(parsed)
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      return errorResponse(409, 'A coupon with this code already exists');
    }
    console.error('coupons insert failed', error);
    return errorResponse(500, 'Failed to create coupon');
  }

  return NextResponse.json({ coupon: data as Coupon }, { status: 201 });
}
