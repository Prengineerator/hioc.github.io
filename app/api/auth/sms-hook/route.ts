import { NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'crypto';

export const dynamic = 'force-dynamic';

// POST /api/auth/sms-hook — Supabase "Send SMS Hook". When enabled, Supabase
// Auth calls THIS instead of sending an SMS itself, handing us the phone + the
// OTP it generated; we deliver that code over WhatsApp (Authentication
// template) via the Meta Cloud API. Verification still happens through
// Supabase's verifyOtp — we only change the delivery channel.
//
// Configure: Supabase Dashboard → Authentication → Hooks → Send SMS Hook →
//   URL https://hioc.in/api/auth/sms-hook → copy the secret into
//   SUPABASE_SEND_SMS_HOOK_SECRET. Set WHATSAPP_OTP_TEMPLATE to your approved
//   Authentication template name.

// Standard-Webhooks signature check (what Supabase auth hooks use).
function signatureOk(rawBody: string, headers: Headers): boolean {
  const secretRaw = process.env.SUPABASE_SEND_SMS_HOOK_SECRET;
  if (!secretRaw) return true; // not configured yet — accept (dev/staging)
  const id = headers.get('webhook-id');
  const ts = headers.get('webhook-timestamp');
  const sigHeader = headers.get('webhook-signature');
  if (!id || !ts || !sigHeader) return false;

  const base64Secret = secretRaw.replace(/^v1,?\s*/, '').replace(/^whsec_/, '');
  let key: Buffer;
  try {
    key = Buffer.from(base64Secret, 'base64');
  } catch {
    return false;
  }
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`).digest('base64');
  // webhook-signature is a space-separated list of "v1,<base64sig>".
  return sigHeader.split(' ').some((part) => {
    const sig = part.split(',')[1];
    if (!sig) return false;
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

async function sendWhatsAppOtp(phoneE164: string, otp: string): Promise<{ ok: boolean; error: string }> {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_ID;
  const version = process.env.WHATSAPP_API_VERSION ?? 'v21.0';
  const template = process.env.WHATSAPP_OTP_TEMPLATE || 'login_code';
  const lang = process.env.WHATSAPP_TPL_LANG || 'en';
  if (!token || !phoneId) return { ok: false, error: 'whatsapp credentials missing' };
  try {
    const res = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: phoneE164.replace(/^\+/, ''),
        type: 'template',
        template: {
          name: template,
          language: { code: lang },
          // Authentication templates: the code goes in the body AND the
          // copy-code button parameter (both required by Meta).
          components: [
            { type: 'body', parameters: [{ type: 'text', text: otp }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: otp }] },
          ],
        },
      }),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) return { ok: false, error: data.error?.message ?? `HTTP ${res.status}` };
    return { ok: true, error: '' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'send failed' };
  }
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  if (!signatureOk(rawBody, request.headers)) {
    return NextResponse.json({ error: { message: 'invalid signature' } }, { status: 401 });
  }

  let payload: { user?: { phone?: string }; phone?: string; sms?: { otp?: string }; otp?: string };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: { message: 'invalid json' } }, { status: 400 });
  }

  const phone = payload.user?.phone ?? payload.phone;
  const otp = payload.sms?.otp ?? payload.otp;
  if (!phone || !otp) {
    return NextResponse.json({ error: { message: 'missing phone or otp' } }, { status: 400 });
  }
  const e164 = phone.startsWith('+') ? phone : `+${phone}`;

  const result = await sendWhatsAppOtp(e164, String(otp));
  if (!result.ok) {
    // Non-2xx so Supabase surfaces/retries the failure rather than silently
    // dropping the login code.
    return NextResponse.json(
      { error: { message: `whatsapp otp delivery failed: ${result.error}` } },
      { status: 500 },
    );
  }
  return NextResponse.json({}); // success — Supabase expects an empty object
}
