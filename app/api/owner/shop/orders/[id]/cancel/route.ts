import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { runAfterResponse } from '@/lib/api/background';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { cancelGatewayPaymentLink, createGatewayRefund, fetchGatewayPaymentLink } from '@/lib/payments/gateway';
import { sendShopCancelledEmail } from '@/lib/shop/emails';
import { onShopOrderCancelled } from '@/lib/shop/lifecycle';
import { captureShopPaymentLink, paidPaymentOfLink } from '@/lib/shop/payments';
import { adoptLinkByReference } from '@/lib/shop/paymentLinkRecovery';
import { parseCancelReason } from '@/lib/shop/owner';
import { getShopOrder, updateShopOrderIf } from '@/lib/shop/server';
import { cancelAmazonShipment } from '@/lib/shop/amazonShipping';
import { cancelShiprocketOrder } from '@/lib/shop/shiprocket';
import type { ShopOrderRow } from '@/lib/shop/types';
import { canCancel, canCancelAmazonLabel, isAmazonOrder, PAID_STATUSES, shouldCancelInShiprocket } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

/** refund_id while the Razorpay refund call is in flight (stops a double refund). */
const REFUND_PENDING = 'pending';

// POST /api/owner/shop/orders/[id]/cancel — owner only. Body: { reason? }.
// Cancels a paid order and refunds the full amount to the customer through
// Razorpay. If the order is in Shiprocket and not yet with a courier, it is
// cancelled there too (best-effort: a failure comes back as `warning`, to do
// in the Shiprocket panel). An Amazon Shipping label the courier hasn't collected
// is cancelled the same way (a failure comes back as `warning`, to do in Amazon
// Shipping). A shipped parcel is the owner's to recall in
// Shiprocket; the refund still goes. The refund is the money paid (total_inr); Beanies spent
// are returned to the customer's balance, not refunded as money, and Beanies
// earned from the order are taken back. Responds { order, warning?, beanies_returned }.
// beanies_returned is the NET change to the customer's balance: it is negative
// when the order earned more than it spent, i.e. Beanies were taken back. A UI
// must word that as "Beanies taken back", never as "-3 returned". A failed
// return or claim release is retried by the expire-orders cron (14 days).
//
// The refund comes first: if Razorpay refuses it, nothing is changed.
//
// Owner-entered orders (docs/SHOP-OWNER-ORDERS-SPEC.md):
//  - an UNPAID payment-link order: the link is cancelled at Razorpay first, then the
//    order is cancelled; no money moved, so no refund. If Razorpay can't cancel the
//    link the order is NOT cancelled (a live link on a cancelled order could take
//    money for nothing): 502, try again. A link found already paid is captured
//    instead and the cancel answers 409.
//  - a paid OFFLINE order (UPI / cash / bank transfer): the site never held the
//    money, so no Razorpay refund. It is cancelled with refunded_inr = total_inr,
//    refund_id null and the reason noted "refund by hand", and the answer carries
//    refund_by_hand: true so the page reminds the owner to send the money back.
//  - a payment-link order paid through Razorpay has a razorpay_payment_id, so it takes
//    the Razorpay refund path above like any website order.
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
  if (order.status === 'payment_pending' && order.payment_channel === 'payment_link') {
    return cancelUnpaidLinkOrder(admin, order, reason.reason);
  }
  if (!canCancel(order)) return errorResponse(409, 'Only a paid order can be cancelled.');

  // Paid by UPI / cash / bank transfer: the money is the café's to send back by hand.
  const refundByHand = order.payment_channel === 'offline';

  let refundId: string | null = null;
  let refundedInr: number | null = null;
  if (refundByHand) {
    refundedInr = order.total_inr;
  } else if (order.razorpay_payment_id) {
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
    if (!sr.ok) warning = `${refundByHand ? 'Cancelled' : 'Refunded'}, but Shiprocket didn't cancel the shipment (${sr.error}). Cancel it in the Shiprocket panel.`;
  } else if (canCancelAmazonLabel(order)) {
    // An Amazon label the courier hasn't collected: call it off too (best effort, like Shiprocket).
    const az = await cancelAmazonShipment(order.amazon_shipment_id as string);
    if (!az.ok) warning = `${refundByHand ? 'Cancelled' : 'Refunded'}, but Amazon Shipping didn't cancel the label (${az.error}). Cancel it in Amazon Shipping.`;
  } else if (order.status === 'shipped' && isAmazonOrder(order)) {
    warning = `${refundByHand ? 'Cancelled' : 'Refunded'}. The parcel is already with Amazon Shipping — arrange its return with Amazon.`;
  } else if (order.status === 'shipped') {
    warning = `${refundByHand ? 'Cancelled' : 'Refunded'}. The parcel is already with the courier — arrange its return in the Shiprocket panel.`;
  }

  const updated = await updateShopOrderIf(admin, order.id, [...PAID_STATUSES], {
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
    cancel_reason: refundByHand ? (reason.reason ? `${reason.reason} (refund by hand)` : 'Refund by hand') : reason.reason,
    refund_id: refundId,
    refunded_inr: refundedInr,
  });
  if (!updated && refundByHand) return errorResponse(409, 'This order was already cancelled or changed — reload the page.');
  if (!updated) {
    console.error('owner shop cancel: refunded but not saved', order.id, refundId);
    return errorResponse(500, `Refunded ₹${refundedInr ?? 0} (Razorpay refund ${refundId ?? '—'}) but this page could not mark the order cancelled. Reload; don't refund it again.`);
  }

  const { beanies_returned } = await onShopOrderCancelled(admin, updated);
  runAfterResponse(sendShopCancelledEmail(updated));
  return NextResponse.json({ order: updated, ...(warning ? { warning } : {}), beanies_returned, ...(refundByHand ? { refund_by_hand: true } : {}) });
}

/** An owner-entered order whose payment link hasn't been paid: close the link, then the order. No refund (nothing was charged). */
async function cancelUnpaidLinkOrder(admin: ReturnType<typeof createAdminSupabaseClient>, order: ShopOrderRow, reason: string) {
  let linkId = order.razorpay_payment_link_id;
  if (!linkId) {
    // Its link was never confirmed (the create call's answer got lost): look for one by our reference first.
    const adopted = await adoptLinkByReference(admin, order);
    if (adopted.state === 'retry_later') {
      return errorResponse(502, "Couldn't confirm with Razorpay whether a payment link exists, so the order was left as it is. Try again in a moment.");
    }
    if (adopted.state === 'paid') {
      return errorResponse(409, 'The customer has just paid this link, so the order is now paid. Reload, then cancel it as a paid order if you need to.');
    }
    if (adopted.state === 'open') linkId = adopted.link.id;
  }
  if (linkId) {
    const closed = await cancelGatewayPaymentLink(linkId);
    if (!closed) {
      // Razorpay refused: it may have been paid, expired or cancelled a moment ago. Look before deciding.
      const link = await fetchGatewayPaymentLink(linkId);
      const paid = link ? paidPaymentOfLink(link) : null;
      if (link && paid) {
        await captureShopPaymentLink({ paymentLinkId: link.id, shopOrderId: order.id, gatewayPaymentId: paid.id, method: paid.method, capturedAmountPaise: paid.amountPaise });
        return errorResponse(409, 'The customer has just paid this link, so the order is now paid. Reload, then cancel it as a paid order if you need to.');
      }
      if (!link || (link.status !== 'cancelled' && link.status !== 'expired')) {
        return errorResponse(502, "Razorpay didn't cancel the payment link, so the order was left as it is. Try again in a moment.");
      }
    }
  }
  const updated = await updateShopOrderIf(admin, order.id, ['payment_pending'], {
    status: 'cancelled',
    cancelled_at: new Date().toISOString(),
    cancel_reason: reason || 'Payment link cancelled',
  });
  if (!updated) return errorResponse(409, 'This order has changed — reload the page.');
  return NextResponse.json({ order: updated, beanies_returned: 0 });
}
