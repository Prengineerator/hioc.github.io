import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { clientIp, rateLimitOk } from '@/lib/api/rateLimit';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { flags } from '@/lib/flags';
import { isUuid } from '@/lib/push/validate';

export const dynamic = 'force-dynamic';

// POST /api/push/click {sendId} — the service worker's beacon when a notification
// is tapped. Anonymous by design (the worker has no session); the only thing it can
// do is add one to a send's clicked counter, never past the number of phones the
// send went to (clicked < device_count), and only by the opaque uuid of that send.
// Always answers ok for a well-formed id: a lost count must never matter to the
// customer.
export async function POST(request: Request) {
  if (!flags.webPush) return notFound();
  const body = await parseJsonBody(request);
  if (!body || !isUuid(body.sendId)) return errorResponse(400, 'sendId must be a uuid');

  if (!(await rateLimitOk(`push-click:${clientIp(request)}`, 60, 3600))) {
    return errorResponse(429, 'Too many requests.');
  }
  try {
    const admin = createAdminSupabaseClient();
    const { data, error } = await admin.from('push_sends').select('clicked, device_count').eq('id', body.sendId).maybeSingle();
    const row = data as { clicked: number; device_count: number } | null;
    if (error) console.error('push click failed', error.message);
    else if (row && row.clicked < row.device_count) {
      // Guarded by the value we read, so two taps at once cannot skip past the cap.
      const upd = await admin.from('push_sends').update({ clicked: row.clicked + 1 }).eq('id', body.sendId).eq('clicked', row.clicked);
      if (upd.error) console.error('push click failed', upd.error.message);
    }
  } catch (err) {
    console.error('push click failed', err);
  }
  return NextResponse.json({ ok: true });
}
