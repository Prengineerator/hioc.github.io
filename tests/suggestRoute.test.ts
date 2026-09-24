import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 7 · SUG-4/SUG-6 — POST /api/suggest.

const state: {
  suggestFlag: boolean;
  menuRows: Record<string, unknown>[];
  traitsRows: Record<string, unknown>[];
  insertedEvents: Record<string, unknown>[];
  sessionInsert: Record<string, unknown> | null;
  sessionInsertError: { message: string } | null;
  insertedSessionId: string;
  rateLimitOk: boolean;
  sessionUser: { id: string } | null;
  spentMicros: number;
} = {
  suggestFlag: true,
  menuRows: [],
  traitsRows: [],
  insertedEvents: [],
  sessionInsert: null,
  sessionInsertError: null,
  insertedSessionId: 'new-session-id',
  rateLimitOk: true,
  sessionUser: null,
  spentMicros: 0,
};

vi.mock('@/lib/flags', () => ({
  flags: {
    get suggest() {
      return state.suggestFlag;
    },
  },
}));

vi.mock('@/lib/api/auth', () => ({
  getAuthUser: () => Promise.resolve(state.sessionUser),
}));

vi.mock('@/lib/api/rateLimit', () => ({
  clientIp: () => '127.0.0.1',
  rateLimitOk: () => Promise.resolve(state.rateLimitOk),
}));

vi.mock('@/lib/suggest/spend', () => ({
  todaySpendMicros: () => Promise.resolve(state.spentMicros),
}));

const opusDeciderMock = vi.fn(async (_args: unknown) => ({
  picks: [{ menuItemId: 'espresso', reason: 'A bold lift for your afternoon', reasonCode: 'boost' as const }],
  header: 'Here is a lovely pick for you',
  model: 'claude-opus-5',
  inputTokens: 100,
  cacheReadTokens: 0,
  outputTokens: 20,
  costUsdMicros: 500,
}));
const geminiDeciderMock = vi.fn(async (_args: unknown) => ({
  picks: [{ menuItemId: 'espresso', reason: 'A bold lift for your afternoon', reasonCode: 'boost' as const }],
  header: 'Here is a lovely pick for you',
  model: 'gemini:gemini-3-flash-preview',
  inputTokens: 100,
  cacheReadTokens: 0,
  outputTokens: 20,
  costUsdMicros: 0,
}));
// Mirrors lib/suggest/llm.ts's real activeDecider(): Anthropic wins when both
// keys are set, matching lib/suggest/models.ts's auto-selection precedence —
// route.ts calls activeDecider() instead of opusDecider directly (SUG-4 +
// Gemini support), so the route-level test only needs to know THAT it calls
// whichever decider is active, not re-implement llmProvider()'s full matrix
// (that's tests/suggestProvider.test.ts's job).
vi.mock('@/lib/suggest/llm', () => ({
  activeDecider: () => {
    if (process.env.ANTHROPIC_API_KEY) return (args: unknown) => opusDeciderMock(args);
    if (process.env.GEMINI_API_KEY) return (args: unknown) => geminiDeciderMock(args);
    return null;
  },
}));

function chainFor(table: string) {
  const chain: Record<string, unknown> = {};
  const passthrough = (..._args: unknown[]) => chain;
  Object.assign(chain, {
    select: passthrough,
    eq: passthrough,
    not: passthrough,
    gte: passthrough,
    in: passthrough,
    order: passthrough,
    limit: passthrough,
    or: passthrough,
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
    insert: (payload: Record<string, unknown> | Record<string, unknown>[]) => {
      if (table === 'suggestion_sessions') {
        state.sessionInsert = Array.isArray(payload) ? payload[0] : payload;
        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                state.sessionInsertError
                  ? { data: null, error: state.sessionInsertError }
                  : { data: { id: state.insertedSessionId }, error: null },
              ),
          }),
        };
      }
      if (table === 'suggestion_events') {
        state.insertedEvents.push(...(Array.isArray(payload) ? payload : [payload]));
      }
      return Promise.resolve({ error: null });
    },
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      let result: { data: unknown; error: unknown };
      if (table === 'menu_items') result = { data: state.menuRows, error: null };
      else if (table === 'menu_item_traits') result = { data: state.traitsRows, error: null };
      else result = { data: [], error: null };
      return Promise.resolve(result).then(resolve, reject);
    },
  });
  return chain;
}

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({ from: (table: string) => chainFor(table) }),
}));

const { POST } = await import('@/app/api/suggest/route');

function menuRow(id: string, name: string, priceInr: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    description: '',
    category: 'Coffee',
    parent_category: 'Hot',
    is_veg: true,
    is_available: true,
    sort_order: 0,
    image_url: '',
    unavailable_until: null,
    short_code: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    menu_item_variants: [{ id: `${id}-var`, menu_item_id: id, label: 'Regular', price_inr: priceInr, sort_order: 0 }],
    menu_item_addon_groups: [],
    ...extra,
  };
}

function traitsRow(menu_item_id: string, extra: Record<string, unknown> = {}) {
  return {
    menu_item_id,
    temperature: 'hot',
    caffeine: 'high',
    is_coffee: true,
    sweetness: 0,
    body: 'light',
    kind: 'drink',
    moods: ['boost'],
    dayparts: ['morning', 'afternoon', 'evening', 'late'],
    flavor_notes: ['bold'],
    source: 'opus',
    confirmed: true,
    updated_at: '2026-01-01T00:00:00Z',
    ...extra,
  };
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    inputs: {
      temperature: 'either',
      base: 'either',
      extras: [],
      needs: [],
      budget: 'any',
      mood: 'boost',
      note: '',
    },
    ...overrides,
  };
}

function post(body: unknown) {
  return POST(
    new Request('http://t/api/suggest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  state.suggestFlag = true;
  state.menuRows = [menuRow('espresso', 'Espresso', 80), menuRow('latte', 'Latte', 140)];
  state.traitsRows = [traitsRow('espresso'), traitsRow('latte', { caffeine: 'medium', moods: ['cosy'] })];
  state.insertedEvents = [];
  state.sessionInsert = null;
  state.sessionInsertError = null;
  state.rateLimitOk = true;
  state.sessionUser = null;
  state.spentMicros = 0;
  delete process.env.SUGGEST_LLM;
  delete process.env.SUGGEST_LLM_PROVIDER;
  delete process.env.SUGGEST_DAILY_BUDGET_USD;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODEL;
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

describe('POST /api/suggest', () => {
  it('404s when the flag is off', async () => {
    state.suggestFlag = false;
    const res = await post(requestBody());
    expect(res.status).toBe(404);
  });

  it('400s on a malformed body', async () => {
    const res = await post({ inputs: { temperature: 'not-a-real-value' } });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(typeof data.error).toBe('string');
  });

  it('calls the decider and returns source "llm" on the happy path', async () => {
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe('llm');
    expect(opusDeciderMock).toHaveBeenCalledTimes(1);
    expect(data.sessionId).toBe(state.insertedSessionId);
  });

  it('SUGGEST_LLM=off — no decider call at all, fallback reason "disabled"', async () => {
    process.env.SUGGEST_LLM = 'off';
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe('fallback');
    expect(opusDeciderMock).not.toHaveBeenCalled();
    expect((state.sessionInsert as Record<string, unknown>)?.fallback_reason).toBe('disabled');
  });

  it('no ANTHROPIC_API_KEY (and no GEMINI_API_KEY) — fallback reason "no_key", no decider call', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    expect(opusDeciderMock).not.toHaveBeenCalled();
    expect(geminiDeciderMock).not.toHaveBeenCalled();
    expect((state.sessionInsert as Record<string, unknown>)?.fallback_reason).toBe('no_key');
  });

  it('Gemini-only env (no ANTHROPIC_API_KEY, GEMINI_API_KEY set) uses the gemini decider', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.GEMINI_API_KEY = 'gemini-test-key';
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe('llm');
    expect(geminiDeciderMock).toHaveBeenCalledTimes(1);
    expect(opusDeciderMock).not.toHaveBeenCalled();
    expect((state.sessionInsert as Record<string, unknown>)?.model).toBe('gemini:gemini-3-flash-preview');
    expect((state.sessionInsert as Record<string, unknown>)?.cost_usd_micros).toBe(0);
  });

  it('over the daily budget — fallback reason "budget", no decider call', async () => {
    state.spentMicros = 10_000_000; // way over the $3 default cap
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe('fallback');
    expect(opusDeciderMock).not.toHaveBeenCalled();
    expect((state.sessionInsert as Record<string, unknown>)?.fallback_reason).toBe('budget');
  });

  it('rate-limited — still answers 200 with fallback reason "rate_limited", no decider call', async () => {
    state.rateLimitOk = false;
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe('fallback');
    expect(opusDeciderMock).not.toHaveBeenCalled();
    expect((state.sessionInsert as Record<string, unknown>)?.fallback_reason).toBe('rate_limited');
  });

  it('persists shown events for every pick + usual', async () => {
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    expect(state.insertedEvents.every((e) => e.event === 'shown')).toBe(true);
    expect(state.insertedEvents.length).toBeGreaterThan(0);
  });

  it('still returns suggestions (with a generated sessionId) when the session insert fails', async () => {
    state.sessionInsertError = { message: 'boom' };
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(typeof data.sessionId).toBe('string');
    expect(data.sessionId).not.toBe(state.insertedSessionId);
    expect(state.insertedEvents).toEqual([]);
  });
});
