import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { generateWeeklyDigest } from '@/lib/suggest/digest';
import { getSuggestionStats } from '@/lib/suggest/queries';

export const dynamic = 'force-dynamic';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// The IST-Monday date (YYYY-MM-DD) of the week this run covers — the 7 days
// up to "now", which is why the cron fires just after Monday 00:00 IST
// (vercel.json: "30 22 * * 0" UTC = Monday 04:00 IST).
function currentIstMondayDateStr(): string {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  const dow = ist.getUTCDay(); // wall-clock IST day-of-week, 0=Sun..6=Sat
  const daysSinceMonday = (dow + 6) % 7;
  const mondayMs = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - daysSinceMonday);
  return new Date(mondayMs).toISOString().slice(0, 10);
}

// GET /api/cron/suggest-digest — Vercel Cron, Mondays 04:00 IST.
//   vercel.json → { "path": "/api/cron/suggest-digest", "schedule": "30 22 * * 0" }
// Protected by CRON_SECRET (Bearer), fails CLOSED exactly like
// /api/cron/expire-orders: an unset secret disables the route rather than
// leaving it runnable by anyone (playbook C-4).
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const windowStart = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const { stats } = await getSuggestionStats(windowStart);
  const digest = await generateWeeklyDigest(stats);

  const admin = createAdminSupabaseClient();
  const { error } = await admin.from('suggestion_digests').insert({
    week_start: currentIstMondayDateStr(),
    summary: digest.summary,
    stats,
    source: digest.source,
    model: digest.model,
  });
  if (error) return errorResponse(500, error.message);

  return NextResponse.json({ ok: true, source: digest.source, sessions: stats.sessions });
}
