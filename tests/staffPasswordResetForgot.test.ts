import { beforeEach, describe, expect, it, vi } from 'vitest';

// SA-4 — handler tests for POST /api/auth/staff/forgot.
//
// docs/PHASE-5-STAFF-ACCOUNTS.md, "Password emails": the response must be
// IDENTICAL whether the login ID is unknown, deactivated, has no personal
// email on file, or names a non-staff role — anything else would let someone
// probe which login IDs are real staff accounts. Only a rate limit differs.

const state: {
  tableMissing: boolean;
  accountsByLoginId: Record<string, { user_id: string; personal_email: string | null; status: string }>;
  profilesByUserId: Record<string, { role: string; name: string | null }>;
} = {
  tableMissing: false,
  accountsByLoginId: {},
  profilesByUserId: {},
};

const { rateLimitOk, sendPasswordLink } = vi.hoisted(() => ({
  rateLimitOk: vi.fn(async (_key: string, _max: number, _windowSecs: number) => true),
  sendPasswordLink: vi.fn(async (_admin: unknown, _args: Record<string, unknown>) => ({
    kind: 'password_reset',
    status: 'sent',
    detail: '',
  })),
}));

vi.mock('@/lib/api/rateLimit', () => ({
  rateLimitOk,
  clientIp: () => '1.2.3.4',
}));

vi.mock('@/lib/staff/emails', () => ({ sendPasswordLink }));

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: (_col: string, val: string) => ({
          maybeSingle: async () => {
            if (table === 'staff_accounts') {
              if (state.tableMissing) {
                return { data: null, error: { message: 'relation "staff_accounts" does not exist' } };
              }
              return { data: state.accountsByLoginId[val] ?? null, error: null };
            }
            if (table === 'profiles') {
              return { data: state.profilesByUserId[val] ?? null, error: null };
            }
            return { data: null, error: null };
          },
        }),
      }),
    }),
  }),
}));

const { POST } = await import('@/app/api/auth/staff/forgot/route');

function post(body: unknown) {
  return POST(
    new Request('http://t/api/auth/staff/forgot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.tableMissing = false;
  state.accountsByLoginId = {};
  state.profilesByUserId = {};
  rateLimitOk.mockReset();
  rateLimitOk.mockResolvedValue(true);
  sendPasswordLink.mockReset();
  sendPasswordLink.mockResolvedValue({ kind: 'password_reset', status: 'sent', detail: '' });
});

describe('POST /api/auth/staff/forgot — same response regardless of outcome', () => {
  it('200s an unknown login ID and sends nothing', async () => {
    const res = await post({ loginId: 'nosuchuser' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendPasswordLink).not.toHaveBeenCalled();
  });

  it('200s the same way when staff_accounts is not migrated yet', async () => {
    state.tableMissing = true;
    const res = await post({ loginId: 'ayush' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendPasswordLink).not.toHaveBeenCalled();
  });

  it('200s the same way for a deactivated account', async () => {
    state.accountsByLoginId.ayush = { user_id: 'u1', personal_email: 'ayush@gmail.com', status: 'deactivated' };
    state.profilesByUserId.u1 = { role: 'staff', name: 'Ayush' };
    const res = await post({ loginId: 'ayush' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendPasswordLink).not.toHaveBeenCalled();
  });

  it('200s the same way for an active account with no personal email on file', async () => {
    state.accountsByLoginId.ayush = { user_id: 'u1', personal_email: null, status: 'active' };
    state.profilesByUserId.u1 = { role: 'staff', name: 'Ayush' };
    const res = await post({ loginId: 'ayush' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendPasswordLink).not.toHaveBeenCalled();
  });

  it('200s the same way when the profile role is not staff/manager/owner', async () => {
    state.accountsByLoginId.ayush = { user_id: 'u1', personal_email: 'a@gmail.com', status: 'active' };
    state.profilesByUserId.u1 = { role: 'customer', name: 'Ayush' };
    const res = await post({ loginId: 'ayush' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(sendPasswordLink).not.toHaveBeenCalled();
  });

  it('sends only for an active staff/manager/owner account with a personal email, same 200 response', async () => {
    state.accountsByLoginId.ayush = { user_id: 'u1', personal_email: 'ayush@gmail.com', status: 'active' };
    state.profilesByUserId.u1 = { role: 'manager', name: 'Ayush Garg' };

    // Accepts the full hioc.in address too, not just the bare login ID.
    const res = await post({ loginId: 'ayush@hioc.in' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    expect(sendPasswordLink).toHaveBeenCalledTimes(1);
    const args = sendPasswordLink.mock.calls[0][1] as Record<string, unknown>;
    expect(args.loginEmail).toBe('ayush@hioc.in');
    expect(args.personalEmail).toBe('ayush@gmail.com');
    expect(args.kind).toBe('password_reset');
    expect(args.userId).toBe('u1');
  });
});

describe('POST /api/auth/staff/forgot — rate limiting', () => {
  it('429s once the per-IP budget is spent, before any lookup', async () => {
    rateLimitOk.mockImplementation(async (key: string) => !key.startsWith('staff-forgot-ip:'));
    const res = await post({ loginId: 'ayush' });
    expect(res.status).toBe(429);
    expect(sendPasswordLink).not.toHaveBeenCalled();
  });

  it('429s once the per-login-ID budget is spent', async () => {
    rateLimitOk.mockImplementation(async (key: string) => !key.startsWith('staff-forgot:'));
    const res = await post({ loginId: 'ayush' });
    expect(res.status).toBe(429);
    expect(sendPasswordLink).not.toHaveBeenCalled();
  });
});
