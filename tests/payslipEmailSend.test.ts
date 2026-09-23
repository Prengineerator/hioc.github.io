import { beforeEach, describe, expect, it, vi } from 'vitest';

// SA-5 — sendPayslipsForRun against a fake admin client. The properties worth
// locking down: it only ever touches a FINALIZED run, it is idempotent per
// (user, run) via staff_emails_payslip_once, a missing personal email is
// 'skipped' rather than silently dropped, a missing staff_accounts/
// staff_emails table (migration not applied) degrades to an all-'skipped'
// result instead of throwing, and resendPayslip's forced resend logs under a
// distinct ref instead of colliding with a prior 'sent' row.

interface FakeEmailRow {
  user_id: string;
  kind: string;
  ref: string;
  to_email: string;
  status: string;
  error: string;
  created_at: string;
}

const state: {
  runs: Record<string, Record<string, unknown>>;
  lines: Record<string, Record<string, unknown>[]>;
  accountsMissing: boolean;
  accounts: Record<string, { personal_email: string | null }>;
  emailsMissing: boolean;
  emails: FakeEmailRow[];
  profiles: { id: string; name: string | null }[];
  sendFailures: Record<string, string>; // to_email -> error, else success
} = {
  runs: {},
  lines: {},
  accountsMissing: false,
  accounts: {},
  emailsMissing: false,
  emails: [],
  profiles: [],
  sendFailures: {},
};

vi.mock('@/lib/notifications/adapters', () => ({
  emailAdapter: {
    name: 'email',
    channel: 'email',
    send: vi.fn(async ({ to }: { to: string }) => {
      const failure = state.sendFailures[to];
      if (failure) return { ok: false, providerRef: '', error: failure };
      return { ok: true, providerRef: `prov-${state.emails.length + 1}` };
    }),
  },
}));

function missingRelationError(table: string) {
  return { code: '42P01', message: `relation "${table}" does not exist` };
}

interface QueryCtx {
  op: 'select' | 'insert';
  filters: Record<string, unknown>;
  inCol?: string;
  inVals?: unknown[];
}

function resolveQuery(table: string, ctx: QueryCtx): { data: unknown; error: unknown } {
  if (ctx.op === 'insert') return { data: null, error: null };

  if (table === 'payroll_runs') {
    const id = ctx.filters.id as string;
    return { data: state.runs[id] ?? null, error: null };
  }
  if (table === 'payroll_run_lines') {
    const runId = ctx.filters.run_id as string | undefined;
    const userId = ctx.filters.user_id as string | undefined;
    const rows = state.lines[runId ?? ''] ?? [];
    if (userId) return { data: rows.find((r) => r.user_id === userId) ?? null, error: null };
    return { data: rows, error: null };
  }
  if (table === 'staff_accounts') {
    if (state.accountsMissing) return { data: null, error: missingRelationError('staff_accounts') };
    const userId = ctx.filters.user_id as string | undefined;
    if (userId) {
      const acct = state.accounts[userId];
      return { data: acct ? { personal_email: acct.personal_email } : null, error: null };
    }
    const ids = (ctx.inVals as string[] | undefined) ?? [];
    return {
      data: ids.map((id) => ({ user_id: id, personal_email: state.accounts[id]?.personal_email ?? null })),
      error: null,
    };
  }
  if (table === 'staff_emails') {
    if (state.emailsMissing) return { data: null, error: missingRelationError('staff_emails') };
    let rows = state.emails.slice();
    if (ctx.filters.kind !== undefined) rows = rows.filter((r) => r.kind === ctx.filters.kind);
    if (ctx.filters.ref !== undefined) rows = rows.filter((r) => r.ref === ctx.filters.ref);
    if (ctx.filters.status !== undefined) rows = rows.filter((r) => r.status === ctx.filters.status);
    if (ctx.filters.user_id !== undefined) rows = rows.filter((r) => r.user_id === ctx.filters.user_id);
    if (ctx.inCol === 'user_id' && ctx.inVals) {
      const ids = ctx.inVals as string[];
      rows = rows.filter((r) => ids.includes(r.user_id));
    }
    return { data: rows, error: null };
  }
  if (table === 'profiles') {
    const ids = (ctx.inVals as string[] | undefined) ?? [];
    return { data: state.profiles.filter((p) => ids.includes(p.id)), error: null };
  }
  return { data: null, error: null };
}

function toSingle(r: { data: unknown; error: unknown }) {
  return Array.isArray(r.data) ? { data: r.data[0] ?? null, error: r.error } : r;
}

function makeAdmin() {
  return {
    from(table: string) {
      const ctx: QueryCtx = { op: 'select', filters: {} };
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          ctx.filters[col] = val;
          return chain;
        },
        in: (col: string, vals: unknown[]) => {
          ctx.inCol = col;
          ctx.inVals = vals;
          return chain;
        },
        or: () => chain,
        order: () => chain,
        insert: (payload: Record<string, unknown>) => {
          ctx.op = 'insert';
          if (table === 'staff_emails') {
            state.emails.push({
              user_id: payload.user_id as string,
              kind: payload.kind as string,
              ref: (payload.ref as string) ?? '',
              to_email: (payload.to_email as string) ?? '',
              status: payload.status as string,
              error: (payload.error as string) ?? '',
              created_at: new Date(1_700_000_000_000 + state.emails.length).toISOString(),
            });
          }
          return chain;
        },
        maybeSingle: () => Promise.resolve(toSingle(resolveQuery(table, ctx))),
        single: () => Promise.resolve(toSingle(resolveQuery(table, ctx))),
        then: (resolve: (v: unknown) => void) => resolve(resolveQuery(table, ctx)),
      };
      return chain;
    },
    auth: { admin: { listUsers: vi.fn(async () => ({ data: { users: [] }, error: null })) } },
  } as never;
}

const { sendPayslipsForRun, resendPayslip } = await import('@/lib/payroll/payslipEmail');

function finalizedRun(id: string) {
  return { id, status: 'finalized', period_start: '2026-08-01', period_end: '2026-08-31' };
}

function payslipLine(runId: string, userId: string, overrides: Record<string, unknown> = {}) {
  return {
    id: `${runId}-${userId}`,
    run_id: runId,
    user_id: userId,
    monthly_salary_inr: 25_000,
    contracted_hours_per_day: 9,
    per_minute_paise: 100,
    days_present: 20,
    days_half: 0,
    days_absent: 0,
    days_off: 4,
    days_paid_leave: 0,
    worked_minutes: 10_800,
    ot_minutes: 0,
    late_marks: 0,
    base_pay_inr: 24_000,
    ot_pay_inr: 0,
    deductions_inr: 0,
    adjustments_inr: 0,
    net_pay_inr: 24_000,
    detail: {},
    ...overrides,
  };
}

beforeEach(() => {
  state.runs = {};
  state.lines = {};
  state.accountsMissing = false;
  state.accounts = {};
  state.emailsMissing = false;
  state.emails = [];
  state.profiles = [];
  state.sendFailures = {};
});

describe('sendPayslipsForRun', () => {
  it('sends and logs one payslip per line with a personal email', async () => {
    state.runs['run-1'] = finalizedRun('run-1');
    state.lines['run-1'] = [payslipLine('run-1', 'u1'), payslipLine('run-1', 'u2')];
    state.accounts = { u1: { personal_email: 'ravi@example.com' }, u2: { personal_email: 'meera@example.com' } };
    state.profiles = [
      { id: 'u1', name: 'Ravi' },
      { id: 'u2', name: 'Meera' },
    ];

    const outcomes = await sendPayslipsForRun(makeAdmin(), 'run-1');

    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === 'sent')).toBe(true);
    expect(state.emails).toHaveLength(2);
    expect(state.emails.every((e) => e.kind === 'payslip' && e.ref === 'run-1' && e.status === 'sent')).toBe(true);
  });

  it('is idempotent: a second call skips whoever already has a sent payslip for this run', async () => {
    state.runs['run-1'] = finalizedRun('run-1');
    state.lines['run-1'] = [payslipLine('run-1', 'u1')];
    state.accounts = { u1: { personal_email: 'ravi@example.com' } };
    state.profiles = [{ id: 'u1', name: 'Ravi' }];

    const first = await sendPayslipsForRun(makeAdmin(), 'run-1');
    expect(first[0].status).toBe('sent');
    expect(state.emails).toHaveLength(1);

    const second = await sendPayslipsForRun(makeAdmin(), 'run-1');
    expect(second).toEqual([{ userId: 'u1', toEmail: 'ravi@example.com', status: 'skipped', detail: 'already sent' }]);
    // No second send attempt, and no second log row.
    expect(state.emails).toHaveLength(1);
  });

  it('skips (does not send) a staffer with no personal email on file, and still logs it', async () => {
    state.runs['run-1'] = finalizedRun('run-1');
    state.lines['run-1'] = [payslipLine('run-1', 'u1')];
    state.accounts = { u1: { personal_email: null } };
    state.profiles = [{ id: 'u1', name: 'Ravi' }];

    const outcomes = await sendPayslipsForRun(makeAdmin(), 'run-1');
    expect(outcomes).toEqual([{ userId: 'u1', toEmail: '', status: 'skipped', detail: 'no personal email' }]);
    expect(state.emails[0]).toMatchObject({ status: 'skipped', to_email: '' });
  });

  it('reports a failed send without throwing and without blocking the other lines', async () => {
    state.runs['run-1'] = finalizedRun('run-1');
    state.lines['run-1'] = [payslipLine('run-1', 'u1'), payslipLine('run-1', 'u2')];
    state.accounts = { u1: { personal_email: 'bounces@example.com' }, u2: { personal_email: 'ok@example.com' } };
    state.profiles = [
      { id: 'u1', name: 'Ravi' },
      { id: 'u2', name: 'Meera' },
    ];
    state.sendFailures['bounces@example.com'] = 'mailbox full';

    const outcomes = await sendPayslipsForRun(makeAdmin(), 'run-1');
    const byUser = new Map(outcomes.map((o) => [o.userId, o]));
    expect(byUser.get('u1')).toMatchObject({ status: 'failed', detail: 'mailbox full' });
    expect(byUser.get('u2')).toMatchObject({ status: 'sent' });
  });

  it('never emails against a draft or reversed run', async () => {
    state.runs['run-1'] = { id: 'run-1', status: 'draft', period_start: '2026-08-01', period_end: '2026-08-31' };
    state.lines['run-1'] = [payslipLine('run-1', 'u1')];
    state.accounts = { u1: { personal_email: 'ravi@example.com' } };

    const outcomes = await sendPayslipsForRun(makeAdmin(), 'run-1');
    expect(outcomes).toEqual([]);
    expect(state.emails).toHaveLength(0);
  });

  it('degrades to all-skipped with "migration not applied" when staff_accounts is missing', async () => {
    state.runs['run-1'] = finalizedRun('run-1');
    state.lines['run-1'] = [payslipLine('run-1', 'u1'), payslipLine('run-1', 'u2')];
    state.accountsMissing = true;

    const outcomes = await sendPayslipsForRun(makeAdmin(), 'run-1');
    expect(outcomes).toHaveLength(2);
    expect(outcomes.every((o) => o.status === 'skipped' && o.detail === 'migration not applied')).toBe(true);
    expect(state.emails).toHaveLength(0);
  });

  it('degrades to all-skipped with "migration not applied" when staff_emails is missing', async () => {
    state.runs['run-1'] = finalizedRun('run-1');
    state.lines['run-1'] = [payslipLine('run-1', 'u1')];
    state.accounts = { u1: { personal_email: 'ravi@example.com' } };
    state.emailsMissing = true;

    const outcomes = await sendPayslipsForRun(makeAdmin(), 'run-1');
    expect(outcomes).toEqual([{ userId: 'u1', toEmail: '', status: 'skipped', detail: 'migration not applied' }]);
  });

  it('returns [] rather than throwing when the run does not exist', async () => {
    const outcomes = await sendPayslipsForRun(makeAdmin(), 'nope');
    expect(outcomes).toEqual([]);
  });
});

describe('resendPayslip', () => {
  it('logs a plain resend under the run ref when nothing was sent yet', async () => {
    state.runs['run-1'] = finalizedRun('run-1');
    state.lines['run-1'] = [payslipLine('run-1', 'u1')];
    state.accounts = { u1: { personal_email: 'ravi@example.com' } };
    state.profiles = [{ id: 'u1', name: 'Ravi' }];

    const outcome = await resendPayslip(makeAdmin(), 'run-1', 'u1');
    expect(outcome.status).toBe('sent');
    expect(state.emails).toHaveLength(1);
    expect(state.emails[0].ref).toBe('run-1');
  });

  it('logs a forced resend under a distinct ref instead of colliding with an existing sent row', async () => {
    state.runs['run-1'] = finalizedRun('run-1');
    state.lines['run-1'] = [payslipLine('run-1', 'u1')];
    state.accounts = { u1: { personal_email: 'ravi@example.com' } };
    state.profiles = [{ id: 'u1', name: 'Ravi' }];

    await sendPayslipsForRun(makeAdmin(), 'run-1');
    expect(state.emails).toHaveLength(1);
    expect(state.emails[0].ref).toBe('run-1');

    const outcome = await resendPayslip(makeAdmin(), 'run-1', 'u1');
    expect(outcome.status).toBe('sent');
    expect(state.emails).toHaveLength(2);
    // Same (user_id, ref) as the first row would violate staff_emails_payslip_once.
    expect(state.emails[1].ref).not.toBe('run-1');
    expect(state.emails[1].ref).toMatch(/^run-1:resend:\d+$/);
  });
});
