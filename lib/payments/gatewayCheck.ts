// "Before this order stops waiting on the gateway, did the customer pay?" —
// asked by the auto-expiry sweep (app/api/cron/expire-orders) and by a
// customer cancelling a 'placed' order (app/api/orders/[id]/cancel). Without a
// webhook (or if it was missed), a customer who paid and closed the tab would
// otherwise have a paid order cancelled. A captured payment is recorded
// (captureGatewayPayment) and the order moves into the staff queue instead.

import 'server-only';
import type { createAdminSupabaseClient } from '@/lib/supabase-server';
import { fetchOrderPaymentAttempts } from './gateway';
import { captureGatewayPayment } from './reconcile';

type Admin = ReturnType<typeof createAdminSupabaseClient>;

/**
 *   'captured'     a payment was captured — recorded now; the order is paid
 *   'unpaid'       nothing was paid on any of its Razorpay orders
 *   'authorized'   a payment is authorized but not yet captured: money is held
 *                  and auto-capture is on its way, so don't cancel now
 *   'unreachable'  the gateway (or our payments rows) could not be read
 */
export type GatewayPaidCheck = 'captured' | 'unpaid' | 'authorized' | 'unreachable';

export async function checkGatewayBeforeCancel(admin: Admin, orderId: string): Promise<GatewayPaidCheck> {
  const { data: payments, error } = await admin
    .from('payments')
    .select('gateway_order_id')
    .eq('order_id', orderId)
    .eq('gateway', 'razorpay');
  if (error) return 'unreachable';

  let result: GatewayPaidCheck = 'unpaid';
  for (const p of payments ?? []) {
    if (!p.gateway_order_id) continue;
    const attempts = await fetchOrderPaymentAttempts(p.gateway_order_id as string);
    if (!attempts) {
      if (result === 'unpaid') result = 'unreachable';
      continue;
    }
    const captured = attempts.find((a) => a.status === 'captured');
    if (captured) {
      const capture = await captureGatewayPayment({
        gatewayOrderId: p.gateway_order_id as string,
        gatewayPaymentId: captured.id,
        method: captured.method,
        signatureOk: false, // reconciled via API poll, not a signed webhook
        capturedAmountPaise: captured.amount, // M5 cross-check
      });
      return capture.ok ? 'captured' : 'unreachable';
    }
    if (attempts.some((a) => a.status === 'authorized')) result = 'authorized';
  }
  return result;
}
