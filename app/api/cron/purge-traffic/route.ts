import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { isMissingTrafficTable } from '@/lib/traffic/record';
import { TRAFFIC_RETENTION_DAYS } from '@/lib/traffic/types';

export const dynamic = 'force-dynamic';

// Weekly (vercel.json). Deletes traffic_events rows older than 13 months — the
// retention the privacy policy states for usage data. A whole row goes: unlike
// attendance, nothing in it is a record anyone needs to keep.
//
// Idempotent, and a no-op before supabase/2026-11-traffic-tracking.sql is
// applied. Fails CLOSED without CRON_SECRET, same posture as the other jobs.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const cutoff = new Date(Date.now() - TRAFFIC_RETENTION_DAYS * 86_400_000).toISOString();
  const { error, count } = await createAdminSupabaseClient()
    .from('traffic_events')
    .delete({ count: 'exact' })
    .lt('created_at', cutoff);

  if (error) {
    if (isMissingTrafficTable(error)) return NextResponse.json({ ok: true, deleted: 0, note: 'traffic_events not created yet' });
    console.error('purge-traffic: delete failed', error);
    return errorResponse(500, 'Could not purge old traffic rows');
  }
  return NextResponse.json({ ok: true, deleted: count ?? 0, cutoff });
}
