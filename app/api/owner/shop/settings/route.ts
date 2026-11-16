import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { normalizeOfferTiers } from '@/lib/shop/pricing';
import { SHOP_MIGRATION_HINT } from '@/lib/shop/server';

export const dynamic = 'force-dynamic';

// PATCH /api/owner/shop/settings — owner only. The online offer:
//   { offer_active?: boolean, offer_name?: string, offer_tier_prices?: number[] }
// offer_tier_prices[n - 1] is what n jars cost (2–6 tiers, each more than the
// last), e.g. [399, 599, 749]. Only checkouts started after the change are
// priced by it; orders already placed keep what they paid. Responds { settings }.
export async function PATCH(request: Request) {
  if (!(await getOwnerUser())) return unauthorized();
  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const patch: Record<string, unknown> = {};
  if (body.offer_active !== undefined) {
    if (typeof body.offer_active !== 'boolean') return errorResponse(400, 'offer_active must be true or false');
    patch.offer_active = body.offer_active;
  }
  if (body.offer_name !== undefined) {
    const name = typeof body.offer_name === 'string' ? body.offer_name.replace(/\s+/g, ' ').trim() : '';
    if (name.length < 1 || name.length > 40) return errorResponse(400, 'Offer name must be 1–40 characters');
    patch.offer_name = name;
  }
  if (body.offer_tier_prices !== undefined) {
    const tiers = normalizeOfferTiers(body.offer_tier_prices);
    if (!tiers) {
      return errorResponse(400, 'Prices must be whole rupees for 2 to 6 jar counts, each more than the one before (e.g. 399, 599, 749).');
    }
    patch.offer_tier_prices = tiers;
  }
  if (Object.keys(patch).length === 0) return errorResponse(400, 'Nothing to change');

  const { data, error } = await createAdminSupabaseClient()
    .from('shop_settings')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('is_singleton', true)
    .select('offer_active, offer_name, offer_tier_prices')
    .maybeSingle();
  if (error) {
    console.error('owner shop settings update failed', error);
    return errorResponse(500, 'Could not save that just now — please try again.');
  }
  if (!data) return errorResponse(503, `The offer settings aren't set up yet — ${SHOP_MIGRATION_HINT}`);
  return NextResponse.json({ settings: data });
}
