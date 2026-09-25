import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse } from '@/lib/api/http';
import type { FeedbackRequest } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 100;

export interface FeedbackThreadRow extends FeedbackRequest {
  order_number: number | null;
  last_message: { body: string; direction: 'in' | 'out'; created_at: string } | null;
}

// GET /api/owner/feedback?filter=attention|all|resolved — the inbox list.
// Owner-only (getOwnerUser()). "Needs attention" = an unread inbound message
// OR a low rating (<=3) on a thread that isn't already resolved; every view
// puts a rating <=2 first — that is the signal most likely to need a human
// today, wherever it's found.
export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const { searchParams } = new URL(request.url);
  const filter = searchParams.get('filter') ?? 'attention';
  const parsedLimit = Number.parseInt(searchParams.get('limit') ?? '', 10);
  const limit = Number.isFinite(parsedLimit) ? Math.min(Math.max(parsedLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT;

  const admin = createAdminSupabaseClient();

  let query = admin.from('feedback_requests').select('*, orders(order_number)').limit(limit);
  if (filter === 'resolved') {
    query = query.eq('thread_status', 'resolved');
  } else if (filter === 'attention') {
    query = query.neq('thread_status', 'resolved').or('unread.eq.true,rating.lte.3');
  }
  // 'all' — no extra filter.

  const { data, error } = await query.order('updated_at', { ascending: false });
  if (error) return errorResponse(500, error.message);

  const rows = (data ?? []) as (FeedbackRequest & { orders: { order_number: number } | null })[];
  const requestIds = rows.map((r) => r.id);

  // One batch query for every thread's most recent message, rather than N+1.
  const lastByRequest = new Map<string, { body: string; direction: 'in' | 'out'; created_at: string }>();
  if (requestIds.length > 0) {
    const { data: msgRows } = await admin
      .from('feedback_messages')
      .select('request_id, body, direction, created_at')
      .in('request_id', requestIds)
      .order('created_at', { ascending: false });
    for (const m of msgRows ?? []) {
      const reqId = m.request_id as string | null;
      if (!reqId || lastByRequest.has(reqId)) continue; // first hit per id = latest (already DESC)
      lastByRequest.set(reqId, { body: m.body as string, direction: m.direction as 'in' | 'out', created_at: m.created_at as string });
    }
  }

  const threads: FeedbackThreadRow[] = rows
    .map((r): FeedbackThreadRow => {
      const { orders, ...request } = r;
      return {
        ...request,
        order_number: orders?.order_number ?? null,
        last_message: lastByRequest.get(r.id) ?? null,
      };
    })
    // Rating <=2 first, in every view — the spec's own sort rule.
    .sort((a, b) => {
      const aLow = a.rating !== null && a.rating <= 2 ? 0 : 1;
      const bLow = b.rating !== null && b.rating <= 2 ? 0 : 1;
      if (aLow !== bLow) return aLow - bLow;
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });

  return NextResponse.json({ threads });
}
