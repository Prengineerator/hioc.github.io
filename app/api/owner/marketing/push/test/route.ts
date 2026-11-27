import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { rateLimitOk } from '@/lib/api/rateLimit';
import { flags } from '@/lib/flags';
import { ownerRoute } from '@/lib/marketing/server/http';
import { assertOk } from '@/lib/marketing/server/repo';
import { loadSubscriptions, NOT_CONFIGURED_MESSAGE, sendAndRecord, vapidConfig } from '@/lib/push/server';
import { parseMessage } from '@/lib/push/validate';
import { istDateIso } from '@/lib/api/date';
import type { PushSendResult } from '@/lib/push/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// POST /api/owner/marketing/push/test — the message to the OWNER'S OWN signed-up
// phones only, so it can be read on a real phone before anyone else gets it.
// Recorded as kind 'test' (never counts toward the one-a-day limit). OWNER ONLY.
export async function POST(request: Request) {
  if (!flags.webPush) return notFound();
  // Access gate (SECURITY-PLAYBOOK C-3): owner session only, checked before the
  // service-role client is created. ownerRoute re-checks and maps failures.
  if (!(await getOwnerUser())) return unauthorized();
  return ownerRoute(async (owner) => {
    const body = await parseJsonBody(request);
    if (!body) return errorResponse(400, 'Request body must be a JSON object');
    const message = parseMessage(body);
    if (!message.ok) return errorResponse(400, message.error);

    const cfg = vapidConfig();
    if (!cfg) return errorResponse(503, NOT_CONFIGURED_MESSAGE);

    if (!(await rateLimitOk(`push-test:${owner.id}`, 10, 3600))) {
      return errorResponse(429, 'You can send 10 test notifications an hour. Please try again later.');
    }

    const admin = createAdminSupabaseClient();
    const subs = await loadSubscriptions(admin, owner.id);
    if (subs.length === 0) {
      return errorResponse(400, 'None of your own phones are signed up yet. Open Account → Profile on your phone, turn on "Offers as phone notifications", then try again.');
    }

    const ins = await admin
      .from('push_sends')
      .insert({ ...message.value, kind: 'test', sent_by: owner.id, sent_on: istDateIso(), device_count: subs.length })
      .select('id')
      .single();
    assertOk('push_sends insert', ins.error);
    const sendId = (ins.data as { id: string }).id;

    const outcome = await sendAndRecord(admin, subs, message.value, sendId, cfg);

    return NextResponse.json({ ok: true, send_id: sendId, device_count: subs.length, ...outcome } satisfies PushSendResult);
  });
}
