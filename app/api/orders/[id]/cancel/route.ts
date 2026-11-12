import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { canTransition } from '@/lib/orders/stateMachine';
import { sendOrderNotification } from '@/lib/notifications/engine';
import { broadcastOrderEvent } from '@/lib/realtime/broadcast';
import { reverseForOrder } from '@/lib/loyalty/ledger';
import { canTransitionPayment } from '@/lib/orders/paymentStateMachine';
import { abandonGatewayPayments } from '@/lib/payments/evidence';
import { checkGatewayBeforeCancel } from '@/lib/payments/gatewayCheck';
import type { Order } from '@/lib/types';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// POST /api/orders/[id]/cancel — public (guest self-cancel, no login), gated by
// the opaque order id like GET /api/orders/[id]. Only legal before the order is
// accepted (received → cancelled); once staff have accepted it, the customer
// must call the counter. Records the attributed 'cancelled' event and notifies.
//
// A 'placed' order (waiting on its online payment) is cancelled the way the
// expiry sweep cancels one: the gateway is asked first — a payment that went
// through is recorded and the order goes to the café instead (409) — and the
// order then reads unpaid, its Razorpay orders abandoned, so a capture landing
// later is recorded as an orphan for a refund instead of marking a cancelled
// order paid (lib/orders/paymentStateMachine.ts, 'cancel_placed').
export async function POST(request: Request, { params }: RouteParams) {
  const { id } = params;
  if (!isUuid(id)) {
    return notFound();
  }

  const body = await parseJsonBody(request);
  const reason =
    body && typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim()
      : 'Cancelled by customer';

  const admin = createAdminSupabaseClient();
  const { data: current, error: readError } = await admin
    .from('orders')
    .select('id, status, version, payment_status')
    .eq('id', id)
    .maybeSingle();

  if (readError) return errorResponse(500, 'Failed to load order');
  if (!current) return notFound();

  const from = current.status as Order['status'];
  const check = canTransition(from, 'cancelled', 'customer', reason);
  if (!check.ok) {
    // Most commonly: the order was already accepted (race with staff) — the
    // loser gets a clear message per the F1 edge case.
    return errorResponse(409, 'This order can no longer be cancelled — it may already be in progress.');
  }

  const leavesGateway =
    from === 'placed' &&
    current.payment_status === 'payment_pending' &&
    canTransitionPayment('payment_pending', 'unpaid', 'cancel_placed', 'customer', { orderStatus: from }).ok;
  if (leavesGateway) {
    const paid = await checkGatewayBeforeCancel(admin, id);
    if (paid === 'captured') {
      return errorResponse(409, 'Your payment went through, so the café has your order — ask at the counter to cancel it.');
    }
    if (paid === 'authorized') {
      return errorResponse(409, 'Your payment is still being confirmed — try again in a minute.');
    }
    // 'unreachable': cancel as before; a payment that still lands is recorded
    // as an orphan to refund, never as a paid cancelled order.
  }

  const { data: updated, error: updateError } = await admin
    .from('orders')
    .update({
      status: 'cancelled',
      reject_reason: reason,
      version: (current.version as number) + 1,
      ...(leavesGateway ? { payment_status: 'unpaid' } : {}),
    })
    .eq('id', id)
    .eq('version', current.version)
    .select('*')
    .maybeSingle();

  if (updateError) return errorResponse(500, 'Failed to cancel order');
  if (!updated) {
    return errorResponse(409, 'This order can no longer be cancelled — it may already be in progress.');
  }

  await admin.from('order_status_events').insert({
    order_id: id,
    from_status: from,
    to_status: 'cancelled',
    actor_id: null,
    actor_role: 'customer',
    reason,
  });

  if (leavesGateway) await abandonGatewayPayments(admin, id);

  const order = updated as Order;
  // Credit back any points the customer redeemed at checkout — this order was
  // never fulfilled (H3). Idempotent; a no-op when there was no earn/redemption.
  await reverseForOrder(id);
  await sendOrderNotification(order, 'cancelled');
  await broadcastOrderEvent(id, 'cancelled');

  return NextResponse.json({ order });
}
