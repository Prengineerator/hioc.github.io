import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { runOnlineReportSync } from '@/lib/online-settlements/sync';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/owner/online-reports/sync  { lookbackDays?: 1–400 } — owner only.
// The "Check email now" button on Owner → Online orders: the same mailbox read
// as the daily cron, on demand. A larger look-back pulls in older reports the
// first time (a run downloads at most 60 report emails, starts no new one after
// 45 s, and says how many are left; emails already handled are skipped without
// downloading).
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();

  // No body (or not JSON): use the configured look-back.
  const body = ((await request.json().catch(() => null)) ?? {}) as { lookbackDays?: unknown };
  let lookbackDays: number | undefined;
  if (body.lookbackDays !== undefined) {
    const n = Number(body.lookbackDays);
    if (!Number.isInteger(n) || n < 1 || n > 400) return errorResponse(400, 'lookbackDays must be a whole number from 1 to 400');
    lookbackDays = n;
  }

  const result = await runOnlineReportSync(createAdminSupabaseClient(), 'owner', { lookbackDays });
  if (!result.configured) return errorResponse(400, result.error ?? 'Email is not set up');
  if (!result.ok) return errorResponse(502, result.error ?? 'Mail check failed');
  return NextResponse.json({ result });
}
