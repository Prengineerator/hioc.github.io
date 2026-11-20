import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { cancelAmazonShipment } from '@/lib/shop/amazonShipping';
import { getShopOrder, updateShopOrderIf } from '@/lib/shop/server';
import { canCancelAmazonLabel } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

// POST /api/owner/shop/orders/[id]/amazon/cancel-label — owner only. Cancels the
// Amazon label BEFORE pickup and returns the order to To ship ('paid'), so it
// can go by Amazon again or by Shiprocket. The customer's payment is untouched
// (to refund the customer, use Cancel order). Amazon gives the label charge
// back to the café's Amazon account under its own rules.
//
// Only allowed while canCancelAmazonLabel(order): carrier amazon, status
// 'shipped', amazon_status empty / PreTransit / PickupCancelled.
//
// The cancel is made in Amazon FIRST; only when Amazon accepts it is the order
// moved shipped -> paid, with carrier, amazon_shipment_id, amazon_service_name,
// amazon_charge_inr, amazon_status, awb_code, courier_name and shipped_at cleared.
//
// Request:  none (empty body).
// Response 200: { order } now 'paid' with the Amazon fields cleared.
// Errors: { error } with 404, 409 (not cancellable: already collected, not an
//   Amazon order, or the order changed meanwhile), 502 (Amazon refused: nothing
//   changed here), 500 (Amazon cancelled but the page could not save it),
//   503.
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const admin = createAdminSupabaseClient();
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();
  if (!canCancelAmazonLabel(order)) {
    return errorResponse(409, "The Amazon label can't be cancelled now: it is not booked with Amazon, or the courier has already collected it.");
  }

  const cancelled = await cancelAmazonShipment(order.amazon_shipment_id as string);
  if (!cancelled.ok) return errorResponse(502, `${cancelled.error} The label was not cancelled.`);

  const updated = await updateShopOrderIf(admin, order.id, ['shipped'], {
    status: 'paid',
    carrier: null,
    amazon_shipment_id: null,
    amazon_service_name: null,
    amazon_charge_inr: null,
    amazon_status: null,
    awb_code: null,
    courier_name: null,
    shipped_at: null,
    amazon_booking_at: null,
  });
  if (!updated) {
    console.error('owner shop amazon cancel-label: cancelled at Amazon but not saved', order.id);
    return errorResponse(500, "The Amazon label was cancelled, but this page could not move the order back to To ship. Reload; if it still shows With courier, don't use that label — it is cancelled.");
  }
  return NextResponse.json({ order: updated });
}
