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
// Owner-entered orders (docs/SHOP-OWNER-ORDERS-SPEC.md) use the same step: a payment
// link is captured by captureShopPaymentLink (webhook payment_link.paid, the order
// page's poll, the link-expiry pass), an offline order by captureOfflineShopOrder.
//
// Beanies are RESERVED at checkout, and a failed payment does NOT release them
// here: Checkout.js may retry the same Razorpay order. SV2-09's expiry pass
// releases them when the pending order expires or is cancelled.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { runAfterResponse } from '@/lib/api/background';
import { fetchGatewayPaymentLink, fetchOrderPaymentAttempts, type GatewayPaymentLink } from '@/lib/payments/gateway';
import { sendShopPaidEmails } from './emails';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CreatedPaymentIntent } from '@/lib/payments/types';
import { sameDeliveryAddress } from './address';
import { isUuid } from '@/lib/api/constants';
import { isMissingColumnError, safeDbError } from '@/lib/api/postgrest';
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
  return settleShopCapture(admin, order, {
    label: params.gatewayOrderId,
    gatewayPaymentId: params.gatewayPaymentId,
    method: params.method ?? null,
    capturedAmountPaise: params.capturedAmountPaise,
    strictAmount: false,
  });
}

/**
 * The one place an order goes from unpaid to paid, for every way of paying (the
 * Razorpay order, a payment link, an offline order the owner recorded). A
 * conditional update, so it happens once whichever caller lands first; only the
 * call that made the change sends the emails.
 *
 * `strictAmount` (payment links, which Razorpay binds to no order of ours): a
 * captured amount that is not exactly the order's total is NOT captured, it is
 * logged loudly for the owner to reconcile by hand. A Checkout.js payment keeps
 * the old rule (the amount is bound to the Razorpay order, so a mismatch is
 * logged and the order honoured).
 */
async function settleShopCapture(
  admin: SupabaseClient,
  order: ShopOrderRow,
  p: {
    label: string;
    gatewayPaymentId: string | null;
    method: string | null;
    capturedAmountPaise?: number;
    strictAmount: boolean;
    /** Only an unpaid order moves (an offline order has nothing to be "paid after expiry"). */
    from?: readonly string[];
    /** Written in the same update that marks it paid (a kept link order's missing link fields). */
    extraPatch?: Record<string, unknown>;
  },
): Promise<{ handled: true; order: ShopOrderRow; newlyPaid: boolean }> {
  const from = p.from ?? ['payment_pending', 'expired'];
  if (!from.includes(order.status)) {
    // Already paid (or cancelled): finish any effects a crash left undone.
    const settled = isPaidStatus(order.status) && !order.capture_effects_at ? await applyCaptureEffects(admin, order) : order;
    return { handled: true, order: settled, newlyPaid: false };
  }

  // Razorpay binds the amount to the order, so a mismatch is anomalous: the
  // money has moved, so it is recorded, and logged loudly to be looked at.
  if (p.strictAmount) {
    if (typeof p.capturedAmountPaise !== 'number' || p.capturedAmountPaise !== order.total_inr * 100) {
      console.error(
        `captureShopPayment: AMOUNT MISMATCH for ${p.label} (order ${order.id}) — captured ${p.capturedAmountPaise ?? 'unknown'}p vs expected ${order.total_inr * 100}p; NOT marked paid, reconcile by hand`,
      );
      return { handled: true, order, newlyPaid: false };
    }
  } else if (typeof p.capturedAmountPaise === 'number' && p.capturedAmountPaise !== order.total_inr * 100) {
    console.error(
      `captureShopPayment: AMOUNT MISMATCH for ${p.label} — captured ${p.capturedAmountPaise}p vs expected ${order.total_inr * 100}p`,
    );
  }
  if (order.status === 'expired') {
    console.error(`captureShopPayment: PAID AFTER EXPIRY for ${p.label} (order ${order.id}) — money was taken, so the order is honoured`);
  }

  const paid = await updateShopOrderIf(admin, order.id, from, {
    status: 'paid',
    paid_at: new Date().toISOString(),
    razorpay_payment_id: p.gatewayPaymentId,
    payment_method: p.method,
    ...(p.extraPatch ?? {}),
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

/**
 * Owner-entered order paid offline (UPI to the café, cash, bank transfer): marks
 * it paid through the same step as a gateway payment, so the intro claim, coupon
 * redemption and emails (the customer's only when there is an email) follow.
 * No Razorpay ids. Idempotent: a second call finds it paid.
 */
export async function captureOfflineShopOrder(admin: SupabaseClient, order: ShopOrderRow): Promise<ShopCaptureResult & { handled: true }> {
  return settleShopCapture(admin, order, {
    label: `offline ${order.id}`,
    gatewayPaymentId: null,
    method: order.offline_method,
    strictAmount: false,
    from: ['payment_pending'],
  });
}

async function findLinkOrder(
  admin: SupabaseClient,
  ref: { paymentLinkId?: string | null; shopOrderId?: string | null },
): Promise<ShopOrderRow | null> {
  const read = async (col: string, val: string) => {
    const { data, error } = await admin.from('shop_orders').select('*').eq(col, val).maybeSingle();
    if (error) {
      if (!isMissingShopSchema(error) && !isMissingColumnError(error)) console.error('shop payment link: lookup failed', safeDbError(error));
      return null;
    }
    return data ? toShopOrderRow(data as Record<string, unknown>) : null;
  };
  if (ref.paymentLinkId) {
    const byLink = await read('razorpay_payment_link_id', ref.paymentLinkId);
    if (byLink) return byLink;
  }
  if (ref.shopOrderId && isUuid(ref.shopOrderId)) {
    const byNote = await read('id', ref.shopOrderId);
    // The note is only a fallback: it must be a link order, and not one holding a different link.
    if (byNote && byNote.payment_channel === 'payment_link' && (!byNote.razorpay_payment_link_id || !ref.paymentLinkId || byNote.razorpay_payment_link_id === ref.paymentLinkId)) {
      return byNote;
    }
  }
  return null;
}

/**
 * A payment link was paid (webhook payment_link.paid, the order page's poll, the
 * link-expiry pass). Finds the order by link id, else by the shop_order_id note,
 * and marks it paid through the same step as every other payment. The amount
 * must equal the order's total exactly, else nothing is captured and it is
 * logged to be reconciled by hand. `{ handled: false }` = no such shop order.
 */
export async function captureShopPaymentLink(params: {
  paymentLinkId?: string | null;
  shopOrderId?: string | null;
  gatewayPaymentId: string;
  method?: string;
  capturedAmountPaise?: number;
  /** The link's own address and expiry (unix seconds), when the caller has them (the webhook does). */
  shortUrl?: string | null;
  expireBy?: number | null;
}): Promise<ShopCaptureResult> {
  const admin = createAdminSupabaseClient();
  const order = await findLinkOrder(admin, params);
  if (!order) {
    // Money was taken through a link we can't match to an order: loud, ids and amount only, so the owner can refund it from Razorpay.
    console.error(
      `captureShopPaymentLink: UNMATCHED PAID LINK — link ${params.paymentLinkId ?? 'unknown'}, payment ${params.gatewayPaymentId}, ${params.capturedAmountPaise ?? 'unknown'}p was paid but matches no shop order; check Razorpay and refund or record it by hand`,
    );
    return { handled: false };
  }
  // Money came in on a link whose order is not waiting for it (cancelled, or already paid by another
  // payment): never marked paid here, but never silent either. Ids and amount only.
  if (order.status !== 'payment_pending' && order.status !== 'expired' && !(isPaidStatus(order.status) && order.razorpay_payment_id === params.gatewayPaymentId)) {
    console.error(
      `captureShopPaymentLink: PAID LINK ON ${order.status.toUpperCase()} ORDER — order ${order.id} (${order.status}), link ${params.paymentLinkId ?? order.razorpay_payment_link_id ?? 'unknown'}, payment ${params.gatewayPaymentId}, ${params.capturedAmountPaise ?? 'unknown'}p — refund by hand in Razorpay`,
    );
  }
  // A kept order (its link was never confirmed) has no link fields yet; a paid link order must have all three.
  let extraPatch: Record<string, unknown> | undefined;
  const linkId = order.razorpay_payment_link_id ?? params.paymentLinkId ?? null;
  if (linkId && (!order.razorpay_payment_link_id || !order.payment_link_url || !order.payment_link_expires_at)) {
    let url = order.payment_link_url ?? params.shortUrl ?? null;
    let expireBy = params.expireBy ?? null;
    if (!url || (!order.payment_link_expires_at && expireBy === null)) {
      const link = await fetchGatewayPaymentLink(linkId);
      url = url ?? link?.shortUrl ?? null;
      expireBy = expireBy ?? link?.expireBy ?? null;
    }
    if (!url) console.error(`captureShopPaymentLink: no link address for ${linkId} (order ${order.id}); the paid update may be refused, the poll will retry`);
    extraPatch = {
      razorpay_payment_link_id: linkId,
      ...(url ? { payment_link_url: url } : {}),
      payment_link_expires_at:
        order.payment_link_expires_at ?? new Date(expireBy !== null ? expireBy * 1000 : new Date(order.created_at).getTime() + 48 * 3600_000).toISOString(),
    };
  }
  return settleShopCapture(admin, order, {
    label: `payment link ${linkId ?? ''}`.trim(),
    gatewayPaymentId: params.gatewayPaymentId,
    method: params.method ?? null,
    capturedAmountPaise: params.capturedAmountPaise,
    strictAmount: true,
    extraPatch,
  });
}

/**
 * An unpaid link order's link expired or was cancelled at Razorpay (webhook
 * payment_link.expired / .cancelled): the order becomes expired / cancelled. Only
 * an order still waiting for payment moves; nothing was charged, so there is no
 * refund. Returns the order as it now stands, or null when there is none.
 */
export async function closeUnpaidShopLinkOrder(
  params: { paymentLinkId?: string | null; shopOrderId?: string | null },
  to: 'expired' | 'cancelled',
): Promise<ShopOrderRow | null> {
  const admin = createAdminSupabaseClient();
  const order = await findLinkOrder(admin, params);
  if (!order) return null;
  if (order.status !== 'payment_pending') return order;
  const updated = await updateShopOrderIf(
    admin,
    order.id,
    ['payment_pending'],
    to === 'expired'
      ? { status: 'expired', cancel_reason: 'Payment link expired unpaid' }
      : { status: 'cancelled', cancelled_at: new Date().toISOString(), cancel_reason: 'Payment link cancelled' },
  );
  return updated ?? order;
}

/** What a paid payment link tells us about the payment that paid it, or null while it is not paid. */
export function paidPaymentOfLink(link: GatewayPaymentLink): { id: string; method?: string; amountPaise: number } | null {
  if (link.status !== 'paid') return null;
  const pay = link.payments.find((x) => x.status === 'captured') ?? link.payments[0];
  if (!pay) return null;
  return { id: pay.id, method: pay.method, amountPaise: link.amountPaidPaise || pay.amountPaise || 0 };
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
    console.error(`applyCaptureEffects: ${step} failed for shop order ${order.id}; will retry`, safeDbError(err));
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
      console.error('applyCaptureEffects: could not stamp capture_effects_at', order.id, safeDbError(error));
      return current;
    }
    return { ...current, capture_effects_at: stamp };
  } catch (err) {
    console.error('applyCaptureEffects: could not stamp capture_effects_at', order.id, safeDbError(err));
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
    if (order.payment_channel === 'payment_link' && order.razorpay_payment_link_id) return reconcileShopLinkOrder(order);
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

/** The poll's way of noticing a paid payment link when the webhook is late: asks Razorpay, captures through the same step. */
async function reconcileShopLinkOrder(order: ShopOrderRow): Promise<ShopOrderRow> {
  const link = await fetchGatewayPaymentLink(order.razorpay_payment_link_id as string);
  const paid = link ? paidPaymentOfLink(link) : null;
  if (!link || !paid) return order;
  const result = await captureShopPaymentLink({
    paymentLinkId: link.id,
    shopOrderId: order.id,
    gatewayPaymentId: paid.id,
    method: paid.method,
    capturedAmountPaise: paid.amountPaise,
  });
  return result.handled ? result.order : order;
}
