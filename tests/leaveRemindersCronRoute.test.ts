import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reminderPhoneMap } from '@/lib/leave/reminderPhone';

// GET /api/cron/leave-reminders: phone numbers come from staff_accounts.phone
// (the owner portal Staff screen), never profiles.phone. Nothing sends yet.

const NOT_VALID = 'no valid mobile number in the Phone field on the owner portal Staff screen';
const NOT_READ = 'could not read staff phone numbers (staff_accounts)';
const NOT_IMPLEMENTED = 'leave reminder template approved but the send is not implemented yet';

const state: {
  profiles: Record<string, unknown>[];
  staffAccounts: Record<string, unknown>[];
  staffError: { code: string } | null;
  inserted: Record<string, unknown>[];
  selects: Record<string, string>;
} = { profiles: [], staffAccounts: [], staffError: null, inserted: [], selects: {} };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: (cols: string) => {
          state.selects[table] = cols;
          return chain;
        },
        in: () => chain,
        eq: () => chain,
        neq: () => chain,
        insert: (row: Record<string, unknown>) => {
          state.inserted.push(row);
          return Promise.resolve({ error: null });
        },
        then: (resolve: (v: unknown) => void) => {
          if (table === 'profiles') return resolve({ data: state.profiles, error: null });
          if (table === 'staff_accounts')
            return resolve(
              state.staffError ? { data: null, error: state.staffError } : { data: state.staffAccounts, error: null },
            );
          return resolve({ data: [], error: null });
        },
      });
      return chain;
    },
  }),
}));

const { GET } = await import('@/app/api/cron/leave-reminders/route');

const run = (auth: string | null = 'Bearer cron_secret') =>
  GET(new Request('http://localhost/api/cron/leave-reminders', { headers: auth ? { authorization: auth } : {} }));

const ENV = ['CRON_SECRET', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_ID', 'WHATSAPP_TPL_LEAVE_REMINDER'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  process.env.CRON_SECRET = 'cron_secret';
  process.env.WHATSAPP_TOKEN = 'test-token';
  process.env.WHATSAPP_PHONE_ID = 'test-phone-id';
  process.env.WHATSAPP_TPL_LEAVE_REMINDER = 'test-template';
  // Friday 2026-11-27 (IST): one day to the Saturday deadline, a nudge day.
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-27T05:00:00Z'));
  state.profiles = [{ id: 'u1', name: 'Test Staff', role: 'staff', phone: '9876543210' }];
  state.staffAccounts = [];
  state.staffError = null;
  state.inserted = [];
  state.selects = {};
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('GET /api/cron/leave-reminders: auth', () => {
  it('fails CLOSED with no header, a wrong token, or CRON_SECRET unset', async () => {
    expect((await run(null)).status).toBe(401);
    expect((await run('Bearer wrong')).status).toBe(401);
    delete process.env.CRON_SECRET;
    expect((await run('Bearer cron_secret')).status).toBe(401);
    expect(state.inserted).toHaveLength(0);
  });
});

describe('GET /api/cron/leave-reminders: phone source', () => {
  it.each(['098765 43210', '+91 98765-43210', '9876543210'])(
    'uses staff_accounts.phone (%s), not skipped as missing',
    async (typed) => {
      // A real staff profile is created with only id, role and name, so the
      // number can only have come from staff_accounts.
      state.profiles = [{ id: 'u1', name: 'Test Staff', role: 'staff' }];
      state.staffAccounts = [{ user_id: 'u1', phone: typed }];
      const res = await run();
      const body = await res.json();
      expect(body.sent).toBe(0);
      expect(state.inserted).toHaveLength(1);
      expect(state.inserted[0]).toMatchObject({ user_id: 'u1', status: 'skipped', skip_reason: NOT_IMPLEMENTED });
      expect(reminderPhoneMap(state.staffAccounts).get('u1')).toBe('+919876543210');
    },
  );

  it.each([['ask Ravi'], ['98765'], [''], ['+65 9123 4567']])(
    'treats %j as no number',
    async (typed) => {
      state.staffAccounts = [{ user_id: 'u1', phone: typed }];
      const body = await (await run()).json();
      expect(body.sent).toBe(0);
      expect(state.inserted[0]).toMatchObject({ status: 'skipped', skip_reason: NOT_VALID });
      expect(reminderPhoneMap(state.staffAccounts).size).toBe(0);
    },
  );

  it('ignores profiles.phone and does not select it', async () => {
    state.staffAccounts = []; // profile has a valid phone, staff_accounts has nothing
    await run();
    expect(state.inserted[0]).toMatchObject({ status: 'skipped', skip_reason: NOT_VALID });
    expect(state.selects.profiles).not.toContain('phone');
    expect(state.selects.staff_accounts).toBe('user_id, phone');
  });

  it('uses a distinct reason when the staff_accounts read fails, and logs only the code', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    state.staffError = { code: 'XX000' };
    state.staffAccounts = [{ user_id: 'u1', phone: '9876543210' }];
    const body = await (await run()).json();
    expect(body.sent).toBe(0);
    expect(state.inserted[0]).toMatchObject({ status: 'skipped', skip_reason: NOT_READ });
    expect(spy).toHaveBeenCalledWith('leave reminder: staff_accounts read failed', 'XX000');
    spy.mockRestore();
  });

  it('keeps "template not configured" as the first reason', async () => {
    delete process.env.WHATSAPP_TPL_LEAVE_REMINDER;
    state.staffError = { code: 'XX000' };
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await run();
    expect(String(state.inserted[0].skip_reason)).toContain('WHATSAPP_TPL_LEAVE_REMINDER not configured');
  });
});
