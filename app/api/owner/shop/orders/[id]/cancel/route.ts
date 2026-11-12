import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { runAfterResponse } from '@/lib/api/background';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { createGatewayRefund, fetchGatewayPayment } from '@/lib/payments/gateway';
import { sendShopCancelledEmail } from '@/lib/shop/emails';
import { parseCancelReason } from '@/lib/shop/owner';
import { getShopOrder, updateShopOrderIf } from '@/lib/shop/server';
import { cancelShiprocketOrder } from '@/lib/shop/shiprocket';
import { checkShopAction, refundPendingMarker, shopFromStatuses, shouldCancelInShiprocket } from '@/lib/shop/status';
import type { ShopOrderRow } from '@/lib/shop/types';

export const dynamic = 'force-dynamic';

// POST /api/owner/shop/orders/[id]/cancel — owner only. Body: { reason? }.
// Cancels a paid order and refunds the full amount to the customer through
// Razorpay. If the order is in Shiprocket and not yet with a courier, it is
// cancelled there too (best-effort: a failure comes back as `warning`, to do
// in the Shiprocket panel). A shipped parcel is the owner's to recall in
// Shiprocket; the refund still goes. Responds { order, warning? }.
//
// The refund comes first: if Razorpay refuses it, nothing is changed.
//
// The steps, and what each guards against (lib/shop/status.ts has the rules):
//   1. Claim: refund_id := "pending:<now>", only if the order is still paid and
//      neither marker moved since it was read — no refund already in flight
//      (two clicks), no Send to Shiprocket in flight (it would put the order in
//      Shiprocket after step 3 decided there was nothing there to cancel).
//      While the claim is held no send can start: its claim needs refund_id
//      empty.
//   2. Ask Razorpay whether the payment is already refunded (an earlier
//      attempt whose answer was lost), and refund only if not. Razorpay
//      reports a payment fully refunded as status 'refunded'.
//   3. Read the order again and call the shipment off in Shiprocket if it is
//      there now.
//   4. Save, compare-and-set on the claim. A claim left behind (killed, or the
//      save failed) reads 'unconfirmed' after REFUND_CLAIM_MS and pressing
//      Cancel & refund again finishes from step 1 — step 2 sees the money
//      already went back and does not send it twice.
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

  const nowMs = Date.now();
  const check = checkShopAction('cancel', order, nowMs);
  if (!check.ok) return errorResponse(409, check.code === 'not_allowed' ? 'Only a paid order can be cancelled.' : check.message);

  const cancelFrom = shopFromStatuses('cancel', 'cancelled');
  // Both markers exactly as read: the claim lands only if neither has moved.
  const seen = { refund_id: order.refund_id, shiprocket_sending_at: order.shiprocket_sending_at };

  let current: ShopOrderRow = order;
  let claim: string | null = null;
  let refundId: string | null = null;
  let refundedInr: number | null = null;
  let note: string | null = null;
  if (order.razorpay_payment_id) {
    claim = refundPendingMarker(nowMs);
    const claimed = await updateShopOrderIf(admin, order.id, cancelFrom, { refund_id: claim }, seen);
    if (!claimed) {
      return errorResponse(409, 'The order changed meanwhile (a refund or a Shiprocket send has started) — reload the page.');
    }
    current = claimed;

    const paymentId = order.razorpay_payment_id;
    const before = await fetchGatewayPayment(paymentId);
    if (!before) {
      await releaseRefundClaim(admin, order.id, claim, seen.refund_id);
      return errorResponse(502, "Couldn't reach Razorpay to check this payment, so nothing was changed. Try again in a minute.");
    }
    if (before.status === 'refunded') {
      // Razorpay's id for that refund isn't known here; the amount is.
      refundedInr = order.total_inr;
      note = 'Razorpay had already refunded this payment, so it was not refunded again.';
    } else {
      const refund = await createGatewayRefund(paymentId, order.total_inr, {
        hioc_shop_order_id: order.id,
        reason: reason.reason.slice(0, 200) || 'Cancelled by HIOC',
      });
      if (refund) {
        refundId = refund.id;
        refundedInr = order.total_inr;
      } else {
        // Refused, or no answer at all (the money may have moved): ask again.
        const after = await fetchGatewayPayment(paymentId);
        if (after?.status === 'refunded') {
          refundedInr = order.total_inr;
          note = 'Razorpay refunded this payment but did not answer in time.';
        } else if (after) {
          await releaseRefundClaim(admin, order.id, claim, null);
          return errorResponse(502, 'Razorpay did not accept the refund, so nothing was changed. Try again, or refund from the Razorpay dashboard.');
        } else {
          // Unknown: the claim stays, so nothing can ship this order, and it
          // reads 'unconfirmed' in a few minutes for the retry to resolve.
          return errorResponse(
            502,
            "Razorpay didn't answer, so it isn't known yet whether the refund went through. Don't refund it from the dashboard: press Cancel & refund again in a few minutes — it checks with Razorpay first and never refunds twice.",
          );
        }
      }
    }

    // The order as it is NOW: a send that finished between the first read and
    // the claim has put it in Shiprocket, and that shipment must be called off.
    const fresh = await getShopOrder(admin, order.id);
    if (fresh.ok && fresh.order) current = fresh.order;
  }

  let warning: string | null = null;
  if (shouldCancelInShiprocket(current)) {
    const sr = await cancelShiprocketOrder(current.shiprocket_order_id as string);
    if (!sr.ok) warning = `Refunded, but Shiprocket didn't cancel the shipment (${sr.error}). Cancel it in the Shiprocket panel.`;
  } else if (current.status === 'shipped') {
    warning = 'Refunded. The parcel is already with the courier — arrange its return in the Shiprocket panel.';
  }
  if (note) warning = warning ? `${note} ${warning}` : note;

  const updated = await updateShopOrderIf(
    admin,
    order.id,
    cancelFrom,
    {
      status: 'cancelled',
      cancelled_at: new Date().toISOString(),
      cancel_reason: reason.reason,
      refund_id: refundId,
      refunded_inr: refundedInr,
    },
    // Our own claim; with no payment to refund there is none, so both markers as read.
    claim ? { refund_id: claim } : seen,
  );
  if (!updated) {
    console.error('owner shop cancel: refunded but not saved', order.id, refundId);
    if (!claim) return errorResponse(409, 'The order changed meanwhile — reload the page.');
    return errorResponse(
      500,
      `Refunded ₹${refundedInr ?? 0} (Razorpay refund ${refundId ?? '—'}) but this page could not mark the order cancelled. Don't refund it again: reload, and in a few minutes press Cancel & refund once more to finish — it checks with Razorpay first.`,
    );
  }

  runAfterResponse(sendShopCancelledEmail(updated));
  return NextResponse.json({ order: updated, ...(warning ? { warning } : {}) });
}

/** Puts refund_id back to `to`, only if it still holds our claim. */
async function releaseRefundClaim(admin: SupabaseClient, id: string, claim: string, to: string | null): Promise<void> {
  const { error } = await admin.from('shop_orders').update({ refund_id: to }).eq('id', id).eq('refund_id', claim);
  if (error) console.error('owner shop cancel: could not release the refund claim', id, error);
}
