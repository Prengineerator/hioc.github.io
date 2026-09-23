import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// WA-3 — handler tests for POST /api/owner/notifications/test-send.
//
// The load-bearing assertions are the ones about NAMING THE CAUSE. This route
// exists so an owner can answer "is the bill working right now?" without a
// script, and it is only worth more than the script if it says WHY when the
// answer is no. An expired token and a paused template both arrive from the
// engine as the single token 'send_failed'; if the route renders both as "the
// provider rejected the message" it is strictly less useful than the CLI it
// replaced, which prints Meta's raw response.
//
// Note what is NOT tested here any more: stub detection. WA-1 removed
// getAdapter() from the bill path, so sendBillNotification can only reach
// whatsappAdapter and only after whatsappBillHealth() reports configured — the
// stub cannot answer, and the tests that claimed to catch it were passing only
// because the mocked engine was made to return a state the real engine provably
// cannot emit (whatsapp:true with blank credentials).

const state: { owner: { id: string } | null } = { owner: { id: 'owner-1' } };

interface EngineResult {
  email: boolean;
  whatsapp: boolean;
  reasons: { email: string; whatsapp: string };
  errors: { email: string; whatsapp: string };
}

const NOTHING_SENT: EngineResult = {
  email: false,
  whatsapp: false,
  reasons: { email: '', whatsapp: '' },
  errors: { email: '', whatsapp: '' },
};

const { sendBillNotification, rateLimitOk } = vi.hoisted(() => ({
  sendBillNotification: vi.fn((_order: unknown, _opts?: { force?: boolean }) =>
    Promise.resolve({
      email: false,
      whatsapp: false,
      reasons: { email: '', whatsapp: '' },
      errors: { email: '', whatsapp: '' },
    }),
  ),
  rateLimitOk: vi.fn((_key: string, _max: number, _window: number) => Promise.resolve(true)),
}));

vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification }));
vi.mock('@/lib/api/rateLimit', () => ({ rateLimitOk }));
vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));

const { POST } = await import('@/app/api/owner/notifications/test-send/route');

const PHONE = '9876543210';

function post(body: unknown) {
  return POST(
    new Request('http://t/api/owner/notifications/test-send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

interface Verdict {
  channel: string;
  sent: boolean;
  reason: string;
  detail: string;
  provider_error: string;
}

interface Payload {
  ok: boolean;
  to: string;
  accepted: boolean;
  summary: string;
  channels: Verdict[];
}

const whatsapp = (p: Payload) => p.channels.find((c) => c.channel === 'whatsapp') as Verdict;

/** Credentials for BOTH bill channels — i.e. a fully live deployment. */
function configureRealProviders() {
  vi.stubEnv('WHATSAPP_TOKEN', 'tok');
  vi.stubEnv('WHATSAPP_PHONE_ID', '123');
  vi.stubEnv('WHATSAPP_TPL_BILL', 'order_bill_1');
  vi.stubEnv('RESEND_API_KEY', 'key');
  vi.stubEnv('RESEND_FROM', 'HIOC <bills@hioc.in>');
}

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  sendBillNotification.mockReset();
  sendBillNotification.mockResolvedValue(NOTHING_SENT);
  rateLimitOk.mockReset();
  rateLimitOk.mockResolvedValue(true);
  // The health checks read process.env directly; blank every bill variable so a
  // developer's real .env can't decide a test's outcome.
  for (const v of ['WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TPL_BILL', 'RESEND_API_KEY', 'RESEND_FROM']) {
    vi.stubEnv(v, '');
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/owner/notifications/test-send — gating (WA-3)', () => {
  it('403s a non-owner and sends nothing', async () => {
    state.owner = null;

    const res = await post({ phone: PHONE });

    expect(res.status).toBe(403);
    expect(sendBillNotification).not.toHaveBeenCalled();
  });

  it('429s once the hourly budget is spent, before any send', async () => {
    rateLimitOk.mockResolvedValue(false);

    const res = await post({ phone: PHONE });

    expect(res.status).toBe(429);
    expect(sendBillNotification).not.toHaveBeenCalled();
    // 5 per hour, keyed per owner — a stuck finger must not burn Meta quota.
    expect(rateLimitOk).toHaveBeenCalledWith('notify-test:owner-1', 5, 3600);
  });

  it('rejects a bad number without spending an attempt', async () => {
    const res = await post({ phone: '12345' });

    expect(res.status).toBe(400);
    expect(rateLimitOk).not.toHaveBeenCalled();
    expect(sendBillNotification).not.toHaveBeenCalled();
  });

  it('normalises the phone to the E.164 form orders store', async () => {
    configureRealProviders();

    const res = await post({ phone: '+91 98765-43210' });

    expect(res.status).toBe(200);
    const order = sendBillNotification.mock.calls[0][0] as { customer_phone: string; customer_name: string };
    expect(order.customer_phone).toBe('+919876543210');
    // The bill template's {{1}} is the first name, so the message announces itself.
    expect(order.customer_name.split(' ')[0]).toBe('TEST');
  });
});

describe('POST /api/owner/notifications/test-send — failures name their cause', () => {
  it('surfaces the missing configuration variable by name', async () => {
    vi.stubEnv('WHATSAPP_TOKEN', 'tok');
    vi.stubEnv('WHATSAPP_PHONE_ID', '123'); // WHATSAPP_TPL_BILL still unset
    sendBillNotification.mockResolvedValue({
      ...NOTHING_SENT,
      reasons: { email: 'no_email', whatsapp: 'not_configured:WHATSAPP_TPL_BILL' },
    });

    const body = (await (await post({ phone: PHONE })).json()) as Payload;

    expect(body.accepted).toBe(false);
    expect(whatsapp(body).reason).toBe('not_configured:WHATSAPP_TPL_BILL');
    expect(whatsapp(body).detail).toContain('WHATSAPP_TPL_BILL');
  });

  // The reason this route is worth more than a generic "failed": these two
  // failures are indistinguishable through `reason` and need opposite remedies.
  it("quotes Meta's own words for an expired token", async () => {
    configureRealProviders();
    sendBillNotification.mockResolvedValue({
      ...NOTHING_SENT,
      reasons: { email: 'no_email', whatsapp: 'send_failed' },
      errors: { email: '', whatsapp: 'Error validating access token: Session has expired' },
    });

    const body = (await (await post({ phone: PHONE })).json()) as Payload;

    expect(whatsapp(body).reason).toBe('send_failed');
    expect(whatsapp(body).provider_error).toBe('Error validating access token: Session has expired');
    expect(whatsapp(body).detail).toContain('Session has expired');
    expect(body.summary.toLowerCase()).toContain('nothing sent');
  });

  it('distinguishes a paused template from an expired token', async () => {
    configureRealProviders();
    sendBillNotification.mockResolvedValue({
      ...NOTHING_SENT,
      reasons: { email: 'no_email', whatsapp: 'send_failed' },
      errors: { email: '', whatsapp: 'Template name does not exist in the translation' },
    });

    const body = (await (await post({ phone: PHONE })).json()) as Payload;

    expect(whatsapp(body).detail).toContain('Template name does not exist');
    expect(whatsapp(body).detail).not.toContain('Session has expired');
  });

  it('still reads sensibly when the provider gave no message at all', async () => {
    configureRealProviders();
    sendBillNotification.mockResolvedValue({
      ...NOTHING_SENT,
      reasons: { email: 'no_email', whatsapp: 'send_failed' },
    });

    const body = (await (await post({ phone: PHONE })).json()) as Payload;

    expect(whatsapp(body).detail).toBe('The provider rejected the message');
    expect(whatsapp(body).provider_error).toBe('');
  });

  it('says notifications are off rather than blaming the provider', async () => {
    sendBillNotification.mockResolvedValue({
      ...NOTHING_SENT,
      reasons: { email: 'notifications_disabled', whatsapp: 'notifications_disabled' },
    });

    const body = (await (await post({ phone: PHONE })).json()) as Payload;

    expect(whatsapp(body).detail).toBe('Notifications are turned off');
  });

  it('does not blame the provider when the engine returned no reason at all', async () => {
    const body = (await (await post({ phone: PHONE })).json()) as Payload;

    expect(whatsapp(body).reason).toBe('unknown');
    expect(whatsapp(body).detail).toContain('server logs');
  });
});

describe('POST /api/owner/notifications/test-send — acceptance is not arrival', () => {
  it('reports a provider acceptance as accepted, never as delivered', async () => {
    configureRealProviders();
    sendBillNotification.mockResolvedValue({
      ...NOTHING_SENT,
      whatsapp: true,
      reasons: { email: 'no_email', whatsapp: '' },
    });

    const body = (await (await post({ phone: PHONE })).json()) as Payload;

    expect(body.accepted).toBe(true);
    expect(whatsapp(body).sent).toBe(true);
    expect(body.summary).toContain('accepted by WhatsApp');
    // The whole point of the phase: an HTTP 200 from Meta must never be
    // rendered as proof the handset got anything.
    expect(body.summary).not.toMatch(/delivered|arrived/i);
  });

  it("names MARKETING as the suspect when Meta accepts but nothing lands", async () => {
    configureRealProviders();
    sendBillNotification.mockResolvedValue({
      ...NOTHING_SENT,
      whatsapp: true,
      reasons: { email: 'no_email', whatsapp: '' },
    });

    const body = (await (await post({ phone: PHONE })).json()) as Payload;

    // A template categorised MARKETING is accepted here and throttled after —
    // the owner needs that pointer on the screen, not in a doc.
    expect(whatsapp(body).detail).toContain('MARKETING');
  });

  it('explains that the sample bill carries no email rather than blaming the order', async () => {
    configureRealProviders();
    sendBillNotification.mockResolvedValue({
      ...NOTHING_SENT,
      whatsapp: true,
      reasons: { email: 'no_email', whatsapp: '' },
    });

    const body = (await (await post({ phone: PHONE })).json()) as Payload;

    const email = body.channels.find((c) => c.channel === 'email') as Verdict;
    expect(email.detail).toContain('sample bill');
  });
});
