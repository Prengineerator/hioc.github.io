import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { runAfterResponse } from '@/lib/api/background';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { defaultPackageForLines, validatePackage } from '@/lib/shop/catalog';
import { sendShopShippedEmail } from '@/lib/shop/emails';
import { getShopOrder, saveShiprocketTotal, updateShopOrderIf } from '@/lib/shop/server';
import { createShiprocketOrder, fetchShiprocketOrder, isShiprocketConfigured, SHIPROCKET_NOT_CONFIGURED } from '@/lib/shop/shiprocket';
import { amazonBookingHeld, canSendToShiprocket, shiprocketBillWarning } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

/** A send in flight holds its claim this long; after that a retry may go. */
const CLAIM_MS = 2 * 60 * 1000;

// POST /api/owner/shop/orders/[id]/shiprocket — owner only. The one click:
// creates this paid order in Shiprocket with the parcel the owner confirmed.
// Body: { weight_kg, length_cm, breadth_cm, height_cm }, or none to use the
// default parcel for the order's lines (defaultPackageForLines). Responds
// { order, warning? }.
//
// Creating the Shiprocket order spends nothing; the courier, label and pickup
// are chosen in the Shiprocket panel, and Refresh reads the AWB back. A short
// claim (shiprocket_sending_at) stops a double click from creating it twice.
//
// Right after creating it, the order is read back once for Shiprocket's own
// total, so a bill that doesn't match what the customer paid is flagged (the
// warning) while it can still be corrected, before a courier is booked. That
// read is best effort: if it fails, the send still stands and Refresh checks
// the bill later.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  // A body with no parcel fields uses the default worked out from the order's
  // lines; whatever the owner typed is validated as before.
  const typed = body !== null && ['weight_kg', 'length_cm', 'breadth_cm', 'height_cm'].some((k) => body[k] !== undefined);
  const pkg = typed ? validatePackage(body) : null;
  if (pkg && !pkg.ok) return errorResponse(400, pkg.error);

  if (!isShiprocketConfigured()) return errorResponse(503, SHIPROCKET_NOT_CONFIGURED);

  const admin = createAdminSupabaseClient();
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();
  if (!canSendToShiprocket(order)) {
    return errorResponse(
      409,
      order.shiprocket_order_id
        ? 'This order is already in Shiprocket.'
        : amazonBookingHeld(order) || order.amazon_shipment_id
          ? 'This order has an Amazon Shipping booking (or an unconfirmed one) — check Amazon Shipping first.'
          : 'Only a paid order can be sent to Shiprocket.',
    );
  }

  const cutoff = new Date(Date.now() - CLAIM_MS).toISOString();
  // The claim also refuses an order Amazon has booked or is booking (the other carrier's
  // claim does the same for us). Before supabase/2026-11-shop-amazon-shipping.sql those
  // columns don't exist: the query then errors with a missing column, and the old claim runs.
  const claim = (withAmazon: boolean) => {
    let q = admin
      .from('shop_orders')
      .update({ shiprocket_sending_at: new Date().toISOString() })
      .eq('id', order.id)
      .eq('status', 'paid')
      .is('shiprocket_order_id', null)
      .or(`shiprocket_sending_at.is.null,shiprocket_sending_at.lt."${cutoff}"`);
    if (withAmazon) q = q.is('amazon_shipment_id', null).or(`amazon_booking_at.is.null,amazon_booking_at.lt."${cutoff}"`);
    return q.select('id').maybeSingle();
  };
  let { data: claimed, error: claimError } = await claim(true);
  if (claimError && isMissingColumnError(claimError)) ({ data: claimed, error: claimError } = await claim(false));
  if (claimError) {
    console.error('owner shop send: claim failed', claimError);
    return errorResponse(500, 'Could not start sending — please try again.');
  }
  if (!claimed) return errorResponse(409, 'This order is already being sent — give it a minute, then reload.');

  const parcel = pkg && pkg.ok ? pkg.pkg : defaultPackageForLines(order.lines);
  const result = await createShiprocketOrder(order, parcel);
  if (!result.ok) {
    await admin.from('shop_orders').update({ shiprocket_sending_at: null }).eq('id', order.id);
    return errorResponse(502, result.error);
  }

  const { created } = result;
  const now = new Date().toISOString();
  const shipped = Boolean(created.awb);
  const updated = await updateShopOrderIf(admin, order.id, ['paid'], {
    status: shipped ? 'shipped' : 'sent_to_shiprocket',
    shiprocket_order_id: created.shiprocketOrderId,
    shiprocket_shipment_id: created.shipmentId,
    shiprocket_status: created.status,
    awb_code: created.awb,
    courier_name: created.courier,
    package_weight_kg: parcel.weight_kg,
    package_dims_cm: `${parcel.length_cm} × ${parcel.breadth_cm} × ${parcel.height_cm}`,
    sent_to_shiprocket_at: now,
    shipped_at: shipped ? now : null,
    shiprocket_sending_at: null,
  });
  if (!updated) {
    console.error('owner shop send: created in Shiprocket but not saved', order.id, created);
    return errorResponse(
      500,
      `Created in Shiprocket (order ${created.shiprocketOrderId}) but this page could not save it. Don't send it again — reload, and if it still shows "To ship", mark it shipped by hand once it has an AWB.`,
    );
  }

  if (shipped) runAfterResponse(sendShopShippedEmail(updated));

  const details = await fetchShiprocketOrder(created.shiprocketOrderId);
  const total = details.ok ? details.state.total : null;
  if (total === null) return NextResponse.json({ order: updated });
  const saved = await saveShiprocketTotal(admin, updated, total);
  const bill = shiprocketBillWarning({ ...updated, shiprocket_total_inr: total }); // warn even if the save didn't go through
  return NextResponse.json(bill ? { order: saved, warning: `Sent to Shiprocket — but check the amount. ${bill}` } : { order: saved });
}
