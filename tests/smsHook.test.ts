import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

// Handler-level test for POST /api/auth/sms-hook — the Supabase "Send SMS Hook"
// that delivers the login/checkout OTP over WhatsApp (WhatsApp-only). Verifies:
//   1. the Standard-Webhooks signature check (what Supabase auth hooks send),
//   2. the Supabase payload parsing (user.phone + sms.otp),
//   3. the exact Meta Cloud API Authentication-template params.
// No network: global fetch is stubbed and its call args asserted.

const SECRET = 'v1,whsec_dGVzdHNlY3JldA=='; // base64 "testsecret" → HMAC key

function sign(id: string, ts: string, body: string): string {
  const key = Buffer.from(SECRET.replace(/^v1,?\s*/, '').replace(/^whsec_/, ''), 'base64');
  const sig = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return `v1,${sig}`;
}

function makeReq(body: unknown, opts: { sign?: boolean; badSig?: boolean } = {}) {
  const raw = JSON.stringify(body);
  const id = 'msg_1';
  const ts = '1700000000';
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.sign) {
    headers['webhook-id'] = id;
    headers['webhook-timestamp'] = ts;
    headers['webhook-signature'] = opts.badSig ? 'v1,ZGVhZGJlZWY=' : sign(id, ts, raw);
  }
  return new Request('http://t/api/auth/sms-hook', { method: 'POST', headers, body: raw });
}

const OTP_PAYLOAD = { user: { phone: '+919000000000' }, sms: { otp: '123456' } };

let fetchMock: ReturnType<typeof vi.fn>;
const { POST } = await import('@/app/api/auth/sms-hook/route');

beforeEach(() => {
  process.env.SUPABASE_SEND_SMS_HOOK_SECRET = SECRET;
  process.env.WHATSAPP_TOKEN = 'tkn';
  process.env.WHATSAPP_PHONE_ID = '111222';
  process.env.WHATSAPP_OTP_TEMPLATE = 'login_code';
  delete process.env.WHATSAPP_TPL_LANG;
  fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /api/auth/sms-hook', () => {
  it('rejects a bad signature with 401 and sends nothing', async () => {
    const res = await POST(makeReq(OTP_PAYLOAD, { sign: true, badSig: true }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a missing signature with 401 when a secret is configured', async () => {
    const res = await POST(makeReq(OTP_PAYLOAD, { sign: false }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the OTP over WhatsApp with the correct Authentication-template params', async () => {
    const res = await POST(makeReq(OTP_PAYLOAD, { sign: true }));
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toContain('/111222/messages');
    const sent = JSON.parse(opts.body);
    expect(sent.messaging_product).toBe('whatsapp');
    expect(sent.to).toBe('919000000000'); // E.164 with the '+' stripped
    expect(sent.type).toBe('template');
    expect(sent.template.name).toBe('login_code');
    expect(sent.template.language.code).toBe('en');
    // Authentication template: code in the body AND the copy-code button param.
    expect(sent.template.components[0]).toEqual({
      type: 'body',
      parameters: [{ type: 'text', text: '123456' }],
    });
    expect(sent.template.components[1]).toMatchObject({
      type: 'button',
      sub_type: 'url',
      index: '0',
      parameters: [{ type: 'text', text: '123456' }],
    });
  });

  it('400s when the payload has no otp', async () => {
    const res = await POST(makeReq({ user: { phone: '+919000000000' } }, { sign: true }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces a WhatsApp send failure as 500 so Supabase retries', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: { message: 'bad template' } }) });
    const res = await POST(makeReq(OTP_PAYLOAD, { sign: true }));
    expect(res.status).toBe(500);
  });

  it('REFUSES every request when no secret is configured, and sends nothing', async () => {
    // This test previously asserted the opposite — 200, message sent — under
    // the reasoning "no secret means dev/staging, so accept". That made the
    // route an unauthenticated public endpoint which would send a WhatsApp
    // message to any number in the request body, billed to the cafe, from the
    // cafe's verified sender. A test asserting it made the hole look deliberate.
    //
    // Failing closed costs an outage that is loud and fixed by one copy-paste.
    // Failing open costs a bill and a sender reputation nobody notices losing.
    delete process.env.SUPABASE_SEND_SMS_HOOK_SECRET;
    const res = await POST(makeReq(OTP_PAYLOAD, { sign: false }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses even a CORRECTLY signed request when no secret is configured', async () => {
    // There is nothing to verify against, so a signature proves nothing.
    delete process.env.SUPABASE_SEND_SMS_HOOK_SECRET;
    const res = await POST(makeReq(OTP_PAYLOAD, { sign: true }));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
