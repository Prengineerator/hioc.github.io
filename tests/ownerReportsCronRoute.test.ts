import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level test for GET /api/cron/owner-reports, in the style of
// tests/suggestDigestRoute.test.ts: the server module is mocked so the route's
// CRON_SECRET gate and its decide-what-to-send logic run without a database.

const state = {
  migrated: true,
  settings: {} as Record<string, unknown>,
  ownerEmails: ['owner@hioc.in'],
  empty: false,
  built: [] as { kind: string; from: string; to: string }[],
  sent: [] as { kind: string; recipients: string[]; trigger: string }[],
  logged: [] as { kind: string; status: string; detail: string }[],
};

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => ({}) }));

vi.mock('@/lib/api/date', () => ({ istDateIso: () => '2026-10-01' })); // a Thursday, the 1st

vi.mock('@/lib/reports/ownerDigestServer', () => ({
  MIGRATION_NOT_APPLIED: 'migration not applied',
  loadReportSettings: async () => {
    const { DEFAULT_REPORT_SETTINGS } = await import('@/lib/reports/ownerDigest');
    return { settings: { ...DEFAULT_REPORT_SETTINGS, ...state.settings }, migrated: state.migrated };
  },
  ownerLoginEmails: async () => state.ownerEmails,
  buildDigest: async (_admin: unknown, period: { kind: string; from: string; to: string }) => {
    state.built.push(period);
    return { email: { subject: 's', html: 'h', text: 't' }, empty: state.empty };
  },
  sendDigest: async (_admin: unknown, period: { kind: string }, _email: unknown, recipients: string[], trigger: string) => {
    state.sent.push({ kind: period.kind, recipients, trigger });
    return recipients.map((to) => ({ to, status: 'sent', detail: '' }));
  },
  logSend: async (_admin: unknown, period: { kind: string }, _trigger: string, o: { status: string; detail: string }) => {
    state.logged.push({ kind: period.kind, status: o.status, detail: o.detail });
  },
}));

process.env.CRON_SECRET = 'cron_secret';

const { GET } = await import('@/app/api/cron/owner-reports/route');

const run = (headers: Record<string, string> = { authorization: 'Bearer cron_secret' }) =>
  GET(new Request('http://localhost/api/cron/owner-reports', { headers }));

beforeEach(() => {
  state.migrated = true;
  state.settings = {};
  state.ownerEmails = ['owner@hioc.in'];
  state.empty = false;
  state.built = [];
  state.sent = [];
  state.logged = [];
});

describe('GET /api/cron/owner-reports', () => {
  it('401s without the secret, and fails closed when it is unset', async () => {
    expect((await run({})).status).toBe(401);
    expect((await run({ authorization: 'Bearer wrong' })).status).toBe(401);
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      expect((await run()).status).toBe(401);
    } finally {
      process.env.CRON_SECRET = prev;
    }
    expect(state.sent).toEqual([]);
  });

  it('sends nothing before the migration is applied', async () => {
    state.migrated = false;
    const res = await run();
    expect(res.status).toBe(200);
    expect((await res.json()).sent).toBe(0);
    expect(state.built).toEqual([]);
  });

  it('sends the daily and, on the 1st, the monthly report to the owner and extras', async () => {
    state.settings = { recipients: ['acc@example.com'] };
    const res = await run();
    expect(res.status).toBe(200);
    expect(state.built).toEqual([
      { kind: 'daily', from: '2026-09-30', to: '2026-09-30' },
      { kind: 'monthly', from: '2026-09-01', to: '2026-09-30' },
    ]);
    expect(state.sent).toEqual([
      { kind: 'daily', recipients: ['owner@hioc.in', 'acc@example.com'], trigger: 'cron' },
      { kind: 'monthly', recipients: ['owner@hioc.in', 'acc@example.com'], trigger: 'cron' },
    ]);
    expect((await res.json()).sent).toBe(4);
  });

  it('sends the weekly report on the chosen weekday', async () => {
    state.settings = { weekly_send_dow: 4, monthly_enabled: false, daily_enabled: false }; // Thursday
    await run();
    expect(state.built).toEqual([{ kind: 'weekly', from: '2026-09-24', to: '2026-09-30' }]);
  });

  it('skips an empty day (logged) but still sends the monthly report', async () => {
    state.empty = true;
    await run();
    expect(state.sent.map((s) => s.kind)).toEqual(['monthly']);
    expect(state.logged).toEqual([{ kind: 'daily', status: 'skipped', detail: 'no orders or payments that day' }]);
  });

  it('sends an empty day when the owner asked for every day', async () => {
    state.empty = true;
    state.settings = { daily_skip_empty: false, monthly_enabled: false };
    await run();
    expect(state.sent.map((s) => s.kind)).toEqual(['daily']);
  });

  it('does nothing without any recipient', async () => {
    state.ownerEmails = [];
    const res = await run();
    expect((await res.json()).note).toBe('no recipients configured');
    expect(state.built).toEqual([]);
  });
});
