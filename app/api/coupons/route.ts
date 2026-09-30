import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { parseCouponInput } from '@/lib/promotions/validate';
import type { Coupon } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_COUPONS = 200;

// GET /api/coupons — staff/owner only. Lists coupons for the owner promotions
// UI (newest first).
//
// Marketing campaigns issue one single-use code PER RECIPIENT (campaign_id set), which
// would bury the handful of coupons the owner actually manages under hundreds of
// machine-made rows — so they are hidden by default. `?include_campaign=1` shows them.
// A database without the campaign_id column (marketing migration not applied) has none
// to hide: the read then retries without the filter.
export async function GET(request: Request) {
  const user = await getManagerUser();
  if (!user) {
    return unauthorized();
  }

  const includeCampaign = new URL(request.url).searchParams.get('include_campaign') === '1';
  const admin = createAdminSupabaseClient();

  const list = (hideCampaign: boolean) => {
    const query = admin.from('coupons').select('*');
    return (hideCampaign ? query.is('campaign_id', null) : query)
      .order('created_at', { ascending: false })
      .limit(MAX_COUPONS);
  };

  let { data, error } = await list(!includeCampaign);
  if (error && !includeCampaign && isMissingColumnError(error)) {
    ({ data, error } = await list(false));
  }

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
