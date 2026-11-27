import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { computeEarnedPoints, getLoyaltyConfig, shopEarnBaseInr } from '@/lib/loyalty/ledger';
import { reconcileShopOrder } from '@/lib/shop/payments';
import { getShopOrder } from '@/lib/shop/server';
import { PAID_STATUSES, toPublicView } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

// GET /api/shop/orders/[id] — the customer's order page. Public by the order's
// id (a random uuid, sent only to the buyer), and answers the PUBLIC view: the
// parcel, the money and the tracking, not the street address, phone or email.
//
// While the order still waits on payment this asks Razorpay too (the webhook can
// be late), so the page flips to "confirmed" on its own. The view carries
// beanies_to_earn for an order with an account.
export async function GET(request: Request, { params }: { params: { id: string } }) {
  if (!isUuid(params.id)) return notFound();

  // The poll may call Razorpay: bounded per IP (a page polls a few times a minute).
  if (!(await rateLimitOk(`shop-order:${clientIp(request)}`, 120, 600))) {
    return errorResponse(429, 'Too many requests — please wait a minute.');
  }

  const lookup = await getShopOrder(createAdminSupabaseClient(), params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load your order just now — please try again.');
  if (!lookup.order) return notFound();

  const order = await reconcileShopOrder(lookup.order);

  // What the order will earn, for a signed-in buyer while it is paid and on its way (earned on delivery).
  let beanies_to_earn: number | null = null;
  if (order.user_id && PAID_STATUSES.includes(order.status) && order.status !== 'delivered') {
    const config = await getLoyaltyConfig();
    if (config) beanies_to_earn = computeEarnedPoints(shopEarnBaseInr(order), config);
  }
  return NextResponse.json({ order: toPublicView(order, { beanies_to_earn }) }, { headers: { 'Cache-Control': 'no-store' } });
}
