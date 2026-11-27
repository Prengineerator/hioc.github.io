import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { parseSpendOfferInput } from '@/lib/promotions/offerInput';
import {
  SPEND_OFFER_SELECT,
  spendOfferWriteError,
  toOwnerSpendOffer,
  type SpendOfferDbRow,
} from '@/lib/promotions/offerRoutes';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/spend-offers/[id] — edit a spend offer or switch it on/off. Orders
// already placed keep the offer they were priced with (orders.spend_offers).
export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getManagerUser();
  if (!user) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  if ('menu_item_id' in body) return errorResponse(400, 'An offer stays on its item — create a new offer for another one');
  const parsed = parseSpendOfferInput(body, { partial: true });
  if (typeof parsed === 'string') return errorResponse(400, parsed);
  if (Object.keys(parsed).length === 0) return errorResponse(400, 'No writable fields provided');

  const admin = createAdminSupabaseClient();
  const { data: existing, error: readError } = await admin
    .from('spend_offers')
    .select('valid_from, valid_to')
    .eq('id', params.id)
    .maybeSingle();
  if (readError) return spendOfferWriteError(readError, 'Failed to load the offer');
  if (!existing) return notFound();
  const from = 'valid_from' in parsed ? parsed.valid_from : (existing as { valid_from: string | null }).valid_from;
  const to = 'valid_to' in parsed ? parsed.valid_to : (existing as { valid_to: string | null }).valid_to;
  if (from && to && Date.parse(to) <= Date.parse(from)) return errorResponse(400, 'The offer must end after it starts');

  const { data, error } = await admin
    .from('spend_offers')
    .update({ ...parsed, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .select(SPEND_OFFER_SELECT)
    .maybeSingle();
  if (error) return spendOfferWriteError(error, 'Failed to update the offer');
  if (!data) return notFound();
  return NextResponse.json({ offer: toOwnerSpendOffer(data as unknown as SpendOfferDbRow) });
}

// DELETE /api/spend-offers/[id] — remove a spend offer. Bills already made keep it.
export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getManagerUser();
  if (!user) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('spend_offers').delete().eq('id', params.id).select('id').maybeSingle();
  if (error) return spendOfferWriteError(error, 'Failed to delete the offer');
  if (!data) return notFound();
  return NextResponse.json({ ok: true });
}
