import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { resendGatewayPaymentLink } from '@/lib/payments/gateway';
import { adoptLinkByReference, createLinkForOrder } from '@/lib/shop/paymentLinkRecovery';
import { getShopOrder } from '@/lib/shop/server';

export const dynamic = 'force-dynamic';

// POST /api/owner/shop/orders/[id]/payment-link — owner only (401 otherwise).
// Body: { action: 'resend' | 'retry' }. Only for an order still waiting on its payment link.
//  resend: Razorpay texts the link again (and emails it when the order has an email).
//          200 { ok: true, payment_link_url }; 409 for any other order, or one with no
//          link stored yet (use retry); 502 when Razorpay didn't send.
//  retry:  for an order saved without a confirmed link (create answered 202 link_pending).
//          Looks the link up at Razorpay by our reference first: found -> stored (and
//          captured when already paid); none -> a new link is made. An order that
//          already has its link just answers with it.
//          200 { ok: true, payment_link_url, payment_link_expires_at } (plus status:'paid'
//          when the link turned out to be paid already); 502 { error } with nothing changed.
export async function POST(request: Request, { params }: { params: { id: string } }) {
  if (!(await getOwnerUser())) return unauthorized();
  if (!isUuid(params.id)) return notFound();
  if (!(await rateLimitOk(`owner-shop-link:${clientIp(request)}`, 20, 600))) {
    return errorResponse(429, 'Too many attempts — please wait a few minutes and try again.');
  }

  const body = (await parseJsonBody(request)) ?? {};
  if (body.action !== 'resend' && body.action !== 'retry') return errorResponse(400, "action must be 'resend' or 'retry'");

  const admin = createAdminSupabaseClient();
  const lookup = await getShopOrder(admin, params.id);
  if (!lookup.ok) return errorResponse(503, 'Could not load the order just now — please try again.');
  const order = lookup.order;
  if (!order) return notFound();

  if (body.action === 'retry') {
    if (order.payment_channel !== 'payment_link' || order.status !== 'payment_pending') {
      return errorResponse(409, 'Only an order waiting for its payment link can have the link retried.');
    }
    const done = (o: typeof order, extra: Record<string, unknown> = {}) =>
      NextResponse.json({ ok: true, payment_link_url: o.payment_link_url, payment_link_expires_at: o.payment_link_expires_at, ...extra });
    if (order.razorpay_payment_link_id && order.payment_link_url) return done(order);

    const adopted = await adoptLinkByReference(admin, order);
    if (adopted.state === 'retry_later') return errorResponse(502, "Couldn't reach Razorpay to check the link, so nothing was changed. Try again in a moment.");
    if (adopted.state === 'open') return done(adopted.order);
    if (adopted.state === 'paid') return done(adopted.order, { status: adopted.order.status });
    // None found (or only a closed one): make a new link.
    const made = await createLinkForOrder(admin, order);
    if (made.kind === 'ok') return done(made.order);
    return errorResponse(502, "Razorpay didn't confirm a payment link, so nothing was changed. Try again in a moment.");
  }

  if (order.payment_channel !== 'payment_link' || order.status !== 'payment_pending' || !order.razorpay_payment_link_id || !order.payment_link_url) {
    return errorResponse(409, 'Only an order waiting for its payment link can have the link sent again.');
  }

  const sent = await resendGatewayPaymentLink(order.razorpay_payment_link_id, Boolean(order.email));
  if (!sent) return errorResponse(502, "Razorpay didn't send the link (it may have expired). You can still copy the link and send it yourself.");
  return NextResponse.json({ ok: true, payment_link_url: order.payment_link_url });
}
