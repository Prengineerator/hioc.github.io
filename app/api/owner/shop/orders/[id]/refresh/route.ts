import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { runAfterResponse } from '@/lib/api/background';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { sendShopShippedEmail } from '@/lib/shop/emails';
import { getShopOrder, updateShopOrderIf } from '@/lib/shop/server';
import { fetchShiprocketOrder } from '@/lib/shop/shiprocket';
import { shopStatusFromShiprocket } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

// POST /api/owner/shop/orders/[id]/refresh — owner only. Reads the order back
// from Shiprocket: its status, AWB and courier. An AWB moves the order to
// 'shipped' (the customer is emailed the tracking link), 'DELIVERED' to
// 'delivered'. A cancelled or returning (RTO) shipment changes nothing here;
// the owner sees Shiprocket's status and decides. Responds { order }.
export async function POST(_request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const admin = createAdminSupabaseClient();
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();
  if (!order.shiprocket_order_id) return errorResponse(409, "This order hasn't been sent to Shiprocket.");

  const result = await fetchShiprocketOrder(order.shiprocket_order_id);
  if (!result.ok) return errorResponse(502, result.error);
  const { state } = result;

  const next = shopStatusFromShiprocket(order.status, state.status, state.awb);
  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    shiprocket_status: state.status,
    awb_code: state.awb ?? order.awb_code,
    courier_name: state.courier ?? order.courier_name,
    shiprocket_shipment_id: state.shipmentId ?? order.shiprocket_shipment_id,
  };
  if (next === 'shipped') {
    patch.status = 'shipped';
    patch.shipped_at = order.shipped_at ?? now;
  } else if (next === 'delivered') {
    patch.status = 'delivered';
    patch.shipped_at = order.shipped_at ?? now;
    patch.delivered_at = now;
  }

  const updated = await updateShopOrderIf(admin, order.id, [order.status], patch);
  if (!updated) return errorResponse(409, 'The order changed meanwhile — reload the page.');

  if (next === 'shipped' || (next === 'delivered' && order.status === 'sent_to_shiprocket')) {
    runAfterResponse(sendShopShippedEmail(updated));
  }
  return NextResponse.json({ order: updated });
}
