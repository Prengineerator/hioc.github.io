import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { runAfterResponse } from '@/lib/api/background';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { createGatewayRefund } from '@/lib/payments/gateway';
import { sendShopCancelledEmail } from '@/lib/shop/emails';
import { parseCancelReason } from '@/lib/shop/owner';
import { getShopOrder, updateShopOrderIf } from '@/lib/shop/server';
import { cancelShiprocketOrder } from '@/lib/shop/shiprocket';
import { canCancel, PAID_STATUSES, shouldCancelInShiprocket } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

/** refund_id while the Razorpay refund call is in flight (stops a double refund). */
const REFUND_PENDING = 'pending';

// POST /api/owner/shop/orders/[id]/cancel — owner only. Body: { reason? }.
// Cancels a paid order and refunds the full amount to the customer through
// Razorpay. If the order is in Shiprocket and not yet with a courier, it is
// cancelled there too (best-effort: a failure comes back as `warning`, to do
// in the Shiprocket panel). A shipped parcel is the owner's to recall in
// Shiprocket; the refund still goes. Responds { order, warning? }.
//
// The refund comes first: if Razorpay refuses it, nothing is changed.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();

  const body = (await parseJsonBody(request)) ?? {};
  const reason = parseCancelReason(body.reason);
  if (!reason.ok) return errorResponse(400, reason.error);

  const admin = createAdminSupabaseClient();
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();
  if (!canCancel(order)) return errorResponse(409, 'Only a paid order can be cancelled.');

  let refundId: string | null = null;
  let refundedInr: number | null = null;
  if (order.razorpay_payment_id) {
    // Claim the refund so a second click can't issue another.
    const { data: claimed } = await admin
      .from('shop_orders')
      .update({ refund_id: REFUND_PENDING })
      .eq('id', order.id)
      .in('status', [...PAID_STATUSES])
      .is('refund_id', null)
      .select('id')
      .maybeSingle();
    if (!claimed) return errorResponse(409, 'A refund for this order is already under way — reload the page.');

    const refund = await createGatewayRefund(order.razorpay_payment_id, order.total_inr, {
      hioc_shop_order_id: order.id,
      reason: reason.reason.slice(0, 200) || 'Cancelled by HIOC',
    });
    if (!refund) {
      await admin.from('shop_orders').update({ refund_id: null }).eq('id', order.id);
      return errorResponse(502, 'Razorpay did not accept the refund, so nothing was changed. Try again, or refund from the Razorpay dashboard.');
    }
    refundId = refund.id;
    refundedInr = order.total_inr;
  }

  let warning: string | null = null;
  if (shouldCancelInShiprocket(order)) {
    const sr = await cancelShiprocketOrder(order.shiprocket_order_id as string);
    if (!sr.ok) warning = `Refunded, but Shiprocket didn't cancel the shipment (${sr.error}). Cancel it in the Shiprocket panel.`;
  } else if (order.status === 'shipped') {
    warning = 'Refunded. The parcel is already with the courier — arrange its return in the Shiprocket panel.';
  }

  const updated = await updateShopOrderIf(admin, order.id, [...PAID_STATUSES], {
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
    cancel_reason: reason.reason,
    refund_id: refundId,
    refunded_inr: refundedInr,
  });
  if (!updated) {
    console.error('owner shop cancel: refunded but not saved', order.id, refundId);
    return errorResponse(500, `Refunded ₹${refundedInr ?? 0} (Razorpay refund ${refundId ?? '—'}) but this page could not mark the order cancelled. Reload; don't refund it again.`);
  }

  runAfterResponse(sendShopCancelledEmail(updated));
  return NextResponse.json({ order: updated, ...(warning ? { warning } : {}) });
}
