import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-3 — POST/GET/DELETE /api/device/operator. The properties that matter:
// the whole route is a no-op ("not enabled") with the flag off or the secret
// missing/short; a correct PIN sets an operator cookie scoped to THIS
// device's id; a wrong PIN never sets one; DELETE always clears, even with
// nothing to clear.

const state: {
  pinSwitch: boolean;
  secret: string | undefined;
  device: { id: string; name: string } | null;
  verifyResult: Awaited<ReturnType<typeof import('@/lib/staff/pinAuth').verifyPin>>;
  operators: { id: string; name: string }[];
  rateLimitAllowed: boolean;
  setCookie: { name: string; value: string; options: Record<string, unknown> } | null;
} = {
  pinSwitch: true,
  secret: 'x'.repeat(40),
  device: { id: 'device-1', name: 'Counter 1' },
  verifyResult: { ok: true },
  operators: [{ id: 'u1', name: 'Ravi' }],
  rateLimitAllowed: true,
  setCookie: null,
};

vi.mock('@/lib/flags', () => ({
  flags: {
    get pinSwitch() {
      return state.pinSwitch;
    },
  },
}));

vi.mock('next/headers', () => ({
  cookies: () => ({
    set: (name: string, value: string, options: Record<string, unknown>) => {
      state.setCookie = { name, value, options };
    },
  }),
}));

vi.mock('@/lib/api/device', () => ({
  getEnrolledDevice: () => Promise.resolve(state.device),
}));

vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk: () => Promise.resolve(state.rateLimitAllowed),
  clientIp: () => '1.2.3.4',
}));

vi.mock('@/lib/staff/pinAuth', () => ({
  verifyPin: () => Promise.resolve(state.verifyResult),
}));

vi.mock('@/lib/api/operator', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/operator')>('@/lib/api/operator');
  return {
    ...actual,
    operatorFeatureConfigured: () => state.secret !== undefined && state.secret.length >= 32,
    issueOperatorCookieValue: (op: string, dev: string) =>
      state.secret ? { value: `signed.${op}.${dev}`, iat: 1000 } : null,
    listOperatorOptions: () => Promise.resolve(state.operators),
  };
});

const { GET, POST, DELETE } = await import('@/app/api/device/operator/route');

function postReq(body: unknown) {
  return new Request('https://hioc.in/api/device/operator', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.pinSwitch = true;
  state.secret = 'x'.repeat(40);
  state.device = { id: 'device-1', name: 'Counter 1' };
  state.verifyResult = { ok: true };
  state.operators = [{ id: 'u1', name: 'Ravi' }];
  state.rateLimitAllowed = true;
  state.setCookie = null;
});

describe('GET /api/device/operator', () => {
  it('lists operators when enabled + a device is enrolled', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).operators).toEqual([{ id: 'u1', name: 'Ravi' }]);
  });

  it('answers an empty list, not an error, when the flag is off', async () => {
    state.pinSwitch = false;
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).operators).toEqual([]);
  });

  it('answers an empty list when there is no enrolled device', async () => {
    state.device = null;
    const res = await GET();
    expect((await res.json()).operators).toEqual([]);
  });
});

describe('POST /api/device/operator', () => {
  it('404s ("not enabled") when the flag is off — never a partial feature', async () => {
    state.pinSwitch = false;
    const res = await POST(postReq({ userId: '11111111-1111-1111-1111-111111111111', pin: '7392' }));
    expect(res.status).toBe(404);
    expect(state.setCookie).toBeNull();
  });

  it('404s when the secret is missing or short', async () => {
    state.secret = undefined;
    const res = await POST(postReq({ userId: '11111111-1111-1111-1111-111111111111', pin: '7392' }));
    expect(res.status).toBe(404);
  });

  it('404s when this machine is not an enrolled device', async () => {
    state.device = null;
    const res = await POST(postReq({ userId: '11111111-1111-1111-1111-111111111111', pin: '7392' }));
    expect(res.status).toBe(404);
  });

  it('400s a malformed PIN before ever touching verifyPin', async () => {
    const res = await POST(postReq({ userId: '11111111-1111-1111-1111-111111111111', pin: '12' }));
    expect(res.status).toBe(400);
  });

  it('400s a missing/invalid userId', async () => {
    const res = await POST(postReq({ userId: 'not-a-uuid', pin: '7392' }));
    expect(res.status).toBe(400);
  });

  it('sets the operator cookie, scoped to THIS device, on a correct PIN', async () => {
    state.verifyResult = { ok: true };
    const res = await POST(postReq({ userId: '11111111-1111-1111-1111-111111111111', pin: '7392' }));
    expect(res.status).toBe(200);
    expect(state.setCookie?.name).toBe('hioc_operator');
    expect(state.setCookie?.value).toBe('signed.11111111-1111-1111-1111-111111111111.device-1');
    expect(state.setCookie?.options).toMatchObject({ httpOnly: true, sameSite: 'lax' });
  });

  it('401s a wrong PIN and sets no cookie', async () => {
    state.verifyResult = { ok: false, reason: 'wrong_pin', retryAfterSeconds: 0 };
    const res = await POST(postReq({ userId: '11111111-1111-1111-1111-111111111111', pin: '7392' }));
    expect(res.status).toBe(401);
    expect(state.setCookie).toBeNull();
  });

  it('423s while locked out, distinct from a plain wrong PIN', async () => {
    state.verifyResult = { ok: false, reason: 'locked', retryAfterSeconds: 45 };
    const res = await POST(postReq({ userId: '11111111-1111-1111-1111-111111111111', pin: '7392' }));
    expect(res.status).toBe(423);
    expect((await res.json()).error).toContain('45s');
  });

  it('is rate-limited per device regardless of which userId is tried', async () => {
    state.rateLimitAllowed = false;
    const res = await POST(postReq({ userId: '11111111-1111-1111-1111-111111111111', pin: '7392' }));
    expect(res.status).toBe(429);
    expect(state.setCookie).toBeNull();
  });
});

describe('DELETE /api/device/operator', () => {
  it('always clears the cookie, even with nothing to clear', async () => {
    const res = await DELETE();
    expect(res.status).toBe(200);
    expect(state.setCookie?.value).toBe('');
    expect(state.setCookie?.options).toMatchObject({ maxAge: 0 });
  });
});
