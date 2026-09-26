import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { mergeCustomerSuggestions, phoneSearchPrefix } from '@/lib/customers/phoneSearch';

export const dynamic = 'force-dynamic';

// GET /api/customers/search?q=<4–9 digits> — staff-gated. Customer suggestions
// while a phone number is being typed at the POS (New order → Customer): up to
// six people whose number STARTS with those digits, from verified accounts,
// app orders and the Petpooja history, most recent visit first.
//
// Same data minimisation as /api/customers/lookup: a name, the number, a bill
// count and the last visit — no ids, emails, addresses or balances (those
// arrive through the exact lookup once a number is picked). Prefix-only, at
// least 4 digits and six rows, so it can't list the customer base; the rate
// limit bounds a borrowed session.
export async function GET(request: Request) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();

  const prefix = phoneSearchPrefix(new URL(request.url).searchParams.get('q') ?? '');
  if (!prefix) return NextResponse.json({ customers: [] });

  // Typing fires one search per pause; a busy shift is far below this.
  if (!(await rateLimitOk(`customer-search:${actor.user.id}`, 600, 600))) {
    return errorResponse(429, 'Too many customer searches — please wait a moment.');
  }

  const admin = createAdminSupabaseClient();
  const pattern = `${prefix}%`;
  const [accounts, orders, legacy] = await Promise.all([
    admin.from('profiles').select('phone, name').eq('phone_verified', true).like('phone', pattern).limit(20),
    admin
      .from('orders')
      .select('customer_phone, customer_name, created_at')
      .like('customer_phone', pattern)
      .order('created_at', { ascending: false })
      .limit(200),
    admin
      .from('legacy_customers')
      .select('phone, name, order_count, last_order_at')
      .like('phone', pattern)
      .order('last_order_at', { ascending: false, nullsFirst: false })
      .limit(20),
  ]);
  for (const [label, r] of [
    ['accounts', accounts],
    ['orders', orders],
    ['legacy', legacy],
  ] as const) {
    if (r.error) console.error(`customers/search: ${label} query failed`, r.error);
  }

  return NextResponse.json({
    customers: mergeCustomerSuggestions({
      accounts: accounts.data ?? [],
      orders: orders.data ?? [],
      legacy: legacy.data ?? [],
    }),
  });
}
