import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/http';
import { runSendBatch } from '@/lib/marketing/server/sender';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET or POST /api/cron/marketing-send — polled by pg_cron every 5 minutes
// (supabase/2026-10-marketing-agent.sql) via `net.http_post`, which issues a POST, so POST
// is exported alongside GET; both run the identical handler. NOT Vercel Cron. The plan
// is Pro (since 2026-11-18), so a 5-minute Vercel cron is possible, but the poll stays in
// Supabase on purpose: its guard skips the call when nothing is due, which costs less than
// a Vercel cron invocation every 5 minutes.
//
// Sends up to 50 queued messages a run, inside the IST send window, under the month's
// budget and the day's cap — and does NOTHING unless the owner switched Sending ON. Every
// message re-checks consent first. With the migration not applied it is a no-op
// {enabled:false, migration_missing:true}, never an error.
//
// Protected by CRON_SECRET (Bearer), fails CLOSED when unset.
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }
  try {
    return NextResponse.json(await runSendBatch());
  } catch (err) {
    console.error('marketing-send cron failed', err);
    return errorResponse(500, 'The marketing send run failed');
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
