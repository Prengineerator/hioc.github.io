import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isMissingColumnError, safeDbError } from '@/lib/api/postgrest';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { isGatewayConfigured } from '@/lib/payments/gateway';
import { createLinkForOrder } from '@/lib/shop/paymentLinkRecovery';
import {
  ownerOrderFingerprintSource,
  parseOwnerOrderBody,
} from '@/lib/shop/ownerOrders';
import { ownerQuoteView, priceOwnerOrder } from '@/lib/shop/ownerPricing';
import { captureOfflineShopOrder } from '@/lib/shop/payments';
import { findShopOrderByIdempotencyKey, isMissingShopSchema, SHOP_MIGRATION_HINT, toShopOrderRow } from '@/lib/shop/server';
import { isPaidStatus } from '@/lib/shop/status';
import type { ShopOrderRow } from '@/lib/shop/types';

export const dynamic = 'force-dynamic';

const OWNER_ORDERS_HINT = 'apply supabase/2026-11-shop-owner-orders.sql first';

// POST /api/owner/shop/orders — owner only (401 for anyone else). The owner types in a
// shipped shop order (docs/SHOP-OWNER-ORDERS-SPEC.md).
// Body: { idempotency_key: <uuid v4, one per attempt, kept for its retries>,
//         address: { customer_name, phone, email?, address_line1, address_line2?, landmark?, city, state, pincode },
//         items: [{ product_id, quantity, grind? }], coupon_code?,
//         owner_discount_inr?, owner_discount_reason?   // reason 3-80 chars when there is a discount
//         payment: { kind: 'link' } | { kind: 'offline', method: 'upi_direct'|'cash'|'bank_transfer', reference: 3-60 chars },
//         expected_total_inr }                            // the total the page showed
// 201 { order_id, order_number, status, total_inr, payment_link_url, payment_link_expires_at }
//     link order: status 'payment_pending', url + expiry set. Offline: status 'paid', both null.
// 200 the same, plus `reused: true`, for a repeat of an attempt already made (nothing new is created).
// 409 { error, code: 'price_changed' | 'coupon', quote } when the total differs / a typed code does not apply
//     (quote has the same shape as POST /api/owner/shop/quote's `quote`);
//     409 { code: 'idempotency_mismatch' | 'idempotency_in_progress' | 'idempotency_expired' } as the website's checkout.
// 202 link order saved but its link is not confirmed yet (see above); 502 Razorpay refused the link (nothing kept);
// 400 { error, field? } bad input; 429 too many;
// 503 gateway not configured (link) or the owner-order migration is missing.
//
// The price is the server's (priceOwnerOrder: the website's serverQuote + the owner
// discount, no Beanies). The order is linked to the account whose VERIFIED phone matches.
// link:    inserted payment_pending (channel payment_link) and the Razorpay link made; if that
//          is refused outright (a 4xx) the row is deleted; if the outcome is unknown (timeout, 5xx,
//          no URL, link not saved) the row is KEPT (a link may exist) and the answer is 202
//          { order_id, order_number, status:'payment_pending', link_pending:true, message }:
//          the owner taps "Retry link" (POST .../payment-link {action:'retry'}). Paid later by the webhook (lib/shop/payments.ts), and
//          expired after 48 h by the expire-orders cron (lib/shop/lifecycle.ts).
// offline: inserted, then marked paid by the same capture step a website payment uses
//          (intro claim, coupon redemption, emails only when there is an email). No Razorpay ids.
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();
  if (!(await rateLimitOk(`owner-shop-orders:${clientIp(request)}`, 10, 600))) {
    return errorResponse(429, 'Too many attempts — please wait a few minutes and try again.');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const parsed = parseOwnerOrderBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error, ...(parsed.field ? { field: parsed.field } : {}) }, { status: 400 });
  const input = parsed.input;
  if (input.expected_total_inr === null) return NextResponse.json({ error: 'expected_total_inr is required', field: 'expected_total_inr' }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const fingerprint = createHash('sha256').update(ownerOrderFingerprintSource(input)).digest('hex');

  const respond = (o: Pick<ShopOrderRow, 'id' | 'order_number' | 'status' | 'total_inr' | 'payment_link_url' | 'payment_link_expires_at'>, status: number, extra: Record<string, unknown> = {}) =>
    NextResponse.json(
      {
        order_id: o.id,
        order_number: o.order_number,
        status: o.status,
        total_inr: o.total_inr,
        payment_link_url: o.payment_link_url ?? null,
        payment_link_expires_at: o.payment_link_expires_at ?? null,
        ...extra,
      },
      { status },
    );

  const answerExisting = async (existing: ShopOrderRow) => {
    if (existing.source !== 'owner' || existing.checkout_fingerprint !== fingerprint) {
      return NextResponse.json({ error: 'This attempt changed — start the order again.', code: 'idempotency_mismatch' }, { status: 409 });
    }
    if (isPaidStatus(existing.status)) return respond(existing, 200, { reused: true });
    if (existing.status === 'payment_pending') {
      if (existing.payment_channel === 'offline') {
        // The first attempt stopped between saving the order and recording the payment: finish it.
        const done = await captureOfflineShopOrder(admin, existing);
        if (isPaidStatus(done.order.status)) return respond(done.order, 200, { reused: true });
      } else if (existing.payment_link_url) {
        return respond(existing, 200, { reused: true });
      } else {
        // Saved, but its link was never confirmed: the owner retries it from the order.
        return NextResponse.json(
          {
            order_id: existing.id,
            order_number: existing.order_number,
            status: 'payment_pending',
            link_pending: true,
            reused: true,
            message: "The order is saved under Awaiting payment, but the payment link isn't confirmed yet. Tap Retry link on the order.",
          },
          { status: 202 },
        );
      }
      return NextResponse.json({ error: 'Still starting this order — try again in a moment.', code: 'idempotency_in_progress' }, { status: 409 });
    }
    return NextResponse.json({ error: 'That order is no longer open — start it again.', code: 'idempotency_expired' }, { status: 409 });
  };

  const earlier = await findShopOrderByIdempotencyKey(admin, input.idempotency_key);
  if (earlier) return answerExisting(earlier);

  // ---- the price, from the server ----
  const { priced, userId } = await priceOwnerOrder(admin, {
    phoneE164: input.address.phone,
    email: input.address.email || null,
    items: input.items,
    couponCode: input.coupon_code,
    ownerDiscountInr: input.owner_discount_inr,
  });
  if (!priced.ok) return errorResponse(priced.status, priced.error);
  const { quote } = priced;
  const publicQuote = ownerQuoteView(quote, priced.coupon_error);
  if (priced.coupon_error) {
    return NextResponse.json({ error: priced.coupon_error, code: 'coupon', quote: publicQuote }, { status: 409 });
  }
  if (input.expected_total_inr !== quote.total_inr) {
    return NextResponse.json({ error: "Prices changed: here's the new total", code: 'price_changed', quote: publicQuote }, { status: 409 });
  }
  if (input.payment.kind === 'link' && !isGatewayConfigured()) {
    return errorResponse(503, "Payment links aren't available right now. Record it as already paid, or try again later.");
  }

  const offline = input.payment.kind === 'offline' ? input.payment : null;
  const { data: inserted, error: insertError } = await admin
    .from('shop_orders')
    .insert({
      ...input.address,
      lines: quote.lines,
      jar_count: quote.unit_count,
      subtotal_inr: quote.subtotal_inr,
      offer_name: quote.offer_name,
      offer_discount_inr: quote.offer_discount_inr,
      coupon_id: quote.coupon_id,
      coupon_code: quote.coupon_code,
      coupon_discount_inr: quote.coupon_discount_inr,
      beanies_redeemed: 0,
      beanies_discount_inr: 0,
      owner_discount_inr: quote.owner_discount_inr,
      owner_discount_reason: input.owner_discount_reason,
      discount_inr: quote.discount_inr,
      intro_offer_applied: quote.intro_offer_applied,
      shipping_inr: quote.shipping_inr,
      total_inr: quote.total_inr,
      goods_weight_kg: quote.goods_weight_kg,
      idempotency_key: input.idempotency_key,
      checkout_fingerprint: fingerprint,
      user_id: userId,
      source: 'owner',
      created_by: owner.id,
      payment_channel: offline ? 'offline' : 'payment_link',
      offline_method: offline ? offline.method : null,
      payment_reference: offline ? offline.reference : null,
      status: 'payment_pending',
    })
    .select('*')
    .single();
  if (insertError || !inserted) {
    // Two taps with one key racing past the lookup: the unique index lets one in.
    if (insertError?.code === '23505') {
      const raced = await findShopOrderByIdempotencyKey(admin, input.idempotency_key);
      if (raced) return answerExisting(raced);
    }
    console.error('POST /api/owner/shop/orders: insert failed', safeDbError(insertError)); // code + message only: `details` holds the failing row
    if (isMissingColumnError(insertError)) return errorResponse(503, `Owner-entered orders aren't set up yet — ${OWNER_ORDERS_HINT}`);
    if (isMissingShopSchema(insertError)) return errorResponse(503, `The shop isn't open yet — ${SHOP_MIGRATION_HINT}`);
    return errorResponse(500, 'Could not save the order — please try again.');
  }
  const order = toShopOrderRow(inserted as Record<string, unknown>);

  const withdraw = async () => {
    const { error } = await admin.from('shop_orders').delete().eq('id', order.id);
    if (error) console.error('POST /api/owner/shop/orders: could not withdraw the order', order.id, safeDbError(error));
  };

  // ---- already paid: record it through the same capture step as a website payment ----
  if (offline) {
    const done = await captureOfflineShopOrder(admin, order);
    if (!isPaidStatus(done.order.status)) {
      await withdraw();
      return errorResponse(500, 'Could not record the payment — nothing was saved. Please try again.');
    }
    return respond(done.order, 201);
  }

  // ---- payment link ----
  // Once the create call is sent a link may exist, so from here the row is kept, never
  // deleted, unless Razorpay clearly refused (4xx): then no link can exist.
  const outcome = await createLinkForOrder(admin, order);
  if (outcome.kind === 'definite_failure') {
    await withdraw();
    return errorResponse(502, "Razorpay didn't create the payment link, so no order was saved. Try again, or record it as already paid.");
  }
  if (outcome.kind === 'unknown') {
    return NextResponse.json(
      {
        order_id: order.id,
        order_number: order.order_number,
        status: 'payment_pending',
        link_pending: true,
        message: "The order is saved under Awaiting payment, but the payment link isn't confirmed yet. Tap Retry link on the order.",
      },
      { status: 202 },
    );
  }
  return respond(outcome.order, 201);
}
