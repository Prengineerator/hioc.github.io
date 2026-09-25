import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signOperatorToken } from '@/lib/api/operatorCookie';

// PIN-3 — getCounterActor(). The property that matters most: a classic
// session ALWAYS wins, unconditionally, even when a device+operator cookie
// pair is also present — the device path only ever runs when there is no
// session at all. Every device-path failure mode collapses to null, exactly
// like getEnrolledDevice()'s "fail to unenrolled" posture.

const SECRET = 'x'.repeat(40);

const state: {
  sessionUser: { id: string } | null;
  sessionRole: string | null;
  operatorCookie: string | undefined;
  device: { id: string } | null;
  profileRole: string | null;
  authUser: { id: string; email?: string } | null;
} = {
  sessionUser: null,
  sessionRole: null,
  operatorCookie: undefined,
  device: null,
  profileRole: null,
  authUser: null,
};

vi.mock('next/headers', () => ({
  cookies: () => ({
    get: (name: string) => (name === 'hioc_operator' && state.operatorCookie ? { value: state.operatorCookie } : undefined),
    set: () => {},
  }),
}));

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({
    auth: { getUser: () => Promise.resolve({ data: { user: state.sessionUser }, error: null }) },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { role: state.sessionRole }, error: null }),
        }),
      }),
    }),
  }),
  createAdminSupabaseClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { role: state.profileRole }, error: null }),
        }),
      }),
    }),
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: state.authUser }, error: null }) } },
  }),
}));

vi.mock('@/lib/api/device', () => ({
  getEnrolledDevice: () => Promise.resolve(state.device),
}));

process.env.OPERATOR_JWT_SECRET = SECRET;

const { getCounterActor } = await import('@/lib/api/auth');

beforeEach(() => {
  state.sessionUser = null;
  state.sessionRole = null;
  state.operatorCookie = undefined;
  state.device = null;
  state.profileRole = null;
  state.authUser = null;
  process.env.OPERATOR_JWT_SECRET = SECRET;
});

describe('getCounterActor', () => {
  it('resolves the classic session and never looks at cookies/device at all', async () => {
    state.sessionUser = { id: 'staff-1' };
    state.sessionRole = 'staff';
    state.device = { id: 'device-1' }; // present, but must be irrelevant
    state.operatorCookie = signOperatorToken({ op: 'someone-else', dev: 'device-1', iat: Math.floor(Date.now() / 1000) }, SECRET);

    const actor = await getCounterActor();
    expect(actor).toEqual({ user: { id: 'staff-1' }, role: 'staff', via: 'session' });
  });

  it('is null with no session and no operator cookie', async () => {
    expect(await getCounterActor()).toBeNull();
  });

  it('is null with no session and OPERATOR_JWT_SECRET unset', async () => {
    delete process.env.OPERATOR_JWT_SECRET;
    state.operatorCookie = signOperatorToken({ op: 'u1', dev: 'device-1', iat: Math.floor(Date.now() / 1000) }, SECRET);
    state.device = { id: 'device-1' };
    expect(await getCounterActor()).toBeNull();
  });

  it('resolves the device+operator path when there is no classic session', async () => {
    state.operatorCookie = signOperatorToken({ op: 'u1', dev: 'device-1', iat: Math.floor(Date.now() / 1000) }, SECRET);
    state.device = { id: 'device-1' };
    state.profileRole = 'staff';
    state.authUser = { id: 'u1', email: 'ravi@example.com' };

    const actor = await getCounterActor();
    expect(actor).toEqual({ user: { id: 'u1', email: 'ravi@example.com' }, role: 'staff', via: 'device' });
  });

  it('is null when the device cookie does not match the token\'s dev claim (E4-adjacent)', async () => {
    state.operatorCookie = signOperatorToken({ op: 'u1', dev: 'device-OLD', iat: Math.floor(Date.now() / 1000) }, SECRET);
    state.device = { id: 'device-NEW' }; // re-enrolled machine, fresh id
    state.profileRole = 'staff';
    expect(await getCounterActor()).toBeNull();
  });

  it('is null when there is no enrolled device at all (revoked mid-shift, E4)', async () => {
    state.operatorCookie = signOperatorToken({ op: 'u1', dev: 'device-1', iat: Math.floor(Date.now() / 1000) }, SECRET);
    state.device = null;
    state.profileRole = 'staff';
    expect(await getCounterActor()).toBeNull();
  });

  it('is null when the operator is no longer a staff role (E3)', async () => {
    state.operatorCookie = signOperatorToken({ op: 'u1', dev: 'device-1', iat: Math.floor(Date.now() / 1000) }, SECRET);
    state.device = { id: 'device-1' };
    state.profileRole = 'customer'; // deactivated mid-shift
    state.authUser = { id: 'u1' };
    expect(await getCounterActor()).toBeNull();
  });
});
