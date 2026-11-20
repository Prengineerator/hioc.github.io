import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { runAfterResponse } from '@/lib/api/background';
import { isUuid } from '@/lib/api/constants';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { amazonColumnsReady, AMAZON_SCHEMA_MISSING_MESSAGE, getShopOrder, updateShopOrderIf } from '@/lib/shop/server';
import { amazonNotConfiguredMessage, isAmazonShippingConfigured, purchaseAmazonShipment } from '@/lib/shop/amazonShipping';
import { defaultPackageForLines, validatePackage } from '@/lib/shop/catalog';
import { sendShopShippedEmail } from '@/lib/shop/emails';
import { canShipWithAmazon } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

/** A booking in flight holds its claim this long; after that a retry may go. */
const CLAIM_MS = 2 * 60 * 1000;
/** Sanity ceiling on a label price in rupees. */
const MAX_CHARGE_INR = 100000;

// POST /api/owner/shop/orders/[id]/amazon/book — owner only. Books the service
// the owner picked on the café's own Amazon Shipping account. THIS CHARGES the
// Amazon account.
//
// Request:  { requestToken, rateId, serviceName, chargeInr, weight_kg?, length_cm?,
//           breadth_cm?, height_cm? }
//           requestToken and rateId come unchanged from /rates; serviceName and
//           chargeInr (rupees, >= 0) are the service and price the owner saw;
//           the parcel fields should be the parcel /rates priced (none = default).
// Response 200: { order, label?: string, warning?: string }
//           order: the saved order, now 'shipped' with carrier 'amazon'. label:
//           the label PDF as base64 when Amazon returned it with the booking
//           (otherwise open GET /amazon/label). warning: set when Amazon gave no
//           tracking number.
// Errors: { error } with 400 (bad body), 404, 409 (not a paid unsent order, or a
//   booking already under way: a double tap), 502 (Amazon refused: nothing was
//   booked, the claim is released, the reason is in the message), 500 (Amazon
//   booked but the page could not save it: the message names the shipment id
//   and says not to book again), 503 (Amazon not set up / database file not applied).
//
// A short claim (amazon_booking_at, 2 minutes) stops a double tap buying two
// labels. After saving, the customer's shipped email goes out after the response.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Send the chosen Amazon service.');
  const requestToken = typeof body.requestToken === 'string' ? body.requestToken.trim() : '';
  const rateId = typeof body.rateId === 'string' ? body.rateId.trim() : '';
  if (!requestToken || requestToken.length > 4000 || !rateId || rateId.length > 1000) {
    return errorResponse(400, 'Get the Amazon prices again, then pick one.');
  }
  const serviceName = typeof body.serviceName === 'string' ? body.serviceName.trim().slice(0, 100) : '';
  if (!serviceName) return errorResponse(400, 'Send the name of the Amazon service you picked.');
  const seenCharge = typeof body.chargeInr === 'string' && body.chargeInr.trim() !== '' ? Number(body.chargeInr) : body.chargeInr;
  if (typeof seenCharge !== 'number' || !Number.isFinite(seenCharge) || seenCharge < 0 || seenCharge > MAX_CHARGE_INR) {
    return errorResponse(400, 'The price must be a number of rupees, zero or more.');
  }
  const typed = ['weight_kg', 'length_cm', 'breadth_cm', 'height_cm'].some((k) => body[k] !== undefined);
  const pkg = typed ? validatePackage(body) : null;
  if (pkg && !pkg.ok) return errorResponse(400, pkg.error);

  if (!isAmazonShippingConfigured()) return errorResponse(503, amazonNotConfiguredMessage());

  const admin = createAdminSupabaseClient();
  if (!(await amazonColumnsReady(admin))) return errorResponse(503, AMAZON_SCHEMA_MISSING_MESSAGE);
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();
  if (!canShipWithAmazon(order)) {
    return errorResponse(409, order.status === 'paid' ? 'This order has already been sent with a courier.' : 'Only a paid order can be shipped with Amazon.');
  }

  const cutoff = new Date(Date.now() - CLAIM_MS).toISOString();
  const { data: claimed, error: claimError } = await admin
    .from('shop_orders')
    .update({ amazon_booking_at: new Date().toISOString() })
    .eq('id', order.id)
    .eq('status', 'paid')
    .is('shiprocket_order_id', null)
    .is('amazon_shipment_id', null)
    .or(`amazon_booking_at.is.null,amazon_booking_at.lt."${cutoff}"`)
    .select('id')
    .maybeSingle();
  if (claimError) {
    if (isMissingColumnError(claimError)) return errorResponse(503, AMAZON_SCHEMA_MISSING_MESSAGE);
    console.error('owner shop amazon book: claim failed', claimError.code);
    return errorResponse(500, 'Could not start booking — please try again.');
  }
  if (!claimed) return errorResponse(409, 'This order is already being booked — give it a minute, then reload.');

  const parcel = pkg && pkg.ok ? pkg.pkg : defaultPackageForLines(order.lines);
  const result = await purchaseAmazonShipment(requestToken, rateId);
  if (!result.ok) {
    await admin.from('shop_orders').update({ amazon_booking_at: null }).eq('id', order.id);
    return errorResponse(502, result.error);
  }

  const { purchase } = result;
  // Amazon's own figure when the answer carries one; otherwise the price the owner saw.
  const charge = purchase.chargeInr !== null && purchase.chargeInr >= 0 ? purchase.chargeInr : Math.round(seenCharge * 100) / 100;
  const now = new Date().toISOString();
  const updated = await updateShopOrderIf(admin, order.id, ['paid'], {
    status: 'shipped',
    carrier: 'amazon',
    amazon_shipment_id: purchase.shipmentId,
    amazon_service_name: serviceName,
    amazon_charge_inr: charge,
    awb_code: purchase.trackingId,
    courier_name: 'Amazon Shipping',
    package_weight_kg: parcel.weight_kg,
    package_dims_cm: `${parcel.length_cm} × ${parcel.breadth_cm} × ${parcel.height_cm}`,
    shipped_at: now,
    amazon_booking_at: null,
  });
  if (!updated) {
    console.error('owner shop amazon book: booked but not saved', order.id, purchase.shipmentId);
    return errorResponse(
      500,
      `Booked with Amazon Shipping (shipment ${purchase.shipmentId}) but this page could not save it. Don't book it again — reload, and if it still shows "To ship", look the shipment up in Amazon Shipping.`,
    );
  }

  if (updated.awb_code) runAfterResponse(sendShopShippedEmail(updated));
  const warning = updated.awb_code
    ? undefined
    : 'Booked with Amazon Shipping, but Amazon sent no tracking number yet. Print the label; the customer was not emailed.';
  return NextResponse.json({
    order: updated,
    ...(purchase.labelBase64 ? { label: purchase.labelBase64 } : {}),
    ...(warning ? { warning } : {}),
  });
}
