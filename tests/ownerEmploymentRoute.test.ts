import { beforeEach, describe, expect, it, vi } from 'vitest';

// SHEET-4 — POST /api/owner/employment: close the current record, insert the
// new one (lib/attendance/employmentState.ts). The exclusion constraint forbids
// insert-then-close, so the route closes first — and must RESTORE the closed
// row if the insert fails, or the person is left with no current rate. A
// back-dated effective_from must also respect the payroll lock.

type Row = Record<string, unknown>;
type Filter = { col: string; op: 'eq' | 'is' | 'gte' | 'lte'; val: unknown };

const state: {
  owner: { id: string } | null;
  employment: Row[];
  payrollRuns: Row[];
  insertError: { code?: string; message: string } | null;
  /** Fail this many re-open (effective_to → null) updates. */
  restoreFailures: number;
} = { owner: null, employment: [], payrollRuns: [], insertError: null, restoreFailures: 0 };

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(({ col, op, val }) => {
    const v = row[col];
    if (op === 'eq') return v === val;
    if (op === 'is') return v === val;
    if (op === 'gte') return String(v) >= String(val);
    if (op === 'lte') return String(v) <= String(val);
    return true;
  });
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const filters: Filter[] = [];
      let op: 'select' | 'insert' | 'update' = 'select';
      let payload: Row = {};
      const rows = (): Row[] =>
        table === 'staff_employment' ? state.employment : table === 'payroll_runs' ? state.payrollRuns : [];
      const run = (): { data: unknown; error: { code?: string; message: string } | null } => {
        if (op === 'insert') {
          if (state.insertError) return { data: null, error: state.insertError };
          const row = { id: `emp-${rows().length + 1}`, effective_to: null, ...payload };
          rows().push(row);
          return { data: [{ ...row }], error: null };
        }
        if (op === 'update') {
          if (payload.effective_to === null && state.restoreFailures > 0) {
            state.restoreFailures -= 1;
            return { data: null, error: { message: 'restore failed' } };
          }
          const hit = rows().filter((r) => matches(r, filters));
          for (const r of hit) Object.assign(r, payload);
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        return { data: rows().filter((r) => matches(r, filters)).map((r) => ({ ...r })), error: null };
      };
      const chain: Record<string, unknown> = {};
      const add = (o: Filter['op']) => (col: string, val: unknown) => {
        filters.push({ col, op: o, val });
        return chain;
      };
      Object.assign(chain, {
        select: () => chain,
        insert: (p: Row) => {
          op = 'insert';
          payload = p;
          return chain;
        },
        update: (p: Row) => {
          op = 'update';
          payload = p;
          return chain;
        },
        eq: add('eq'),
        is: add('is'),
        gte: add('gte'),
        lte: add('lte'),
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          const r = run();
          return Promise.resolve({ data: ((r.data as Row[] | null) ?? [])[0] ?? null, error: r.error });
        },
        single: () => {
          const r = run();
          return Promise.resolve({ data: ((r.data as Row[] | null) ?? [])[0] ?? null, error: r.error });
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));

const { POST } = await import('@/app/api/owner/employment/route');

function post(over: Row = {}) {
  return POST(
    new Request('http://t/api/owner/employment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        user_id: 'staff-1',
        monthly_salary_inr: 30_000,
        contracted_hours_per_day: 9,
        shift_start_time: '10:00',
        shift_end_time: '19:00',
        weekly_off_dow: 0,
        effective_from: '2026-10-01',
        ...over,
      }),
    }),
  );
}

const current = () => state.employment.find((r) => r.id === 'emp-old')!;

beforeEach(() => {
  state.owner = { id: 'owner-1' };
  state.employment = [
    { id: 'emp-old', user_id: 'staff-1', monthly_salary_inr: 25_000, effective_from: '2026-01-01', effective_to: null },
  ];
  state.payrollRuns = [];
  state.insertError = null;
  state.restoreFailures = 0;
});

describe('POST /api/owner/employment', () => {
  it('closes the current record at the new start and inserts the new one', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(current().effective_to).toBe('2026-10-01');
    expect(state.employment.filter((r) => r.effective_to === null)).toHaveLength(1);
  });

  it('RESTORES the closed record when the insert fails — never leaves the person with no rate', async () => {
    state.insertError = { message: 'insert exploded' };
    const res = await post();
    expect(res.status).toBe(500);
    expect(current().effective_to).toBeNull();
  });

  it('restores on an overlap (23P01) too, and keeps the friendly message', async () => {
    state.insertError = { code: '23P01', message: 'conflicting key value violates exclusion constraint' };
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/overlaps/i);
    expect(current().effective_to).toBeNull();
  });

  it('retries the restore, and SAYS so when it still could not re-open the old record', async () => {
    state.insertError = { message: 'insert exploded' };
    state.restoreFailures = 2;
    const res = await post();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/left closed/i);
  });

  it('a single failed restore attempt is retried and succeeds', async () => {
    state.insertError = { message: 'insert exploded' };
    state.restoreFailures = 1;
    const res = await post();
    expect((await res.json()).error).not.toMatch(/left closed/i);
    expect(current().effective_to).toBeNull();
  });

  it('refuses a new record that does not start after the current one', async () => {
    const res = await post({ effective_from: '2026-01-01' });
    expect(res.status).toBe(400);
    expect(current().effective_to).toBeNull();
  });

  it('refuses a back-dated record reaching into a finalized payroll month', async () => {
    state.payrollRuns = [
      { id: 'run-9', user_id: 'staff-1', status: 'finalized', period_start: '2026-09-01', period_end: '2026-09-30' },
    ];
    const res = await post({ effective_from: '2026-09-15' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/finalized payroll/i);
    expect(current().effective_to).toBeNull();
  });

  it('locks a finalized month AFTER the start date too — the new rate prices every later day', async () => {
    state.payrollRuns = [
      { id: 'run-9', user_id: 'staff-1', status: 'finalized', period_start: '2026-09-01', period_end: '2026-09-30' },
    ];
    expect((await post({ effective_from: '2026-08-20' })).status).toBe(409);
  });

  it('allows a record starting after every finalized month', async () => {
    state.payrollRuns = [
      { id: 'run-9', user_id: 'staff-1', status: 'finalized', period_start: '2026-09-01', period_end: '2026-09-30' },
    ];
    expect((await post({ effective_from: '2026-10-01' })).status).toBe(200);
  });
});
