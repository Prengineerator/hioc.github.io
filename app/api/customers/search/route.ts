import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { mergeCustomerSuggestions, nameSearchTerm, phoneSearchPrefix } from '@/lib/customers/phoneSearch';

export const dynamic = 'force-dynamic';

// GET /api/customers/search?q=<4–9 digits> or ?name=<2+ characters> — staff-
// gated. Customer suggestions while a phone number or a name is being typed at
// the POS (New order → Customer): up to six people whose number STARTS with
// those digits, or whose name CONTAINS that text, from verified accounts, app
// orders and the Petpooja history, most recent visit first. Digits win if both
// are sent.
//
// Same data minimisation as /api/customers/lookup: a name, the number, a bill
// count and the last visit — no ids, emails, addresses or balances (those
// arrive through the exact lookup once a number is picked). Minimum lengths
// and six rows, so it can't list the customer base; the rate limit bounds a
// borrowed session. Only rows that matched are merged, though a phone matched
// by name may show its account name rather than the typed one.
export async function GET(request: Request) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();

  const params = new URL(request.url).searchParams;
  const prefix = phoneSearchPrefix(params.get('q') ?? '');
  const term = prefix ? null : nameSearchTerm(params.get('name') ?? '');
  if (!prefix && !term) return NextResponse.json({ customers: [] });

  // Typing fires one search per pause; a busy shift is far below this.
  if (!(await rateLimitOk(`customer-search:${actor.user.id}`, 600, 600))) {
    return errorResponse(429, 'Too many customer searches — please wait a moment.');
  }

  const admin = createAdminSupabaseClient();
  // nameSearchTerm() already stripped the pattern wildcards, so % is ours alone.
  const pattern = prefix ? `${prefix}%` : `%${term}%`;
  const accountsQuery = admin.from('profiles').select('phone, name').eq('phone_verified', true).limit(20);
  const ordersQuery = admin.from('orders').select('customer_phone, customer_name, created_at');
  const legacyQuery = admin.from('legacy_customers').select('phone, name, order_count, last_order_at');
  const [accounts, orders, legacy] = await Promise.all([
    prefix ? accountsQuery.like('phone', pattern) : accountsQuery.not('phone', 'is', null).ilike('name', pattern),
    (prefix ? ordersQuery.like('customer_phone', pattern) : ordersQuery.not('customer_phone', 'is', null).ilike('customer_name', pattern))
      .order('created_at', { ascending: false })
      .limit(200),
    (prefix ? legacyQuery.like('phone', pattern) : legacyQuery.ilike('name', pattern))
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
