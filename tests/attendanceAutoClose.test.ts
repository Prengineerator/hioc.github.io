import { beforeEach, describe, expect, it, vi } from 'vitest';

// SHEET-3 — the auto-close cron.
//
// The behaviours worth holding: it fails closed without a secret, it closes AT
// the shift end rather than at "now", it never silently pays a guess (the row
// stays unapproved), it handles overnight shifts, it falls back to an absolute
// cap for anyone with no employment record, and running it twice changes
// nothing the second time.

const state: {
  settings: Record<string, unknown>;
  open: Record<string, unknown>[];
  employment: Record<string, unknown>[];
  updates: { id: string; patch: Record<string, unknown> }[];
  /** Ids the guarded update matches. Anything else returns zero rows. */
  updatableIds: Set<string>;
} = {
  settings: {},
  open: [],
  employment: [],
  updates: [],
  updatableIds: new Set(),
};

function baseSettings(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    is_singleton: true,
    store_lat: 28.6,
    store_lng: 77.2,
    geofence_radius_m: 150,
    max_accuracy_m: 100,
    max_fix_age_sec: 60,
    grace_period_min: 15,
    late_marks_per_halfday: 3,
    ot_threshold_min: 0,
    ot_multiplier: 1,
    auto_break_min: 0,
    auto_break_after_min: 360,
    half_day_min_minutes: 240,
    absent_below_minutes: 120,
    auto_close_grace_min: 120,
    max_session_hours: 14,
    location_retention_days: 365,
    updated_by: null,
    updated_at: '',
    ...over,
  };
}

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const filters: [string, unknown][] = [];
      const ctx = { op: 'select', patch: {} as Record<string, unknown> };
      const chain: Record<string, unknown> = {};
      const result = () => {
        if (table === 'attendance_settings') return { data: state.settings, error: null };
        if (table === 'staff_employment') return { data: state.employment, error: null };
        if (table === 'attendance_sessions') {
          if (ctx.op === 'update') {
            const id = String(filters.find((f) => f[0] === 'id')?.[1] ?? '');
            state.updates.push({ id, patch: ctx.patch });
            return state.updatableIds.has(id)
              ? { data: { id }, error: null }
              : { data: null, error: null };
          }
          return { data: state.open, error: null };
        }
        return { data: null, error: null };
      };
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.op = 'update';
          ctx.patch = p;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          filters.push([c, v]);
          return chain;
        },
        lte: () => chain,
        gte: () => chain,
        is: () => chain,
        or: () => chain,
        order: () => chain,
        maybeSingle: () => Promise.resolve(result()),
        single: () => Promise.resolve(result()),
        then: (r: (v: unknown) => void) => r(result()),
      });
      return chain;
    },
  }),
}));

const { GET } = await import('@/app/api/cron/close-attendance/route');

function cronReq(secret?: string) {
  return new Request('http://t/api/cron/close-attendance', {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

const HOUR = 3_600_000;

function openSession(over: Record<string, unknown> = {}) {
  return {
    id: 'sess-1',
    user_id: 'staff-1',
    business_date: '2026-08-06',
    clock_in_at: new Date(Date.now() - 12 * HOUR).toISOString(),
    clock_out_at: null,
    status: 'open',
    source: 'punch',
    flags: [],
    approved_at: null,
    ...over,
  };
}

function employmentRow(over: Record<string, unknown> = {}) {
  return {
    id: 'emp-1',
    user_id: 'staff-1',
    monthly_salary_inr: 25000,
    contracted_hours_per_day: 9,
    shift_start_time: '10:00',
    shift_end_time: '19:00',
    weekly_off_dow: 0,
    effective_from: '2026-01-01',
    effective_to: null,
    ...over,
  };
}

beforeEach(() => {
  process.env.CRON_SECRET = 'topsecret';
  state.settings = baseSettings();
  state.open = [];
  state.employment = [employmentRow()];
  state.updates = [];
  state.updatableIds = new Set(['sess-1']);
});

describe('close-attendance cron — authorization', () => {
  it('401s without the bearer secret', async () => {
    expect((await GET(cronReq())).status).toBe(401);
  });

  it('401s with the wrong secret', async () => {
    expect((await GET(cronReq('wrong'))).status).toBe(401);
  });

  it('fails CLOSED when CRON_SECRET is unset — never publicly runnable', async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(cronReq('anything'))).status).toBe(401);
  });
});

describe('close-attendance cron — closing behaviour', () => {
  it('does nothing when nothing is open', async () => {
    const body = await (await GET(cronReq('topsecret'))).json();
    expect(body).toEqual({ scanned: 0, closed: 0, capped: 0 });
  });

  it('leaves a shift that is still within its grace period alone', async () => {
    // The employment record is pinned relative to the clock-in so this does not
    // depend on what time of day the suite happens to run.
    const clockIn = new Date(Date.now() - HOUR);
    const istHour = new Date(clockIn.getTime() + 5.5 * HOUR).getUTCHours();
    state.employment = [
      employmentRow({
        shift_start_time: `${String(istHour).padStart(2, '0')}:00`,
        shift_end_time: `${String((istHour + 9) % 24).padStart(2, '0')}:00`,
      }),
    ];
    state.open = [openSession({ clock_in_at: clockIn.toISOString() })];
    const body = await (await GET(cronReq('topsecret'))).json();
    expect(body.closed).toBe(0);
    expect(state.updates).toHaveLength(0);
  });

  it('falls back to the cap when the shift end resolves BEFORE the clock-in', async () => {
    // Someone starting at 22:00 against a 10:00–19:00 record (a swapped shift,
    // a covered shift, a stale employment row). Naively this yields a due time
    // earlier than their arrival, and we would write a clock-out BEFORE the
    // clock-in — which the times-ordered CHECK rejects outright.
    //
    // The clock is pinned because the outcome otherwise depends on what time of
    // day the suite runs, and a test that passes only in the evening is worse
    // than no test.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-08T00:00:00Z'));
      const clockIn = new Date(Date.UTC(2026, 7, 6, 16, 30)); // 22:00 IST on the 6th
      state.employment = [employmentRow({ shift_start_time: '10:00', shift_end_time: '19:00' })];
      state.open = [openSession({ clock_in_at: clockIn.toISOString() })];

      const body = await (await GET(cronReq('topsecret'))).json();
      expect(body.closed).toBe(1);
      expect(body.capped).toBe(1);
      const closeAt = Date.parse(String(state.updates[0].patch.clock_out_at));
      expect(closeAt).toBeGreaterThan(clockIn.getTime());
      expect(closeAt - clockIn.getTime()).toBe(14 * HOUR);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes a long-abandoned session and marks it auto_closed', async () => {
    state.open = [openSession({ clock_in_at: new Date(Date.now() - 30 * HOUR).toISOString() })];
    const body = await (await GET(cronReq('topsecret'))).json();
    expect(body.closed).toBe(1);
    expect(state.updates[0].patch.status).toBe('auto_closed');
    expect(state.updates[0].patch.flags).toContain('auto_closed');
  });

  it('never approves what it closes — an auto-close must not become paid hours', async () => {
    // D5-4: rollUpDay gives an unapproved auto-close zero payable minutes. If
    // this job approved its own guess, that protection would evaporate.
    state.open = [openSession({ clock_in_at: new Date(Date.now() - 30 * HOUR).toISOString() })];
    await GET(cronReq('topsecret'));
    expect(state.updates[0].patch).not.toHaveProperty('approved_at');
    expect(state.updates[0].patch).not.toHaveProperty('approved_by');
  });

  it('closes AT the shift end, not at the moment the cron happened to run', async () => {
    // A cron that runs late must not hand out the hours it was late by.
    const clockIn = new Date(Date.now() - 30 * HOUR);
    state.open = [openSession({ clock_in_at: clockIn.toISOString() })];
    await GET(cronReq('topsecret'));
    const closeAt = Date.parse(String(state.updates[0].patch.clock_out_at));
    expect(closeAt).toBeLessThan(Date.now());
    expect(closeAt - clockIn.getTime()).toBeLessThanOrEqual(14 * HOUR);
  });

  it('applies the absolute cap when the person has no employment record', async () => {
    state.employment = [];
    const clockIn = new Date(Date.now() - 30 * HOUR);
    state.open = [openSession({ clock_in_at: clockIn.toISOString() })];
    const body = await (await GET(cronReq('topsecret'))).json();
    expect(body.closed).toBe(1);
    expect(body.capped).toBe(1);
    const closeAt = Date.parse(String(state.updates[0].patch.clock_out_at));
    expect(closeAt - clockIn.getTime()).toBe(14 * HOUR);
    expect(String(state.updates[0].patch.notes)).toMatch(/maximum/i);
  });

  it('never leaves a session open past the absolute cap even with a shift on record', async () => {
    state.settings = baseSettings({ max_session_hours: 10, auto_close_grace_min: 600 });
    const clockIn = new Date(Date.now() - 40 * HOUR);
    state.open = [openSession({ clock_in_at: clockIn.toISOString() })];
    await GET(cronReq('topsecret'));
    const closeAt = Date.parse(String(state.updates[0].patch.clock_out_at));
    expect(closeAt - clockIn.getTime()).toBeLessThanOrEqual(10 * HOUR);
  });

  it('handles an overnight shift without computing a negative duration', async () => {
    state.employment = [employmentRow({ shift_start_time: '16:00', shift_end_time: '01:30' })];
    const clockIn = new Date(Date.now() - 30 * HOUR);
    state.open = [openSession({ clock_in_at: clockIn.toISOString() })];
    await GET(cronReq('topsecret'));
    const closeAt = Date.parse(String(state.updates[0].patch.clock_out_at));
    expect(closeAt).toBeGreaterThan(clockIn.getTime());
  });

  it('is idempotent — the guarded update matches nothing on a second run', async () => {
    state.open = [openSession({ clock_in_at: new Date(Date.now() - 30 * HOUR).toISOString() })];
    state.updatableIds = new Set(); // the row is already closed
    const body = await (await GET(cronReq('topsecret'))).json();
    expect(body.scanned).toBe(1);
    expect(body.closed).toBe(0);
  });

  it('skips a session with an unparseable clock-in rather than crashing the run', async () => {
    state.open = [
      openSession({ id: 'bad', clock_in_at: 'nonsense' }),
      openSession({ id: 'sess-1', clock_in_at: new Date(Date.now() - 30 * HOUR).toISOString() }),
    ];
    const body = await (await GET(cronReq('topsecret'))).json();
    expect(body.closed).toBe(1);
  });
});
