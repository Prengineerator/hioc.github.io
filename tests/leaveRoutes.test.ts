import { beforeEach, describe, expect, it, vi } from 'vitest';

// LEAVE-2 — handler tests for the request and approval routes.
//
// The gates worth holding: the window is enforced on the SERVER (a closed
// window only the browser knows about is not closed), the week is derived from
// the requested date rather than taken from the client, weekend dates are
// refused, one staffer cannot touch another's leave, and deciding requires the
// permission key while merely asking does not.
//
// Plus the leave state machine (lib/leave/state.ts): every move is legal from
// the status actually on record, compare-and-set against it, and refused
// inside the person's finalized payroll month (lib/payroll/lock.ts).
//
// The admin client is a tiny in-memory store so the routes' own read → check
// → compare-and-set logic runs for real.

type Row = Record<string, unknown>;
type Filter = { col: string; op: 'eq' | 'in' | 'gte' | 'lte' | 'neq'; val: unknown };

const state: {
  account: { user: { id: string }; role: string } | null;
  perms: Record<string, boolean>;
  settings: Record<string, unknown>;
  leave: Row[];
  payrollRuns: Row[];
  /** Every UPDATE on leave_requests: its payload and filters. */
  updates: { payload: Row; filters: Filter[] }[];
  inserts: Row[];
  /** Called after each SELECT on leave_requests — a concurrent writer. */
  onSelect: ((filters: Filter[]) => void) | null;
} = {
  account: null,
  perms: {},
  settings: {},
  leave: [],
  payrollRuns: [],
  updates: [],
  inserts: [],
  onSelect: null,
};

let nextId = 1;

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every(({ col, op, val }) => {
    const v = row[col];
    if (op === 'eq') return v === val;
    if (op === 'neq') return v !== val;
    if (op === 'in') return (val as unknown[]).includes(v);
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
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let payload: Row = {};
      const rows = (): Row[] =>
        table === 'leave_requests' ? state.leave : table === 'payroll_runs' ? state.payrollRuns : [];

      const run = (): { data: unknown; error: { code?: string; message?: string } | null } => {
        if (table === 'attendance_settings') return { data: state.settings, error: null };
        if (op === 'insert') {
          const clash = rows().some((r) => r.user_id === payload.user_id && r.leave_date === payload.leave_date);
          if (clash) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          const row = { id: `req-${nextId++}`, ...payload };
          rows().push(row);
          state.inserts.push(row);
          return { data: [{ ...row }], error: null };
        }
        if (op === 'update') {
          const hit = rows().filter((r) => matches(r, filters));
          for (const r of hit) Object.assign(r, payload);
          if (table === 'leave_requests') state.updates.push({ payload, filters: [...filters] });
          return { data: hit.map((r) => ({ ...r })), error: null };
        }
        if (op === 'delete') {
          const keep = rows().filter((r) => !matches(r, filters));
          rows().splice(0, rows().length, ...keep);
          return { data: null, error: null };
        }
        const found = rows()
          .filter((r) => matches(r, filters))
          .map((r) => ({ ...r }));
        if (table === 'leave_requests' && state.onSelect) state.onSelect([...filters]);
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
        delete: () => {
          op = 'delete';
          return chain;
        },
        eq: add('eq'),
        neq: add('neq'),
        in: add('in'),
        gte: add('gte'),
        lte: add('lte'),
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => {
          const r = run();
          const list = (r.data as Row[] | null) ?? [];
          return Promise.resolve({ data: r.error ? null : (list[0] ?? null), error: r.error });
        },
        single: () => {
          const r = run();
          const list = (r.data as Row[] | null) ?? [];
          return Promise.resolve({ data: r.error ? null : (list[0] ?? null), error: r.error });
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
          Promise.resolve(run()).then(resolve, reject),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.account),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: (_u: unknown, key: string) => Promise.resolve(state.perms[key] ?? false),
}));

const { GET, POST, DELETE } = await import('@/app/api/leave/route');
const team = await import('@/app/api/leave/team/route');
const { plannableWeek } = await import('@/lib/leave/week');

function req(method: string, body?: unknown) {
  return new Request('http://t/api/leave', {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function leaveRow(over: Row = {}): Row {
  const week = plannableWeek();
  return {
    id: `req-${nextId++}`,
    user_id: 'staff-1',
    week_start: week.weekStart,
    leave_date: week.requestableDates[0],
    status: 'requested',
    reason: '',
    decided_by: null,
    decided_at: null,
    decision_note: '',
    ...over,
  };
}

const rowById = (id: string) => state.leave.find((r) => r.id === id)!;

beforeEach(() => {
  state.account = { user: { id: 'staff-1' }, role: 'staff' };
  state.perms = {};
  state.settings = { max_leave_days_per_week: 1, is_singleton: true };
  state.leave = [];
  state.payrollRuns = [];
  state.updates = [];
  state.inserts = [];
  state.onSelect = null;
});

describe('GET /api/leave', () => {
  it('401s without a staff session', async () => {
    state.account = null;
    expect((await GET()).status).toBe(401);
  });

  it('returns exactly five requestable weekdays', async () => {
    const body = await (await GET()).json();
    expect(body.week.requestableDates).toHaveLength(5);
    expect(body.maxPerWeek).toBe(1);
  });
});

describe('POST /api/leave — asking for a day off', () => {
  it('is NOT permission-gated — a plain staffer can ask', async () => {
    // An unseeded key would fail closed to manager and stop the whole team
    // requesting leave at all (playbook A-4).
    const date = plannableWeek().requestableDates[0];
    const res = await POST(req('POST', { leave_date: date }));
    expect(res.status).toBe(200);
    expect(state.inserts).toHaveLength(1);
  });

  it('refuses a weekend date', async () => {
    const week = plannableWeek();
    // Saturday of the target week — two days after Friday.
    const sat = new Date(Date.parse(`${week.requestableDates[4]}T00:00:00Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    const res = await POST(req('POST', { leave_date: sat }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/weekend/i);
  });

  it('refuses a date outside the plannable week', async () => {
    const res = await POST(req('POST', { leave_date: '2020-01-06' }));
    expect(res.status).toBe(400);
  });

  it('derives the week from the DATE, never from the client', async () => {
    const date = plannableWeek().requestableDates[2];
    await POST(req('POST', { leave_date: date, week_start: '1999-01-04' }));
    expect(state.inserts[0].week_start).toBe(plannableWeek().weekStart);
  });

  it('always records the caller as the requester', async () => {
    const date = plannableWeek().requestableDates[0];
    await POST(req('POST', { leave_date: date, user_id: 'someone-else' }));
    expect(state.inserts[0].user_id).toBe('staff-1');
  });

  it('always resets the status to requested, ignoring a client-sent status', async () => {
    const date = plannableWeek().requestableDates[0];
    const prior = leaveRow({ leave_date: date, status: 'declined', decided_by: 'mgr', decided_at: 'then', decision_note: 'no' });
    state.leave = [prior];
    const res = await POST(req('POST', { leave_date: date, status: 'approved' }));
    expect(res.status).toBe(200);
    expect(rowById(prior.id as string).status).toBe('requested');
    expect(rowById(prior.id as string).decided_at).toBeNull();
    expect(rowById(prior.id as string).decision_note).toBe('');
  });

  it('refuses a second day when the weekly cap is one', async () => {
    state.leave = [leaveRow({ leave_date: plannableWeek().requestableDates[0] })];
    const res = await POST(req('POST', { leave_date: plannableWeek().requestableDates[3] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already have a day/i);
  });

  it('lets the same day be re-requested without tripping the cap', async () => {
    const date = plannableWeek().requestableDates[1];
    state.leave = [leaveRow({ leave_date: date })];
    expect((await POST(req('POST', { leave_date: date }))).status).toBe(200);
  });

  it('400s on a missing date', async () => {
    expect((await POST(req('POST', {}))).status).toBe(400);
  });

  it('401s without a session', async () => {
    state.account = null;
    expect((await POST(req('POST', { leave_date: '2026-08-10' }))).status).toBe(401);
  });
});

describe('POST /api/leave — state machine fixes', () => {
  it('does NOT knock an approved day back to requested (the old blind upsert did)', async () => {
    const date = plannableWeek().requestableDates[0];
    const approved = leaveRow({ leave_date: date, status: 'approved', decided_by: 'mgr', decided_at: 'then' });
    state.leave = [approved];
    const res = await POST(req('POST', { leave_date: date, reason: 'again' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already approved/i);
    expect(rowById(approved.id as string).status).toBe('approved');
    expect(rowById(approved.id as string).decided_by).toBe('mgr');
  });

  it('is compare-and-set: a manager approving between the read and the write wins, the re-ask 409s', async () => {
    const date = plannableWeek().requestableDates[0];
    const declined = leaveRow({ leave_date: date, status: 'declined', decision_note: 'busy' });
    state.leave = [declined];
    let fired = false;
    state.onSelect = () => {
      if (fired) return;
      fired = true;
      Object.assign(rowById(declined.id as string), { status: 'approved', decided_by: 'mgr' });
    };
    const res = await POST(req('POST', { leave_date: date }));
    expect(res.status).toBe(409);
    expect(rowById(declined.id as string).status).toBe('approved');
  });

  it('re-asks after a withdrawal', async () => {
    const date = plannableWeek().requestableDates[4];
    const gone = leaveRow({ leave_date: date, status: 'withdrawn' });
    state.leave = [gone];
    expect((await POST(req('POST', { leave_date: date }))).status).toBe(200);
    expect(rowById(gone.id as string).status).toBe('requested');
  });

  it('takes its own request back when a concurrent one for another day breaks the weekly cap', async () => {
    // Both requests read "nothing held yet" before either wrote. Without the
    // re-count the week would quietly hold two days against a cap of one.
    const week = plannableWeek();
    let reads = 0;
    state.onSelect = (filters) => {
      const isCapRead = filters.some((f) => f.col === 'status' && f.op === 'in');
      if (!isCapRead || ++reads !== 1) return;
      state.leave.push(leaveRow({ id: 'other-device', leave_date: week.requestableDates[3] }));
    };
    const res = await POST(req('POST', { leave_date: week.requestableDates[1] }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/same moment/i);
    expect(state.leave.map((r) => r.id)).toEqual(['other-device']);
  });

  it("refuses inside the person's finalized payroll month", async () => {
    const date = plannableWeek().requestableDates[0];
    state.payrollRuns = [
      { id: 'run-1', user_id: 'staff-1', status: 'finalized', period_start: `${date.slice(0, 7)}-01`, period_end: `${date.slice(0, 7)}-31` },
    ];
    const res = await POST(req('POST', { leave_date: date }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/finalized payroll/i);
    expect(state.inserts).toHaveLength(0);
  });
});

describe('DELETE /api/leave — withdrawing', () => {
  it('scopes the withdrawal to the caller', async () => {
    const date = plannableWeek().requestableDates[0];
    const mine = leaveRow({ leave_date: date });
    const theirs = leaveRow({ user_id: 'staff-2', leave_date: date });
    state.leave = [mine, theirs];
    const res = await DELETE(req('DELETE', { leave_date: date }));
    expect(res.status).toBe(200);
    expect(state.updates[0].filters).toContainEqual({ col: 'user_id', op: 'eq', val: 'staff-1' });
    expect(rowById(mine.id as string).status).toBe('withdrawn');
    expect(rowById(theirs.id as string).status).toBe('requested');
  });

  it('404s when there is nothing to withdraw', async () => {
    const res = await DELETE(req('DELETE', { leave_date: plannableWeek().requestableDates[0] }));
    expect(res.status).toBe(404);
  });

  it('refuses a day outside the week being planned — e.g. past leave payroll already counted', async () => {
    // The old route checked next week's window and then withdrew BY DATE with
    // no week filter, so any of the staffer's leave could be struck out.
    const past = leaveRow({ week_start: '2026-08-10', leave_date: '2026-08-12', status: 'approved' });
    state.leave = [past];
    const res = await DELETE(req('DELETE', { leave_date: '2026-08-12' }));
    expect(res.status).toBe(409);
    expect(rowById(past.id as string).status).toBe('approved');
    expect(state.updates).toHaveLength(0);
  });

  it('will not withdraw an APPROVED day — the planner disables it; ask the manager', async () => {
    const date = plannableWeek().requestableDates[2];
    const approved = leaveRow({ leave_date: date, status: 'approved' });
    state.leave = [approved];
    const res = await DELETE(req('DELETE', { leave_date: date }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/approved/i);
    expect(rowById(approved.id as string).status).toBe('approved');
  });

  it('is compare-and-set: approved between the read and the write → 409, still approved', async () => {
    const date = plannableWeek().requestableDates[2];
    const row = leaveRow({ leave_date: date });
    state.leave = [row];
    state.onSelect = () => Object.assign(rowById(row.id as string), { status: 'approved' });
    const res = await DELETE(req('DELETE', { leave_date: date }));
    expect(res.status).toBe(409);
    expect(rowById(row.id as string).status).toBe('approved');
  });
});

describe('GET /api/leave/team — the manager view', () => {
  it('403s without leave_approve', async () => {
    const res = await team.GET(new Request('http://t/api/leave/team'));
    expect(res.status).toBe(403);
  });

  it('allows a manager holding the key', async () => {
    state.perms.leave_approve = true;
    const res = await team.GET(new Request('http://t/api/leave/team'));
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/leave/team — deciding', () => {
  beforeEach(() => {
    state.leave = [leaveRow({ id: 'req-1', user_id: 'staff-2' })];
  });

  it('403s without leave_approve', async () => {
    const res = await team.PATCH(req('PATCH', { id: 'req-1', action: 'approve' }));
    expect(res.status).toBe(403);
  });

  it('approves with the key', async () => {
    state.perms.leave_approve = true;
    const res = await team.PATCH(req('PATCH', { id: 'req-1', action: 'approve' }));
    expect(res.status).toBe(200);
    expect(rowById('req-1').status).toBe('approved');
    expect(rowById('req-1').decided_by).toBe('staff-1');
  });

  it('PIN-3: an enrolled-device manager operator (no classic session) can approve too', async () => {
    state.account = { user: { id: 'ravi' }, role: 'manager' };
    state.perms.leave_approve = true;
    const res = await team.PATCH(req('PATCH', { id: 'req-1', action: 'approve' }));
    expect(res.status).toBe(200);
    expect(rowById('req-1').decided_by).toBe('ravi');
  });

  it('refuses a decline with no note — that is the one an argument starts over', async () => {
    state.perms.leave_approve = true;
    const res = await team.PATCH(req('PATCH', { id: 'req-1', action: 'decline' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/why/i);
  });

  it('accepts a decline carrying a note', async () => {
    state.perms.leave_approve = true;
    const res = await team.PATCH(
      req('PATCH', { id: 'req-1', action: 'decline', note: 'three others already off' }),
    );
    expect(res.status).toBe(200);
    expect(rowById('req-1').status).toBe('declined');
    expect(rowById('req-1').decision_note).toBe('three others already off');
  });

  it('rejects an unknown action', async () => {
    state.perms.leave_approve = true;
    expect((await team.PATCH(req('PATCH', { id: 'req-1', action: 'maybe' }))).status).toBe(400);
  });

  it('409s when the row was withdrawn from under the decision', async () => {
    state.perms.leave_approve = true;
    rowById('req-1').status = 'withdrawn';
    expect((await team.PATCH(req('PATCH', { id: 'req-1', action: 'approve' }))).status).toBe(409);
    expect(rowById('req-1').status).toBe('withdrawn');
  });

  it('409s when the staffer withdraws between the read and the write (compare-and-set)', async () => {
    state.perms.leave_approve = true;
    state.onSelect = () => Object.assign(rowById('req-1'), { status: 'withdrawn' });
    const res = await team.PATCH(req('PATCH', { id: 'req-1', action: 'approve' }));
    expect(res.status).toBe(409);
    expect(rowById('req-1').status).toBe('withdrawn');
  });

  it('lets a manager change their mind (approved → declined), as the team panel offers', async () => {
    state.perms.leave_approve = true;
    rowById('req-1').status = 'approved';
    const res = await team.PATCH(req('PATCH', { id: 'req-1', action: 'decline', note: 'cover fell through' }));
    expect(res.status).toBe(200);
    expect(rowById('req-1').status).toBe('declined');
  });

  it('refuses to approve what is already approved', async () => {
    state.perms.leave_approve = true;
    rowById('req-1').status = 'approved';
    const res = await team.PATCH(req('PATCH', { id: 'req-1', action: 'approve' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already approved/i);
  });

  it("refuses inside the staffer's finalized payroll month — approved leave is their paid day off", async () => {
    state.perms.leave_approve = true;
    const date = rowById('req-1').leave_date as string;
    state.payrollRuns = [
      { id: 'run-1', user_id: 'staff-2', status: 'finalized', period_start: `${date.slice(0, 7)}-01`, period_end: `${date.slice(0, 7)}-31` },
    ];
    const res = await team.PATCH(req('PATCH', { id: 'req-1', action: 'approve' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/finalized payroll/i);
    expect(rowById('req-1').status).toBe('requested');
  });
});
