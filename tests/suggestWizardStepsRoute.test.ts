import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Coffey wizard step tracking (docs/COFFEY-SPEC.md §10.7):
// POST /api/suggest/steps, and the owner page's read in
// lib/suggest/wizardStepsStore.ts (getWizardFunnel).

const ANON_ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';
const WINDOW_START = '2026-10-18T00:00:00.000Z';

type PgError = { code?: string; message?: string };

interface ChainCall {
  table: string;
  method: string;
  args: unknown[];
}

const state: {
  flag: boolean;
  rateLimitOk: boolean;
  rateLimitCalls: unknown[][];
  sessionUser: { id: string } | null;
  authThrows: boolean;
  inserted: Record<string, unknown>[];
  insertError: PgError | null;
  insertThrows: boolean;
  fromThrows: boolean;
  stepRows: { anon_id: string; step: string }[];
  stepsError: PgError | null;
  eventRows: { session_id: string | null }[];
  eventsError: PgError | null;
  sessionRows: { id: string; anon_id: string | null }[];
  sessionsError: PgError | null;
  calls: ChainCall[];
} = {
  flag: true,
  rateLimitOk: true,
  rateLimitCalls: [],
  sessionUser: null,
  authThrows: false,
  inserted: [],
  insertError: null,
  insertThrows: false,
  fromThrows: false,
  stepRows: [],
  stepsError: null,
  eventRows: [],
  eventsError: null,
  sessionRows: [],
  sessionsError: null,
  calls: [],
};

vi.mock('@/lib/flags', () => ({
  flags: {
    get suggest() {
      return state.flag;
    },
  },
}));

vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => {
    if (state.authThrows) return Promise.reject(new Error('auth down'));
    return Promise.resolve(state.sessionUser);
  },
}));

vi.mock('@/lib/api/rateLimit', () => ({
  clientIp: () => '203.0.113.9',
  rateLimitOk: (...args: unknown[]) => {
    state.rateLimitCalls.push(args);
    return Promise.resolve(state.rateLimitOk);
  },
}));

function chainFor(table: string) {
  const chain: Record<string, unknown> = {};
  let range: [number, number] | null = null;
  let inIds: string[] | null = null;
  const record =
    (method: string) =>
    (...args: unknown[]) => {
      state.calls.push({ table, method, args });
      if (method === 'range') range = [args[0] as number, args[1] as number];
      if (method === 'in') inIds = args[1] as string[];
      return chain;
    };
  const page = <T,>(rows: T[]) => (range ? rows.slice(range[0], range[1] + 1) : rows);
  Object.assign(chain, {
    select: record('select'),
    eq: record('eq'),
    gte: record('gte'),
    in: record('in'),
    order: record('order'),
    range: record('range'),
    insert: (payload: Record<string, unknown>) => {
      state.calls.push({ table, method: 'insert', args: [payload] });
      if (state.insertThrows) throw new Error('insert exploded');
      if (table !== 'suggestion_wizard_steps') return Promise.resolve({ error: { message: `unexpected table ${table}` } });
      if (state.insertError) return Promise.resolve({ error: state.insertError });
      state.inserted.push(payload);
      return Promise.resolve({ error: null });
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let result: { data: unknown; error: unknown };
      if (table === 'suggestion_wizard_steps') {
        result = state.stepsError ? { data: null, error: state.stepsError } : { data: page(state.stepRows), error: null };
      } else if (table === 'suggestion_events') {
        result = state.eventsError ? { data: null, error: state.eventsError } : { data: page(state.eventRows), error: null };
      } else if (table === 'suggestion_sessions') {
        result = state.sessionsError
          ? { data: null, error: state.sessionsError }
          : { data: state.sessionRows.filter((s) => (inIds ? inIds.includes(s.id) : true)), error: null };
      } else {
        result = { data: [], error: null };
      }
      return Promise.resolve(result).then(resolve, reject);
    },
  });
  return chain;
}

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      if (state.fromThrows) throw new Error('database unreachable');
      return chainFor(table);
    },
  }),
}));

// The store logs a missing table once per server instance (module state), so
// each test gets a fresh module registry.
async function freshModules() {
  vi.resetModules();
  const route = await import('@/app/api/suggest/steps/route');
  const store = await import('@/lib/suggest/wizardStepsStore');
  return { route, store };
}

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://t/api/suggest/steps', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': PHONE_UA, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

let errorSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  state.flag = true;
  state.rateLimitOk = true;
  state.rateLimitCalls = [];
  state.sessionUser = null;
  state.authThrows = false;
  state.inserted = [];
  state.insertError = null;
  state.insertThrows = false;
  state.fromThrows = false;
  state.stepRows = [];
  state.stepsError = null;
  state.eventRows = [];
  state.eventsError = null;
  state.sessionRows = [];
  state.sessionsError = null;
  state.calls = [];
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// POST /api/suggest/steps
// ---------------------------------------------------------------------------

describe('POST /api/suggest/steps', () => {
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const { route } = await freshModules();
    return route.POST(request(body, headers));
  };

  it('writes each of the three steps and answers 204 with no body', async () => {
    for (const step of ['opened', 'feeling_chosen', 'picks_requested']) {
      state.inserted = [];
      const res = await post({ anonId: ANON_ID, step });
      expect(res.status, step).toBe(204);
      expect(await res.text()).toBe('');
      expect(state.inserted).toEqual([{ anon_id: ANON_ID, user_id: null, step }]);
    }
  });

  it('404s when the flag is off, before touching anything', async () => {
    state.flag = false;
    const res = await post({ anonId: ANON_ID, step: 'opened' });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'Not found' });
    expect(state.calls).toEqual([]);
    expect(state.rateLimitCalls).toEqual([]);
  });

  it('400s on a malformed body, and writes nothing', async () => {
    for (const body of [
      'not json',
      '[]',
      {},
      { step: 'opened' },
      { anonId: ANON_ID },
      { anonId: 'short', step: 'opened' },
      { anonId: 'i am feeling low today', step: 'opened' },
      { anonId: ANON_ID, step: 'added_to_cart' },
      { anonId: ANON_ID, step: 'bogus' },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    }
    expect(state.inserted).toEqual([]);
    expect(state.rateLimitCalls).toEqual([]);
  });

  it('stores only the guest id, the user id and the step — nothing the customer chose, no IP, no User-Agent', async () => {
    const res = await post(
      { anonId: ANON_ID, step: 'feeling_chosen', mood: 'comfort', note: 'studying late', inputs: { sweetness: 'sweet' } },
      { 'x-forwarded-for': '203.0.113.9' },
    );
    expect(res.status).toBe(204);
    expect(Object.keys(state.inserted[0]).sort()).toEqual(['anon_id', 'step', 'user_id']);
    const stored = JSON.stringify(state.inserted);
    for (const leak of ['comfort', 'studying', 'sweet', '203.0.113.9', 'Pixel']) expect(stored).not.toContain(leak);
  });

  it('takes user_id from the session', async () => {
    state.sessionUser = { id: 'user-from-session' };
    const res = await post({ anonId: ANON_ID, step: 'opened' });
    expect(res.status).toBe(204);
    expect(state.inserted).toEqual([{ anon_id: ANON_ID, user_id: 'user-from-session', step: 'opened' }]);
  });

  it('never takes user_id from the body — signed in or not', async () => {
    const forged = { anonId: ANON_ID, step: 'opened', user_id: 'forged-user', userId: 'forged-user' };

    let res = await post(forged);
    expect(res.status).toBe(204);
    expect(state.inserted[0].user_id).toBeNull();

    state.inserted = [];
    state.sessionUser = { id: 'real-user' };
    res = await post(forged);
    expect(res.status).toBe(204);
    expect(state.inserted[0].user_id).toBe('real-user');
  });

  it('a failed session lookup just means a guest', async () => {
    state.authThrows = true;
    const res = await post({ anonId: ANON_ID, step: 'opened' });
    expect(res.status).toBe(204);
    expect(state.inserted).toEqual([{ anon_id: ANON_ID, user_id: null, step: 'opened' }]);
  });

  it('answers 204 to a crawler and stores nothing', async () => {
    for (const ua of ['Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'HeadlessChrome/120', '']) {
      const res = await post({ anonId: ANON_ID, step: 'opened' }, { 'user-agent': ua });
      expect(res.status, ua).toBe(204);
    }
    expect(state.inserted).toEqual([]);
  });

  it('429s when the IP is over its limit — its own bucket, 120 per 10 minutes like the events route', async () => {
    state.rateLimitOk = false;
    const res = await post({ anonId: ANON_ID, step: 'opened' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'Too many requests' });
    expect(state.inserted).toEqual([]);
    expect(state.rateLimitCalls).toEqual([['suggest-step:203.0.113.9', 120, 600]]);
  });

  it('still answers 204 before the table exists, and says so once per server instance, not once per visit', async () => {
    const { route } = await freshModules();
    for (const insertError of [
      { code: 'PGRST205', message: "Could not find the table 'public.suggestion_wizard_steps' in the schema cache" },
      { code: '42P01', message: 'relation "suggestion_wizard_steps" does not exist' },
      { code: 'PGRST205', message: "Could not find the table 'public.suggestion_wizard_steps' in the schema cache" },
    ]) {
      state.insertError = insertError;
      const res = await route.POST(request({ anonId: ANON_ID, step: 'opened' }));
      expect(res.status).toBe(204);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('supabase/2026-11-coffey-wizard-steps.sql');
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('answers 204 when the insert fails for any other reason, and logs it', async () => {
    state.insertError = { code: '23514', message: 'new row violates check constraint' };
    const res = await post({ anonId: ANON_ID, step: 'opened' });
    expect(res.status).toBe(204);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('answers 204 when the insert throws, or the database client cannot be made', async () => {
    state.insertThrows = true;
    expect((await post({ anonId: ANON_ID, step: 'opened' })).status).toBe(204);
    state.insertThrows = false;
    state.fromThrows = true;
    expect((await post({ anonId: ANON_ID, step: 'opened' })).status).toBe(204);
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it("reads a sendBeacon body, whatever content type the browser put on it", async () => {
    const res = await post(JSON.stringify({ anonId: ANON_ID, step: 'picks_requested' }), { 'content-type': 'text/plain;charset=UTF-8' });
    expect(res.status).toBe(204);
    expect(state.inserted).toEqual([{ anon_id: ANON_ID, user_id: null, step: 'picks_requested' }]);
  });
});

// ---------------------------------------------------------------------------
// getWizardFunnel (lib/suggest/wizardStepsStore.ts)
// ---------------------------------------------------------------------------

describe('getWizardFunnel', () => {
  const load = async () => {
    const { store } = await freshModules();
    return store.getWizardFunnel(WINDOW_START);
  };
  const callsOn = (table: string, method: string) => state.calls.filter((c) => c.table === table && c.method === method);
  const step = (anon_id: string, s: string) => ({ anon_id, step: s });

  it('adds up the window: steps from suggestion_wizard_steps, cart adds from the events the dashboard already had', async () => {
    state.stepRows = [
      step('v1', 'opened'),
      step('v1', 'feeling_chosen'),
      step('v1', 'picks_requested'),
      step('v2', 'opened'),
      step('v2', 'feeling_chosen'),
      step('v2', 'picks_requested'),
      step('v3', 'opened'),
      step('v3', 'feeling_chosen'),
      step('v4', 'opened'),
    ];
    // v1 added a pick from two sessions; v2 added nothing; s9 belongs to a browser that sent no steps.
    state.eventRows = [{ session_id: 's1' }, { session_id: 's1' }, { session_id: 's2' }, { session_id: 's9' }];
    state.sessionRows = [
      { id: 's1', anon_id: 'v1' },
      { id: 's2', anon_id: 'v1' },
      { id: 's3', anon_id: 'v2' },
      { id: 's9', anon_id: 'untracked' },
    ];

    expect(await load()).toEqual({
      status: 'ok',
      funnel: { opened: 4, feelingChosen: 3, picksRequested: 2, addedToCart: 1, truncated: false },
    });

    // The window bounds both reads.
    expect(callsOn('suggestion_wizard_steps', 'select')[0].args).toEqual(['anon_id, step']);
    expect(callsOn('suggestion_wizard_steps', 'gte')[0].args).toEqual(['created_at', WINDOW_START]);
    expect(callsOn('suggestion_events', 'eq')[0].args).toEqual(['event', 'added_to_cart']);
    expect(callsOn('suggestion_events', 'gte')[0].args).toEqual(['created_at', WINDOW_START]);
    // Each session is looked up once, by id.
    expect(callsOn('suggestion_sessions', 'in')[0].args).toEqual(['id', ['s1', 's2', 's9']]);
  });

  it('answers missing_table, quietly, before the SQL file is applied', async () => {
    for (const stepsError of [
      { code: 'PGRST205', message: "Could not find the table 'public.suggestion_wizard_steps' in the schema cache" },
      { code: '42P01', message: 'relation "public.suggestion_wizard_steps" does not exist' },
      { message: 'relation "suggestion_wizard_steps" does not exist' },
    ]) {
      state.stepsError = stepsError;
      expect(await load()).toEqual({ status: 'missing_table' });
    }
    expect(errorSpy).not.toHaveBeenCalled();
    // Nothing else is read for a table that is not there.
    expect(state.calls.filter((c) => c.table !== 'suggestion_wizard_steps')).toEqual([]);
  });

  it('answers error, and logs, for any other failure', async () => {
    state.stepsError = { code: '57014', message: 'canceling statement due to statement timeout' };
    expect(await load()).toEqual({ status: 'error' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('answers error rather than throwing when the database is unreachable', async () => {
    state.fromThrows = true;
    expect(await load()).toEqual({ status: 'error' });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it('does not look for cart adds when nobody asked for picks', async () => {
    state.stepRows = [step('v1', 'opened'), step('v1', 'feeling_chosen'), step('v2', 'opened')];
    state.eventRows = [{ session_id: 's1' }];
    expect(await load()).toEqual({
      status: 'ok',
      funnel: { opened: 2, feelingChosen: 1, picksRequested: 0, addedToCart: 0, truncated: false },
    });
    expect(state.calls.filter((c) => c.table !== 'suggestion_wizard_steps')).toEqual([]);
  });

  it('keeps the three steps and leaves the cart step unknown when the cart events cannot be read', async () => {
    state.stepRows = [step('v1', 'opened'), step('v1', 'feeling_chosen'), step('v1', 'picks_requested')];

    state.eventsError = { code: '57014', message: 'timeout' };
    expect(await load()).toEqual({
      status: 'ok',
      funnel: { opened: 1, feelingChosen: 1, picksRequested: 1, addedToCart: null, truncated: false },
    });

    state.eventsError = null;
    state.eventRows = [{ session_id: 's1' }];
    state.sessionsError = { code: '57014', message: 'timeout' };
    expect((await load()) as unknown).toMatchObject({ status: 'ok', funnel: { picksRequested: 1, addedToCart: null } });
    expect(errorSpy).toHaveBeenCalledTimes(2);
  });

  it('reads the steps a page of 1000 at a time, oldest first, and stops at a short page', async () => {
    state.stepRows = Array.from({ length: 2300 }, (_, i) => step(`v${i}`, 'opened'));
    const result = await load();
    expect(result).toMatchObject({ status: 'ok', funnel: { opened: 2300, truncated: false } });
    expect(callsOn('suggestion_wizard_steps', 'range').map((c) => c.args)).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
    expect(callsOn('suggestion_wizard_steps', 'order').slice(0, 2).map((c) => c.args)).toEqual([
      ['created_at', { ascending: true }],
      ['id', { ascending: true }],
    ]);
  });

  it('stops at 20,000 rows and marks the result truncated', async () => {
    state.stepRows = Array.from({ length: 20_500 }, (_, i) => step(`v${i}`, 'opened'));
    const result = await load();
    expect(result).toMatchObject({ status: 'ok', funnel: { opened: 20_000, truncated: true } });
    expect(callsOn('suggestion_wizard_steps', 'range')).toHaveLength(20);
  });

  it('looks sessions up 150 at a time', async () => {
    state.stepRows = Array.from({ length: 400 }, (_, i) => [
      step(`v${i}`, 'opened'),
      step(`v${i}`, 'feeling_chosen'),
      step(`v${i}`, 'picks_requested'),
    ]).flat();
    state.eventRows = Array.from({ length: 400 }, (_, i) => ({ session_id: `s${i}` }));
    state.sessionRows = Array.from({ length: 400 }, (_, i) => ({ id: `s${i}`, anon_id: `v${i}` }));
    const result = await load();
    expect(result).toMatchObject({ status: 'ok', funnel: { picksRequested: 400, addedToCart: 400 } });
    expect(callsOn('suggestion_sessions', 'in').map((c) => (c.args[1] as string[]).length)).toEqual([150, 150, 100]);
  });

  it('ignores a session with no guest id (an old client that sent none)', async () => {
    state.stepRows = [step('v1', 'opened'), step('v1', 'feeling_chosen'), step('v1', 'picks_requested')];
    state.eventRows = [{ session_id: 's1' }, { session_id: null }];
    state.sessionRows = [{ id: 's1', anon_id: null }];
    expect(await load()).toMatchObject({ status: 'ok', funnel: { picksRequested: 1, addedToCart: 0 } });
  });
});
