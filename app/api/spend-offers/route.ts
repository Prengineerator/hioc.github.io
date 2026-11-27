import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { parseSpendOfferInput, type SpendOfferInput } from '@/lib/promotions/offerInput';
import {
  SPEND_OFFER_SELECT,
  spendOfferWriteError,
  toOwnerSpendOffer,
  type SpendOfferDbRow,
} from '@/lib/promotions/offerRoutes';

export const dynamic = 'force-dynamic';

// Spend offers (Promotions → Offers, lib/orders/offers.ts billOffers): "spend
// ₹1099, get one Instant Coffee jar at ₹49". Its own record on one menu item;
// the item's menu price is never changed. Same gate as coupons (manager or owner).

// GET /api/spend-offers — every spend offer, newest first, with its item's name.
export async function GET() {
  const user = await getManagerUser();
  if (!user) return unauthorized();

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('spend_offers')
    .select(SPEND_OFFER_SELECT)
    .order('created_at', { ascending: false });
  if (error) return spendOfferWriteError(error, 'Failed to load spend offers');
  return NextResponse.json({ offers: ((data ?? []) as unknown as SpendOfferDbRow[]).map(toOwnerSpendOffer) });
}

// POST /api/spend-offers — create one.
export async function POST(request: Request) {
  const user = await getManagerUser();
  if (!user) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = parseSpendOfferInput(body, { partial: false });
  if (typeof parsed === 'string') return errorResponse(400, parsed);
  const input = parsed as SpendOfferInput;

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

  const { data, error } = await admin.from('spend_offers').insert(input).select(SPEND_OFFER_SELECT).single();
  if (error || !data) return spendOfferWriteError(error, 'Failed to create the offer');
  return NextResponse.json({ offer: toOwnerSpendOffer(data as unknown as SpendOfferDbRow) }, { status: 201 });
}
