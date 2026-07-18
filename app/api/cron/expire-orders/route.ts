import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { reverseForOrder } from '@/lib/loyalty/ledger';
import { broadcastOrderEvent } from '@/lib/realtime/broadcast';

export const dynamic = 'force-dynamic';

// Orders stuck at 'placed' (online payment started, never captured) older than
// this are auto-cancelled so they don't linger forever (H5 / Phase-2 DoD:
// "failed/abandoned online payments … auto-expire").
const EXPIRE_AFTER_MIN = 30;

// GET /api/cron/expire-orders — point a Vercel Cron at this (e.g. every 5 min):
//   vercel.json → { "crons": [{ "path": "/api/cron/expire-orders", "schedule": "*/5 * * * *" }] }
// Protected by CRON_SECRET (Bearer). Fails CLOSED: if CRON_SECRET is unset the
// endpoint is disabled (401), so it can never be triggered publicly.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  // S2: fail CLOSED — if CRON_SECRET is not configured, the endpoint is disabled
  // rather than runnable by anyone. It must be set (and matched) to run.
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return errorResponse(401, 'Unauthorized');
  }

  const admin = createAdminSupabaseClient();
  const cutoff = new Date(Date.now() - EXPIRE_AFTER_MIN * 60_000).toISOString();

  const { data: stale, error } = await admin
    .from('orders')
    .select('id, version')
    .eq('status', 'placed')
    .lt('created_at', cutoff);
  if (error) return errorResponse(500, 'Failed to query stale orders');

  let expired = 0;
  for (const o of stale ?? []) {
    // Version-guarded so we never cancel one that just got captured/paid.
    const { data: updated } = await admin
      .from('orders')
      .update({
        status: 'cancelled',
        payment_status: 'unpaid',
        reject_reason: 'Payment not completed in time',
        version: (o.version as number) + 1,
      })
      .eq('id', o.id)
      .eq('version', o.version)
      .eq('status', 'placed')
      .select('id')
      .maybeSingle();
    if (!updated) continue;

    await admin.from('order_status_events').insert({
      order_id: o.id,
      from_status: 'placed',
      to_status: 'cancelled',
      actor_id: null,
      actor_role: 'system',
      reason: 'Auto-expired: payment not completed',
    });
    await reverseForOrder(o.id);
    await broadcastOrderEvent(o.id, 'cancelled');
    expired++;
  }

  return NextResponse.json({ expired });
}
