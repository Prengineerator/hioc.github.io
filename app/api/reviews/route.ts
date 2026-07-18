import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser, getStaffUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import type { Review } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_COMMENT_LENGTH = 1000;
const MAX_REVIEWS = 200;

// POST /api/reviews — public (LOY-3: no-login guest reviews via the order
// link, exactly like the order-status page — the opaque order id in the body
// IS the access control). One review per (order_id, menu_item_id); a null
// menu_item_id is the overall-order review.
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const { order_id, menu_item_id, rating, comment } = body;

  if (!isUuid(order_id)) {
    return errorResponse(400, 'order_id is required and must be a valid uuid');
  }
  if (menu_item_id !== undefined && menu_item_id !== null && !isUuid(menu_item_id)) {
    return errorResponse(400, 'menu_item_id must be a valid uuid or null');
  }
  if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return errorResponse(400, 'rating is required and must be an integer between 1 and 5');
  }
  let trimmedComment = '';
  if (comment !== undefined) {
    if (typeof comment !== 'string') {
      return errorResponse(400, 'comment must be a string');
    }
    trimmedComment = comment.trim().slice(0, MAX_COMMENT_LENGTH);
  }

  const admin = createAdminSupabaseClient();

  const { data: order, error: orderError } = await admin
    .from('orders')
    .select('id, status, order_items(menu_item_id)')
    .eq('id', order_id)
    .maybeSingle();

  if (orderError) {
    return errorResponse(500, 'Failed to load order');
  }
  if (!order) {
    return notFound();
  }
  if (order.status !== 'completed') {
    return errorResponse(409, 'You can rate this order once it has been completed');
  }

  const itemId = (menu_item_id as string | null | undefined) ?? null;
  if (itemId) {
    const orderItemIds = (order.order_items as { menu_item_id: string | null }[] | null ?? [])
      .map((i) => i.menu_item_id)
      .filter((v): v is string => v !== null);
    if (!orderItemIds.includes(itemId)) {
      return errorResponse(400, 'That item is not part of this order');
    }
  }

  // Guest reviews are allowed (attributed via the order, which carries the
  // customer's phone); a logged-in customer's review is attributed to them.
  const user = await getAuthUser();

  const { data, error } = await admin
    .from('reviews')
    .insert({
      order_id,
      menu_item_id: itemId,
      user_id: user?.id ?? null,
      rating,
      comment: trimmedComment,
    })
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      return errorResponse(409, 'This order (or item) has already been reviewed');
    }
    console.error('reviews insert failed', error);
    return errorResponse(500, 'Failed to submit review');
  }

  return NextResponse.json({ review: data as Review }, { status: 201 });
}

// GET /api/reviews — dual-purpose:
//   ?order_id=<uuid>  → public, returns that order's review(s) (same
//                        opaque-id access control as the order-status page).
//   (no order_id)     → staff/owner only, recent reviews for moderation.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const orderId = searchParams.get('order_id');

  const admin = createAdminSupabaseClient();

  if (orderId) {
    if (!isUuid(orderId)) {
      return errorResponse(400, 'order_id must be a valid uuid');
    }
    const { data, error } = await admin
      .from('reviews')
      .select('*')
      .eq('order_id', orderId)
      .order('created_at', { ascending: true });
    if (error) {
      return errorResponse(500, 'Failed to load reviews');
    }
    return NextResponse.json({ reviews: (data ?? []) as Review[] });
  }

  const user = await getStaffUser();
  if (!user) {
    return unauthorized();
  }

  // Staff see everything by default (they need hidden reviews visible to
  // un-hide them); `?hidden=true|false` narrows to just one bucket.
  let query = admin.from('reviews').select('*').order('created_at', { ascending: false }).limit(MAX_REVIEWS);
  const hiddenParam = searchParams.get('hidden');
  if (hiddenParam === 'true' || hiddenParam === 'false') {
    query = query.eq('hidden', hiddenParam === 'true');
  }
  const { data, error } = await query;
  if (error) {
    return errorResponse(500, 'Failed to load reviews');
  }
  return NextResponse.json({ reviews: (data ?? []) as Review[] });
}
