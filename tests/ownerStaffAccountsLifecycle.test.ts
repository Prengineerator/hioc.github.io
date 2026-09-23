import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level tests for the per-account owner staff routes (SA-2,
// docs/PHASE-5-STAFF-ACCOUNTS.md): PATCH, password, deactivate, reactivate,
// and true delete. Covers: cannot deactivate/reactivate/delete self or an
// owner, delete blocked when the account has history, and that a password
// never appears in any response.

type Row = Record<string, unknown>;

const HISTORY_TABLES = new Set([
  'attendance_sessions',
  'staff_employment',
  'payroll_run_lines',
  'leave_requests',
  'orders',
  'cash_days',
]);

const VALID_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_OWNER_TARGET = '33333333-3333-4333-8333-333333333333';

const state: {
  owner: { id: string } | null;
  profiles: Row[];
  accounts: Row[];
  accountsMissing: boolean;
  authUsers: { id: string; email: string; last_sign_in_at: string | null }[];
  historyIds: Set<string>;
  bannedPatches: { id: string; attrs: Row }[];
  deletedUserIds: string[];
} = {
  owner: { id: OWNER_ID },
  profiles: [],
  accounts: [],
  accountsMissing: false,
  authUsers: [],
  historyIds: new Set(),
  bannedPatches: [],
  deletedUserIds: [],
};

function accountsError() {
  return state.accountsMissing
    ? { code: 'PGRST205', message: "Could not find the table 'public.staff_accounts' in the schema cache" }
    : null;
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx: {
        op: 'select' | 'insert' | 'update' | 'upsert';
        eq: [string, unknown][];
        inFilter?: [string, unknown[]];
        payload?: Row;
      } = { op: 'select', eq: [] };
      const chain: Record<string, unknown> = {};

      function matchesEq(row: Row) {
        return ctx.eq.every(([col, val]) => row[col] === val);
      }
      function matchesIn(row: Row) {
        if (!ctx.inFilter) return true;
        const [col, vals] = ctx.inFilter;
        return (vals as unknown[]).includes(row[col]);
      }

      function result(): { data: unknown; error: unknown; count?: number } {
        if (table === 'profiles') {
          if (ctx.op === 'update') {
            const id = ctx.eq.find(([c]) => c === 'id')?.[1] as string | undefined;
            const row = state.profiles.find((p) => p.id === id);
            if (row) Object.assign(row, ctx.payload);
            return { data: null, error: null };
          }
          if (ctx.op === 'upsert') {
            const payload = ctx.payload as Row;
            const existing = state.profiles.find((p) => p.id === payload.id);
            if (existing) Object.assign(existing, payload);
            else state.profiles.push({ ...payload });
            return { data: null, error: null };
          }
          let rows = state.profiles;
          if (ctx.inFilter) rows = rows.filter(matchesIn);
          rows = rows.filter(matchesEq);
          return { data: rows, error: null };
        }

        if (table === 'staff_accounts') {
          const missing = accountsError();
          if (missing) return { data: null, error: missing };
          if (ctx.op === 'insert') {
            const payload = { status: 'active', ...(ctx.payload as Row) };
            state.accounts.push(payload);
            return { data: null, error: null };
          }
          if (ctx.op === 'update') {
            const id = ctx.eq.find(([c]) => c === 'user_id')?.[1] as string | undefined;
            const row = state.accounts.find((a) => a.user_id === id);
            if (row) Object.assign(row, ctx.payload);
            return { data: null, error: null };
          }
          let rows = state.accounts;
          if (ctx.inFilter) rows = rows.filter(matchesIn);
          rows = rows.filter(matchesEq);
          return { data: rows, error: null };
        }

        if (HISTORY_TABLES.has(table)) {
          const id = ctx.eq[0]?.[1] as string | undefined;
          const count = id && state.historyIds.has(id) ? 1 : 0;
          return { data: null, error: null, count };
        }

        return { data: [], error: null };
      }

      Object.assign(chain, {
        select: () => chain,
        insert: (p: Row) => {
          ctx.op = 'insert';
          ctx.payload = p;
          return chain;
        },
        update: (p: Row) => {
          ctx.op = 'update';
          ctx.payload = p;
          return chain;
        },
        upsert: (p: Row) => {
          ctx.op = 'upsert';
          ctx.payload = p;
          return chain;
        },
        eq: (col: string, val: unknown) => {
          ctx.eq.push([col, val]);
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          ctx.inFilter = [col, vals];
          return chain;
        },
        order: () => chain,
        maybeSingle: () => {
          const r = result();
          const rows = Array.isArray(r.data) ? r.data : r.data ? [r.data] : [];
          return Promise.resolve({ data: rows[0] ?? null, error: r.error });
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(result()).then(resolve, reject),
      });
      return chain;
    },
    auth: {
      admin: {
        listUsers: () => Promise.resolve({ data: { users: state.authUsers }, error: null }),
        getUserById: (id: string) => {
          const u = state.authUsers.find((x) => x.id === id);
          return Promise.resolve({
            data: { user: u ? { id: u.id, email: u.email, last_sign_in_at: u.last_sign_in_at } : null },
            error: null,
          });
        },
        updateUserById: (id: string, attrs: Row) => {
          state.bannedPatches.push({ id, attrs });
          const u = state.authUsers.find((x) => x.id === id);
          if (u && typeof attrs.email === 'string') u.email = attrs.email;
          return Promise.resolve({ data: { user: u ?? null }, error: null });
        },
        deleteUser: (id: string) => {
          state.deletedUserIds.push(id);
          state.authUsers = state.authUsers.filter((u) => u.id !== id);
          state.accounts = state.accounts.filter((a) => a.user_id !== id);
          state.profiles = state.profiles.filter((p) => p.id !== id);
          return Promise.resolve({ data: {}, error: null });
        },
      },
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));
vi.mock('@/lib/api/rateLimit', () => ({ rateLimitOk: () => Promise.resolve(true) }));

const sendPasswordLink = vi.fn((..._args: unknown[]) => Promise.resolve({ kind: 'password_reset', status: 'sent', detail: '' }));
const sendPasswordChangedNotice = vi.fn((..._args: unknown[]) =>
  Promise.resolve({ kind: 'password_changed', status: 'sent', detail: '' }),
);
vi.mock('@/lib/staff/emails', () => ({
  sendPasswordLink: (...args: unknown[]) => sendPasswordLink(...args),
  sendPasswordChangedNotice: (...args: unknown[]) => sendPasswordChangedNotice(...args),
}));

const { PATCH, DELETE } = await import('@/app/api/owner/staff/[id]/route');
const { POST: POST_PASSWORD } = await import('@/app/api/owner/staff/[id]/password/route');
const { POST: POST_DEACTIVATE } = await import('@/app/api/owner/staff/[id]/deactivate/route');
const { POST: POST_REACTIVATE } = await import('@/app/api/owner/staff/[id]/reactivate/route');

function req(method: string, body: unknown) {
  return new Request('http://t/api/owner/staff/x', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(id: string) {
  return { params: { id } };
}

beforeEach(() => {
  state.owner = { id: OWNER_ID };
  state.profiles = [
    { id: OWNER_ID, role: 'owner', name: 'Owner' },
    { id: OTHER_OWNER_TARGET, role: 'owner', name: 'Other Owner' },
    { id: VALID_ID, role: 'staff', name: 'Ravi' },
  ];
  state.accounts = [
    { user_id: VALID_ID, login_id: 'ravi', personal_email: 'ravi@example.com', phone: '', status: 'active' },
  ];
  state.accountsMissing = false;
  state.authUsers = [
    { id: OWNER_ID, email: 'owner@hioc.in', last_sign_in_at: null },
    { id: OTHER_OWNER_TARGET, email: 'owner2@hioc.in', last_sign_in_at: null },
    { id: VALID_ID, email: 'ravi@hioc.in', last_sign_in_at: null },
  ];
  state.historyIds = new Set();
  state.bannedPatches = [];
  state.deletedUserIds = [];
  sendPasswordLink.mockClear();
  sendPasswordChangedNotice.mockClear();
});

describe('PATCH /api/owner/staff/[id]', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    expect((await PATCH(req('PATCH', { name: 'X' }), params(VALID_ID))).status).toBe(403);
  });

  it('404s an unknown id', async () => {
    const res = await PATCH(req('PATCH', { name: 'X' }), params('99999999-9999-4999-8999-999999999999'));
    expect(res.status).toBe(404);
  });

  it('refuses to target an owner', async () => {
    const res = await PATCH(req('PATCH', { name: 'New Name' }), params(OTHER_OWNER_TARGET));
    expect(res.status).toBe(403);
  });

  it('400s an empty patch', async () => {
    const res = await PATCH(req('PATCH', {}), params(VALID_ID));
    expect(res.status).toBe(400);
  });

  it('updates the name', async () => {
    const res = await PATCH(req('PATCH', { name: 'Ravi Kumar' }), params(VALID_ID));
    expect(res.status).toBe(200);
    expect(state.profiles.find((p) => p.id === VALID_ID)).toMatchObject({ name: 'Ravi Kumar' });
  });

  it('treats a role equal to the current role as a no-op, not a self-role-change error', async () => {
    // Owner PATCHing someone ELSE's account with their own unchanged role —
    // this must succeed quietly (it's a no-op on the role field).
    const res = await PATCH(req('PATCH', { name: 'Ravi K', role: 'staff' }), params(VALID_ID));
    expect(res.status).toBe(200);
    expect(state.profiles.find((p) => p.id === VALID_ID)).toMatchObject({ role: 'staff', name: 'Ravi K' });
  });

  it('409s a duplicate login ID', async () => {
    state.accounts.push({ user_id: OTHER_OWNER_TARGET, login_id: 'taken', personal_email: null, phone: '', status: 'active' });
    const res = await PATCH(req('PATCH', { loginId: 'taken' }), params(VALID_ID));
    // OTHER_OWNER_TARGET is an owner target for the *patch*, but the
    // duplicate is keyed on VALID_ID (a staff account) taking a login ID
    // already claimed by a different user_id.
    expect(res.status).toBe(409);
  });

  it('renames the login (auth email) and updates staff_accounts.login_id', async () => {
    const res = await PATCH(req('PATCH', { loginId: 'ravi2' }), params(VALID_ID));
    expect(res.status).toBe(200);
    expect(state.authUsers.find((u) => u.id === VALID_ID)?.email).toBe('ravi2@hioc.in');
    expect(state.accounts.find((a) => a.user_id === VALID_ID)).toMatchObject({ login_id: 'ravi2' });
  });

  it('updates role_before_deactivation instead of profiles.role for a deactivated account', async () => {
    state.profiles.find((p) => p.id === VALID_ID)!.role = 'customer';
    state.accounts[0].status = 'deactivated';
    state.accounts[0].role_before_deactivation = 'staff';

    const res = await PATCH(req('PATCH', { role: 'manager' }), params(VALID_ID));
    expect(res.status).toBe(200);
    expect(state.profiles.find((p) => p.id === VALID_ID)).toMatchObject({ role: 'customer' });
    expect(state.accounts.find((a) => a.user_id === VALID_ID)).toMatchObject({ role_before_deactivation: 'manager' });
  });

  it('409s when the migration is not applied', async () => {
    state.accountsMissing = true;
    const res = await PATCH(req('PATCH', { name: 'X' }), params(VALID_ID));
    expect(res.status).toBe(409);
  });
});

describe('POST /api/owner/staff/[id]/password', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    expect((await POST_PASSWORD(req('POST', { mode: 'link' }), params(VALID_ID))).status).toBe(403);
  });

  it('400s "link" when there is no personal email', async () => {
    state.accounts[0].personal_email = null;
    const res = await POST_PASSWORD(req('POST', { mode: 'link' }), params(VALID_ID));
    expect(res.status).toBe(400);
  });

  it('sends a reset link for mode "link"', async () => {
    const res = await POST_PASSWORD(req('POST', { mode: 'link' }), params(VALID_ID));
    expect(res.status).toBe(200);
    expect(sendPasswordLink).toHaveBeenCalledTimes(1);
    expect(sendPasswordChangedNotice).not.toHaveBeenCalled();
  });

  it('400s a too-short password for mode "set"', async () => {
    const res = await POST_PASSWORD(req('POST', { mode: 'set', password: 'short' }), params(VALID_ID));
    expect(res.status).toBe(400);
  });

  it('sets the password, sends a changed notice, and never echoes the password', async () => {
    const res = await POST_PASSWORD(req('POST', { mode: 'set', password: 'brandNewPassword1' }), params(VALID_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(JSON.stringify(body)).not.toContain('brandNewPassword1');
    expect(state.bannedPatches.find((p) => p.id === VALID_ID)?.attrs).toMatchObject({ password: 'brandNewPassword1' });
    expect(sendPasswordChangedNotice).toHaveBeenCalledTimes(1);
  });

  it('409s a deactivated account', async () => {
    state.accounts[0].status = 'deactivated';
    const res = await POST_PASSWORD(req('POST', { mode: 'set', password: 'brandNewPassword1' }), params(VALID_ID));
    expect(res.status).toBe(409);
  });
});

describe('POST /api/owner/staff/[id]/deactivate', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    expect((await POST_DEACTIVATE(req('POST', {}), params(VALID_ID))).status).toBe(403);
  });

  it('refuses to deactivate self', async () => {
    const res = await POST_DEACTIVATE(req('POST', {}), params(OWNER_ID));
    expect(res.status).toBe(403);
  });

  it('refuses to deactivate an owner', async () => {
    const res = await POST_DEACTIVATE(req('POST', {}), params(OTHER_OWNER_TARGET));
    expect(res.status).toBe(403);
  });

  it('bans the user, demotes profiles.role to customer, and marks staff_accounts deactivated', async () => {
    const res = await POST_DEACTIVATE(req('POST', {}), params(VALID_ID));
    expect(res.status).toBe(200);
    expect(state.bannedPatches.find((p) => p.id === VALID_ID)?.attrs).toMatchObject({ ban_duration: '876000h' });
    expect(state.profiles.find((p) => p.id === VALID_ID)).toMatchObject({ role: 'customer' });
    const account = state.accounts.find((a) => a.user_id === VALID_ID);
    expect(account).toMatchObject({ status: 'deactivated', role_before_deactivation: 'staff', deactivated_by: OWNER_ID });
  });

  it('is idempotent on an already-deactivated account', async () => {
    await POST_DEACTIVATE(req('POST', {}), params(VALID_ID));
    const res = await POST_DEACTIVATE(req('POST', {}), params(VALID_ID));
    expect(res.status).toBe(200);
    // Only banned once — the second call short-circuits.
    expect(state.bannedPatches.filter((p) => p.id === VALID_ID)).toHaveLength(1);
  });
});

describe('POST /api/owner/staff/[id]/reactivate', () => {
  beforeEach(() => {
    state.profiles.find((p) => p.id === VALID_ID)!.role = 'customer';
    state.accounts[0].status = 'deactivated';
    state.accounts[0].role_before_deactivation = 'manager';
  });

  it('403s a non-owner', async () => {
    state.owner = null;
    expect((await POST_REACTIVATE(req('POST', {}), params(VALID_ID))).status).toBe(403);
  });

  it('unbans and restores the role from role_before_deactivation', async () => {
    const res = await POST_REACTIVATE(req('POST', {}), params(VALID_ID));
    expect(res.status).toBe(200);
    expect(state.bannedPatches.find((p) => p.id === VALID_ID)?.attrs).toMatchObject({ ban_duration: 'none' });
    expect(state.profiles.find((p) => p.id === VALID_ID)).toMatchObject({ role: 'manager' });
    expect(state.accounts.find((a) => a.user_id === VALID_ID)).toMatchObject({ status: 'active' });
  });

  it('defaults the restored role to staff when role_before_deactivation is unset', async () => {
    state.accounts[0].role_before_deactivation = null;
    const res = await POST_REACTIVATE(req('POST', {}), params(VALID_ID));
    expect(res.status).toBe(200);
    expect(state.profiles.find((p) => p.id === VALID_ID)).toMatchObject({ role: 'staff' });
  });
});

describe('DELETE /api/owner/staff/[id] — true delete', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    expect((await DELETE(req('DELETE', {}), params(VALID_ID))).status).toBe(403);
  });

  it('refuses to delete self', async () => {
    const res = await DELETE(req('DELETE', {}), params(OWNER_ID));
    expect(res.status).toBe(403);
  });

  it('refuses to delete an owner', async () => {
    const res = await DELETE(req('DELETE', {}), params(OTHER_OWNER_TARGET));
    expect(res.status).toBe(403);
  });

  it('409s and refuses when the account has history', async () => {
    state.historyIds.add(VALID_ID);
    const res = await DELETE(req('DELETE', {}), params(VALID_ID));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe('This account has history — deactivate it instead.');
    expect(state.deletedUserIds).not.toContain(VALID_ID);
  });

  it('deletes the auth user (cascades staff_accounts/profiles) when there is no history', async () => {
    const res = await DELETE(req('DELETE', {}), params(VALID_ID));
    expect(res.status).toBe(200);
    expect(state.deletedUserIds).toContain(VALID_ID);
  });
});
