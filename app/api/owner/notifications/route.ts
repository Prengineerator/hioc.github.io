import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse } from '@/lib/api/http';
import { billChannelHealth, providerMismatch } from '@/lib/notifications/health';

export const dynamic = 'force-dynamic';

// BILL-5 — owner-only delivery log. Answers "did our bills actually go out?",
// which until now was answerable only by querying Supabase directly.
//
// Returns two things:
//   1. `health` — the live channel configuration (BILL-3). An owner seeing zero
//      sends needs to know whether nothing was sent or nothing was configured.
//   2. `notifications` — the recent delivery rows, newest first, with the order
//      number resolved so a row is traceable to a real order.
//
// Read-only. Owner-gated by getOwnerUser(); the service-role client is used for
// the join (the notifications RLS policy is staff-read, but the owner surface
// wants the order number alongside it).

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const { searchParams } = new URL(request.url);
  const event = searchParams.get('event'); // e.g. 'bill'
  const status = searchParams.get('status'); // 'sent' | 'failed' | 'skipped' | 'queued'
  const parsedLimit = Number.parseInt(searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT)
    : DEFAULT_LIMIT;

  const admin = createAdminSupabaseClient();

  let query = admin
    .from('notifications')
    .select('id, order_id, channel, event, status, provider_ref, error, skip_reason, attempts, sent_at, created_at, orders(order_number)')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (event) query = query.eq('event', event);
  // 'undelivered' is the view an owner actually wants: everything that did NOT
  // reach the customer, whether it failed at the provider or was never tried.
  if (status === 'undelivered') query = query.in('status', ['failed', 'skipped']);
  else if (status) query = query.eq('status', status);

  const { data, error } = await query;
  if (error) return errorResponse(500, error.message);

  const notifications = (data ?? []).map((row) => {
    const { orders, ...rest } = row as typeof row & { orders?: { order_number: number } | null };
    return { ...rest, order_number: orders?.order_number ?? null };
  });

  return NextResponse.json({
    notifications,
    health: billChannelHealth(),
    provider_warning: providerMismatch(),
  });
}
