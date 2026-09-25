import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-5 — owner set/reset/unlock at /api/owner/staff/[id]/pin. The
// properties that matter: owner-gated on every method; a trivial or
// malformed PIN is refused before it ever reaches the database; a PIN with
// no `pin` in the body is generated (and is itself never trivial); the
// response is the ONLY place the plaintext PIN ever appears; set vs reset is
// derived from whether a PIN already existed, for the audit trail.

const state: {
  owner: { id: string } | null;
  pinState: { hasPin: boolean; locked: boolean; retryAfterSeconds: number } | null;
  setPinCalls: { userId: string; pin: string; setBy: string; action: string }[];
  setPinResult: { ok: true } | { ok: false; error: string };
  unlockCalls: string[];
} = {
  owner: { id: 'owner-1' },
  pinState: { hasPin: false, locked: false, retryAfterSeconds: 0 },
  setPinCalls: [],
  setPinResult: { ok: true },
  unlockCalls: [],
};

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));

vi.mock('@/lib/staff/pinAuth', () => ({
  getPinState: () => Promise.resolve(state.pinState),
  setPin: (userId: string, pin: string, setBy: string, action: string) => {
    state.setPinCalls.push({ userId, pin, setBy, action });
    return Promise.resolve(state.setPinResult);
  },
  unlockPin: (userId: string) => {
    state.unlockCalls.push(userId);
    return Promise.resolve({ ok: true });
  },
  isMissingPinTable: () => false,
}));

const { GET, POST, DELETE } = await import('@/app/api/owner/staff/[id]/pin/route');

const ID = '11111111-1111-1111-1111-111111111111';
function ctx() {
  return { params: { id: ID } };
}
function postReq(body: unknown) {
  return new Request('https://hioc.in/api/owner/staff/x/pin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  state.pinState = { hasPin: false, locked: false, retryAfterSeconds: 0 };
  state.setPinCalls = [];
  state.setPinResult = { ok: true };
  state.unlockCalls = [];
});

describe('GET /api/owner/staff/[id]/pin', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    expect((await GET(new Request('https://x'), ctx())).status).toBe(403);
  });

  it('returns the lock state, never a PIN', async () => {
    state.pinState = { hasPin: true, locked: true, retryAfterSeconds: 42 };
    const res = await GET(new Request('https://x'), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ hasPin: true, locked: true, retryAfterSeconds: 42 });
    expect(JSON.stringify(body)).not.toMatch(/pin_hash|pinHash/);
  });
});

describe('POST /api/owner/staff/[id]/pin — set/reset', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    expect((await POST(postReq({}), ctx())).status).toBe(403);
  });

  it('rejects a trivial PIN before it ever reaches setPin', async () => {
    const res = await POST(postReq({ pin: '1234' }), ctx());
    expect(res.status).toBe(400);
    expect(state.setPinCalls).toHaveLength(0);
  });

  it('rejects a malformed PIN', async () => {
    expect((await POST(postReq({ pin: '12' }), ctx())).status).toBe(400);
    expect((await POST(postReq({ pin: 'abcd' }), ctx())).status).toBe(400);
  });

  it('sets an owner-chosen PIN and echoes it exactly once', async () => {
    const res = await POST(postReq({ pin: '7392' }), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pin).toBe('7392');
    expect(body.action).toBe('set'); // hasPin was false
    expect(state.setPinCalls[0]).toMatchObject({ userId: ID, pin: '7392', setBy: 'owner-1', action: 'set' });
  });

  it('generates a PIN when none is given, and it is never trivial', async () => {
    const res = await POST(postReq({}), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pin).toMatch(/^\d{4}$/);
    expect(['0000', '1234', '9876']).not.toContain(body.pin);
  });

  it('records "reset" (not "set") when a PIN already exists', async () => {
    state.pinState = { hasPin: true, locked: false, retryAfterSeconds: 0 };
    const res = await POST(postReq({ pin: '7392' }), ctx());
    expect((await res.json()).action).toBe('reset');
    expect(state.setPinCalls[0].action).toBe('reset');
  });

  it('surfaces a setPin failure as a 500 (or 409 for a missing migration)', async () => {
    state.setPinResult = { ok: false, error: 'boom' };
    const res = await POST(postReq({ pin: '7392' }), ctx());
    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/owner/staff/[id]/pin — unlock', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    expect((await DELETE(new Request('https://x'), ctx())).status).toBe(403);
  });

  it('clears the lockout', async () => {
    const res = await DELETE(new Request('https://x'), ctx());
    expect(res.status).toBe(200);
    expect(state.unlockCalls).toContain(ID);
  });
});
