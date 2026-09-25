import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { normalizeIndianMobile } from '@/lib/phone';
import { findVerifiedCustomerByPhone, orderMatchFilter } from '@/lib/loyalty/customerLink';
import { getBalance } from '@/lib/loyalty/ledger';

export const dynamic = 'force-dynamic';

// GET /api/customers/lookup?phone=<10-digit> — staff-gated (VAL-1/VAL-2).
//
// Answers what a staffer needs when a regular gives their number: is this the
// right person, what can they spend, and is there a "Last orders" worth
// offering? Hence a name, a balance, and a past-order count/date — and
// deliberately NOTHING else: no user id, no email, no address, no item-level
// history (that lives behind GET /api/customers/orders, fetched only once the
// staffer actually opens it). A counter tablet is the least-protected screen
// in the building and is often visible to whoever is standing at it; the POS
// has no use for more than this, so it never receives it and cannot leak it.
//
// The name is not decoration: it is the confirmation step VAL-2 requires before
// a linkage takes effect, so a mistyped digit is caught by a human rather than
// spending a stranger's points.
//
// `source` tells the POS how much to trust the name it's showing:
//  - 'account'       — a VERIFIED phone-linked account (findVerifiedCustomerByPhone).
//  - 'order_history'  — no account matched, but a past order used this exact
//                        phone; the name comes from that order's own
//                        customer_name (whatever a staffer typed for them
//                        last time — never re-verified, just recalled).
// The fallback exists because most regulars at a counter never make an
// account; without it, "returning customer" would mean nothing for anyone
// who has ordered ten times and signed up for zero accounts.
//
// PIN-3: gated by getCounterActor() — classic session first, unchanged; an
// enrolled-device PIN operator only when there is no session at all.
export async function GET(request: Request) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  const user = actor.user;

  const raw = new URL(request.url).searchParams.get('phone') ?? '';
  const normalized = normalizeIndianMobile(raw);
  if (!normalized) {
    return errorResponse(400, 'phone must be a valid 10-digit Indian mobile number');
  }

  // A staff session is already the gate; this only bounds what a stolen or
  // borrowed one can harvest. It cannot stop a targeted lookup (nothing can —
  // that is the feature), so it is set well above a real shift's traffic:
  // ~2 lookups per order at 60 orders an hour is nowhere near 120 per 10 min.
  if (!(await rateLimitOk(`customer-lookup:${user.id}`, 120, 600))) {
    return errorResponse(429, 'Too many customer lookups — please wait a moment.');
  }

  const admin = createAdminSupabaseClient();
  const phoneE164 = `+91${normalized}`;
  const account = await findVerifiedCustomerByPhone(admin, phoneE164);

  if (account) {
    // One query for both order_count and last_order_at: PostgREST's `count`
    // reflects every row matching the filter regardless of `.limit()`, so a
    // single indexed round trip (ordered, capped at 1 row of data) answers
    // both without a second query.
    const { data, count, error } = await admin
      .from('orders')
      .select('created_at', { count: 'exact' })
      .or(orderMatchFilter(phoneE164, account.userId))
      .order('created_at', { ascending: false })
      .limit(1);
    if (error) console.error('customers/lookup: order-history count failed', error);

    return NextResponse.json({
      found: true,
      source: 'account',
      name: account.name,
      points_balance: await getBalance(account.userId),
      order_count: count ?? 0,
      last_order_at: data?.[0]?.created_at ?? null,
    });
  }

  // No account — fall back to the most recent order placed with this exact
  // phone. Not an error: most walk-ins have no account, and the POS shows
  // that as "no order history either" rather than a failure.
  const { data, count, error } = await admin
    .from('orders')
    .select('customer_name, created_at', { count: 'exact' })
    .or(orderMatchFilter(phoneE164, null))
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) console.error('customers/lookup: order-history fallback failed', error);

  const lastOrder = data?.[0];
  if (!lastOrder) {
    return NextResponse.json({ found: false });
  }

  return NextResponse.json({
    found: true,
    source: 'order_history',
    name: lastOrder.customer_name,
    order_count: count ?? 0,
    last_order_at: lastOrder.created_at,
  });
}
