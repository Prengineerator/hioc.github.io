import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { toStoredPhone } from '@/lib/loyalty/customerLink';
import { coffeePassDisabled, PASS_MIGRATION_HINT } from '@/lib/passes/api';
import { PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { createPassSaleOrder } from '@/lib/passes/sale';
import { loadPlanById } from '@/lib/passes/server';
import { createPaymentIntent, isGatewayConfigured } from '@/lib/payments/gateway';
import { getStoreSettings } from '@/lib/store/settings';

export const dynamic = 'force-dynamic';

const NO_PHONE_MESSAGE = 'Add your mobile number in your profile first';
const ONLINE_UNAVAILABLE_MESSAGE = `Online purchase isn't available right now — buy your ${PASS_PROGRAM_NAME} at the counter.`;

// POST /api/passes/checkout — the signed-in customer buys a HIOC Ritual online.
// Body: { plan_id }. Responds 201 { order_id, order_number, total_inr, payment }.
//
// It creates the SALE ORDER (order_kind 'coffee_pass', channel 'customer_web',
// status 'placed', payment_pending, payment_method 'online') and the Razorpay
// intent for it. `payment` is the intent exactly as POST /api/orders returns it
// for an online order ({ gateway, gatewayOrderId, amountInr, keyId }), which is
// what openRazorpayCheckout() (lib/payments/razorpayCheckout.ts) takes, so the
// /ritual page opens the same payment window checkout does. When the payment is
// captured (verify, webhook or the status poll) the order goes 'paid' and a
// database trigger issues the pass and completes the order (CP-D6). Nothing here
// creates a pass.
//
// The pass belongs to the SESSION's account (CP-D4): user_id and customer_user_id
// are both the caller, and nothing about who owns it is read from the body.
//
// There is no pay-at-counter fallback (CP-D8). With no gateway keys the route
// answers 503 BEFORE creating anything; if the keys exist but the gateway call
// fails, the order it just made is deleted again, so a failed attempt leaves no
// 'placed' order behind on the board.
//
// orders.customer_phone is NOT NULL and the receipt and WhatsApp bill go to it,
// so the profile must have a number ("Add your mobile number in your profile
// first"). It need not be VERIFIED to buy: verification is what lets the counter
// find the account to spend cups, and /api/passes/mine tells the page which.
export async function POST(request: Request) {
  const off = coffeePassDisabled();
  if (off) return off;

  const user = await getAuthUser();
  if (!user) return unauthorized();

  // Each attempt can call the gateway, so this is bounded per account. A real
  // customer buys one pass now and then; ten in ten minutes is a script.
  if (!(await rateLimitOk(`pass-checkout:${user.id}`, 10, 600))) {
    return errorResponse(429, 'Too many attempts — please wait a few minutes and try again.');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  if (!isUuid(body.plan_id)) return errorResponse(400, 'plan_id must be a plan id');

  const admin = createAdminSupabaseClient();
  const plan = await loadPlanById(admin, body.plan_id);
  // An inactive plan reads as missing: the customer never learns which plans exist unsold.
  if (!plan || !plan.is_active) return errorResponse(404, `That ${PASS_PROGRAM_NAME} plan isn't available.`);

  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('name, phone')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) {
    console.error('POST /api/passes/checkout: profile read failed', profileError);
    return errorResponse(503, 'Could not read your profile just now — please try again.');
  }
  // Stored form (+91XXXXXXXXXX) like every other order; a number that is not a valid
  // Indian mobile is treated as no number, since the bill could not be delivered to it.
  const phone = toStoredPhone((profile as { phone?: string | null } | null)?.phone ?? '');
  if (!phone) return errorResponse(400, NO_PHONE_MESSAGE);

  const profileName = ((profile as { name?: string | null } | null)?.name ?? '').trim();
  const emailName = (user.email ?? '').split('@')[0].trim();
  const customerName = profileName || emailName || 'Customer';

  if (!isGatewayConfigured()) return errorResponse(503, ONLINE_UNAVAILABLE_MESSAGE);

  const settings = await getStoreSettings();
  const sale = await createPassSaleOrder(admin, {
    plan,
    channel: 'customer_web',
    status: 'placed',
    paymentStatus: 'payment_pending',
    paymentMethod: 'online',
    customerName,
    customerPhone: phone,
    userId: user.id,
    customerUserId: user.id,
    createdBy: null,
    settings,
  });
  if (!sale.ok) {
    return errorResponse(500, sale.missingSchema ? `Could not start the purchase — ${PASS_MIGRATION_HINT}` : sale.message);
  }
  const order = sale.order;

  const payment = await createPaymentIntent(order.id, order.total_inr ?? 0);
  if (!payment) {
    // The gateway refused or is down. The order is unpaid and cannot be paid
    // (there is no intent), so withdraw it rather than leave it 'placed'.
    const { error: deleteError } = await admin.from('orders').delete().eq('id', order.id);
    if (deleteError) console.error('POST /api/passes/checkout: could not withdraw the order', order.id, deleteError);
    return errorResponse(503, ONLINE_UNAVAILABLE_MESSAGE);
  }

  return NextResponse.json(
    { order_id: order.id, order_number: order.order_number, total_inr: order.total_inr, payment },
    { status: 201 },
  );
}
