import { beforeEach, describe, expect, it, vi } from 'vitest';

// SHEET-2 / SHEET-3 — the owner correction route, driven through the session
// state machine (lib/attendance/sessionState.ts) and the shared payroll lock
// (lib/payroll/lock.ts). Each case below is a bug the route used to allow
// because it updated attendance_sessions by id alone:
//
//   * approving an OPEN session (the cron then paid the guess);
//   * a time edit resurrecting a VOID session;
//   * voiding a void session;
//   * the payroll lock checking only the PRE-edit business date, and not at
//     all for a manual entry;
//   * last-writer-wins between two people acting on the same row.
//
// The admin client is an in-memory store so the route's read → check →
// compare-and-set runs for real.

type Row = Record<string, unknown>;
type Filter = { col: string; op: 'eq' | 'is' | 'gte' | 'lte'; val: unknown };

const state: {
  actor: { user: { id: string }; role: string } | null;
  perms: Record<string, boolean>;
  sessions: Row[];
  payrollRuns: Row[];
  edits: Row[];
  /** Runs once, right after the route reads the session — a concurrent writer. */
  raceAfterRead: (() => void) | null;
} = { actor: null, perms: {}, sessions: [], payrollRuns: [], edits: [], raceAfterRead: null };

const IST = 5.5 * 3_600_000;
const businessDate = (iso: string) => new Date(Date.parse(iso) + IST).toISOString().slice(0, 10);

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(({ col, op, val }) => {
    const v = row[col];
    if (op === 'eq') return v === val;
    if (op === 'is') return v === val || (val === null && v === undefined);
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
        table === 'attendance_sessions' ? state.sessions : table === 'payroll_runs' ? state.payrollRuns : [];
      const run = (): { data: unknown; error: null } => {
        if (table === 'attendance_settings') return { data: { is_singleton: true, max_session_hours: 14 }, error: null };
        if (table === 'attendance_edits') {
          if (op === 'insert') state.edits.push(...(payload as unknown as Row[]));
          return { data: null, error: null };
        }
        if (op === 'insert') {
          const row: Row = { id: `sess-${rows().length + 1}`, ...payload };
          row.business_date = businessDate(String(row.clock_in_at));
          rows().push(row);
          return { data: [{ ...row }], error: null };
        }
        if (op === 'update') {
          const hit = rows().filter((r) => matches(r, filters));
          for (const r of hit) {
            Object.assign(r, payload);
            // The set_attendance_business_date trigger.
            if ('clock_in_at' in payload) r.business_date = businessDate(String(r.clock_in_at));
          }
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        const found = rows()
          .filter((r) => matches(r, filters))
          .map((r) => ({ ...r }));
        if (table === 'attendance_sessions' && state.raceAfterRead) {
          const race = state.raceAfterRead;
          state.raceAfterRead = null;
          race();
        }
        return { data: found, error: null };
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
        limit: () => chain,
        maybeSingle: () => {
          const r = run();
          return Promise.resolve({ data: ((r.data as Row[] | null) ?? [])[0] ?? null, error: null });
        },
        single: () => {
          const r = run();
          return Promise.resolve({ data: ((r.data as Row[] | null) ?? [])[0] ?? null, error: null });
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getStaffOrOwner: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/permissions', () => ({
  hasPermission: (_u: unknown, key: string) => Promise.resolve(state.perms[key] ?? false),
}));
vi.mock('@/lib/attendance/settings', () => ({
  getAttendanceSettings: () => Promise.resolve({ max_session_hours: 14 }),
}));

const { PATCH, POST } = await import('@/app/api/owner/attendance/sessions/route');

function req(method: string, body: unknown) {
  return new Request('http://t/api/owner/attendance/sessions', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function session(over: Row = {}): Row {
  const clockIn = (over.clock_in_at as string) ?? '2026-08-06T04:30:00.000Z'; // 10:00 IST
  return {
    id: 'sess-1',
    user_id: 'staff-1',
    business_date: businessDate(clockIn),
    clock_in_at: clockIn,
    clock_out_at: '2026-08-06T13:30:00.000Z',
    status: 'auto_closed',
    source: 'punch',
    flags: ['auto_closed'],
    approved_at: null,
    approved_by: null,
    notes: '',
    ...over,
  };
}

const finalized = (start: string, end: string, user = 'staff-1'): Row => ({
  id: `run-${start}`,
  user_id: user,
  status: 'finalized',
  period_start: start,
  period_end: end,
});

const row = () => state.sessions[0];

beforeEach(() => {
  state.actor = { user: { id: 'owner-1' }, role: 'owner' };
  state.perms = { attendance_approve: true, attendance_edit: true };
  state.sessions = [];
  state.payrollRuns = [];
  state.edits = [];
  state.raceAfterRead = null;
});

describe('approve', () => {
  it('approves an unapproved auto-close, with an audit row', async () => {
    state.sessions = [session()];
    const res = await PATCH(req('PATCH', { session_id: 'sess-1', action: 'approve', reason: 'confirmed' }));
    expect(res.status).toBe(200);
    expect(row().approved_by).toBe('owner-1');
    expect(state.edits).toHaveLength(1);
  });

  it('refuses to approve an OPEN session — the cron would have paid the guess', async () => {
    state.sessions = [session({ status: 'open', clock_out_at: null })];
    const res = await PATCH(req('PATCH', { session_id: 'sess-1', action: 'approve', reason: 'ok' }));
    expect(res.status).toBe(409);
    expect(row().approved_at).toBeNull();
  });

  it('refuses to approve a closed, a void, or an already-approved session', async () => {
    for (const over of [{ status: 'closed' }, { status: 'void' }, { approved_at: '2026-08-07T00:00:00Z' }]) {
      state.sessions = [session(over)];
      const res = await PATCH(req('PATCH', { session_id: 'sess-1', action: 'approve', reason: 'ok' }));
      expect(res.status).toBe(409);
    }
  });

  it('is compare-and-set: approved by someone else between read and write → 409, one audit row only', async () => {
    state.sessions = [session()];
    state.raceAfterRead = () => Object.assign(row(), { approved_at: 'x', approved_by: 'manager-2' });
    const res = await PATCH(req('PATCH', { session_id: 'sess-1', action: 'approve', reason: 'ok' }));
    expect(res.status).toBe(409);
    expect(row().approved_by).toBe('manager-2');
    expect(state.edits).toHaveLength(0);
  });
});

describe('void', () => {
  it('voids an auto-close or a closed session', async () => {
    for (const status of ['auto_closed', 'closed']) {
      state.sessions = [session({ status })];
      const res = await PATCH(req('PATCH', { session_id: 'sess-1', action: 'void', reason: 'duplicate' }));
      expect(res.status).toBe(200);
      expect(row().status).toBe('void');
    }
  });

  it('refuses to void an already-void session (no second audit row)', async () => {
    state.sessions = [session({ status: 'void' })];
    const res = await PATCH(req('PATCH', { session_id: 'sess-1', action: 'void', reason: 'again' }));
    expect(res.status).toBe(409);
    expect(state.edits).toHaveLength(0);
  });

  it('needs attendance_edit, not just attendance_approve', async () => {
    state.perms = { attendance_approve: true };
    state.sessions = [session()];
    expect((await PATCH(req('PATCH', { session_id: 'sess-1', action: 'void', reason: 'x' }))).status).toBe(403);
  });
});

describe('edit times', () => {
  it('does NOT resurrect a void session', async () => {
    state.sessions = [session({ status: 'void' })];
    const res = await PATCH(
      req('PATCH', { session_id: 'sess-1', reason: 'fix', clock_out_at: '2026-08-06T12:30:00.000Z' }),
    );
    expect(res.status).toBe(409);
    expect(row().status).toBe('void');
    expect(row().approved_at).toBeNull();
  });

  it('a corrected auto-close becomes closed and carries the corrector’s approval', async () => {
    state.sessions = [session()];
    const res = await PATCH(
      req('PATCH', { session_id: 'sess-1', reason: 'left at 6', clock_out_at: '2026-08-06T12:30:00.000Z' }),
    );
    expect(res.status).toBe(200);
    expect(row().status).toBe('closed');
    expect(row().approved_by).toBe('owner-1');
  });

  it('correcting only the clock-in of a still-OPEN session leaves it open and UNstamped', async () => {
    state.sessions = [session({ status: 'open', clock_out_at: null })];
    const res = await PATCH(
      req('PATCH', { session_id: 'sess-1', reason: 'came in at 9:55', clock_in_at: '2026-08-06T04:25:00.000Z' }),
    );
    expect(res.status).toBe(200);
    expect(row().status).toBe('open');
    expect(row().approved_at).toBeNull();
  });

  it('refuses to clear the clock-out of a finished session (it would be a second open shift)', async () => {
    state.sessions = [session({ status: 'closed' })];
    const res = await PATCH(req('PATCH', { session_id: 'sess-1', reason: 'oops', clock_out_at: null }));
    expect(res.status).toBe(400);
    expect(row().clock_out_at).not.toBeNull();
  });

  it('is compare-and-set: voided between read and write → 409, still void', async () => {
    state.sessions = [session()];
    state.raceAfterRead = () => Object.assign(row(), { status: 'void' });
    const res = await PATCH(
      req('PATCH', { session_id: 'sess-1', reason: 'fix', clock_out_at: '2026-08-06T12:30:00.000Z' }),
    );
    expect(res.status).toBe(409);
    expect(row().status).toBe('void');
  });

  it('400s an unknown action rather than treating it as an edit', async () => {
    state.sessions = [session()];
    expect((await PATCH(req('PATCH', { session_id: 'sess-1', action: 'delete', reason: 'x' }))).status).toBe(400);
  });
});

describe('payroll lock (lib/payroll/lock.ts)', () => {
  it('locks a session whose day is inside the finalized month', async () => {
    state.sessions = [session()];
    state.payrollRuns = [finalized('2026-08-01', '2026-08-31')];
    const res = await PATCH(req('PATCH', { session_id: 'sess-1', action: 'approve', reason: 'ok' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/finalized payroll/i);
  });

  it('locks an edit that MOVES a session into a finalized month (the post-edit date)', async () => {
    // 1 Sept 00:30 IST → 31 Aug 23:30 IST: the trigger refiles it under August,
    // which is finalized. Only the pre-edit date used to be checked.
    state.sessions = [
      session({ clock_in_at: '2026-08-31T19:00:00.000Z', clock_out_at: '2026-09-01T02:00:00.000Z', status: 'closed' }),
    ];
    expect(row().business_date).toBe('2026-09-01');
    state.payrollRuns = [finalized('2026-08-01', '2026-08-31')];
    const res = await PATCH(
      req('PATCH', { session_id: 'sess-1', reason: 'clock skew', clock_in_at: '2026-08-31T18:00:00.000Z' }),
    );
    expect(res.status).toBe(409);
    expect(row().clock_in_at).toBe('2026-08-31T19:00:00.000Z');
  });

  it("is per staffer — someone else's finalized month locks nothing, nor does a reversed run", async () => {
    state.sessions = [session()];
    state.payrollRuns = [
      finalized('2026-08-01', '2026-08-31', 'staff-2'),
      { ...finalized('2026-08-01', '2026-08-31'), id: 'rev', status: 'reversed' },
    ];
    const res = await PATCH(req('PATCH', { session_id: 'sess-1', action: 'approve', reason: 'ok' }));
    expect(res.status).toBe(200);
  });

  it('locks a MANUAL entry into a finalized month (it was unchecked)', async () => {
    state.payrollRuns = [finalized('2026-08-01', '2026-08-31')];
    const res = await POST(
      req('POST', {
        user_id: 'staff-1',
        reason: 'phone died',
        clock_in_at: '2026-08-12T04:30:00.000Z',
        clock_out_at: '2026-08-12T13:30:00.000Z',
      }),
    );
    expect(res.status).toBe(409);
    expect(state.sessions).toHaveLength(0);
  });

  it('allows a manual entry outside any finalized month', async () => {
    state.payrollRuns = [finalized('2026-07-01', '2026-07-31')];
    const res = await POST(
      req('POST', {
        user_id: 'staff-1',
        reason: 'phone died',
        clock_in_at: '2026-08-12T04:30:00.000Z',
        clock_out_at: '2026-08-12T13:30:00.000Z',
      }),
    );
    expect(res.status).toBe(200);
    expect(row().status).toBe('closed');
    expect(row().source).toBe('manual');
  });
});
