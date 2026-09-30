import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { findVerifiedCustomerByPhone, orderMatchFilter, toStoredPhone } from '@/lib/loyalty/customerLink';
import { coffeePassDisabled } from '@/lib/passes/api';
import { PASS_SALE_SUMMARY_SELECT, toPassSaleSummaries } from '@/lib/passes/sale';
import { loadPassRedemptionHistory, loadPassSummaries } from '@/lib/passes/server';

export const dynamic = 'force-dynamic';

/** Past passes shown after the usable ones. */
const OTHER_PASSES = 5;
/** History lines kept per pass: the counter needs "what was it last spent on", not an audit. */
const HISTORY_PER_PASS = 10;
const UNPAID_LIMIT = 10;

// GET /api/passes/holder?phone=<10-digit> — the counter's view of a customer's
// HIOC Ritual: the Passes screen types a number and reads back who it is, what
// they hold and what they still owe.
//
//   { found: false }                       no VERIFIED account holds that number
//   { found: true, name, passes, unpaid_sales }
//
//   passes        the usable passes first (soonest-expiring first), then the last
//                 5 others (used up, expired, refunded), each with its balance
//                 and history (`reversed` marks cups that came back).
//   unpaid_sales  pass sales opened at the counter and not yet paid (order
//                 'unpaid', not cancelled or rejected), for that account OR that
//                 phone number: the "Collect payment" list. The phone match is
//                 the same one customer lookup uses (orderMatchFilter), so a
//                 sale filed under a number is found however it was linked.
//
// The account is found the way the counter finds it for an order: by the VERIFIED
// phone (findVerifiedCustomerByPhone), never by anything the client names. And
// like GET /api/customers/lookup it returns NO user id, email or address, only a
// name and pass and order ids: a counter tablet is the least-protected screen in
// the building.
//
// Rate limit 120 per 10 minutes per staffer, the same as customer lookup: a
// real shift never gets near it, a borrowed session cannot harvest with it.
//
// PIN-3: gated by getCounterActor() (a session, else an enrolled device's PIN operator).
export async function GET(request: Request) {
  const off = coffeePassDisabled();
  if (off) return off;

  const actor = await getCounterActor();
  if (!actor) return unauthorized();

  const phone = toStoredPhone(new URL(request.url).searchParams.get('phone') ?? '');
  if (!phone) return errorResponse(400, 'phone must be a valid 10-digit Indian mobile number');

  if (!(await rateLimitOk(`customer-lookup:${actor.user.id}`, 120, 600))) {
    return errorResponse(429, 'Too many customer lookups — please wait a moment.');
  }

  const admin = createAdminSupabaseClient();
  const account = await findVerifiedCustomerByPhone(admin, phone);
  if (!account) return NextResponse.json({ found: false });

  const [passes, unpaid] = await Promise.all([
    loadPassSummaries(admin, account.userId, { includeInactive: true, inactiveLimit: OTHER_PASSES }),
    admin
      .from('orders')
      .select(PASS_SALE_SUMMARY_SELECT)
      .eq('order_kind', 'coffee_pass')
      .eq('payment_status', 'unpaid')
      .not('status', 'in', '(cancelled,rejected)')
      .or(orderMatchFilter(phone, account.userId))
      .order('created_at', { ascending: true })
      .limit(UNPAID_LIMIT),
  ]);
  // A failed read of the unpaid list must not hide the passes: log it and show none.
  if (unpaid.error) console.error('GET /api/passes/holder: unpaid sales read failed', unpaid.error);

  const history = await loadPassRedemptionHistory(
    admin,
    passes.map((p) => p.id),
    { perPass: HISTORY_PER_PASS },
  );

  return NextResponse.json({
    found: true,
    name: account.name,
    passes: passes.map((p) => ({ ...p, history: history[p.id] ?? [] })),
    unpaid_sales: toPassSaleSummaries(unpaid.data),
  });
}
