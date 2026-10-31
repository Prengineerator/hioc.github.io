import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { parseOfferInput } from '@/lib/promotions/offerInput';
import { offerWriteError, OFFER_SELECT, toOwnerOffer, type OfferRow } from '@/lib/promotions/offerRoutes';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// PATCH /api/offers/[id] — edit an offer or switch it on/off. Orders already
// placed keep the offer they were sold under (their lines carry a snapshot).
export async function PATCH(request: Request, { params }: RouteParams) {
  const user = await getManagerUser();
  if (!user) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  // The item an offer is on is fixed: a different item is a different offer.
  if ('menu_item_id' in body) return errorResponse(400, 'An offer stays on its item — create a new offer for another one');
  const parsed = parseOfferInput(body, { partial: true });
  if (typeof parsed === 'string') return errorResponse(400, parsed);
  if (Object.keys(parsed).length === 0) return errorResponse(400, 'No writable fields provided');

  const admin = createAdminSupabaseClient();
  const { data: existing, error: readError } = await admin
    .from('menu_offers')
    .select('valid_from, valid_to')
    .eq('id', params.id)
    .maybeSingle();
  if (readError) return offerWriteError(readError, 'Failed to load the offer');
  if (!existing) return notFound();
  // The window is checked as it will be once saved, half old and half new.
  const from = 'valid_from' in parsed ? parsed.valid_from : (existing as { valid_from: string | null }).valid_from;
  const to = 'valid_to' in parsed ? parsed.valid_to : (existing as { valid_to: string | null }).valid_to;
  if (from && to && Date.parse(to) <= Date.parse(from)) return errorResponse(400, 'The offer must end after it starts');

  const { data, error } = await admin
    .from('menu_offers')
    .update({ ...parsed, updated_at: new Date().toISOString() })
    .eq('id', params.id)
    .select(OFFER_SELECT)
    .maybeSingle();
  if (error) return offerWriteError(error, 'Failed to update the offer');
  if (!data) return notFound();
  return NextResponse.json({ offer: toOwnerOffer(data as unknown as OfferRow) });
}

// DELETE /api/offers/[id] — remove an offer. Sold lines keep their snapshot
// (order_items.offer_id is on delete set null).
export async function DELETE(_request: Request, { params }: RouteParams) {
  const user = await getManagerUser();
  if (!user) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin.from('menu_offers').delete().eq('id', params.id).select('id').maybeSingle();
  if (error) return offerWriteError(error, 'Failed to delete the offer');
  if (!data) return notFound();
  return NextResponse.json({ ok: true });
}
