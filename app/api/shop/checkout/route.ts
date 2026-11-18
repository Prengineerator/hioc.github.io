import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { verifiedEmailOf } from '@/lib/account/history';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { flags } from '@/lib/flags';
import { redeemForShopOrder, reverseForShopOrder } from '@/lib/loyalty/ledger';
import { createGatewayOrder, isGatewayConfigured } from '@/lib/payments/gateway';
import { normalizeAddressLabel, validateShopAddress } from '@/lib/shop/address';
import { checkoutFingerprintSource, isIdempotencyKey } from '@/lib/shop/checkoutKey';
import { serverQuote } from '@/lib/shop/context';
import { locationColumns, parseShopLocation, type ShopLocation } from '@/lib/shop/location';
import { paymentIntentFor } from '@/lib/shop/payments';
import { parseCartItems } from '@/lib/shop/pricing';
import { findShopOrderByIdempotencyKey, isMissingShopSchema, SHOP_MIGRATION_HINT, SHOP_V2_MIGRATION_HINT } from '@/lib/shop/server';
import { isPaidStatus, shopOrderRef } from '@/lib/shop/status';
import type { ShopOrderRow } from '@/lib/shop/types';
import { runAfterResponse } from '@/lib/api/background';
import { recordTrafficConversion, trafficContext } from '@/lib/traffic/record';
import { parseTrafficAttribution } from '@/lib/traffic/validate';

export const dynamic = 'force-dynamic';

const PAYMENT_UNAVAILABLE = "Online payment isn't available right now — please try again in a little while.";
const CHOOSE_ADDRESS = 'Choose a delivery address';

// POST /api/shop/checkout — buy Instant Coffee and Signature Home Blend to be shipped.
// Header: Idempotency-Key: <uuid v4>, optional (one per checkout attempt, kept
//   for its retries). Present but not a uuid → 400.
// Body: { items: [{ product_id, quantity, grind? }],
//         address?: {...}, address_id?: <a saved address of the signed-in customer>,
//         save_address?: { label } | null,   // save it on the account once PAID
//         location?, coupon_code?, use_beanies? (default true),
//         expected_total_inr?, traffic? }.
// `location` is the optional delivery pin { lat, lng, accuracy_m?, source }
// (lib/shop/location.ts); it goes to Shiprocket with the order. With address_id
// the body's address only needs the email; the rest comes from the saved row.
// Responds 201 { order_id, order_number, total_inr, payment } where `payment` is
// the Razorpay intent openRazorpayCheckout() takes.
//
// The price is the server's, from lib/shop/context.ts serverQuote (the same
// quoteShopCart the page's POST /api/shop/quote uses): products from
// shop_products (unlisted, out-of-stock and grind-less Home Blend refused even
// when posted by hand), the introductory offer once per customer, one coupon,
// Beanies for signed-in repeat customers, shipping by goods value. Every part is
// frozen on the order (lines, offer / coupon / Beanies columns, and discount_inr
// = their sum). If the page showed a different total the customer is told before
// any payment: 409 { code: 'price_changed', quote }. A typed coupon that does not
// apply is 409 { code: 'coupon', quote }.
//
// Double taps: with an Idempotency-Key, a repeat of the same cart gets the order
// (and Razorpay intent) it opened, with `reused: true`, and nothing new is
// created; an already paid one answers `already_paid: true`; the same key with a
// different cart is 409 idempotency_mismatch; with an expired / cancelled order,
// 409 idempotency_expired. Two taps racing past the lookup are caught by the
// unique index (23505) and answered the same way.
//
// Beanies are RESERVED here (the reserve_shop_beanies RPC, atomic with the
// balance check). If that fails, or Razorpay refuses, or the order can't be
// linked, the order is withdrawn: Beanies reversed first, then the row deleted.
// The intro-offer claim, the coupon redemption and the saved address are NOT
// done here: they happen when the payment is captured (lib/shop/payments.ts),
// so an abandoned checkout leaves nothing behind.
//
// Prepaid only: with no Razorpay keys this answers 503 before creating anything.
export async function POST(request: Request) {
  if (!flags.shop) return notFound();

  // Each attempt can call Razorpay: bounded per IP.
  if (!(await rateLimitOk(`shop-checkout:${clientIp(request)}`, 10, 600))) {
    return errorResponse(429, 'Too many attempts — please wait a few minutes and try again.');
  }

  const rawKey = request.headers.get('Idempotency-Key');
  if (rawKey !== null && !isIdempotencyKey(rawKey.trim())) return errorResponse(400, 'Idempotency-Key must be a uuid');
  const idempotencyKey = rawKey === null ? null : rawKey.trim().toLowerCase();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const cart = parseCartItems(body.items);
  if (!cart.ok) return errorResponse(400, cart.error);

  const pin = parseShopLocation(body.location);
  if (!pin.ok) return NextResponse.json({ error: pin.error, field: 'location' }, { status: 400 });

  const admin = createAdminSupabaseClient();

  let user: Awaited<ReturnType<typeof getAuthUser>> = null;
  try {
    user = await getAuthUser();
  } catch {
    user = null; // a guest; nothing about the order depends on it
  }
  const userId = user?.id ?? null;

  // ---- the delivery address: a saved one of this customer's, or the form's ----
  const bodyAddress = typeof body.address === 'object' && body.address !== null ? (body.address as Record<string, unknown>) : {};
  const addressId = typeof body.address_id === 'string' && body.address_id ? body.address_id : null;
  let location: ShopLocation | null = pin.location;
  let address;
  if (addressId) {
    if (!userId || !/^[0-9a-f-]{36}$/i.test(addressId)) return NextResponse.json({ error: CHOOSE_ADDRESS, field: 'address_id' }, { status: 400 });
    const { data: saved, error: savedError } = await admin
      .from('customer_addresses')
      .select('*')
      .eq('id', addressId)
      .eq('user_id', userId)
      .maybeSingle();
    if (savedError) {
      console.error('POST /api/shop/checkout: saved address lookup failed', savedError);
      return errorResponse(isMissingShopSchema(savedError) ? 503 : 500, 'Could not load your saved address — please try again.');
    }
    if (!saved) return NextResponse.json({ error: CHOOSE_ADDRESS, field: 'address_id' }, { status: 400 });
    const row = saved as Record<string, unknown>;
    const typedEmail = typeof bodyAddress.email === 'string' && bodyAddress.email.trim() ? bodyAddress.email : null;
    address = validateShopAddress({
      customer_name: row.customer_name,
      phone: row.phone,
      address_line1: row.address_line1,
      address_line2: row.address_line2,
      landmark: row.landmark,
      city: row.city,
      state: row.state,
      pincode: row.pincode,
      email: typedEmail ?? verifiedEmailOf(user) ?? '',
    });
    // The saved pin travels with the saved address, unless the customer dropped a new one.
    if (!location && row.location_lat != null && row.location_lng != null) {
      const savedPin = parseShopLocation({ lat: Number(row.location_lat), lng: Number(row.location_lng), source: row.location_source ?? 'map' });
      if (savedPin.ok) location = savedPin.location;
    }
  } else {
    address = validateShopAddress(body.address);
  }
  if (!address.ok) return NextResponse.json({ error: address.error, field: address.field }, { status: 400 });

  // ---- what the customer asked for, and the label to save the address under ----
  const couponCode = typeof body.coupon_code === 'string' && body.coupon_code.trim() ? body.coupon_code.trim().slice(0, 40) : null;
  const useBeanies = body.use_beanies !== false;
  let saveLabel: string | null = null;
  if (userId && !addressId && typeof body.save_address === 'object' && body.save_address !== null) {
    saveLabel = normalizeAddressLabel((body.save_address as Record<string, unknown>).label);
    if (saveLabel.length > 20) return NextResponse.json({ error: 'Label is too long (20 characters at most)', field: 'save_address' }, { status: 400 });
  }

  // ---- a repeat of a checkout we already opened ----
  const fingerprint = createHash('sha256')
    .update(
      checkoutFingerprintSource({
        items: cart.items,
        address: address.address,
        address_id: addressId,
        coupon_code: couponCode,
        use_beanies: useBeanies,
        save_address_label: saveLabel,
      }),
    )
    .digest('hex');

  const answerExisting = (existing: ShopOrderRow) => {
    if (existing.checkout_fingerprint !== fingerprint) {
      return NextResponse.json({ error: 'Your order changed — tap Pay again.', code: 'idempotency_mismatch' }, { status: 409 });
    }
    if (isPaidStatus(existing.status)) {
      return NextResponse.json({ order_id: existing.id, order_number: existing.order_number, total_inr: existing.total_inr, already_paid: true });
    }
    if (existing.status === 'payment_pending') {
      const payment = paymentIntentFor(existing);
      // Another tap is still opening the Razorpay order: let the page try again in a moment.
      if (!payment) return NextResponse.json({ error: 'Still starting your payment — tap Pay again.', code: 'idempotency_in_progress' }, { status: 409 });
      return NextResponse.json({ order_id: existing.id, order_number: existing.order_number, total_inr: existing.total_inr, payment, reused: true });
    }
    return NextResponse.json({ error: 'That payment window closed — tap Pay again.', code: 'idempotency_expired' }, { status: 409 });
  };

  if (idempotencyKey) {
    const existing = await findShopOrderByIdempotencyKey(admin, idempotencyKey);
    if (existing) return answerExisting(existing);
  }

  // ---- the price, from the server ----
  const buyer = { userId, phone: address.address.phone, email: address.address.email };
  const priced = await serverQuote(admin, { items: cart.items, buyer, coupon_code: couponCode, use_beanies: useBeanies });
  if (!priced.ok) return errorResponse(priced.status, priced.error);
  const { quote } = priced;

  if (priced.coupon_error) {
    return NextResponse.json({ error: priced.coupon_error, code: 'coupon', quote }, { status: 409 });
  }
  if (typeof body.expected_total_inr === 'number' && body.expected_total_inr !== quote.total_inr) {
    return NextResponse.json({ error: "Prices changed: here's the new total", code: 'price_changed', quote }, { status: 409 });
  }

  if (!isGatewayConfigured()) return errorResponse(503, PAYMENT_UNAVAILABLE);

  const { data: inserted, error: insertError } = await admin
    .from('shop_orders')
    .insert({
      ...address.address,
      lines: quote.lines,
      jar_count: quote.unit_count,
      subtotal_inr: quote.subtotal_inr,
      offer_name: quote.offer_name,
      offer_discount_inr: quote.offer_discount_inr,
      coupon_id: quote.coupon_id,
      coupon_code: quote.coupon_code,
      coupon_discount_inr: quote.coupon_discount_inr,
      beanies_redeemed: quote.beanies_redeemed,
      beanies_discount_inr: quote.beanies_discount_inr,
      discount_inr: quote.discount_inr,
      intro_offer_applied: quote.intro_offer_applied,
      shipping_inr: quote.shipping_inr,
      total_inr: quote.total_inr,
      goods_weight_kg: quote.goods_weight_kg,
      idempotency_key: idempotencyKey,
      checkout_fingerprint: fingerprint,
      save_address_label: saveLabel,
      customer_address_id: addressId,
      ...locationColumns(location),
      user_id: userId,
    })
    .select('id, order_number, total_inr')
    .single();
  if (insertError || !inserted) {
    // Two taps with one key racing past the lookup: the unique index lets one in.
    if (insertError?.code === '23505' && idempotencyKey) {
      const raced = await findShopOrderByIdempotencyKey(admin, idempotencyKey);
      if (raced) return answerExisting(raced);
    }
    console.error('POST /api/shop/checkout: insert failed', insertError);
    if (isMissingShopSchema(insertError) || isMissingColumnError(insertError)) {
      const hint = isMissingColumnError(insertError) ? SHOP_V2_MIGRATION_HINT : SHOP_MIGRATION_HINT;
      return errorResponse(503, `The shop isn't open yet — ${hint}`);
    }
    return errorResponse(500, 'Could not start your order — please try again.');
  }
  const order = inserted as { id: string; order_number: number; total_inr: number };

  let reserved = false;
  // Takes the order back: Beanies first (the ledger row points at the order), then the row.
  const withdraw = async (reason: string) => {
    if (reserved) {
      const given = await reverseForShopOrder(order.id, reason);
      if (!(given > 0)) {
        // The Beanies did not come back: keep the order (the expiry pass releases them) rather than lose them.
        console.error('POST /api/shop/checkout: could not release Beanies, leaving the order for the expiry pass', order.id);
        return;
      }
    }
    const { error } = await admin.from('shop_orders').delete().eq('id', order.id);
    if (error) console.error('POST /api/shop/checkout: could not withdraw the order', order.id, error);
  };

  // Beanies are held now, atomically with the balance check.
  if (quote.beanies_redeemed > 0 && userId) {
    const result = await redeemForShopOrder(order.id, userId, quote.beanies_redeemed, quote.beanies_discount_inr, shopOrderRef(order.order_number));
    if (result !== 'reserved') {
      await withdraw('checkout not started');
      const again = await serverQuote(admin, { items: cart.items, buyer, coupon_code: couponCode, use_beanies: useBeanies });
      return NextResponse.json(
        {
          error: 'Your Beanies balance changed — please check the new total.',
          code: 'beanies_changed',
          ...(again.ok ? { quote: again.quote } : {}),
        },
        { status: 409 },
      );
    }
    reserved = true;
  }

  const payment = await createGatewayOrder(order.total_inr, order.id, {
    hioc_shop_order_id: order.id,
    hioc_shop_order: shopOrderRef(order.order_number),
  });
  if (!payment) {
    await withdraw('checkout not started');
    return errorResponse(503, PAYMENT_UNAVAILABLE);
  }

  const { error: linkError } = await admin
    .from('shop_orders')
    .update({ razorpay_order_id: payment.gatewayOrderId })
    .eq('id', order.id);
  if (linkError) {
    // Without the link a payment could not be matched to the order: refuse now.
    console.error('POST /api/shop/checkout: could not record the Razorpay order', linkError);
    await withdraw('checkout not started');
    return errorResponse(503, PAYMENT_UNAVAILABLE);
  }

  // Which visit this checkout came from, for Owner → Traffic
  // (docs/TRAFFIC-TRACKING.md). Recorded now, counted there only once the
  // order is paid. Best-effort; a missing or malformed `traffic` is skipped.
  runAfterResponse(
    recordTrafficConversion(admin, {
      event: 'shop_order',
      attribution: parseTrafficAttribution(body.traffic),
      route: '/shop',
      context: trafficContext(request),
      shopOrderId: order.id,
      valueInr: order.total_inr,
    }),
  );

  return NextResponse.json(
    { order_id: order.id, order_number: order.order_number, total_inr: order.total_inr, payment },
    { status: 201 },
  );
}
