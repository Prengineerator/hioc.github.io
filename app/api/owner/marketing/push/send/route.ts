import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, notFound, parseJsonBody, unauthorized } from '@/lib/api/http';
import { flags } from '@/lib/flags';
import { ownerRoute } from '@/lib/marketing/server/http';
import { assertOk } from '@/lib/marketing/server/repo';
import { loadSubscriptions, NOT_CONFIGURED_MESSAGE, sendAndRecord, vapidConfig } from '@/lib/push/server';
import { parseMessage } from '@/lib/push/validate';
import { istDateIso } from '@/lib/api/date';
import type { PushSendResult } from '@/lib/push/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const ALREADY_SENT_MESSAGE = 'You have already sent a notification to everyone today. To keep customers from switching them off, you can send one a day. Try again tomorrow.';

// POST /api/owner/marketing/push/send — a notification to EVERY signed-up phone.
// At most one a day (India time): the push_sends partial unique index on
// (sent_on) where kind = 'broadcast' is the real limit, so two taps or two tabs
// race safely, and a unique violation (23505) becomes a plain 409. The body must
// carry `confirm_count`, the number of phones the owner saw in the confirm
// dialog; if the list changed since, nothing is sent. OWNER ONLY.
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
    if (typeof body.confirm_count !== 'number' || !Number.isInteger(body.confirm_count) || body.confirm_count < 0) {
      return errorResponse(400, 'Confirm how many phones this goes to.');
    }

    const cfg = vapidConfig();
    if (!cfg) return errorResponse(503, NOT_CONFIGURED_MESSAGE);

    const admin = createAdminSupabaseClient();
    const subs = await loadSubscriptions(admin);
    if (subs.length === 0) return errorResponse(400, 'Nobody has signed up for notifications yet.');
    if (subs.length !== body.confirm_count) {
      return errorResponse(409, `The number of signed-up phones changed to ${subs.length}. Check the count and send again.`);
    }

    // Claim today's slot BEFORE sending.
    const ins = await admin
      .from('push_sends')
      .insert({ ...message.value, kind: 'broadcast', sent_by: owner.id, sent_on: istDateIso(), device_count: subs.length })
      .select('id')
      .single();
    if (ins.error && (ins.error as { code?: string }).code === '23505') {
      return errorResponse(409, ALREADY_SENT_MESSAGE);
    }
    assertOk('push_sends insert', ins.error);
    const sendId = (ins.data as { id: string }).id;

    const outcome = await sendAndRecord(admin, subs, message.value, sendId, cfg);

    return NextResponse.json({ ok: true, send_id: sendId, device_count: subs.length, ...outcome } satisfies PushSendResult);
  });
}
