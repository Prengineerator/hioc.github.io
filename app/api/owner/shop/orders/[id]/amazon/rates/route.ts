import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { amazonColumnsReady, AMAZON_SCHEMA_MISSING_MESSAGE, getShopOrder } from '@/lib/shop/server';
import { amazonNotConfiguredMessage, getAmazonRates, isAmazonShippingConfigured } from '@/lib/shop/amazonShipping';
import { defaultPackageForLines, validatePackage } from '@/lib/shop/catalog';
import { signAmazonQuote } from '@/lib/shop/amazonQuote';
import { amazonBookingHeld, canShipWithAmazon } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

// POST /api/owner/shop/orders/[id]/amazon/rates — owner only. Asks the café's
// Amazon Shipping account what it would charge for this paid order's parcel.
// Books and charges NOTHING (the only Amazon call is "get rates").
//
// Request:  { weight_kg, length_cm, breadth_cm, height_cm } (the parcel the owner
//           confirmed, same limits as the Shiprocket dialog), or no body / {} to
//           use the default parcel for the order's lines (defaultPackageForLines).
// Response 200: {
//   requestToken: string,            // Amazon's token (informational; /book needs only `quote`)
//   rates: [{ rateId, serviceName, carrierName,
//             chargeInr: number,     // rupees, cheapest first
//             deliveryBy: string | null,   // ISO time, null if Amazon gave none
//             quote: string }],      // signed, opaque: send it to /book as { quote }
//   parcel: { weight_kg, length_cm, breadth_cm, height_cm },  // what was priced
// }
// Each `quote` is an HMAC-signed bundle of this order's id, Amazon's requestToken
// and rateId, the service name, the price shown and the parcel, valid 15 minutes.
// /book takes those from the verified quote, never from the browser.
// Errors: { error } with 400 (bad parcel), 404, 409 (not a paid, unsent order),
//   502 (Amazon refused or has no service for the pincode: the message says so,
//   "use Shiprocket"), 503 (Amazon not set up, naming the missing Vercel
//   settings; or the database file not applied yet).
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  const typed = body !== null && ['weight_kg', 'length_cm', 'breadth_cm', 'height_cm'].some((k) => body[k] !== undefined);
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
    return errorResponse(
      409,
      amazonBookingHeld(order)
        ? 'An Amazon booking for this order is unconfirmed. Check Amazon Shipping, then tell this page what you found.'
        : order.status === 'paid' ? 'This order has already been sent with a courier.' : 'Only a paid order can be shipped with Amazon.',
    );
  }

  const parcel = pkg && pkg.ok ? pkg.pkg : defaultPackageForLines(order.lines);
  const result = await getAmazonRates(order, parcel);
  if (!result.ok) return errorResponse(502, result.error);
  const signed = [];
  for (const r of result.rates) {
    const quote = signAmazonQuote({ orderId: order.id, requestToken: result.requestToken, rateId: r.rateId, serviceName: r.serviceName, chargeInr: r.chargeInr, parcel });
    if (!quote) return errorResponse(503, 'Could not sign the Amazon prices just now — please try again.');
    signed.push({ ...r, quote });
  }
  return NextResponse.json({ requestToken: result.requestToken, rates: signed, parcel });
}
