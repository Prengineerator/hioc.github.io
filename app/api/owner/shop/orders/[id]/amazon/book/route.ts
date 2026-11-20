import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { runAfterResponse } from '@/lib/api/background';
import { isUuid } from '@/lib/api/constants';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { amazonColumnsReady, AMAZON_SCHEMA_MISSING_MESSAGE, getShopOrder, updateShopOrderIf } from '@/lib/shop/server';
import { amazonNotConfiguredMessage, isAmazonShippingConfigured, purchaseAmazonShipment } from '@/lib/shop/amazonShipping';
import { verifyAmazonQuote } from '@/lib/shop/amazonQuote';
import { sendShopShippedEmail } from '@/lib/shop/emails';
import { AMAZON_HOLD_SENTINEL, amazonBookingHeld, canShipWithAmazon, shopOrderRef } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';
/** A purchase waits up to ~25 s on Amazon (plus the login); leave room so the function is never cut off mid-booking. */
export const maxDuration = 60;

/** A booking in flight holds its claim this long; after that a retry may go. */
const CLAIM_MS = 2 * 60 * 1000;

/** The label goes in the answer only if it really is a PDF; otherwise the card falls back to Print label (the label route checks too). */
function isPdf(b64: string | null): b64 is string {
  return Boolean(b64) && Buffer.from(b64 as string, 'base64').subarray(0, 5).toString('latin1') === '%PDF-';
}

const CHECK_AMAZON = "Amazon may have booked this — check Amazon Shipping before booking again.";

/**
 * Leaves a hold that never expires: amazon_booking_at at a far-future value, so
 * the claim's stale check can never pass and both carriers refuse the order until
 * the owner clears it (amazon/release-hold). Logs the order id only.
 */
async function hold(admin: ReturnType<typeof createAdminSupabaseClient>, orderId: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { error } = await admin.from('shop_orders').update({ amazon_booking_at: AMAZON_HOLD_SENTINEL }).eq('id', orderId);
    if (!error) return true;
  }
  console.error('owner shop amazon book: could not set the hold', orderId);
  return false;
}

/** Added to a 500 when the hold could not be written: the order is not locked. */
const NOT_LOCKED = ' This order is NOT locked: do not book it again until you have checked Amazon Shipping.';

// POST /api/owner/shop/orders/[id]/amazon/book — owner only. Books the service
// the owner picked on the café's own Amazon Shipping account. THIS CHARGES the
// Amazon account.
//
// Request:  { quote: string } — one `quote` from the /amazon/rates answer, sent
//           back unchanged. Nothing else is read: the order, Amazon's
//           requestToken and rateId, the service name, the price and the parcel
//           all come from the signed quote (valid 15 minutes, for THIS order
//           only), not from the browser.
// Response 200: { order, label?: string, warning?: string }
//           order: the saved order, now 'shipped' with carrier 'amazon'. label:
//           the label PDF as base64 when Amazon returned it with the booking
//           (otherwise open GET /amazon/label). warning: set when Amazon gave no
//           tracking number.
// Errors: { error } with
//   400  no quote, or the quote is invalid or expired (get the prices again),
//   404,
//   409  not a paid, unsent order; a booking already under way (a double tap);
//        or the order is held (see 500 below) until the owner clears it,
//   502  Amazon DEFINITELY refused (a 4xx with reasons, or the request never
//        went out): nothing was booked, the claim is released, retry is safe,
//   500  UNCLEAR: Amazon may have booked ("check Amazon Shipping before booking
//        again": a network error or timeout, a 5xx, or an unreadable answer), OR
//        Amazon booked but the page could not save it (names the shipment id),
//        OR Amazon's answer named a different order's reference. In all of these
//        the order is HELD (amazon_booking_at set far in the future): both Amazon
//        and Shiprocket buttons refuse it until POST /amazon/release-hold,
//   503  Amazon not set up / database file not applied.
//
// A short claim (amazon_booking_at, 2 minutes) stops a double tap buying two
// labels; it is also refused while a Shiprocket send is in flight. After saving,
// the customer's shipped email goes out after the response.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Pick one of the Amazon prices.');
  const checked = verifyAmazonQuote(body.quote, params.id);
  if (!checked.ok) return errorResponse(400, checked.error);
  const { quote } = checked;

  if (!isAmazonShippingConfigured()) return errorResponse(503, amazonNotConfiguredMessage());

  const admin = createAdminSupabaseClient();
  if (!(await amazonColumnsReady(admin))) return errorResponse(503, AMAZON_SCHEMA_MISSING_MESSAGE);
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();
  if (!canShipWithAmazon(order)) {
    return errorResponse(
      409,
      amazonBookingHeld(order)
        ? 'An Amazon booking for this order is unconfirmed. Check Amazon Shipping, then tell this page what you found.'
        : order.status === 'paid' ? 'This order has already been sent with a courier.' : 'Only a paid order can be shipped with Amazon.',
    );
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
    .or(`shiprocket_sending_at.is.null,shiprocket_sending_at.lt."${cutoff}"`)
    .select('id')
    .maybeSingle();
  if (claimError) {
    if (isMissingColumnError(claimError)) return errorResponse(503, AMAZON_SCHEMA_MISSING_MESSAGE);
    console.error('owner shop amazon book: claim failed', claimError.code);
    return errorResponse(500, 'Could not start booking — please try again.');
  }
  if (!claimed) return errorResponse(409, 'This order is already being booked — give it a minute, then reload.');

  const { parcel } = quote;
  const result = await purchaseAmazonShipment(quote.requestToken, quote.rateId);
  if (!result.ok) {
    if (result.ambiguous) {
      // It may have been booked: keep the order held (never release), and send the owner to Amazon.
      console.error('owner shop amazon book: unclear purchase result', order.id);
      const held = await hold(admin, order.id);
      return errorResponse(500, `${CHECK_AMAZON} (${result.error})${held ? '' : NOT_LOCKED}`);
    }
    await admin.from('shop_orders').update({ amazon_booking_at: null }).eq('id', order.id);
    return errorResponse(502, result.error);
  }

  const { purchase } = result;
  // The booking must be for THIS order. Amazon echoes the package reference we sent
  // (packageDocumentDetails[].packageClientReferenceId); if it names another order,
  // don't save or email. If Amazon doesn't echo it we proceed (confirm against Amazon's docs).
  const ref = shopOrderRef(order.order_number);
  if (purchase.packageClientReferenceId && purchase.packageClientReferenceId !== ref) {
    console.error('owner shop amazon book: Amazon answered for a different reference', order.id, purchase.shipmentId);
    const held = await hold(admin, order.id);
    return errorResponse(
      500,
      `Amazon Shipping's answer (shipment ${purchase.shipmentId}) names a different order, so it was not saved to this one. Check that shipment in Amazon Shipping and cancel it if it is wrong.${held ? ' This order is on hold.' : NOT_LOCKED}`,
    );
  }

  // Amazon's own figure when the answer carries one; otherwise the price in the signed quote.
  const charge = purchase.chargeInr !== null && purchase.chargeInr >= 0 ? purchase.chargeInr : Math.round(quote.chargeInr * 100) / 100;
  const now = new Date().toISOString();
  const updated = await updateShopOrderIf(admin, order.id, ['paid'], {
    status: 'shipped',
    carrier: 'amazon',
    amazon_shipment_id: purchase.shipmentId,
    amazon_service_name: quote.serviceName,
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
    // Hold the order for good, then try to at least record the shipment id and tracking number.
    const held = await hold(admin, order.id);
    const { error: minimalError } = await admin
      .from('shop_orders')
      .update({ carrier: 'amazon', amazon_shipment_id: purchase.shipmentId, awb_code: purchase.trackingId })
      .eq('id', order.id)
      .eq('status', 'paid');
    if (minimalError) console.error('owner shop amazon book: minimal save failed too', order.id);
    return errorResponse(
      500,
      `Booked with Amazon Shipping (shipment ${purchase.shipmentId}) but this page could not save it. Don't book it again — reload, and if it still shows "To ship", look the shipment up in Amazon Shipping.${held ? ' This order is on hold.' : NOT_LOCKED}`,
    );
  }

  if (updated.awb_code) runAfterResponse(sendShopShippedEmail(updated));
  const warning = updated.awb_code
    ? undefined
    : 'Booked with Amazon Shipping, but Amazon sent no tracking number yet. Print the label; the customer was not emailed.';
  return NextResponse.json({
    order: updated,
    ...(isPdf(purchase.labelBase64) ? { label: purchase.labelBase64 } : {}),
    ...(warning ? { warning } : {}),
  });
}
