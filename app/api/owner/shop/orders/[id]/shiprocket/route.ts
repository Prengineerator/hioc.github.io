import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { runAfterResponse } from '@/lib/api/background';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { validatePackage } from '@/lib/shop/catalog';
import { sendShopShippedEmail } from '@/lib/shop/emails';
import { getShopOrder, updateShopOrderIf } from '@/lib/shop/server';
import { createShiprocketOrder, isShiprocketConfigured, SHIPROCKET_NOT_CONFIGURED } from '@/lib/shop/shiprocket';
import { canSendToShiprocket } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

/** A send in flight holds its claim this long; after that a retry may go. */
const CLAIM_MS = 2 * 60 * 1000;

// POST /api/owner/shop/orders/[id]/shiprocket — owner only. The one click:
// creates this paid order in Shiprocket with the parcel the owner confirmed.
// Body: { weight_kg, length_cm, breadth_cm, height_cm }. Responds { order }.
//
// Creating the Shiprocket order spends nothing; the courier, label and pickup
// are chosen in the Shiprocket panel, and Refresh reads the AWB back. A short
// claim (shiprocket_sending_at) stops a double click from creating it twice.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const body = await parseJsonBody(request);
  const pkg = validatePackage(body ?? {});
  if (!pkg.ok) return errorResponse(400, pkg.error);

  if (!isShiprocketConfigured()) return errorResponse(503, SHIPROCKET_NOT_CONFIGURED);

  const admin = createAdminSupabaseClient();
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();
  if (!canSendToShiprocket(order)) {
    return errorResponse(409, order.shiprocket_order_id ? 'This order is already in Shiprocket.' : 'Only a paid order can be sent to Shiprocket.');
  }

  const cutoff = new Date(Date.now() - CLAIM_MS).toISOString();
  const { data: claimed, error: claimError } = await admin
    .from('shop_orders')
    .update({ shiprocket_sending_at: new Date().toISOString() })
    .eq('id', order.id)
    .eq('status', 'paid')
    .is('shiprocket_order_id', null)
    .or(`shiprocket_sending_at.is.null,shiprocket_sending_at.lt."${cutoff}"`)
    .select('id')
    .maybeSingle();
  if (claimError) {
    console.error('owner shop send: claim failed', claimError);
    return errorResponse(500, 'Could not start sending — please try again.');
  }
  if (!claimed) return errorResponse(409, 'This order is already being sent — give it a minute, then reload.');

  const result = await createShiprocketOrder(order, pkg.pkg);
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
    package_weight_kg: pkg.pkg.weight_kg,
    package_dims_cm: `${pkg.pkg.length_cm} × ${pkg.pkg.breadth_cm} × ${pkg.pkg.height_cm}`,
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
  return NextResponse.json({ order: updated });
}
