import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const jevDeciderMock = vi.fn(async (_args: unknown) => ({
  picks: [{ menuItemId: 'espresso', reason: 'A bold lift for your afternoon', reasonCode: 'boost' as const }],
  header: null,
  model: 'jev:jev-latest',
  inputTokens: 100,
  cacheReadTokens: 0,
  outputTokens: 0,
  costUsdMicros: 4,
}));
// Mirrors lib/suggest/llm.ts's real activeDecider(): Jev when TYPESAFE_API_KEY
// is set, else null. The route-level test only needs to know THAT it calls
// the active decider — provider selection is tests/suggestProvider.test.ts's job.
vi.mock('@/lib/suggest/llm', () => ({
  activeDecider: () => (process.env.TYPESAFE_API_KEY ? (args: unknown) => jevDeciderMock(args) : null),
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

/** The live "Choice of Sugar" group, as the nested select hands it back. */
function sugarGroupRow(prefix: string, over: { normalOff?: boolean } = {}) {
  const option = (key: string, name: string, price_inr: number, sort_order: number, extra: Record<string, unknown> = {}) => ({
    id: `${prefix}-${key}`,
    addon_group_id: `${prefix}-group`,
    name,
    price_inr,
    sort_order,
    ...extra,
  });
  return {
    addon_groups: {
      id: `${prefix}-group`,
      name: 'Sugar',
      display_name: 'Choice of Sugar',
      selection_type: 'single',
      min_select: 1,
      max_select: 1,
      sort_order: 20,
      options: [
        option('stevia', 'Stevia (sugarfree)', 10, 0),
        option('brown', 'Brown Sugar', 0, 10),
        option('none', 'No Sugar', 0, 20),
        option('normal', 'Normal', 0, 30, over.normalOff ? { is_available: false } : {}),
      ],
    },
  };
}

// The pre-Coffey body an old browser bundle still sends.
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

// The Coffey (v2) body the new wizard sends.
function v2Inputs(overrides: Record<string, unknown> = {}) {
  return {
    mood: 'boost',
    secondaryMood: null,
    kinds: ['drink'],
    temperature: 'either',
    base: 'either',
    strength: 'any',
    sweetness: 'any',
    body: 'any',
    flavours: [],
    needs: [],
    budget: 'any',
    note: '',
    ...overrides,
  };
}
function v2Body(overrides: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return { inputs: v2Inputs(overrides), ...extra };
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

// The route keeps the menu, traits and popularity in a 60 s per-instance cache
// (app/api/suggest/route.ts). A test that changes the menu rows would otherwise
// be served the PREVIOUS test's menu, so each test starts two minutes after the
// last on a fake clock (only Date is faked — timers and promises stay real).
let clock = Date.now();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  clock += 120_000;
  vi.setSystemTime(clock);
});
afterEach(() => {
  vi.useRealTimers();
});

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
  delete process.env.SUGGEST_DAILY_BUDGET_USD;
  process.env.TYPESAFE_API_KEY = 'test-key';
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
    expect(jevDeciderMock).toHaveBeenCalledTimes(1);
    expect(data.sessionId).toBe(state.insertedSessionId);
  });

  it('SUGGEST_LLM=off — no decider call at all, fallback reason "disabled"', async () => {
    process.env.SUGGEST_LLM = 'off';
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe('fallback');
    expect(jevDeciderMock).not.toHaveBeenCalled();
    expect((state.sessionInsert as Record<string, unknown>)?.fallback_reason).toBe('disabled');
  });

  it('no TYPESAFE_API_KEY — fallback reason "no_key", no decider call', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    expect(jevDeciderMock).not.toHaveBeenCalled();
    expect((state.sessionInsert as Record<string, unknown>)?.fallback_reason).toBe('no_key');
  });

  it('records the Jev model label and cost on the session row', async () => {
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    expect((state.sessionInsert as Record<string, unknown>)?.model).toBe('jev:jev-latest');
    expect((state.sessionInsert as Record<string, unknown>)?.cost_usd_micros).toBe(4);
  });

  it('over the daily budget — fallback reason "budget", no decider call', async () => {
    state.spentMicros = 10_000_000; // way over the $3 default cap
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe('fallback');
    expect(jevDeciderMock).not.toHaveBeenCalled();
    expect((state.sessionInsert as Record<string, unknown>)?.fallback_reason).toBe('budget');
  });

  it('rate-limited — still answers 200 with fallback reason "rate_limited", no decider call', async () => {
    state.rateLimitOk = false;
    const res = await post(requestBody());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.source).toBe('fallback');
    expect(jevDeciderMock).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------
// Coffey v2 (docs/COFFEY-SPEC.md): v2 bodies, the v1 upgrade, and the sugar flow
// ---------------------------------------------------------------------------

describe('POST /api/suggest — Coffey (v2) inputs', () => {
  it('accepts a v2 body and answers 200', async () => {
    const res = await post(v2Body());
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.picks.length).toBeGreaterThan(0);
  });

  it('persists v2 inputs on the session — for a v2 body as sent…', async () => {
    const inputs = v2Inputs({ mood: 'focus', secondaryMood: 'unwind', kinds: ['drink', 'dessert'], sweetness: 'light', flavours: ['nutty'], note: 'studying late' });
    const res = await post({ inputs });
    expect(res.status).toBe(200);
    expect((state.sessionInsert as Record<string, unknown>).inputs).toEqual(inputs);
  });

  it('…and for an old v1 body, upgraded (§2) before it is stored', async () => {
    const res = await post(
      requestBody({
        inputs: { temperature: 'iced', base: 'coffee', extras: ['sweet'], needs: ['less_sugar', 'no_caffeine'], budget: 'treat', mood: 'celebrate', note: 'hi' },
      }),
    );
    expect(res.status).toBe(200);
    expect((state.sessionInsert as Record<string, unknown>).inputs).toEqual({
      mood: 'celebrate',
      secondaryMood: null,
      kinds: ['drink', 'dessert'],
      temperature: 'iced',
      base: 'coffee',
      strength: 'any',
      sweetness: 'light', // less_sugar wins over sweet
      body: 'any',
      flavours: [],
      needs: ['no_caffeine'],
      budget: 'any', // "treat" never filtered anything
      note: 'hi',
    });
  });

  it('400s on a malformed v2 body, with the reason', async () => {
    for (const [override, message] of [
      [{ kinds: [] }, 'invalid kinds'],
      [{ kinds: ['drink', 'drink'] }, 'duplicate kinds'],
      [{ secondaryMood: 'boost' }, 'secondaryMood must differ from mood'],
      [{ sweetness: 'syrupy' }, 'invalid sweetness'],
      [{ flavours: ['savoury'] }, 'invalid flavours'],
      [{ budget: 'treat' }, 'invalid budget'],
      [{ needs: ['less_sugar'] }, 'invalid needs'],
    ] as const) {
      const res = await post(v2Body(override));
      expect(res.status, message).toBe(400);
      expect((await res.json()).error).toBe(message);
    }
  });

  it("answers with Coffey's own header for the primary feeling when Jev writes none", async () => {
    const res = await post(v2Body({ mood: 'focus' }));
    const data = await res.json();
    expect(data.header).toBe("Coffey's picks to help you focus ☕");
  });

  it('applies the v2 rules: a "not sweet" ask drops a sweet item from the picks', async () => {
    state.traitsRows = [traitsRow('espresso'), traitsRow('latte', { caffeine: 'medium', moods: ['cosy'], sweetness: 3 })];
    const res = await post(v2Body({ sweetness: 'none' }));
    const data = await res.json();
    expect(data.picks.map((p: { menuItemId: string }) => p.menuItemId)).toEqual(['espresso']);
    expect((state.sessionInsert as Record<string, unknown>).candidate_ids).toEqual(['espresso']);
  });

  it('only shows the kinds asked for: a dessert is never a pick for a drink request', async () => {
    state.menuRows = [...state.menuRows, menuRow('cheesecake', 'Cheesecake', 250, { category: 'Cheesecakes', parent_category: '' })];
    state.traitsRows = [
      ...state.traitsRows,
      traitsRow('cheesecake', { kind: 'dessert', temperature: 'ambient', caffeine: 'none', is_coffee: false, sweetness: 3, moods: ['celebrate'] }),
    ];
    const drinksOnly = await (await post(v2Body({ kinds: ['drink'] }))).json();
    expect(drinksOnly.picks.map((p: { menuItemId: string }) => p.menuItemId)).not.toContain('cheesecake');
    const withDessert = await (await post(v2Body({ kinds: ['drink', 'dessert'], mood: 'celebrate' }))).json();
    expect(withDessert.picks.map((p: { menuItemId: string }) => p.menuItemId)).toContain('cheesecake');
  });

  it('never suggests an in-store-only item (that filter is kept)', async () => {
    state.menuRows = [...state.menuRows, menuRow('water', 'Water Bottle', 20, { in_store_only: true })];
    state.traitsRows = [...state.traitsRows, traitsRow('water', { caffeine: 'none', is_coffee: false, sweetness: 0 })];
    const data = await (await post(v2Body())).json();
    expect(data.picks.map((p: { menuItemId: string }) => p.menuItemId)).not.toContain('water');
    expect((state.sessionInsert as Record<string, unknown>).candidate_ids).not.toContain('water');
  });
});

describe('POST /api/suggest — sugar presets read the menu\'s own add-on groups (COFFEY-SPEC §4.7)', () => {
  beforeEach(() => {
    // Espresso can be made with or without sugar (the live group); the latte cannot.
    state.menuRows = [
      menuRow('espresso', 'Espresso', 80, { menu_item_addon_groups: [sugarGroupRow('esp')] }),
      menuRow('latte', 'Latte', 140),
    ];
    state.traitsRows = [traitsRow('espresso'), traitsRow('latte', { caffeine: 'medium', moods: ['cosy'] })];
  });

  it('the pick opens with the sugar option chosen for the customer, and its tags say why', async () => {
    const res = await post(v2Body({ sweetness: 'light' }));
    const data = await res.json();
    const espresso = data.picks.find((p: { menuItemId: string }) => p.menuItemId === 'espresso');
    // Inherent 0; "Normal" reaches 3 — exactly the "lightly sweet" asked for — while "No Sugar" stays 0.
    expect(espresso.sugarPreset).toEqual({ groupId: 'esp-group', optionId: 'esp-normal', label: 'Normal' });
    expect(espresso.matchTags).toEqual(['A proper lift', 'Lightly sweet']);
  });

  it('claims a sweetness only when the pick lands in the band they chose: a preset that falls short earns no tag', async () => {
    const data = await (await post(v2Body({ sweetness: 'medium' }))).json();
    const espresso = data.picks.find((p: { menuItemId: string }) => p.menuItemId === 'espresso');
    // "Normal" still gets closest (0 → 3 of the 5 asked for), but 3 is the lightly-sweet band, not medium.
    expect(espresso.sugarPreset?.label).toBe('Normal');
    expect(espresso.matchTags).toEqual(['A proper lift']);
  });

  it('the picks come back as plain JSON: null where there is nothing to preselect, tags always an array', async () => {
    const data = await (await post(v2Body({ sweetness: 'medium' }))).json();
    const latte = data.picks.find((p: { menuItemId: string }) => p.menuItemId === 'latte');
    expect(latte.sugarPreset).toBeNull();
    for (const pick of data.picks) {
      expect(Array.isArray(pick.matchTags)).toBe(true);
      expect(pick.matchTags.length).toBeLessThanOrEqual(3);
    }
  });

  it('sends the add-on groups with their options in `items`, so the modal can show the preset', async () => {
    const data = await (await post(v2Body({ sweetness: 'medium' }))).json();
    const row = data.items.find((i: { id: string }) => i.id === 'espresso');
    expect(row.addon_groups).toHaveLength(1);
    expect(row.addon_groups[0].options.map((o: { name: string }) => o.name)).toEqual(['Stevia (sugarfree)', 'Brown Sugar', 'No Sugar', 'Normal']);
    const preset = data.picks.find((p: { menuItemId: string }) => p.menuItemId === 'espresso').sugarPreset;
    expect(row.addon_groups[0].options.map((o: { id: string }) => o.id)).toContain(preset.optionId);
  });

  it('sets no preset when the customer chose no sweetness', async () => {
    const data = await (await post(v2Body({ sweetness: 'any' }))).json();
    for (const pick of data.picks) expect(pick.sugarPreset).toBeNull();
  });

  it('presets No Sugar when that is what they asked for', async () => {
    const data = await (await post(v2Body({ sweetness: 'none' }))).json();
    const espresso = data.picks.find((p: { menuItemId: string }) => p.menuItemId === 'espresso');
    expect(espresso.sugarPreset).toEqual({ groupId: 'esp-group', optionId: 'esp-none', label: 'No Sugar' });
    expect(espresso.matchTags).toContain('Not sweet');
  });

  it('never presets an option the kitchen has switched off: with Normal out, there is nothing to steer between', async () => {
    state.menuRows = [menuRow('espresso', 'Espresso', 80, { menu_item_addon_groups: [sugarGroupRow('esp', { normalOff: true })] }), menuRow('latte', 'Latte', 140)];
    const data = await (await post(v2Body({ sweetness: 'medium' }))).json();
    const espresso = data.picks.find((p: { menuItemId: string }) => p.menuItemId === 'espresso');
    expect(espresso.sugarPreset).toBeNull();
    // …and the switched-off option is not even offered on the row.
    const row = data.items.find((i: { id: string }) => i.id === 'espresso');
    expect(JSON.stringify(row.addon_groups)).not.toContain('esp-normal');
  });

  it('works the same on the fallback path (no decider)', async () => {
    delete process.env.TYPESAFE_API_KEY;
    const data = await (await post(v2Body({ sweetness: 'medium' }))).json();
    expect(data.source).toBe('fallback');
    const espresso = data.picks.find((p: { menuItemId: string }) => p.menuItemId === 'espresso');
    expect(espresso.sugarPreset?.label).toBe('Normal');
  });
});
