import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { rateLimitOk, clientIp } from '@/lib/api/rateLimit';
import { hashFeedbackToken, looksLikeFeedbackToken } from '@/lib/feedback/token';
import { withinEditWindow } from '@/lib/feedback/window';
import { upsertOrderReview } from '@/lib/feedback/reviewSync';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { FeedbackRequest, OrderItem, Review } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { token: string } };

const MAX_COMMENT_LENGTH = 1000;

/**
 * Public, token-gated — the opaque token IS the access control (same
 * contract as the order-status page). Never leaks feedback_requests.token_hash
 * or any other request's data: the token is hashed and matched server-side,
 * and the row it resolves to is the only one this request can ever see.
 */
async function loadByToken(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  token: string,
): Promise<{ request: FeedbackRequest; expired: boolean } | null> {
  if (!looksLikeFeedbackToken(token)) return null;
  const tokenHash = hashFeedbackToken(token);
  const { data } = await admin.from('feedback_requests').select('*').eq('token_hash', tokenHash).maybeSingle();
  if (!data) return null;
  const request = data as FeedbackRequest;
  return { request, expired: !withinEditWindow(request.created_at) };
}

// GET /api/feedback/[token] — the order summary + any existing rating, for
// the page to render (and pre-fill on a return visit within the edit window).
export async function GET(_request: Request, { params }: RouteParams) {
  const admin = createAdminSupabaseClient();
  const found = await loadByToken(admin, params.token);
  if (!found) return NextResponse.json({ valid: false, reason: 'not_found' }, { status: 404 });
  if (found.expired) return NextResponse.json({ valid: false, reason: 'expired' }, { status: 410 });

  const { data: orderRow } = await admin
    .from('orders')
    .select('id, order_number, order_items(id, menu_item_id, name_snapshot, quantity, voided)')
    .eq('id', found.request.order_id)
    .maybeSingle();
  if (!orderRow) return NextResponse.json({ valid: false, reason: 'not_found' }, { status: 404 });

  const { data: reviewRows } = await admin.from('reviews').select('*').eq('order_id', found.request.order_id);
  const reviews = (reviewRows ?? []) as Review[];
  const overall = reviews.find((r) => r.menu_item_id === null) ?? null;

  const items = ((orderRow.order_items as (Pick<OrderItem, 'id' | 'menu_item_id' | 'name_snapshot' | 'quantity'> & {
    voided: boolean;
  })[]) ?? []).filter((i) => !i.voided);

  return NextResponse.json({
    valid: true,
    order: { order_number: formatOrderNumber(orderRow.order_number as number), items },
    rating: found.request.rating,
    comment: overall?.comment ?? '',
    itemReviews: reviews
      .filter((r) => r.menu_item_id !== null)
      .map((r) => ({ menu_item_id: r.menu_item_id, thumb: r.rating >= 4 ? 'up' : 'down' })),
  });
}

// POST /api/feedback/[token] — submit or edit (within the 7-day window). Body:
//   { rating: 1-5, comment?: string, itemThumbs?: { [menu_item_id]: 'up'|'down' } }
export async function POST(request: Request, { params }: RouteParams) {
  const allowed = await rateLimitOk(`feedback-submit:${clientIp(request)}:${params.token}`, 10, 600);
  if (!allowed) {
    return errorResponse(429, 'Too many submissions — please wait a moment and try again.');
  }

  const admin = createAdminSupabaseClient();
  const found = await loadByToken(admin, params.token);
  if (!found) return errorResponse(404, 'This feedback link is not valid.');
  if (found.expired) return errorResponse(410, 'This feedback link has expired.');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const rating = body.rating;
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return errorResponse(400, 'rating is required and must be an integer between 1 and 5');
  }
  let comment = '';
  if (body.comment !== undefined) {
    if (typeof body.comment !== 'string') return errorResponse(400, 'comment must be a string');
    comment = body.comment.trim().slice(0, MAX_COMMENT_LENGTH);
  }
  const itemThumbs =
    body.itemThumbs && typeof body.itemThumbs === 'object' && !Array.isArray(body.itemThumbs)
      ? (body.itemThumbs as Record<string, unknown>)
      : {};

  // Only thumbs for items that are genuinely on THIS order — never trust a
  // client-supplied menu_item_id blindly onto the reviews table.
  const { data: orderItemRows } = await admin
    .from('order_items')
    .select('menu_item_id, voided')
    .eq('order_id', found.request.order_id);
  const validItemIds = new Set(
    (orderItemRows ?? [])
      .filter((i) => !i.voided && i.menu_item_id)
      .map((i) => i.menu_item_id as string),
  );

  const now = new Date().toISOString();

  const { error: updateError } = await admin
    .from('feedback_requests')
    .update({ rating, rating_source: 'web_form', responded_at: now, unread: true })
    .eq('id', found.request.id);
  if (updateError) {
    console.error('feedback submit: failed to update request', updateError);
    return errorResponse(500, 'Failed to save your feedback');
  }

  await upsertOrderReview(admin, { orderId: found.request.order_id, menuItemId: null, rating, comment });

  for (const [menuItemId, thumb] of Object.entries(itemThumbs)) {
    if (!validItemIds.has(menuItemId)) continue;
    if (thumb !== 'up' && thumb !== 'down') continue;
    await upsertOrderReview(admin, {
      orderId: found.request.order_id,
      menuItemId,
      rating: thumb === 'up' ? 5 : 1,
      comment: '',
    });
  }

  if (comment) {
    await admin.from('feedback_messages').insert({
      request_id: found.request.id,
      order_id: found.request.order_id,
      phone: found.request.phone,
      direction: 'in',
      body: comment,
    });
  }

  return NextResponse.json({ ok: true });
}
