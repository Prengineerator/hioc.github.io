// Razorpay for the Instant Coffee shop. Uses the café's gateway functions
// (lib/payments/gateway.ts) but keeps its own record on shop_orders, so a shop
// payment never creates a café `payments` row or moves a café order.
//
// A shop order goes 'payment_pending' → 'paid' by whichever path sees the
// captured payment first, exactly like a café order:
//   POST /api/shop/verify           the Checkout.js success handler
//   POST /api/payments/webhook      Razorpay's server webhook (shared URL; it
//                                   asks captureShopPayment first)
//   GET  /api/shop/orders/[id]      the order page's poll (reconcileShopOrder)
// The step is a conditional update (status still 'payment_pending'), so it
// happens once, and only that call sends the "new order" emails.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { runAfterResponse } from '@/lib/api/background';
import { fetchOrderPaymentAttempts } from '@/lib/payments/gateway';
import { sendShopPaidEmails } from './emails';
import { isMissingShopSchema, toShopOrderRow, updateShopOrderIf } from './server';
import { canShopTransition, shopFromStatuses } from './status';
import type { ShopOrderRow } from './types';

export type ShopCaptureResult =
  | { handled: false }
  | { handled: true; order: ShopOrderRow; newlyPaid: boolean };

/**
 * Marks the shop order behind `gatewayOrderId` paid. `{ handled: false }` means
 * the Razorpay order isn't a shop order (or the shop tables don't exist yet):
 * the caller goes on to the café's captureGatewayPayment. Idempotent.
 */
export async function captureShopPayment(params: {
  gatewayOrderId: string;
  gatewayPaymentId: string;
  method?: string;
  capturedAmountPaise?: number;
}): Promise<ShopCaptureResult> {
  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('shop_orders')
    .select('*')
    .eq('razorpay_order_id', params.gatewayOrderId)
    .maybeSingle();
  if (error) {
    if (!isMissingShopSchema(error)) console.error('captureShopPayment: lookup failed', error);
    return { handled: false };
  }
  if (!data) return { handled: false };

  const order = toShopOrderRow(data as Record<string, unknown>);
  if (!canShopTransition('capture', order.status, 'paid').ok) return { handled: true, order, newlyPaid: false };

  // Razorpay binds the amount to the order, so a mismatch is anomalous: the
  // money has moved, so it is recorded, and logged loudly to be looked at.
  if (typeof params.capturedAmountPaise === 'number' && params.capturedAmountPaise !== order.total_inr * 100) {
    console.error(
      `captureShopPayment: AMOUNT MISMATCH for ${params.gatewayOrderId} — captured ${params.capturedAmountPaise}p vs expected ${order.total_inr * 100}p`,
    );
  }

  const paid = await updateShopOrderIf(admin, order.id, shopFromStatuses('capture', 'paid'), {
    status: 'paid',
    paid_at: new Date().toISOString(),
    razorpay_payment_id: params.gatewayPaymentId,
    payment_method: params.method ?? null,
  });
  if (!paid) {
    // Someone else got there first (or the write failed): read it back as it is.
    const { data: again } = await admin.from('shop_orders').select('*').eq('id', order.id).maybeSingle();
    return { handled: true, order: again ? toShopOrderRow(again as Record<string, unknown>) : order, newlyPaid: false };
  }

  runAfterResponse(sendShopPaidEmails(paid));
  return { handled: true, order: paid, newlyPaid: true };
}

/**
 * For an order still waiting on payment: asks Razorpay whether a payment was
 * captured (the webhook may be late, or not set up) and records it. Returns
 * the order as it now stands.
 */
export async function reconcileShopOrder(order: ShopOrderRow): Promise<ShopOrderRow> {
  if (order.status !== 'payment_pending' || !order.razorpay_order_id) return order;
  const attempts = await fetchOrderPaymentAttempts(order.razorpay_order_id);
  const captured = attempts?.find((a) => a.status === 'captured');
  if (!captured) return order;
  const result = await captureShopPayment({
    gatewayOrderId: order.razorpay_order_id,
    gatewayPaymentId: captured.id,
    method: captured.method,
    capturedAmountPaise: captured.amount,
  });
  return result.handled ? result.order : order;
}
