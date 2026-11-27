import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { parseShopSettingsPatch } from '@/lib/shop/owner';
import { SHOP_MIGRATION_HINT } from '@/lib/shop/server';

export const dynamic = 'force-dynamic';

// PATCH /api/owner/shop/settings — owner only. The online offer, shipping and
// the Beanies cap (validated by parseShopSettingsPatch, lib/shop/owner.ts):
//   { offer_active?, offer_name?, offer_tier_prices?: number[],
//     shipping_fee_inr?, free_shipping_min_inr?, beanies_max_redeem_pct? }
// offer_tier_prices[n - 1] is what n jars cost (2–6 tiers, each more than the
// last), e.g. [399, 599, 749]. Only checkouts started after the change are
// priced by it; orders already placed keep what they paid. Responds { settings }.
export async function PATCH(request: Request) {
  if (!(await getOwnerUser())) return unauthorized();
  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const parsed = parseShopSettingsPatch(body);
  if (!parsed.ok) return errorResponse(400, parsed.error);
  const patch = parsed.patch;

  const { data, error } = await createAdminSupabaseClient()
    .from('shop_settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('is_singleton', true)
    .select('*')
    .maybeSingle();
  if (error) {
    if (error.code === '42703' || error.code === 'PGRST204') {
      return errorResponse(503, 'Apply supabase/2026-11-shop-v2.sql to change shipping and Beanies settings');
    }
    console.error('owner shop settings update failed', error);
    return errorResponse(500, 'Could not save that just now — please try again.');
  }
  if (!data) return errorResponse(503, `The offer settings aren't set up yet — ${SHOP_MIGRATION_HINT}`);
  return NextResponse.json({ settings: data });
}
