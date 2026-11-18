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
// The step is a conditional update (status still 'payment_pending', or
// 'expired': money taken after the payment window closed is honoured, and
// logged as PAID AFTER EXPIRY), so it happens once, and only that call sends
// the "new order" emails.
//
// Capture effects (docs/SHOP-V2-SPEC.md E2a, E3, E7): what must happen once an
// order is paid, kept apart from the status step so a crash between them is
// repaired rather than lost. applyCaptureEffects runs whenever an order is paid
// and shop_orders.capture_effects_at is still null, on the capturing call AND on
// every later verify / webhook / order-page poll, until all steps succeed:
//   a  introductory offer   claim_shop_intro_offer ('reused' is logged and the
//                           order honoured; the RPC flags intro_offer_reused)
//   b  coupon               record_shop_coupon_redemption ('over_limit' is
//                           logged and honoured: the money is taken)
//   c  address              a signed-in customer who ticked "save this address"
//                           gets it saved NOW, not at checkout, so an abandoned
//                           payment saves nothing; an address already saved is
//                           reused, not duplicated; the 10-address limit skips
//   d  last used            the saved address used is stamped last_used_at
//   e  capture_effects_at   set only when a-d all went through
// Every step is idempotent (the RPCs answer 'already'), and one failing step is
// logged and leaves the stamp null so the next call retries it.
//
// Beanies are RESERVED at checkout, and a failed payment does NOT release them
// here: Checkout.js may retry the same Razorpay order. SV2-09's expiry pass
// releases them when the pending order expires or is cancelled.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { runAfterResponse } from '@/lib/api/background';
import { fetchOrderPaymentAttempts } from '@/lib/payments/gateway';
import { sendShopPaidEmails } from './emails';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CreatedPaymentIntent } from '@/lib/payments/types';
import { sameDeliveryAddress } from './address';
import { isMissingShopSchema, toShopOrderRow, updateShopOrderIf } from './server';
import { isPaidStatus } from './status';
import type { ShopOrderRow } from './types';

/** The Razorpay intent for an order already opened (a repeat checkout gets this back, with no new Razorpay order). */
export function paymentIntentFor(order: Pick<ShopOrderRow, 'razorpay_order_id' | 'total_inr'>): CreatedPaymentIntent | null {
  if (!order.razorpay_order_id) return null;
  return {
    gateway: 'razorpay',
    gatewayOrderId: order.razorpay_order_id,
    amountInr: order.total_inr,
    keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || process.env.RAZORPAY_KEY_ID,
  };
}

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
  if (order.status !== 'payment_pending' && order.status !== 'expired') {
    // Already paid (or cancelled): finish any effects a crash left undone.
    const settled = isPaidStatus(order.status) && !order.capture_effects_at ? await applyCaptureEffects(admin, order) : order;
    return { handled: true, order: settled, newlyPaid: false };
  }

  // Razorpay binds the amount to the order, so a mismatch is anomalous: the
  // money has moved, so it is recorded, and logged loudly to be looked at.
  if (typeof params.capturedAmountPaise === 'number' && params.capturedAmountPaise !== order.total_inr * 100) {
    console.error(
      `captureShopPayment: AMOUNT MISMATCH for ${params.gatewayOrderId} — captured ${params.capturedAmountPaise}p vs expected ${order.total_inr * 100}p`,
    );
  }
  if (order.status === 'expired') {
    console.error(`captureShopPayment: PAID AFTER EXPIRY for ${params.gatewayOrderId} (order ${order.id}) — money was taken, so the order is honoured`);
  }

  const paid = await updateShopOrderIf(admin, order.id, ['payment_pending', 'expired'], {
    status: 'paid',
    paid_at: new Date().toISOString(),
    razorpay_payment_id: params.gatewayPaymentId,
    payment_method: params.method ?? null,
  });
  if (!paid) {
    // Someone else got there first (or the write failed): read it back as it is.
    const { data: again } = await admin.from('shop_orders').select('*').eq('id', order.id).maybeSingle();
    const current = again ? toShopOrderRow(again as Record<string, unknown>) : order;
    const settled = isPaidStatus(current.status) && !current.capture_effects_at ? await applyCaptureEffects(admin, current) : current;
    return { handled: true, order: settled, newlyPaid: false };
  }

  const done = await applyCaptureEffects(admin, paid);
  runAfterResponse(sendShopPaidEmails(done));
  return { handled: true, order: done, newlyPaid: true };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * The once-after-payment work (see the header). Idempotent and safe to call from
 * every capture path: returns immediately for an order not yet paid or already
 * done. Never throws; returns the order with capture_effects_at / customer_address_id
 * as they now stand.
 */
export async function applyCaptureEffects(admin: SupabaseClient, order: ShopOrderRow): Promise<ShopOrderRow> {
  if (!isPaidStatus(order.status) || order.capture_effects_at) return order;
  let current = order;
  let allDone = true;
  const fail = (step: string, err: unknown) => {
    allDone = false;
    console.error(`applyCaptureEffects: ${step} failed for shop order ${order.id}; will retry`, err);
  };

  // (a) the introductory offer, once per customer.
  if (order.intro_offer_applied) {
    try {
      const { data, error } = await admin.rpc('claim_shop_intro_offer', { p_shop_order_id: order.id });
      if (error) fail('intro claim', error);
      else if (data === 'reused') {
        console.warn(`applyCaptureEffects: shop order ${order.id} used the introductory offer a second time (honoured, flagged intro_offer_reused)`);
        current = { ...current, intro_offer_reused: true };
      }
    } catch (err) {
      fail('intro claim', err);
    }
  }

  // (b) the coupon redemption.
  if (order.coupon_id) {
    try {
      const { data, error } = await admin.rpc('record_shop_coupon_redemption', { p_shop_order_id: order.id });
      if (error) fail('coupon redemption', error);
      else if (data === 'over_limit') {
        console.warn(`applyCaptureEffects: coupon ${order.coupon_code ?? order.coupon_id} went over its limit on shop order ${order.id} (honoured: the payment was taken)`);
      }
    } catch (err) {
      fail('coupon redemption', err);
    }
  }

  // (c) save the delivery address, if the customer asked and has an account.
  let addressId = order.customer_address_id;
  if (order.user_id && order.save_address_label && !addressId) {
    try {
      addressId = await saveOrderAddress(admin, order);
      if (addressId) {
        const { error } = await admin.from('shop_orders').update({ customer_address_id: addressId }).eq('id', order.id);
        if (error) {
          addressId = null;
          fail('linking the saved address', error);
        } else current = { ...current, customer_address_id: addressId };
      }
    } catch (err) {
      fail('saving the address', err);
    }
  }

  // (d) which saved address was used, for "most recent first".
  if (addressId) {
    try {
      const { error } = await admin.from('customer_addresses').update({ last_used_at: new Date().toISOString() }).eq('id', addressId);
      if (error) fail('address last_used_at', error);
    } catch (err) {
      fail('address last_used_at', err);
    }
  }

  // (e) done: only when every step above went through.
  if (!allDone) return current;
  try {
    const stamp = new Date().toISOString();
    const { error } = await admin.from('shop_orders').update({ capture_effects_at: stamp }).eq('id', order.id).is('capture_effects_at', null);
    if (error) {
      console.error('applyCaptureEffects: could not stamp capture_effects_at', order.id, error);
      return current;
    }
    return { ...current, capture_effects_at: stamp };
  } catch (err) {
    console.error('applyCaptureEffects: could not stamp capture_effects_at', order.id, err);
    return current;
  }
}

/**
 * Saves the order's address on the customer's account, or finds the one that is
 * already there. Returns its id, or null when it was skipped (the 10-address
 * limit; logged, nothing to retry). Throws on a real failure so the step retries.
 */
async function saveOrderAddress(admin: SupabaseClient, order: ShopOrderRow): Promise<string | null> {
  const { data: existing, error: listError } = await admin.from('customer_addresses').select('*').eq('user_id', order.user_id);
  if (listError) throw listError;
  const saved = (existing ?? []) as Record<string, unknown>[];
  const same = saved.find((a) =>
    sameDeliveryAddress(
      a as unknown as Parameters<typeof sameDeliveryAddress>[0],
      order as unknown as Parameters<typeof sameDeliveryAddress>[1],
    ),
  );
  if (same) return String(same.id);

  const { data, error } = await admin
    .from('customer_addresses')
    .insert({
      user_id: order.user_id,
      label: order.save_address_label,
      customer_name: order.customer_name,
      phone: order.phone,
      address_line1: order.address_line1,
      address_line2: order.address_line2,
      landmark: order.landmark,
      city: order.city,
      state: order.state,
      pincode: order.pincode,
      location_lat: num(order.location_lat),
      location_lng: num(order.location_lng),
      location_source: order.location_source,
      is_default: saved.length === 0,
    })
    .select('id')
    .single();
  if (error) {
    const limit = error.code === 'P0001' || String(error.message ?? '').includes('customer_addresses_limit');
    if (limit) {
      console.warn(`applyCaptureEffects: ${order.user_id} already has 10 saved addresses; not saving the address from shop order ${order.id}`);
      return null;
    }
    throw error;
  }
  return data ? String((data as { id: unknown }).id) : null;
}

/**
 * For an order still waiting on payment: asks Razorpay whether a payment was
 * captured (the webhook may be late, or not set up) and records it. Returns
 * the order as it now stands.
 */
export async function reconcileShopOrder(order: ShopOrderRow): Promise<ShopOrderRow> {
  if (order.status === 'payment_pending' || order.status === 'expired') {
    if (!order.razorpay_order_id) return order;
  } else {
    // Paid already: finish effects a crash left undone (the page poll is one of the retry paths).
    if (isPaidStatus(order.status) && !order.capture_effects_at) {
      return applyCaptureEffects(createAdminSupabaseClient(), order);
    }
    return order;
  }
  const attempts = await fetchOrderPaymentAttempts(order.razorpay_order_id as string);
  const captured = attempts?.find((a) => a.status === 'captured');
  if (!captured) return order;
  const result = await captureShopPayment({
    gatewayOrderId: order.razorpay_order_id as string,
    gatewayPaymentId: captured.id,
    method: captured.method,
    capturedAmountPaise: captured.amount,
  });
  return result.handled ? result.order : order;
}
