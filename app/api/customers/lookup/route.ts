import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { normalizeIndianMobile } from '@/lib/phone';
import { findVerifiedCustomerByPhone } from '@/lib/loyalty/customerLink';
import { getBalance } from '@/lib/loyalty/ledger';

export const dynamic = 'force-dynamic';

// GET /api/customers/lookup?phone=<10-digit> — staff-gated (VAL-1/VAL-2).
//
// Answers the only two questions a staffer has when a regular gives their
// number: is this the right person, and what can they spend? Hence a name and a
// balance, and deliberately NOTHING else — no user id, no email, no order
// history. A counter tablet is the least-protected screen in the building and
// is often visible to whoever is standing at it; the POS has no use for the
// rest, so it never receives it and cannot leak it.
//
// The name is not decoration: it is the confirmation step VAL-2 requires before
// a linkage takes effect, so a mistyped digit is caught by a human rather than
// spending a stranger's points.
export async function GET(request: Request) {
  const user = await getStaffUser();
  if (!user) return unauthorized();

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
  const customer = await findVerifiedCustomerByPhone(admin, `+91${normalized}`);
  if (!customer) {
    // Not an error: most walk-ins have no account, and the POS shows that as
    // "no account", not as a failure.
    return NextResponse.json({ found: false });
  }

  return NextResponse.json({
    found: true,
    name: customer.name,
    points_balance: await getBalance(customer.userId),
  });
}
