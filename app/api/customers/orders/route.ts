import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { normalizeIndianMobile } from '@/lib/phone';
import { findVerifiedCustomerByPhone, orderMatchFilter } from '@/lib/loyalty/customerLink';
import { toCustomerOrderResponse, type CustomerOrderRow } from '@/lib/api/customerOrders';

export const dynamic = 'force-dynamic';

const ORDERS_SELECT =
  'id, order_number, order_type, status, payment_status, total_inr, subtotal_inr, created_at, table_label, order_items(*, order_item_addons(*))';

// GET /api/customers/orders?phone=<10-digit> — staff-gated (VAL-1/VAL-2), same
// gate + rate limit as lookup. Powers the POS "Last orders" button: the ten
// most recent orders belonging to whoever the phone/account is, WITH their
// items, so a cashier can review — or Repeat — one without leaving the New
// order screen.
//
// "Belonging to" is exactly `lib/loyalty/customerLink.ts`'s orderMatchFilter —
// the phone as typed, plus, when it resolves to a verified account, anything
// filed under that account's `customer_user_id`/`user_id`. This is
// deliberately the read side of VAL-2's beneficiary rule (lib/loyalty/
// beneficiary.ts derives WHOSE account an order credits; this finds every
// order that was credited to one).
//
// One query, no N+1: `order_items(*, order_item_addons(*))` embeds every
// line + its add-ons in the same round trip PostgREST already does for the
// order list — a second query per order would turn "open the modal" into ten.
// Top-level columns are the narrow set the modal actually renders (no
// customer contact fields — this is staff-authenticated but still a
// counter-visible screen, same discipline as lookup).
export async function GET(request: Request) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  const user = actor.user;

  const raw = new URL(request.url).searchParams.get('phone') ?? '';
  const normalized = normalizeIndianMobile(raw);
  if (!normalized) {
    return errorResponse(400, 'phone must be a valid 10-digit Indian mobile number');
  }

  // Same budget as lookup (~2 taps per order at 60 orders/hr): this route is
  // only hit once per phone (on "Last orders", not on every keystroke), so it
  // rides well under the shared limit rather than needing its own.
  if (!(await rateLimitOk(`customer-orders:${user.id}`, 120, 600))) {
    return errorResponse(429, 'Too many order-history lookups — please wait a moment.');
  }

  const admin = createAdminSupabaseClient();
  const phoneE164 = `+91${normalized}`;
  const account = await findVerifiedCustomerByPhone(admin, phoneE164);

  const { data, error } = await admin
    .from('orders')
    .select(ORDERS_SELECT)
    .or(orderMatchFilter(phoneE164, account?.userId ?? null))
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    console.error('customers/orders: query failed', error);
    return errorResponse(500, 'Failed to load order history');
  }

  const orders = (data ?? []).map((row) => toCustomerOrderResponse(row as unknown as CustomerOrderRow));
  return NextResponse.json({ orders });
}
