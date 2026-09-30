import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/api/http';
import { runDailyPlan } from '@/lib/marketing/server/planner';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// GET or POST /api/cron/marketing-plan — Vercel Cron, daily at 09:45 IST
// (vercel.json: 15 4 * * *). One pass of the marketing agent's loop (docs/
// MARKETING-AGENT-SPEC.md §6): attribute returns, learn from finished campaigns, expire
// stale approvals, and — only with Sending ON — plan tonight's campaigns.
//
// Idempotent: a campaign is unique per (playbook, IST day), so a retried run plans
// nothing twice. With the migration not applied it is a no-op {enabled:false,
// migration_missing:true}. When pg_cron is not set up, a run inside the send window also
// nudges the sender once.
//
// Protected by CRON_SECRET (Bearer), fails CLOSED when unset — the same posture as every
// other /api/cron/* route. GET for Vercel and manual triggers, POST for anything that
// posts; both run the identical handler.
async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }
  try {
    return NextResponse.json(await runDailyPlan());
  } catch (err) {
    console.error('marketing-plan cron failed', err);
    return errorResponse(500, 'The marketing plan run failed');
  }
}

export async function GET(request: Request) {
  return handle(request);
}

export async function POST(request: Request) {
  return handle(request);
}
