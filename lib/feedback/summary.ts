// Owner-dashboard feedback summary card's numbers — average rating over
// 7/30 days, response rate, and the "needs attention" count. Server-only,
// admin client, same convention as lib/analytics/queries.ts.

import 'server-only';
import { createAdminSupabaseClient } from '@/lib/supabase-server';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface FeedbackSummary {
  avgRating7d: number | null;
  avgRating30d: number | null;
  /** Of the requests actually SENT in the last 30 days, what fraction got a rating. */
  responseRate30d: number | null;
  responseCount30d: number;
  sentCount30d: number;
  needsAttention: number;
}

export async function getFeedbackSummary(): Promise<FeedbackSummary> {
  const admin = createAdminSupabaseClient();
  const now = Date.now();
  const since30 = new Date(now - 30 * DAY_MS).toISOString();
  const since7 = new Date(now - 7 * DAY_MS).toISOString();

  const [{ data: sent30 }, { count: needsAttention }] = await Promise.all([
    admin
      .from('feedback_requests')
      .select('rating, responded_at, sent_at')
      .eq('status', 'sent')
      .gte('sent_at', since30),
    admin
      .from('feedback_requests')
      .select('id', { count: 'exact', head: true })
      .neq('thread_status', 'resolved')
      .or('unread.eq.true,rating.lte.3'),
  ]);

  const rows = sent30 ?? [];
  const rated7 = rows.filter((r) => r.rating !== null && (r.responded_at ?? '') >= since7);
  const rated30 = rows.filter((r) => r.rating !== null);
  const avg = (xs: { rating: number | null }[]) =>
    xs.length > 0 ? xs.reduce((sum, r) => sum + (r.rating as number), 0) / xs.length : null;

  return {
    avgRating7d: avg(rated7),
    avgRating30d: avg(rated30),
    responseRate30d: rows.length > 0 ? rated30.length / rows.length : null,
    responseCount30d: rated30.length,
    sentCount30d: rows.length,
    needsAttention: needsAttention ?? 0,
  };
}
