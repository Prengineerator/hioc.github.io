// Shared "mark a gateway payment captured" logic (FND-1). Used by both the
// webhook route (app/api/payments/webhook) and the reconcile-poll route
// (app/api/payments/[orderId]/status) so a payment can be confirmed either
// by the signed webhook OR by us polling the gateway — whichever lands
// first — without duplicating the order-transition logic, and staying
// idempotent no matter which path runs (or if both run for the same event).

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { canTransition } from '@/lib/orders/stateMachine';
import { broadcastOrderEvent } from '@/lib/realtime/broadcast';
import { mapRazorpayMethod } from './gateway';
import type { Order, PaymentMethod } from '@/lib/types';

export interface CaptureResult {
  ok: boolean;
  order: Order | null;
  alreadyProcessed?: boolean;
}

/**
 * Marks the `payments` row for `gatewayOrderId` as paid and, if the order is
 * still gated at 'placed', transitions it into the staff queue ('received').
 * Idempotent by gateway_order_id: a payment already 'paid' (duplicate
 * webhook, or webhook racing the reconcile poll) is a no-op success.
 */
export async function captureGatewayPayment(params: {
  gatewayOrderId: string;
  gatewayPaymentId: string;
  method?: string;
  signatureOk: boolean;
}): Promise<CaptureResult> {
  const admin = createAdminSupabaseClient();

  const { data: payment, error: paymentError } = await admin
    .from('payments')
    .select('id, order_id, status, amount_inr')
    .eq('gateway', 'razorpay')
    .eq('gateway_order_id', params.gatewayOrderId)
    .maybeSingle();

  if (paymentError || !payment) {
    console.error('captureGatewayPayment: payment row not found', paymentError);
    return { ok: false, order: null };
  }

  if (payment.status === 'paid') {
    const { data: order } = await admin
      .from('orders')
      .select('*')
      .eq('id', payment.order_id)
      .maybeSingle();
    return { ok: true, order: (order as Order) ?? null, alreadyProcessed: true };
  }

  const method: PaymentMethod = mapRazorpayMethod(params.method);

  await admin
    .from('payments')
    .update({
      status: 'paid',
      gateway_payment_id: params.gatewayPaymentId,
      method,
      signature_ok: params.signatureOk,
      error: '',
    })
    .eq('id', payment.id);

  const { data: current, error: orderReadError } = await admin
    .from('orders')
    .select('id, status, version, payment_status')
    .eq('id', payment.order_id)
    .maybeSingle();

  if (orderReadError || !current) {
    console.error('captureGatewayPayment: order not found', orderReadError);
    return { ok: false, order: null };
  }

  const from = current.status as Order['status'];
  const shouldAdvance = from === 'placed' && canTransition(from, 'received', 'system').ok;

  const patch: Record<string, unknown> = { payment_status: 'paid', payment_method: method };
  if (shouldAdvance) {
    patch.status = 'received';
    patch.version = (current.version as number) + 1;
  }

  let query = admin.from('orders').update(patch).eq('id', payment.order_id);
  if (shouldAdvance) {
    query = query.eq('version', current.version);
  }
  const { data: updated, error: updateError } = await query.select('*').maybeSingle();

  if (updateError || !updated) {
    // Payment is already marked paid above; a lost race on the status bump
    // (someone else transitioned it concurrently) is recoverable on the next
    // reconcile call — don't fail the whole capture over it.
    console.error('captureGatewayPayment: order update failed/raced', updateError);
    const { data: fallback } = await admin
      .from('orders')
      .select('*')
      .eq('id', payment.order_id)
      .maybeSingle();
    return { ok: true, order: (fallback as Order) ?? null };
  }

  if (shouldAdvance) {
    await admin.from('order_status_events').insert({
      order_id: payment.order_id,
      from_status: from,
      to_status: 'received',
      actor_id: null,
      actor_role: 'system',
      reason: 'Payment captured',
    });
    await broadcastOrderEvent(payment.order_id, 'received');
  }

  return { ok: true, order: updated as Order };
}

/** Records a failed payment attempt's gateway error (payment.failed webhook). */
export async function markGatewayPaymentFailed(gatewayOrderId: string, errorMsg: string): Promise<void> {
  const admin = createAdminSupabaseClient();
  const { error } = await admin
    .from('payments')
    .update({ error: errorMsg.slice(0, 500) })
    .eq('gateway', 'razorpay')
    .eq('gateway_order_id', gatewayOrderId);
  if (error) {
    console.error('markGatewayPaymentFailed: update failed', error);
  }
}
