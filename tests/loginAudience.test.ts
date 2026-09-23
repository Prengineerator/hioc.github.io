import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  audienceForRole,
  mayUseDoor,
  isValidAudience,
  wrongDoorMessage,
  AUDIENCE_LOGIN_PATH,
} from '@/lib/auth/audience';

// Three surfaces, three doors. /staff/login used to establish OWNER sessions,
// which meant the counter tablet's bookmark could open payroll.

describe('audienceForRole', () => {
  it('sends the owner to the owner door', () => {
    expect(audienceForRole('owner')).toBe('owner');
  });

  it('sends staff AND managers to the staff door', () => {
    // A manager runs the floor; their extra powers are gated per-action by
    // hasPermission(), not by which page they signed in on.
    expect(audienceForRole('staff')).toBe('staff');
    expect(audienceForRole('manager')).toBe('staff');
  });

  it('sends customers — and anything unrecognised — to the customer door', () => {
    expect(audienceForRole('customer')).toBe('customer');
    expect(audienceForRole(null)).toBe('customer');
  });
});

describe('mayUseDoor', () => {
  it('admits each role at exactly one door', () => {
    expect(mayUseDoor('owner', 'owner')).toBe(true);
    expect(mayUseDoor('owner', 'staff')).toBe(false);
    expect(mayUseDoor('owner', 'customer')).toBe(false);

    expect(mayUseDoor('staff', 'staff')).toBe(true);
    expect(mayUseDoor('staff', 'owner')).toBe(false);

    expect(mayUseDoor('manager', 'staff')).toBe(true);
    expect(mayUseDoor('manager', 'owner')).toBe(false);

    expect(mayUseDoor('customer', 'customer')).toBe(true);
    expect(mayUseDoor('customer', 'staff')).toBe(false);
  });

  it('is the regression this exists for: staff cannot sign in at the owner door', () => {
    expect(mayUseDoor('staff', 'owner')).toBe(false);
    expect(mayUseDoor('manager', 'owner')).toBe(false);
  });
});

describe('wrongDoorMessage', () => {
  it('names the correct entrance rather than just refusing', () => {
    // The common case is an owner tapping the counter's bookmark, not an
    // attacker — a refusal with no next step reads as a broken login.
    const msg = wrongDoorMessage('owner', 'staff');
    expect(msg).toContain(AUDIENCE_LOGIN_PATH.owner);
  });
});

describe('isValidAudience', () => {
  it('accepts the three surfaces and nothing else', () => {
    expect(isValidAudience('customer')).toBe(true);
    expect(isValidAudience('staff')).toBe(true);
    expect(isValidAudience('owner')).toBe(true);
    expect(isValidAudience('admin')).toBe(false);
    expect(isValidAudience(undefined)).toBe(false);
  });
});

// --- route behaviour -------------------------------------------------------

const state: { role: string | null; signedOut: boolean; signInError: unknown } = {
  role: null,
  signedOut: false,
  signInError: null,
};

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({
    auth: {
      signInWithPassword: async () =>
        state.signInError
          ? { data: { user: null }, error: state.signInError }
          : { data: { user: { id: 'u1' } }, error: null },
      signOut: async () => {
        state.signedOut = true;
        return { error: null };
      },
    },
  }),
  createAdminSupabaseClient: () => ({}),
}));

vi.mock('@/lib/api/auth', () => ({
  getUserRole: async () => state.role,
}));

vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk: async () => true,
  clientIp: () => '1.2.3.4',
}));

const { POST } = await import('@/app/api/auth/login/route');

function loginReq(body: unknown) {
  return new Request('http://t/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.role = null;
  state.signedOut = false;
  state.signInError = null;
});

describe('POST /api/auth/login — door enforcement', () => {
  it('lets the owner in at the owner door', async () => {
    state.role = 'owner';
    const res = await POST(loginReq({ email: 'o@x.com', password: 'p', audience: 'owner' }));
    expect(res.status).toBe(200);
    expect(state.signedOut).toBe(false);
  });

  it('refuses a staff account at the owner door', async () => {
    state.role = 'staff';
    const res = await POST(loginReq({ email: 's@x.com', password: 'p', audience: 'owner' }));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('/staff/login');
  });

  it('SIGNS OUT the session it just created on a wrong-door attempt', async () => {
    // The role lives in `profiles`, unreadable without a session — so the check
    // runs after sign-in and must undo it. Returning 403 while leaving the
    // cookies set would be worse than not checking: the caller could navigate on.
    state.role = 'staff';
    await POST(loginReq({ email: 's@x.com', password: 'p', audience: 'owner' }));
    expect(state.signedOut).toBe(true);
  });

  it('refuses an owner at the customer door', async () => {
    state.role = 'owner';
    const res = await POST(loginReq({ email: 'o@x.com', password: 'p', audience: 'customer' }));
    expect(res.status).toBe(403);
  });

  it('still 401s on bad credentials, without leaking whether the role matched', async () => {
    state.signInError = { message: 'bad' };
    state.role = 'owner';
    const res = await POST(loginReq({ email: 'o@x.com', password: 'wrong', audience: 'owner' }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid email or password');
  });

  it('stays backwards compatible when no audience is declared', async () => {
    // Any client that has not been updated keeps working rather than being
    // locked out by a field it does not send.
    state.role = 'owner';
    const res = await POST(loginReq({ email: 'o@x.com', password: 'p' }));
    expect(res.status).toBe(200);
  });
});
