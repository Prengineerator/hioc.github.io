import { beforeEach, describe, expect, it, vi } from 'vitest';

// SA-4 — handler tests for POST /api/auth/staff/reset.
//
// Load-bearing assertions: a weak password is refused before the (one-time)
// token is ever spent; an expired/used token and a valid-but-no-longer-staff
// account are told apart (both refuse, but the account check must run only
// after verifyOtp succeeds); and the password itself never appears in the
// response body or in a console.error call.

const state: {
  accountsByUserId: Record<string, { status: string }>;
  profilesByUserId: Record<string, { role: string }>;
} = {
  accountsByUserId: { u1: { status: 'active' } },
  profilesByUserId: { u1: { role: 'staff' } },
};

type VerifyOtpResult = {
  data: { user: { id: string; email: string } | null } | null;
  error: { message: string } | null;
};
type ErrorResult = { error: { message: string } | null };

const { rateLimitOk, verifyOtp, updateUserById, signInWithPassword } = vi.hoisted(() => ({
  rateLimitOk: vi.fn(async (_key: string, _max: number, _windowSecs: number) => true),
  verifyOtp: vi.fn(
    async (_args: { token_hash: string; type: string }): Promise<VerifyOtpResult> => ({
      data: { user: { id: 'u1', email: 'ayush@hioc.in' } },
      error: null,
    }),
  ),
  updateUserById: vi.fn(async (_id: string, _patch: { password: string }): Promise<ErrorResult> => ({ error: null })),
  signInWithPassword: vi.fn(
    async (_args: { email: string; password: string }): Promise<ErrorResult> => ({ error: null }),
  ),
}));

vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk,
  clientIp: () => '1.2.3.4',
}));

// The route deliberately verifies the recovery token with a plain, cookie-less
// client (not the cookie-bound createServerSupabaseClient) — see the comment
// in app/api/auth/staff/reset/route.ts. It builds that client directly from
// '@supabase/supabase-js', so that's what needs mocking here.
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { verifyOtp } }),
}));

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({ auth: { signInWithPassword } }),
  createAdminSupabaseClient: () => ({
    auth: { admin: { updateUserById } },
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, val: string) => ({
          maybeSingle: async () => {
            if (table === 'staff_accounts') return { data: state.accountsByUserId[val] ?? null, error: null };
            if (table === 'profiles') return { data: state.profilesByUserId[val] ?? null, error: null };
            return { data: null, error: null };
          },
        }),
      }),
    }),
  }),
}));

const { POST } = await import('@/app/api/auth/staff/reset/route');

function post(body: unknown) {
  return POST(
    new Request('http://t/api/auth/staff/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

const GOOD_PASSWORD = 'longenough1';

beforeEach(() => {
  rateLimitOk.mockReset();
  rateLimitOk.mockResolvedValue(true);
  verifyOtp.mockReset();
  verifyOtp.mockResolvedValue({ data: { user: { id: 'u1', email: 'ayush@hioc.in' } }, error: null });
  updateUserById.mockReset();
  updateUserById.mockResolvedValue({ error: null });
  signInWithPassword.mockReset();
  signInWithPassword.mockResolvedValue({ error: null });
  state.accountsByUserId = { u1: { status: 'active' } };
  state.profilesByUserId = { u1: { role: 'staff' } };
});

describe('POST /api/auth/staff/reset — validation', () => {
  it('rejects a short password with 400 before ever verifying the token', async () => {
    const res = await post({ token_hash: 'abc', password: 'short' });
    expect(res.status).toBe(400);
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('requires a token_hash', async () => {
    const res = await post({ password: GOOD_PASSWORD });
    expect(res.status).toBe(400);
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/staff/reset — rate limiting', () => {
  it('429s once the per-IP budget is spent, before verifying the token', async () => {
    rateLimitOk.mockResolvedValue(false);
    const res = await post({ token_hash: 'abc', password: GOOD_PASSWORD });
    expect(res.status).toBe(429);
    expect(verifyOtp).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/staff/reset — token handling', () => {
  it('an expired or already-used token is a 400, not a 403', async () => {
    verifyOtp.mockResolvedValue({ data: { user: null }, error: { message: 'Token has expired or is invalid' } });
    const res = await post({ token_hash: 'abc', password: GOOD_PASSWORD });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/expired or was already used/i);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/staff/reset — account status', () => {
  it('refuses a deactivated account with a generic 403', async () => {
    state.accountsByUserId.u1 = { status: 'deactivated' };
    const res = await post({ token_hash: 'abc', password: GOOD_PASSWORD });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('This link is no longer valid.');
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('refuses when there is no staff_accounts row at all', async () => {
    state.accountsByUserId = {};
    const res = await post({ token_hash: 'abc', password: GOOD_PASSWORD });
    expect(res.status).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it('refuses when the profile role is not staff/manager/owner', async () => {
    state.profilesByUserId.u1 = { role: 'customer' };
    const res = await post({ token_hash: 'abc', password: GOOD_PASSWORD });
    expect(res.status).toBe(403);
    expect(updateUserById).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/staff/reset — success', () => {
  it('updates the password via admin, signs the staffer in, and never echoes the password', async () => {
    const res = await post({ token_hash: 'abc', password: GOOD_PASSWORD });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(JSON.stringify(body)).not.toContain(GOOD_PASSWORD);

    expect(updateUserById).toHaveBeenCalledWith('u1', { password: GOOD_PASSWORD });
    expect(signInWithPassword).toHaveBeenCalledWith({ email: 'ayush@hioc.in', password: GOOD_PASSWORD });
  });

  it('never logs the password, even when updateUserById fails', async () => {
    updateUserById.mockResolvedValue({ error: { message: 'weak password' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await post({ token_hash: 'abc', password: GOOD_PASSWORD });

    expect(res.status).toBe(500);
    for (const call of spy.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(GOOD_PASSWORD);
    }
    spy.mockRestore();
  });
});
