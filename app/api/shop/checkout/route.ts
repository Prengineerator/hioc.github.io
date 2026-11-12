import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { flags } from '@/lib/flags';
import { createGatewayOrder, isGatewayConfigured } from '@/lib/payments/gateway';
import { validateShopAddress } from '@/lib/shop/address';
import { locationColumns, parseShopLocation } from '@/lib/shop/location';
import { parseCartItems, priceShopCart } from '@/lib/shop/pricing';
import { isMissingShopSchema, loadShopOffer, loadShopProducts, SHOP_MIGRATION_HINT } from '@/lib/shop/server';
import { shopOrderRef } from '@/lib/shop/status';

export const dynamic = 'force-dynamic';

const PAYMENT_UNAVAILABLE = "Online payment isn't available right now — please try again in a little while.";

// POST /api/shop/checkout — buy Instant Coffee jars to be shipped.
// Body: { items: [{ product_id, quantity }], address: {...}, location?, expected_total_inr? }.
// `location` is the optional delivery pin { lat, lng, accuracy_m?, source }
// (lib/shop/location.ts); it goes to Shiprocket with the order.
// Responds 201 { order_id, order_number, total_inr, payment } where `payment` is
// the Razorpay intent openRazorpayCheckout() takes.
//
// Guest checkout (a signed-in customer's account is linked if there is one).
// The price is the server's: products are read from shop_products, the offer
// from shop_settings (the introductory "2 for ₹599 · 3 for ₹749" while it is
// on), priced by lib/shop/pricing.ts (₹49 shipping below 3 jars, free from 3). If the page
// showed a different total (a price or stock change since it loaded), the
// customer is told before any payment, with 409 and the new figures.
//
// Prepaid only: with no Razorpay keys this answers 503 before creating
// anything, and if Razorpay refuses, the order just created is deleted again.
export async function POST(request: Request) {
  if (!flags.shop) return notFound();

  // Each attempt can call Razorpay: bounded per IP.
  if (!(await rateLimitOk(`shop-checkout:${clientIp(request)}`, 10, 600))) {
    return errorResponse(429, 'Too many attempts — please wait a few minutes and try again.');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const cart = parseCartItems(body.items);
  if (!cart.ok) return errorResponse(400, cart.error);

  const address = validateShopAddress(body.address);
  if (!address.ok) return NextResponse.json({ error: address.error, field: address.field }, { status: 400 });

  const pin = parseShopLocation(body.location);
  if (!pin.ok) return NextResponse.json({ error: pin.error, field: 'location' }, { status: 400 });

  const admin = createAdminSupabaseClient();
  const [products, offer] = await Promise.all([loadShopProducts(admin), loadShopOffer(admin)]);
  if (!products.ok) {
    return errorResponse(503, products.missingSchema ? `The shop isn't open yet — ${SHOP_MIGRATION_HINT}` : 'Could not load the shop just now — please try again.');
  }

  const quote = priceShopCart(products.products, cart.items, offer);
  if (!quote.ok) return errorResponse(400, quote.error);

  if (typeof body.expected_total_inr === 'number' && body.expected_total_inr !== quote.total_inr) {
    return NextResponse.json(
      {
        error: `The total is now ₹${quote.total_inr}, not ₹${body.expected_total_inr}. Please check your order and pay again.`,
        quote: {
          lines: quote.lines,
          jar_count: quote.jar_count,
          subtotal_inr: quote.subtotal_inr,
          discount_inr: quote.discount_inr,
          offer_name: quote.offer_name,
          shipping_inr: quote.shipping_inr,
          total_inr: quote.total_inr,
        },
      },
      { status: 409 },
    );
  }

  if (!isGatewayConfigured()) return errorResponse(503, PAYMENT_UNAVAILABLE);

  let userId: string | null = null;
  try {
    userId = (await getAuthUser())?.id ?? null;
  } catch {
    userId = null; // a guest; nothing about the order depends on it
  }

  const { data: inserted, error: insertError } = await admin
    .from('shop_orders')
    .insert({
      ...address.address,
      lines: quote.lines,
      jar_count: quote.jar_count,
      subtotal_inr: quote.subtotal_inr,
      discount_inr: quote.discount_inr,
      offer_name: quote.offer_name,
      shipping_inr: quote.shipping_inr,
      total_inr: quote.total_inr,
      ...locationColumns(pin.location),
      user_id: userId,
    })
    .select('id, order_number, total_inr')
    .single();
  if (insertError || !inserted) {
    console.error('POST /api/shop/checkout: insert failed', insertError);
    return errorResponse(
      isMissingShopSchema(insertError) ? 503 : 500,
      isMissingShopSchema(insertError) ? `The shop isn't open yet — ${SHOP_MIGRATION_HINT}` : 'Could not start your order — please try again.',
    );
  }
  const order = inserted as { id: string; order_number: number; total_inr: number };

  const withdraw = async () => {
    const { error } = await admin.from('shop_orders').delete().eq('id', order.id);
    if (error) console.error('POST /api/shop/checkout: could not withdraw the order', order.id, error);
  };

  const payment = await createGatewayOrder(order.total_inr, order.id, {
    hioc_shop_order_id: order.id,
    hioc_shop_order: shopOrderRef(order.order_number),
  });
  if (!payment) {
    await withdraw();
    return errorResponse(503, PAYMENT_UNAVAILABLE);
  }

  const { error: linkError } = await admin
    .from('shop_orders')
    .update({ razorpay_order_id: payment.gatewayOrderId })
    .eq('id', order.id);
  if (linkError) {
    // Without the link a payment could not be matched to the order: refuse now.
    console.error('POST /api/shop/checkout: could not record the Razorpay order', linkError);
    await withdraw();
    return errorResponse(503, PAYMENT_UNAVAILABLE);
  }

  return NextResponse.json(
    { order_id: order.id, order_number: order.order_number, total_inr: order.total_inr, payment },
    { status: 201 },
  );
}
