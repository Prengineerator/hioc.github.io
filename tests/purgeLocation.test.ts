import { beforeEach, describe, expect, it, vi } from 'vitest';

// D5-9 — the coordinate retention purge.
//
// What these hold: it fails closed without a secret, it erases only the raw
// coordinates and never the shift record, it leaves `distance_m` and the
// verdict alone (those are what a dispute turns on), it purges refused attempts
// too, and it honours the configured retention window.

const state: {
  settings: Record<string, unknown>;
  sessionPatch: Record<string, unknown> | null;
  attemptPatch: Record<string, unknown> | null;
  sessionFilters: [string, unknown][];
  attemptFilters: [string, unknown][];
  sessionRows: { id: string }[];
  attemptRows: { id: string }[];
} = {
  settings: {},
  sessionPatch: null,
  attemptPatch: null,
  sessionFilters: [],
  attemptFilters: [],
  sessionRows: [],
  attemptRows: [],
};

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      // `select` is terminal on the purge (update → select) but NOT on the
      // settings read (select → eq → maybeSingle), so it has to return the
      // chain and let the resolution decide based on which op ran.
      const ctx = { op: 'select' };
      const record = (col: string, val: unknown) => {
        if (table === 'attendance_sessions') state.sessionFilters.push([col, val]);
        if (table === 'attendance_punch_attempts') state.attemptFilters.push([col, val]);
      };
      const result = () => {
        if (ctx.op === 'update') {
          return {
            data: table === 'attendance_sessions' ? state.sessionRows : state.attemptRows,
            error: null,
          };
        }
        return { data: state.settings, error: null };
      };
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.op = 'update';
          if (table === 'attendance_sessions') state.sessionPatch = p;
          if (table === 'attendance_punch_attempts') state.attemptPatch = p;
          return chain;
        },
        eq: (c: string, v: unknown) => {
          record(c, v);
          return chain;
        },
        lt: (c: string, v: unknown) => {
          record(c, v);
          return chain;
        },
        not: (c: string, op: string, v: unknown) => {
          record(`not:${c}:${op}`, v);
          return chain;
        },
        maybeSingle: () => Promise.resolve(result()),
        then: (r: (v: unknown) => void) => r(result()),
      });
      return chain;
    },
  }),
}));

const { GET } = await import('@/app/api/cron/purge-location/route');

function cronReq(secret?: string) {
  return new Request('http://t/api/cron/purge-location', {
    headers: secret ? { authorization: `Bearer ${secret}` } : {},
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = 'topsecret';
  state.settings = { location_retention_days: 365, is_singleton: true };
  state.sessionPatch = null;
  state.attemptPatch = null;
  state.sessionFilters = [];
  state.attemptFilters = [];
  state.sessionRows = [{ id: 'a' }, { id: 'b' }];
  state.attemptRows = [{ id: 'x' }];
});

describe('purge-location — authorization', () => {
  it('401s without the secret', async () => {
    expect((await GET(cronReq())).status).toBe(401);
  });

  it('fails CLOSED when CRON_SECRET is unset', async () => {
    delete process.env.CRON_SECRET;
    expect((await GET(cronReq('anything'))).status).toBe(401);
  });
});

describe('purge-location — what it erases', () => {
  it('nulls every raw coordinate on a session', async () => {
    await GET(cronReq('topsecret'));
    expect(state.sessionPatch).toEqual({
      clock_in_lat: null,
      clock_in_lng: null,
      clock_out_lat: null,
      clock_out_lng: null,
    });
  });

  it('does NOT touch distance or the verdict — those are what a dispute needs', async () => {
    await GET(cronReq('topsecret'));
    const keys = Object.keys(state.sessionPatch ?? {});
    expect(keys).not.toContain('clock_in_distance_m');
    expect(keys).not.toContain('clock_out_distance_m');
    expect(keys).not.toContain('status');
    expect(keys).not.toContain('flags');
  });

  it('does NOT delete the shift itself — the point is to forget where, not whether', async () => {
    await GET(cronReq('topsecret'));
    // An update patch was built; nothing here ever issues a delete.
    expect(state.sessionPatch).not.toBeNull();
    expect(Object.values(state.sessionPatch!).every((v) => v === null)).toBe(true);
  });

  it('purges refused attempts too — a rejected punch records where someone was off duty', async () => {
    await GET(cronReq('topsecret'));
    expect(state.attemptPatch).toEqual({ lat: null, lng: null });
  });

  it('reports how much it cleared', async () => {
    const body = await (await GET(cronReq('topsecret'))).json();
    expect(body.sessionsPurged).toBe(2);
    expect(body.attemptsPurged).toBe(1);
    expect(body.retentionDays).toBe(365);
  });
});

describe('purge-location — the window', () => {
  it('only touches rows older than the retention window', async () => {
    await GET(cronReq('topsecret'));
    const ltFilter = state.sessionFilters.find((f) => f[0] === 'business_date');
    expect(ltFilter).toBeDefined();
    const cutoff = String(ltFilter![1]);
    // ~365 days back, well before today.
    expect(cutoff < new Date().toISOString().slice(0, 10)).toBe(true);
  });

  it('honours a shorter configured retention window', async () => {
    state.settings = { location_retention_days: 90, is_singleton: true };
    const body = await (await GET(cronReq('topsecret'))).json();
    expect(body.retentionDays).toBe(90);
    const short = Date.parse(body.cutoffDate);
    expect(Date.now() - short).toBeLessThan(120 * 86_400_000);
  });

  it('is idempotent — already-purged rows are excluded by the not-null filter', async () => {
    await GET(cronReq('topsecret'));
    // The filter is what makes a second run a no-op rather than a rewrite.
    expect(state.sessionFilters.some((f) => f[0] === 'not:clock_in_lat:is')).toBe(true);
    expect(state.attemptFilters.some((f) => f[0] === 'not:lat:is')).toBe(true);
  });
});
