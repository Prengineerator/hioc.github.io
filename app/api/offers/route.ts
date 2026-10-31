import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { parseOfferInput, type OfferInput } from '@/lib/promotions/offerInput';
import { offerWriteError, OFFER_SELECT, toOwnerOffer, type OfferRow } from '@/lib/promotions/offerRoutes';

export const dynamic = 'force-dynamic';

// Multi-buy offers (Promotions → Offers, lib/orders/offers.ts): an offer is its
// own record on one menu item; the item's menu price is never changed. Same gate
// as coupons (manager or owner).

// GET /api/offers — every offer, newest first, with its item's name.
export async function GET() {
  const user = await getManagerUser();
  if (!user) return unauthorized();

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('menu_offers').select(OFFER_SELECT).order('created_at', { ascending: false });
  if (error) return offerWriteError(error, 'Failed to load offers');
  return NextResponse.json({ offers: ((data ?? []) as unknown as OfferRow[]).map(toOwnerOffer) });
}

// POST /api/offers — create one.
export async function POST(request: Request) {
  const user = await getManagerUser();
  if (!user) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = parseOfferInput(body, { partial: false });
  if (typeof parsed === 'string') return errorResponse(400, parsed);
  const input = parsed as OfferInput;

  const admin = createAdminSupabaseClient();
  const { data: item, error: itemError } = await admin
    .from('menu_items')
    .select('id, sold_by_weight')
    .eq('id', input.menu_item_id)
    .maybeSingle();
  if (itemError) return errorResponse(500, 'Failed to check the menu item');
  if (!item) return errorResponse(400, 'That menu item no longer exists');
  if ((item as { sold_by_weight?: boolean }).sold_by_weight === true) {
    return errorResponse(400, 'Offers are for items sold by the unit, not by weight');
  }

  const { data, error } = await admin.from('menu_offers').insert(input).select(OFFER_SELECT).single();
  if (error || !data) return offerWriteError(error, 'Failed to create the offer');
  return NextResponse.json({ offer: toOwnerOffer(data as unknown as OfferRow) }, { status: 201 });
}
