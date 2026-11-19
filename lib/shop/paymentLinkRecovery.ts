// Payment links for owner-entered orders, and getting back to one when the create
// call's answer never arrived (docs/SHOP-OWNER-ORDERS-SPEC.md). The rule: once a
// create call has been sent, the order row is NEVER deleted, because Razorpay may
// have made a link the customer can pay. The row is kept as payment_pending +
// payment_link with whatever link fields are known, and a retry, the expiry pass
// or a cancel finds the link by the reference_id we sent (the order ref).
//
// Every Razorpay answer here is read loosely: NOT VERIFIED against a live account.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { safeDbError } from '@/lib/api/postgrest';
import {
  createGatewayPaymentLink,
  findGatewayPaymentLinkByReference,
  type GatewayPaymentLink,
} from '@/lib/payments/gateway';
import { absoluteUrl } from '@/lib/url';
import { PAYMENT_LINK_VALID_HOURS } from './ownerOrders';
import { captureShopPaymentLink, paidPaymentOfLink } from './payments';
import { toShopOrderRow } from './server';
import { shopOrderRef } from './status';
import type { ShopOrderRow } from './types';

/** Stores a link's id, address and expiry on a still-unlinked, unpaid order. Null when it did not go through. */
export async function storeLinkOnOrder(admin: SupabaseClient, order: ShopOrderRow, link: GatewayPaymentLink): Promise<ShopOrderRow | null> {
  if (!link.shortUrl) return null;
  const expires = link.expireBy ? link.expireBy * 1000 : new Date(order.created_at).getTime() + PAYMENT_LINK_VALID_HOURS * 3600_000;
  const { data, error } = await admin
    .from('shop_orders')
    .update({
      razorpay_payment_link_id: link.id,
      payment_link_url: link.shortUrl,
      payment_link_expires_at: new Date(expires).toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', order.id)
    .eq('status', 'payment_pending')
    .is('razorpay_payment_link_id', null)
    .select('*')
    .maybeSingle();
  if (error) {
    console.error('payment link: could not store the link on order', order.id, safeDbError(error));
    return null;
  }
  return data ? toShopOrderRow(data as Record<string, unknown>) : null;
}

export type CreateLinkOutcome =
  | { kind: 'ok'; order: ShopOrderRow }
  /** Razorpay refused with a 4xx: no link exists. */
  | { kind: 'definite_failure' }
  /** A link may exist (timeout, 5xx, unreadable answer, no URL, or the save failed): keep the order. */
  | { kind: 'unknown' };

/** Creates the Razorpay link for an unpaid link order and stores it. Never deletes anything. */
export async function createLinkForOrder(admin: SupabaseClient, order: ShopOrderRow): Promise<CreateLinkOutcome> {
  const expireBy = Math.floor(Date.now() / 1000) + PAYMENT_LINK_VALID_HOURS * 3600;
  const made = await createGatewayPaymentLink({
    amountInr: order.total_inr,
    referenceId: shopOrderRef(order.order_number),
    description: `HIOC. order ${shopOrderRef(order.order_number)}`,
    customer: { name: order.customer_name, contact: order.phone, ...(order.email ? { email: order.email } : {}) },
    expireBy,
    notes: { shop_order_id: order.id, hioc_shop_order: shopOrderRef(order.order_number) },
    callbackUrl: absoluteUrl(`/shop/order/${order.id}`),
  });
  if (!made.ok) return made.definite ? { kind: 'definite_failure' } : { kind: 'unknown' };
  const stored = await storeLinkOnOrder(admin, order, { ...made.link, expireBy: made.link.expireBy ?? expireBy });
  return stored ? { kind: 'ok', order: stored } : { kind: 'unknown' };
}

export type AdoptOutcome =
  /** Razorpay unreachable, or what it said couldn't be used: change nothing, try again later. */
  | { state: 'retry_later' }
  | { state: 'none' }
  /** A link exists but is expired or cancelled (unpaid). */
  | { state: 'closed'; link: GatewayPaymentLink }
  | { state: 'open'; order: ShopOrderRow; link: GatewayPaymentLink }
  | { state: 'paid'; order: ShopOrderRow };

/**
 * For a link order with no stored link id: looks the link up by the reference we sent.
 * An open link is stored on the order; a paid one is captured through the one capture
 * step (which stores the link fields in the same update).
 */
export async function adoptLinkByReference(admin: SupabaseClient, order: ShopOrderRow): Promise<AdoptOutcome> {
  const found = await findGatewayPaymentLinkByReference(shopOrderRef(order.order_number), order.id);
  if (!found) return { state: 'retry_later' };
  const link = found.link;
  if (!link) return { state: 'none' };
  // Defence in depth: never act on a link that says it is another order's.
  const noted = link.notes?.shop_order_id;
  if ((link.referenceId != null && link.referenceId !== shopOrderRef(order.order_number)) || (typeof noted === 'string' && noted !== order.id)) {
    console.error(`payment link ${link.id} came back for order ${order.id} but names another order; not used`);
    return { state: 'retry_later' };
  }
  const paid = paidPaymentOfLink(link);
  if (paid) {
    const cap = await captureShopPaymentLink({
      paymentLinkId: link.id,
      shopOrderId: typeof noted === 'string' ? noted : order.id, // the link's own verified note
      gatewayPaymentId: paid.id,
      method: paid.method,
      capturedAmountPaise: paid.amountPaise,
      shortUrl: link.shortUrl,
      expireBy: link.expireBy,
    });
    if (cap.handled && cap.order.status !== 'payment_pending' && cap.order.status !== 'expired') return { state: 'paid', order: cap.order };
    return { state: 'retry_later' };
  }
  if (link.status === 'paid' || link.status === 'partially_paid') return { state: 'retry_later' };
  if (link.status === 'expired' || link.status === 'cancelled') return { state: 'closed', link };
  const stored = await storeLinkOnOrder(admin, order, link);
  return stored ? { state: 'open', order: stored, link } : { state: 'retry_later' };
}
