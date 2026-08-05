import { NextResponse } from 'next/server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { getOrderWithCoupon } from '@/lib/orders/getOrder';
import { sendBillNotification } from '@/lib/notifications/engine';
import { rateLimitOk } from '@/lib/api/rateLimit';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };

// POST /api/orders/[id]/resend-bill — staff-gated (RCT-1 "Resend bill").
// Re-delivers the settle bill on WhatsApp + email even though a prior send is
// already logged, by forcing past the engine's per-(order,event,channel)
// idempotency guard. The send stays best-effort and logged in `notifications`;
// this route never mutates the order and never blocks. Rate-limited so a
// staffer can't spam a customer's phone/inbox.
export async function POST(_request: Request, { params }: RouteParams) {
  const user = await getStaffUser();
  if (!user) return unauthorized();

  const { id } = params;
  if (!isUuid(id)) return notFound();

  // Cap resends per order (M10). Reuse the shared best-effort limiter — backed by
  // the check_rate_limit RPC, it fails OPEN if that RPC isn't deployed yet, so a
  // resend keeps working on a partial setup. 3 resends / 10 min per order is
  // plenty for a "customer didn't get it" retry without enabling spam.
  const allowed = await rateLimitOk(`resend-bill:${id}`, 3, 600);
  if (!allowed) {
    return errorResponse(429, 'Too many bill resends for this order — please wait a moment.');
  }

  // Load via the shared loader the receipt page + GET /api/orders/[id] use (the
  // opaque uuid IS the access control; service-role read). It shapes `items`, so
  // the bill's item count is accurate.
  const order = await getOrderWithCoupon(id);
  if (!order) return notFound();

  // force:true re-delivers past the already-sent short-circuit. Each channel is
  // still independently dormant until its provider env is configured, and the
  // result flags which channels sent.
  const result = await sendBillNotification(order, { force: true });

  // BILL-3/4: report WHY nothing sent. Returning a bare `ok: true` rendered a
  // total failure ("no phone on this order", "WhatsApp not configured") as a
  // success in the UI — the exact class of silent failure this phase exists to
  // remove. `reasons` is '' per channel when that channel delivered.
  return NextResponse.json({
    ok: true,
    sent: { whatsapp: result.whatsapp, email: result.email },
    reasons: result.reasons,
  });
}
