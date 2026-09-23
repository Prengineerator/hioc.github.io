import { beforeEach, describe, expect, it, vi } from 'vitest';

// LEAVE-2 — handler tests for the request and approval routes.
//
// The gates worth holding: the window is enforced on the SERVER (a closed
// window only the browser knows about is not closed), the week is derived from
// the requested date rather than taken from the client, weekend dates are
// refused, one staffer cannot touch another's leave, and deciding requires the
// permission key while merely asking does not.

const state: {
  account: { user: { id: string }; role: string } | null;
  perms: Record<string, boolean>;
  settings: Record<string, unknown>;
  ownRequests: Record<string, unknown>[];
  existingThisWeek: Record<string, unknown>[];
  upsertResult: Record<string, unknown> | null;
  upsertError: { code?: string; message?: string } | null;
  updateResult: Record<string, unknown> | null;
  upsertPayload: Record<string, unknown> | null;
  updatePayload: Record<string, unknown> | null;
  updateFilters: [string, unknown][];
} = {
  account: null,
  perms: {},
  settings: {},
  ownRequests: [],
  existingThisWeek: [],
  upsertResult: null,
  upsertError: null,
  updateResult: null,
  upsertPayload: null,
  updatePayload: null,
  updateFilters: [],
};

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { op: 'select' };
      const chain: Record<string, unknown> = {};
      const result = () => {
        if (table === 'attendance_settings') return { data: state.settings, error: null };
        if (table === 'leave_requests') {
          if (ctx.op === 'upsert') {
            return state.upsertError
              ? { data: null, error: state.upsertError }
              : { data: state.upsertResult, error: null };
          }
          if (ctx.op === 'update') return { data: state.updateResult, error: null };
          // The max-per-week check filters on week_start; the listing does not.
          if (state.updateFilters.length === 0 && ctx.op === 'select') {
            return { data: state.existingThisWeek.length ? state.existingThisWeek : state.ownRequests, error: null };
          }
          return { data: state.ownRequests, error: null };
        }
        return { data: [], error: null };
      };
      Object.assign(chain, {
        select: () => chain,
        upsert: (p: Record<string, unknown>) => {
          ctx.op = 'upsert';
          state.upsertPayload = p;
          return chain;
        },
        update: (p: Record<string, unknown>) => {
          ctx.op = 'update';
          state.updatePayload = p;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          if (ctx.op === 'update') state.updateFilters.push([c, v]);
          return chain;
        },
        in: () => chain,
        gte: () => chain,
        neq: () => chain,
        order: () => chain,
        maybeSingle: () => Promise.resolve(result()),
        single: () => Promise.resolve(result()),
        then: (r: (v: unknown) => void) => r(result()),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getStaffOrOwner: () => Promise.resolve(state.account),
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

beforeEach(() => {
  state.account = { user: { id: 'staff-1' }, role: 'staff' };
  state.perms = {};
  state.settings = { max_leave_days_per_week: 1, is_singleton: true };
  state.ownRequests = [];
  state.existingThisWeek = [];
  state.upsertResult = { id: 'req-1', status: 'requested' };
  state.upsertError = null;
  state.updateResult = { id: 'req-1', status: 'approved' };
  state.upsertPayload = null;
  state.updatePayload = null;
  state.updateFilters = [];
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
    expect(state.upsertPayload?.week_start).toBe(plannableWeek().weekStart);
  });

  it('always records the caller as the requester', async () => {
    const date = plannableWeek().requestableDates[0];
    await POST(req('POST', { leave_date: date, user_id: 'someone-else' }));
    expect(state.upsertPayload?.user_id).toBe('staff-1');
  });

  it('always resets the status to requested, ignoring a client-sent status', async () => {
    const date = plannableWeek().requestableDates[0];
    await POST(req('POST', { leave_date: date, status: 'approved' }));
    expect(state.upsertPayload?.status).toBe('requested');
    expect(state.upsertPayload?.decided_at).toBeNull();
  });

  it('refuses a second day when the weekly cap is one', async () => {
    state.existingThisWeek = [{ id: 'x', leave_date: plannableWeek().requestableDates[0] }];
    const res = await POST(req('POST', { leave_date: plannableWeek().requestableDates[3] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already have a day/i);
  });

  it('lets the same day be re-requested without tripping the cap', async () => {
    const date = plannableWeek().requestableDates[1];
    state.existingThisWeek = [{ id: 'x', leave_date: date }];
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

describe('DELETE /api/leave — withdrawing', () => {
  it('scopes the withdrawal to the caller', async () => {
    await DELETE(req('DELETE', { leave_date: plannableWeek().requestableDates[0] }));
    expect(state.updateFilters).toContainEqual(['user_id', 'staff-1']);
  });

  it('404s when there is nothing to withdraw', async () => {
    state.updateResult = null;
    const res = await DELETE(req('DELETE', { leave_date: plannableWeek().requestableDates[0] }));
    expect(res.status).toBe(404);
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
  it('403s without leave_approve', async () => {
    const res = await team.PATCH(req('PATCH', { id: 'req-1', action: 'approve' }));
    expect(res.status).toBe(403);
  });

  it('approves with the key', async () => {
    state.perms.leave_approve = true;
    const res = await team.PATCH(req('PATCH', { id: 'req-1', action: 'approve' }));
    expect(res.status).toBe(200);
    expect(state.updatePayload?.status).toBe('approved');
    expect(state.updatePayload?.decided_by).toBe('staff-1');
  });

  it('refuses a decline with no note — that is the one an argument starts over', async () => {
    state.perms.leave_approve = true;
    const res = await team.PATCH(req('PATCH', { id: 'req-1', action: 'decline' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/why/i);
  });

  it('accepts a decline carrying a note', async () => {
    state.perms.leave_approve = true;
    state.updateResult = { id: 'req-1', status: 'declined' };
    const res = await team.PATCH(
      req('PATCH', { id: 'req-1', action: 'decline', note: 'three others already off' }),
    );
    expect(res.status).toBe(200);
    expect(state.updatePayload?.decision_note).toBe('three others already off');
  });

  it('rejects an unknown action', async () => {
    state.perms.leave_approve = true;
    expect((await team.PATCH(req('PATCH', { id: 'req-1', action: 'maybe' }))).status).toBe(400);
  });

  it('409s when the row was withdrawn from under the decision', async () => {
    state.perms.leave_approve = true;
    state.updateResult = null;
    expect((await team.PATCH(req('PATCH', { id: 'req-1', action: 'approve' }))).status).toBe(409);
  });
});
