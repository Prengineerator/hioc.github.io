import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { getAmazonTracking } from '@/lib/shop/amazonShipping';
import { onShopOrderDelivered } from '@/lib/shop/lifecycle';
import { getShopOrder, updateShopOrderIf } from '@/lib/shop/server';
import { isAmazonOrder, shopStatusFromAmazon } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

// POST /api/owner/shop/orders/[id]/amazon/refresh — owner only. Reads Amazon's
// tracking for the order and saves its status (amazon_status). When Amazon says
// Delivered, the order moves shipped -> delivered and the customer's Beanies are
// earned, once (the same path as a Shiprocket order). Any other status only
// updates amazon_status: it never moves the order backwards, and Rejected,
// Undeliverable and Lost never read as delivered.
//
// Request:  none (empty body).
// Response 200: { order } with the latest amazon_status (and status 'delivered'
//           when delivered).
// Errors: { error } with 404, 409 (not an Amazon order with a courier, or the
//   order changed meanwhile), 502 (Amazon would not answer), 503.
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const admin = createAdminSupabaseClient();
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();
  if (!isAmazonOrder(order) || (order.status !== 'shipped' && order.status !== 'delivered')) {
    return errorResponse(409, "This order isn't with Amazon Shipping.");
  }
  if (!order.awb_code) return errorResponse(409, 'This order has no Amazon tracking number to read.');

  const result = await getAmazonTracking(order.awb_code);
  if (!result.ok) return errorResponse(502, result.error);
  const { tracking } = result;

  const next = shopStatusFromAmazon(order.status, tracking.status);
  const patch: Record<string, unknown> = { amazon_status: tracking.status ?? order.amazon_status };
  if (next === 'delivered') {
    patch.status = 'delivered';
    patch.shipped_at = order.shipped_at ?? new Date().toISOString();
    patch.delivered_at = new Date().toISOString();
  }

  const updated = await updateShopOrderIf(admin, order.id, [order.status], patch);
  if (!updated) return errorResponse(409, 'The order changed meanwhile — reload the page.');
  if (next === 'delivered') await onShopOrderDelivered(updated);
  return NextResponse.json({ order: updated });
}
