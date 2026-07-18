import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';
import { createAdminSupabaseClient } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

// GET — Meta's webhook verification handshake. When you click "Verify and save"
// in the WhatsApp webhook config, Meta calls this with hub.verify_token; we echo
// hub.challenge back only if the token matches WHATSAPP_WEBHOOK_VERIFY_TOKEN.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('hub.mode');
  const token = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
  if (mode === 'subscribe' && expected && token === expected) {
    return new Response(challenge ?? '', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('Forbidden', { status: 403 });
}

// Optional signature check (X-Hub-Signature-256 = HMAC-SHA256 of the raw body
// with the app secret). Skipped when WHATSAPP_APP_SECRET isn't set.
function signatureOk(rawBody: string, header: string | null): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true; // not configured — accept (delivery-status only, low risk)
  if (!header?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && timingSafeEqual(a, b);
}

// POST — inbound events. We use the message *status* updates (sent/delivered/
// read/failed) to reconcile the delivery state of the notifications we sent:
// each status references the WhatsApp message id, which the notifications
// engine stores in `notifications.provider_ref`. Always returns 200 so Meta
// doesn't retry-storm on a transient error.
export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!signatureOk(rawBody, request.headers.get('x-hub-signature-256'))) {
    return new Response('Invalid signature', { status: 403 });
  }

  try {
    const payload = JSON.parse(rawBody) as {
      entry?: { changes?: { value?: { statuses?: { id?: string; status?: string; errors?: { title?: string }[] }[] } }[] }[];
    };
    const statuses = payload.entry?.[0]?.changes?.[0]?.value?.statuses;
    if (Array.isArray(statuses) && statuses.length > 0) {
      const admin = createAdminSupabaseClient();
      for (const s of statuses) {
        if (!s.id) continue;
        const mapped = s.status === 'failed' ? 'failed' : 'sent'; // sent/delivered/read → sent
        await admin
          .from('notifications')
          .update({ status: mapped, error: s.errors?.[0]?.title ?? '' })
          .eq('provider_ref', s.id);
      }
    }
  } catch (err) {
    console.error('whatsapp webhook handling failed', err);
  }

  return NextResponse.json({ received: true });
}
