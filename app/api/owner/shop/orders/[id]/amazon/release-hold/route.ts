import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { getShopOrder, toShopOrderRow } from '@/lib/shop/server';
import { AMAZON_HOLD_SENTINEL, amazonBookingHeld } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

// POST /api/owner/shop/orders/[id]/amazon/release-hold — owner only. The owner's
// "I checked Amazon Shipping — nothing was booked" button.
//
// After an unclear Amazon booking (Amazon may have booked it, or booked but this
// page could not save it) the order is HELD: the Amazon and Shiprocket buttons
// refuse it. The owner looks in Amazon Shipping; if no shipment exists for the
// order, this clears the hold so the order can be shipped again. Books nothing.
//
// Request:  none (empty body).
// Response 200: { order } with the hold cleared (still 'paid', no Amazon shipment).
// Errors: { error } with
//   404,
//   409  the order has no hold, is not 'paid', or already has an Amazon shipment
//        id recorded (then it WAS booked: use the order as it is, or cancel the
//        label). Nothing is changed.
// It clears the hold only while status is 'paid' and amazon_shipment_id is null.
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const admin = createAdminSupabaseClient();
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();
  if (!amazonBookingHeld(order) || order.status !== 'paid' || order.amazon_shipment_id) {
    return errorResponse(409, order.amazon_shipment_id ? 'Amazon did book this order (it has a shipment on record), so the hold stays.' : 'This order has no Amazon hold to clear.');
  }

  const { data, error } = await admin
    .from('shop_orders')
    .update({ amazon_booking_at: null })
    .eq('id', order.id)
    .eq('status', 'paid')
    .is('amazon_shipment_id', null)
    .eq('amazon_booking_at', AMAZON_HOLD_SENTINEL)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('owner shop amazon release-hold: failed', order.id);
    return errorResponse(500, 'Could not clear the hold — please try again.');
  }
  if (!data) return errorResponse(409, 'The order changed meanwhile — reload the page.');
  return NextResponse.json({ order: toShopOrderRow(data as Record<string, unknown>) });
}
