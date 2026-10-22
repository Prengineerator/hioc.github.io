import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { runOnlineReportSync } from '@/lib/online-settlements/sync';

export const dynamic = 'force-dynamic';
// Logging into the mailbox, downloading a fortnight of report emails and
// writing a few hundred orders each.
export const maxDuration = 60;

// GET /api/cron/online-reports — Vercel Cron, daily 09:15 IST.
//   vercel.json → { "path": "/api/cron/online-reports", "schedule": "45 3 * * *" }
// Reads the Zomato/Swiggy settlement emails from the last
// ONLINE_REPORTS_LOOKBACK_DAYS (default 14) into Owner → Online orders. Zomato
// settles on Wednesdays; checking daily means a report shows up the morning
// after it lands. Safe to run any number of times: a file already read is
// skipped by its hash (lib/online-settlements/ingest.ts).
//
// Protected by CRON_SECRET (Bearer), fails CLOSED like every other cron. With
// the mailbox not configured it answers 200 with a note rather than an error,
// so an unconfigured feature doesn't page anyone.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const result = await runOnlineReportSync(createAdminSupabaseClient(), 'cron');
  if (!result.configured) return NextResponse.json({ ok: true, note: result.error });
  return NextResponse.json(
    {
      ok: result.ok,
      messagesFound: result.messagesFound,
      messagesLeft: result.messagesLeft,
      filesFound: result.filesFound,
      filesRead: result.filesRead,
      filesSkipped: result.filesSkipped,
      filesFailed: result.filesFailed,
      error: result.error,
    },
    { status: result.ok ? 200 : 500 },
  );
}
