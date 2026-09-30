import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makePassAdmin, type Call, type DbError, type Row } from './helpers/passAdmin';

// Handler-level tests for the owner's HIOC Ritual routes (docs/COFFEE-PASS-SPEC.md §7):
//   GET  /api/owner/passes            plans, eligible ids, the menu picker
//   POST /api/owner/passes/plans      create a plan
//   PATCH /api/owner/passes/plans/[id] edit a plan
//   PUT  /api/owner/passes/eligible   replace the eligible drinks
//   GET  /api/owner/passes/summary    the owner's numbers
//
// What they guard: the flag (404), that ONLY getOwnerUser() opens them (rule D6-6:
// a counter actor, even an owner unlocked by PIN on a device, is refused), the
// validation and the cross-field checks against the stored plan, the unique-name
// 409, the replace semantics of the eligible set, and that the summary route wires
// the range, the paging and the masking to the pure math (tests/coffeePassSummary
// covers that math). The Supabase admin client is an in-memory fake.

const OWNER = '00000000-0000-4000-8000-000000000010';
const PLAN_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_PLAN = '00000000-0000-4000-8000-0000000000a2';
const M1 = '00000000-0000-4000-8000-0000000000e1';
const M2 = '00000000-0000-4000-8000-0000000000e2';
const M3 = '00000000-0000-4000-8000-0000000000e3';
const M4 = '00000000-0000-4000-8000-0000000000e4';

const state: {
  flag: boolean;
  owner: { id: string } | null;
  admin: ReturnType<typeof makePassAdmin>;
} = { flag: true, owner: null, admin: makePassAdmin({}) };

vi.mock('@/lib/flags', () => ({
  flags: new Proxy({}, { get: (_t, key) => (key === 'coffeePass' ? state.flag : true) }),
}));
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => state.admin,
}));
vi.mock('@/lib/api/auth', () => ({
  getOwnerUser: () => Promise.resolve(state.owner),
  // A PIN-unlocked owner on a shared counter device: must NEVER open an owner route.
  getCounterActor: () => Promise.resolve({ user: { id: OWNER }, role: 'owner', via: 'device' }),
}));

const overviewRoute = await import('@/app/api/owner/passes/route');
const plansRoute = await import('@/app/api/owner/passes/plans/route');
const planRoute = await import('@/app/api/owner/passes/plans/[id]/route');
const eligibleRoute = await import('@/app/api/owner/passes/eligible/route');
const summaryRoute = await import('@/app/api/owner/passes/summary/route');

function plan(over: Row = {}): Row {
  return {
    id: PLAN_ID,
    name: 'Weekly Ritual',
    description: '7 cups for the price of 5',
    drinks_total: 7,
    drinks_paid: 5,
    validity_days: 7,
    // A plan is only the recipe (CP-D24): no price, no cup value.
    drink_value_inr: null,
    price_inr: null,
    max_per_day: null,
    gst_exempt: false,
    is_active: false,
    sort_order: 10,
    ...over,
  };
}

/** Fake with the unique index on lower(trim(name)) that coffee_pass_plans has. */
function freshAdmin(tables: Record<string, Row[]>, extraFail?: (c: Call) => DbError) {
  state.admin = makePassAdmin(tables, {
    fail: (c) => {
      if (c.table === 'coffee_pass_plans' && (c.op === 'insert' || c.op === 'update')) {
        const name = ((c.payload as Row).name as string | undefined)?.trim().toLowerCase();
        const id = c.filters.find((f) => f.col === 'id')?.val;
        if (name && (tables.coffee_pass_plans ?? []).some((p) => String(p.name).trim().toLowerCase() === name && p.id !== id)) {
          return { code: '23505', message: 'duplicate key value violates unique constraint "coffee_pass_plans_name_ci"' };
        }
      }
      return extraFail?.(c) ?? null;
    },
  });
  return state.admin;
}

const req = (method: string, url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  });

const asOwner = () => {
  state.owner = { id: OWNER };
};

beforeEach(() => {
  state.flag = true;
  state.owner = null;
  freshAdmin({});
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Every route: flag off = 404; not the owner = 403, whatever else the caller is
// ---------------------------------------------------------------------------

describe('gates', () => {
  const calls: [string, () => Promise<Response>][] = [
    ['GET /api/owner/passes', () => overviewRoute.GET()],
    ['POST /api/owner/passes/plans', () => plansRoute.POST(req('POST', '/api/owner/passes/plans', {}))],
    ['PATCH /api/owner/passes/plans/[id]', () => planRoute.PATCH(req('PATCH', `/api/owner/passes/plans/${PLAN_ID}`, {}), { params: { id: PLAN_ID } })],
    ['PUT /api/owner/passes/eligible', () => eligibleRoute.PUT(req('PUT', '/api/owner/passes/eligible', { menu_item_ids: [] }))],
    ['GET /api/owner/passes/summary', () => summaryRoute.GET(req('GET', '/api/owner/passes/summary'))],
  ];

  it.each(calls)('%s answers 404 while the flag is off, before any database work', async (_name, call) => {
    state.flag = false;
    asOwner();
    const res = await call();
    expect(res.status).toBe(404);
    expect(state.admin.calls).toEqual([]);
  });

  it.each(calls)('%s refuses anyone but the owner (403), even a PIN-unlocked owner on a counter device', async (_name, call) => {
    // getCounterActor() above returns an owner via a device; getOwnerUser() returns null.
    expect(state.owner).toBeNull();
    const res = await call();
    expect(res.status).toBe(403);
    expect(state.admin.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/owner/passes
// ---------------------------------------------------------------------------

describe('GET /api/owner/passes', () => {
  it('returns every plan (active or not), the eligible ids and the menu for the picker', async () => {
    asOwner();
    freshAdmin({
      coffee_pass_plans: [
        plan({ id: OTHER_PLAN, name: 'Monthly Ritual', drinks_paid: 6, validity_days: 30, sort_order: 20 }),
        plan(),
        plan({ id: '00000000-0000-4000-8000-0000000000a3', name: 'Mini Ritual', is_active: true }),
      ],
      menu_items: [
        { id: M3, name: 'Cold Brew', category: 'cold-brews', is_available: true, sort_order: 1, pass_eligible: true },
        { id: M2, name: 'Latte', category: 'coffee', is_available: false, sort_order: 2, pass_eligible: true },
        { id: M1, name: 'Cappuccino', category: 'coffee', is_available: true, sort_order: 1, pass_eligible: true },
        { id: M4, name: 'Croissant', category: 'bakes', is_available: true, sort_order: 1, pass_eligible: false },
      ],
    });
    const res = await overviewRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.plans.map((p: Row) => p.name)).toEqual(['Mini Ritual', 'Weekly Ritual', 'Monthly Ritual']);
    expect(body.plans.map((p: Row) => p.is_active)).toEqual([true, false, false]); // inactive ones included
    // No price and no cup value on a plan any more (CP-D24): both come back null.
    for (const p of body.plans) expect(p).toMatchObject({ price_inr: null, drink_value_inr: null });
    expect(body.eligible_ids).toEqual([M1, M2, M3]);
    expect(body.menu).toEqual([
      { id: M4, name: 'Croissant', category: 'bakes', is_available: true },
      { id: M1, name: 'Cappuccino', category: 'coffee', is_available: true },
      { id: M2, name: 'Latte', category: 'coffee', is_available: false },
      { id: M3, name: 'Cold Brew', category: 'cold-brews', is_available: true },
    ]);
  });

  it('names the migration when the tables are missing', async () => {
    asOwner();
    freshAdmin({}, (c) => (c.table === 'coffee_pass_plans' ? { code: '42P01', message: 'relation "coffee_pass_plans" does not exist' } : null));
    const res = await overviewRoute.GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('2026-10-coffee-pass.sql');
  });
});

// ---------------------------------------------------------------------------
// POST /api/owner/passes/plans
// ---------------------------------------------------------------------------

describe('POST /api/owner/passes/plans', () => {
  const create = (body: unknown) => plansRoute.POST(req('POST', '/api/owner/passes/plans', body));
  const valid = { name: 'Fortnight Ritual', drinks_total: 7, drinks_paid: 5, validity_days: 14 };

  it('rejects a body that is not JSON, and every invalid field (400), writing nothing', async () => {
    asOwner();
    const admin = freshAdmin({});
    expect((await plansRoute.POST(req('POST', '/api/owner/passes/plans', '{oops'))).status).toBe(400);
    for (const bad of [
      {},
      { ...valid, name: '' },
      { ...valid, name: 'x'.repeat(61) },
      { ...valid, drinks_total: 0 },
      { ...valid, drinks_total: 51 },
      { ...valid, drinks_paid: 8 }, // more paid for than given
      { ...valid, validity_days: 366 },
      { ...valid, max_per_day: 8 }, // more per day than the pass holds
      { ...valid, is_active: 'yes' },
      { ...valid, drinks_total: 7.5 },
    ]) {
      const res = await create(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toEqual(expect.any(String));
    }
    expect(admin.calls).toEqual([]);
  });

  it("refuses a price or a cup value (400 \"A Ritual's price now follows the drink the customer picks\"), writing nothing", async () => {
    asOwner();
    const admin = freshAdmin({});
    for (const extra of [{ price_inr: 750 }, { price_inr: 0 }, { price_inr: null }, { drink_value_inr: 150 }, { price_inr: 750, drink_value_inr: 150 }]) {
      const res = await create({ ...valid, ...extra });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("A Ritual's price now follows the drink the customer picks — plans have no price.");
    }
    expect(admin.calls).toEqual([]);
  });

  it('needs no price or cup value: creates an inactive plan with both columns left null (201 { plan })', async () => {
    asOwner();
    const admin = freshAdmin({});
    const res = await create(valid);
    expect(res.status).toBe(201);
    expect(admin.tables.coffee_pass_plans).toEqual([
      expect.objectContaining({
        name: 'Fortnight Ritual',
        description: '',
        drinks_total: 7,
        drinks_paid: 5,
        validity_days: 14,
        max_per_day: null,
        gst_exempt: false,
        is_active: false, // nothing is sold until the owner switches it on
        sort_order: 0,
      }),
    ]);
    // The insert never names either column: the database leaves them null.
    const inserted = admin.calls.find((c) => c.op === 'insert')?.payload as Row;
    expect(inserted).not.toHaveProperty('price_inr');
    expect(inserted).not.toHaveProperty('drink_value_inr');
    const { plan: created } = await res.json();
    expect(created).toEqual({
      id: 'coffee_pass_plans-1',
      name: 'Fortnight Ritual',
      description: '',
      drinks_total: 7,
      drinks_paid: 5,
      validity_days: 14,
      drink_value_inr: null,
      price_inr: null,
      max_per_day: null,
      gst_exempt: false,
      is_active: false,
      sort_order: 0,
    });
  });

  it('keeps an explicit cap, exemption, activation, description and order', async () => {
    asOwner();
    const admin = freshAdmin({});
    const res = await create({ ...valid, description: '  Two weeks  ', max_per_day: 1, gst_exempt: true, is_active: true, sort_order: 30 });
    expect(res.status).toBe(201);
    expect(admin.tables.coffee_pass_plans[0]).toMatchObject({
      description: 'Two weeks', max_per_day: 1, gst_exempt: true, is_active: true, sort_order: 30,
    });
  });

  it('answers 409 for a name already in use, whatever its case or spacing', async () => {
    asOwner();
    const admin = freshAdmin({ coffee_pass_plans: [plan()] });
    const res = await create({ ...valid, name: '  weekly RITUAL ' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('already exists');
    expect(admin.tables.coffee_pass_plans).toHaveLength(1);
  });

  it('answers 500 for any other failure, naming the migration when the schema is missing', async () => {
    asOwner();
    freshAdmin({}, (c) => (c.op === 'insert' ? { message: 'db down' } : null));
    const res = await create(valid);
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain('coffee-pass.sql');

    freshAdmin({}, (c) => (c.op === 'insert' ? { code: '42P01', message: 'relation "coffee_pass_plans" does not exist' } : null));
    expect((await (await create(valid)).json()).error).toContain('2026-10-coffee-pass.sql');
  });
});

// ---------------------------------------------------------------------------
// PATCH /api/owner/passes/plans/[id]
// ---------------------------------------------------------------------------

describe('PATCH /api/owner/passes/plans/[id]', () => {
  const patch = (body: unknown, id = PLAN_ID) =>
    planRoute.PATCH(req('PATCH', `/api/owner/passes/plans/${id}`, body), { params: { id } });
  const updates = () => state.admin.calls.filter((c) => c.op === 'update');

  it('answers 404 for an id that is not a plan id and for a plan that does not exist', async () => {
    asOwner();
    freshAdmin({ coffee_pass_plans: [plan()] });
    expect((await patch({ validity_days: 10 }, 'weekly')).status).toBe(404);
    expect((await patch({ validity_days: 10 }, '00000000-0000-4000-8000-0000000000ff')).status).toBe(404);
    expect(updates()).toEqual([]);
  });

  it('rejects a body that is not JSON, an empty edit and invalid fields (400), writing nothing', async () => {
    asOwner();
    freshAdmin({ coffee_pass_plans: [plan()] });
    expect((await planRoute.PATCH(req('PATCH', `/api/owner/passes/plans/${PLAN_ID}`, '{oops'), { params: { id: PLAN_ID } })).status).toBe(400);
    for (const bad of [{}, { unknown: 1 }, { name: '' }, { validity_days: -5 }, { drinks_total: 0 }, { is_active: 'yes' }, { max_per_day: 0 }]) {
      expect((await patch(bad)).status).toBe(400);
    }
    expect(updates()).toEqual([]);
  });

  it("refuses a price or a cup value (400 \"A Ritual's price now follows the drink the customer picks\"), even alone or mixed with a valid edit", async () => {
    asOwner();
    freshAdmin({ coffee_pass_plans: [plan()] });
    for (const bad of [
      { price_inr: 800 },
      { price_inr: null },
      { drink_value_inr: 120 },
      { price_inr: 800, is_active: true },
      { name: 'Weekly', drink_value_inr: 120 },
    ]) {
      const res = await patch(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("A Ritual's price now follows the drink the customer picks — plans have no price.");
    }
    expect(updates()).toEqual([]);
  });

  it('edits only the fields sent and returns the plan', async () => {
    asOwner();
    const admin = freshAdmin({ coffee_pass_plans: [plan()] });
    const res = await patch({ validity_days: 10, is_active: true });
    expect(res.status).toBe(200);
    expect((await res.json()).plan).toEqual({ ...plan(), validity_days: 10, is_active: true });
    expect(admin.tables.coffee_pass_plans[0]).toMatchObject({ validity_days: 10, is_active: true, drinks_total: 7, name: 'Weekly Ritual' });
    expect(updates()[0].payload).toEqual({ validity_days: 10, is_active: true });
    // ...and the plan stays priceless.
    expect(admin.tables.coffee_pass_plans[0]).toMatchObject({ price_inr: null, drink_value_inr: null });
  });

  it('deactivates a plan, and clears a daily cap with null', async () => {
    asOwner();
    const admin = freshAdmin({ coffee_pass_plans: [plan({ is_active: true, max_per_day: 1 })] });
    expect((await patch({ is_active: false, max_per_day: null })).status).toBe(200);
    expect(admin.tables.coffee_pass_plans[0]).toMatchObject({ is_active: false, max_per_day: null });
  });

  describe('cross-field rules against the stored plan (7 cups, 5 paid, daily cap 3)', () => {
    const stored = () => freshAdmin({ coffee_pass_plans: [plan({ max_per_day: 3 })] });

    it('refuses fewer cups than are paid for when only drinks_total is sent', async () => {
      asOwner();
      stored();
      const res = await patch({ drinks_total: 4 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Cups paid for');
      expect(updates()).toEqual([]);
    });

    it('refuses more cups paid for than the pass holds when only drinks_paid is sent', async () => {
      asOwner();
      stored();
      const res = await patch({ drinks_paid: 8 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Cups paid for');
    });

    it('refuses a daily limit above the cups in the pass when only max_per_day is sent', async () => {
      asOwner();
      stored();
      const res = await patch({ max_per_day: 8 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Daily limit');
    });

    it('refuses shrinking the pass below the stored daily limit when only drinks_total is sent', async () => {
      asOwner();
      // 10 cups, 5 paid, at most 6 a day: shrinking to 5 cups keeps "paid <= total" but breaks the cap.
      freshAdmin({ coffee_pass_plans: [plan({ drinks_total: 10, drinks_paid: 5, max_per_day: 6 })] });
      const res = await patch({ drinks_total: 5 });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain('Daily limit');
    });

    it('accepts an edit that keeps both rules', async () => {
      asOwner();
      const admin = stored();
      expect((await patch({ drinks_total: 10 })).status).toBe(200);
      expect((await patch({ drinks_paid: 7 })).status).toBe(200);
      expect((await patch({ max_per_day: 7 })).status).toBe(200);
      expect(admin.tables.coffee_pass_plans[0]).toMatchObject({ drinks_total: 10, drinks_paid: 7, max_per_day: 7 });
    });
  });

  it('answers 409 when the new name is already another plan’s', async () => {
    asOwner();
    const admin = freshAdmin({ coffee_pass_plans: [plan(), plan({ id: OTHER_PLAN, name: 'Monthly Ritual' })] });
    const res = await patch({ name: 'monthly ritual' });
    expect(res.status).toBe(409);
    expect(admin.tables.coffee_pass_plans[0].name).toBe('Weekly Ritual');
  });

  it('lets a plan keep its own name (a rename to the same words is not a clash)', async () => {
    asOwner();
    freshAdmin({ coffee_pass_plans: [plan()] });
    expect((await patch({ name: 'weekly ritual', description: 'x' })).status).toBe(200);
  });

  it('answers 500 for a failed write and names the migration when the schema is missing', async () => {
    asOwner();
    freshAdmin({ coffee_pass_plans: [plan()] }, (c) => (c.op === 'update' ? { message: 'db down' } : null));
    expect((await patch({ validity_days: 10 })).status).toBe(500);
    freshAdmin({ coffee_pass_plans: [plan()] }, (c) => (c.op === 'select' ? { code: '42P01', message: 'relation does not exist' } : null));
    const res = await patch({ validity_days: 10 });
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('2026-10-coffee-pass.sql');
  });
});

// ---------------------------------------------------------------------------
// PUT /api/owner/passes/eligible
// ---------------------------------------------------------------------------

describe('PUT /api/owner/passes/eligible', () => {
  const put = (body: unknown) => eligibleRoute.PUT(req('PUT', '/api/owner/passes/eligible', body));
  const menu = () => [
    { id: M1, name: 'Cappuccino', pass_eligible: true },
    { id: M2, name: 'Latte', pass_eligible: true },
    { id: M3, name: 'Cold Brew', pass_eligible: false },
    { id: M4, name: 'Croissant', pass_eligible: false },
  ];
  const eligibleNow = () => state.admin.tables.menu_items.filter((m) => m.pass_eligible === true).map((m) => m.id);
  const writes = () => state.admin.calls.filter((c) => c.op === 'update');

  it('rejects a body that is not JSON, a missing or non-array list and ids that are not ids (400)', async () => {
    asOwner();
    freshAdmin({ menu_items: menu() });
    expect((await eligibleRoute.PUT(req('PUT', '/api/owner/passes/eligible', '{oops'))).status).toBe(400);
    expect((await put({})).status).toBe(400);
    expect((await put({ menu_item_ids: M1 })).status).toBe(400);
    expect((await put({ menu_item_ids: [M1, 'latte'] })).status).toBe(400);
    expect((await put({ menu_item_ids: [M1, 7] })).status).toBe(400);
    expect(writes()).toEqual([]);
  });

  it('rejects more than 500 ids (400) and accepts exactly 500 duplicates of one id', async () => {
    asOwner();
    freshAdmin({ menu_items: menu() });
    expect((await put({ menu_item_ids: Array.from({ length: 501 }, () => M1) })).status).toBe(400);
    expect((await put({ menu_item_ids: Array.from({ length: 500 }, () => M1) })).status).toBe(200); // deduped to one
  });

  it('refuses an id that is not on the menu (400) and changes nothing', async () => {
    asOwner();
    freshAdmin({ menu_items: menu() });
    const res = await put({ menu_item_ids: [M3, '00000000-0000-4000-8000-0000000000ff'] });
    expect(res.status).toBe(400);
    expect(writes()).toEqual([]);
    expect(eligibleNow()).toEqual([M1, M2]);
  });

  it('REPLACES the set: listed items become eligible, every other stops being', async () => {
    asOwner();
    freshAdmin({ menu_items: menu() });
    const res = await put({ menu_item_ids: [M2, M3] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligible_ids: [M2, M3] });
    expect(state.admin.tables.menu_items.map((m) => [m.id, m.pass_eligible])).toEqual([
      [M1, false],
      [M2, true],
      [M3, true],
      [M4, false],
    ]);
  });

  it('writes only the rows that change, un-ticks first (a failed write can only shrink the set)', async () => {
    asOwner();
    freshAdmin({ menu_items: menu() });
    await put({ menu_item_ids: [M2, M3] });
    expect(writes().map((c) => [c.payload, (c.filters[0].val as string[])])).toEqual([
      [{ pass_eligible: false }, [M1]],
      [{ pass_eligible: true }, [M3]],
    ]); // M2 was already eligible: not touched
  });

  it('deduplicates the list and accepts ids in upper case', async () => {
    asOwner();
    freshAdmin({ menu_items: menu() });
    const res = await put({ menu_item_ids: [M3, M3.toUpperCase(), M3] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligible_ids: [M3] });
    expect(eligibleNow()).toEqual([M3]);
  });

  it('an empty list makes nothing eligible', async () => {
    asOwner();
    freshAdmin({ menu_items: menu() });
    const res = await put({ menu_item_ids: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eligible_ids: [] });
    expect(eligibleNow()).toEqual([]);
  });

  it('is idempotent: the same list again writes nothing', async () => {
    asOwner();
    freshAdmin({ menu_items: menu() });
    await put({ menu_item_ids: [M1, M3] });
    state.admin.calls.length = 0;
    expect((await put({ menu_item_ids: [M1, M3] })).status).toBe(200);
    expect(writes()).toEqual([]);
  });

  it('leaves the set smaller, never larger, when the enabling write fails half way', async () => {
    asOwner();
    freshAdmin({ menu_items: menu() }, (c) => (c.op === 'update' && (c.payload as Row).pass_eligible === true ? { message: 'db down' } : null));
    const res = await put({ menu_item_ids: [M3, M4] });
    expect(res.status).toBe(500);
    expect(eligibleNow()).toEqual([]); // M1 and M2 un-ticked, M3 and M4 not yet ticked
  });

  it('splits a long list into small filters so the request URL stays short', async () => {
    asOwner();
    const many = Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    freshAdmin({ menu_items: many.map((id) => ({ id, name: id, pass_eligible: false })) });
    const res = await put({ menu_item_ids: many });
    expect(res.status).toBe(200);
    expect((await res.json()).eligible_ids).toHaveLength(250);
    expect(writes().map((c) => (c.filters[0].val as string[]).length)).toEqual([100, 100, 50]);
  });
});

// ---------------------------------------------------------------------------
// GET /api/owner/passes/summary
// ---------------------------------------------------------------------------

describe('GET /api/owner/passes/summary', () => {
  // 2026-10-15 10:00 IST
  const NOW = new Date('2026-10-15T04:30:00Z');
  const summary = (query = '') => summaryRoute.GET(req('GET', `/api/owner/passes/summary${query}`));
  const pass = (over: Row): Row => ({
    user_id: 'u-1', plan_name: 'Weekly Ritual', drinks_total: 7, drinks_remaining: 7, price_inr: 750, status: 'active',
    expires_at: '2026-10-22T18:30:00.000Z', created_at: '2026-10-01T05:00:00.000Z', ...over,
  });

  const tables = (): Record<string, Row[]> => ({
    v_coffee_pass_balances: [
      pass({ id: 'w1', user_id: 'u-1' }), // active, 7 cups, ₹750
      pass({ id: 'w2', user_id: 'u-2', drinks_remaining: 5, created_at: '2026-10-02T05:00:00.000Z', expires_at: '2026-10-08T18:30:00.000Z' }), // expired with 5 cups left
      pass({ id: 'w3', user_id: 'u-3', status: 'refunded', created_at: '2026-10-03T05:00:00.000Z', expires_at: '2026-10-10T18:30:00.000Z' }),
      pass({ id: 'm1', user_id: 'u-4', plan_name: 'Monthly Ritual', price_inr: 900, drinks_remaining: 6, created_at: '2026-10-04T05:00:00.000Z', expires_at: '2026-11-03T18:30:00.000Z' }),
      pass({ id: 'old', user_id: 'u-5', created_at: '2026-08-01T05:00:00.000Z', expires_at: '2026-08-08T18:30:00.000Z' }),
    ],
    coffee_pass_redemptions: [
      { id: 'r1', drinks: 2, covered_inr: 270, created_at: '2026-10-05T05:00:00.000Z', reversed_at: null },
      { id: 'r2', drinks: 1, covered_inr: 150, created_at: '2026-10-06T05:00:00.000Z', reversed_at: null },
      { id: 'r3', drinks: 1, covered_inr: 100, created_at: '2026-10-06T06:00:00.000Z', reversed_at: '2026-10-06T07:00:00.000Z' },
      { id: 'r4', drinks: 1, covered_inr: 100, created_at: '2026-08-20T05:00:00.000Z', reversed_at: null },
    ],
    profiles: [
      { id: 'u-1', name: 'Asha K', phone: '+919876543210' },
      { id: 'u-4', name: 'Meera', phone: '+919123456789' },
    ],
  });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    asOwner();
  });

  it('defaults to the last 30 days including today, and computes every number', async () => {
    freshAdmin(tables());
    const res = await summary();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.range).toEqual({ from: '2026-09-16', to: '2026-10-15' });
    expect(body.sold).toEqual({ count: 3, inr: 2400 });
    expect(body.sold_by_plan).toEqual([
      { plan_name: 'Weekly Ritual', count: 2, inr: 1500 },
      { plan_name: 'Monthly Ritual', count: 1, inr: 900 },
    ]);
    expect(body.refunded).toEqual({ count: 1, inr: 750 });
    // w1: 7 cups = 750; m1: 6 cups x 900/7 = 771.43. Total 1521.43.
    expect(body.active).toEqual({ passes: 2, cups_outstanding: 13, liability_inr: 1521 });
    // r1 + r2; r3 was reversed and r4 is out of range.
    expect(body.redeemed).toEqual({ cups: 3, covered_inr: 420 });
    // w2 lapsed on 9 Oct with 5 cups left: 5 x 750/7 = 535.71.
    expect(body.expired_unused).toEqual({ cups: 5, inr: 536 });
  });

  it('reads the given IST range and echoes it', async () => {
    freshAdmin(tables());
    const body = await (await summary('?from=2026-10-02&to=2026-10-03')).json();
    expect(body.range).toEqual({ from: '2026-10-02', to: '2026-10-03' });
    expect(body.sold).toEqual({ count: 1, inr: 750 }); // w2 (w3 is refunded)
    expect(body.refunded).toEqual({ count: 1, inr: 750 });
    expect(body.redeemed).toEqual({ cups: 0, covered_inr: 0 });
    // Active is as of now, whatever the range.
    expect(body.active.passes).toBe(2);
    // The window was handed to the database as IST midnights.
    const createdFilter = state.admin.calls.find((c) => c.table === 'v_coffee_pass_balances' && c.filters.some((f) => f.col === 'created_at' && f.op === 'gte'));
    expect(createdFilter?.filters).toEqual(
      expect.arrayContaining([
        { op: 'gte', col: 'created_at', val: '2026-10-01T18:30:00.000Z' },
        { op: 'lt', col: 'created_at', val: '2026-10-03T18:30:00.000Z' },
      ]),
    );
  });

  it('lists the newest passes with the holder and only the last four digits of their number', async () => {
    freshAdmin(tables());
    const body = await (await summary()).json();
    expect(body.recent.map((r: Row) => r.id)).toEqual(['m1', 'w3', 'w2', 'w1', 'old']);
    expect(body.recent[0]).toEqual({
      id: 'm1',
      holder_name: 'Meera',
      holder_phone_masked: '••••••6789',
      plan_name: 'Monthly Ritual',
      created_at: '2026-10-04T05:00:00.000Z',
      drinks_total: 7,
      drinks_remaining: 6,
      expires_at: '2026-11-03T18:30:00.000Z',
      state: 'active',
    });
    // A holder with no profile row is still a row.
    expect(body.recent.find((r: Row) => r.id === 'w2')).toMatchObject({ holder_name: 'Customer', holder_phone_masked: '' });
    const text = JSON.stringify(body);
    expect(text).not.toContain('9876543210');
    expect(text).not.toContain('9123456789');
    expect(text).not.toContain('user_id');
    expect(text).not.toContain('u-1');
  });

  it('limits recent to the 20 newest passes', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      pass({ id: `p-${i}`, created_at: `2026-10-05T05:${String(i).padStart(2, '0')}:00.000Z` }),
    );
    freshAdmin({ v_coffee_pass_balances: many });
    const body = await (await summary()).json();
    expect(body.recent).toHaveLength(20);
    expect(body.recent[0].id).toBe('p-24');
  });

  it('reads more than one page of rows (the database answers 1000 at a time)', async () => {
    const redemptions = Array.from({ length: 2500 }, (_, i) => ({
      id: `r-${i}`, drinks: 1, covered_inr: 10, created_at: '2026-10-05T05:00:00.000Z', reversed_at: null,
    }));
    freshAdmin({ coffee_pass_redemptions: redemptions });
    const body = await (await summary()).json();
    expect(body.redeemed).toEqual({ cups: 2500, covered_inr: 25000 });
  });

  it('is all zeros with no passes at all', async () => {
    freshAdmin({});
    const body = await (await summary()).json();
    expect(body).toEqual({
      range: { from: '2026-09-16', to: '2026-10-15' },
      sold: { count: 0, inr: 0 },
      sold_by_plan: [],
      refunded: { count: 0, inr: 0 },
      active: { passes: 0, cups_outstanding: 0, liability_inr: 0 },
      redeemed: { cups: 0, covered_inr: 0 },
      expired_unused: { cups: 0, inr: 0 },
      recent: [],
    });
  });

  it('rejects dates that are not real, a start after the end, an end in the future and a window over a year (400)', async () => {
    freshAdmin(tables());
    for (const query of [
      '?from=2026-02-30',
      '?to=tomorrow',
      '?from=2026-10-10&to=2026-10-05',
      '?to=2026-10-16', // the 16th has not happened (it is the 15th, IST)
      '?from=2025-10-14&to=2026-10-15', // 367 days
    ]) {
      const res = await summary(query);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toEqual(expect.any(String));
    }
    expect(state.admin.calls).toEqual([]);
  });

  it('answers 500, naming the migration when the schema is missing', async () => {
    freshAdmin({}, (c) => (c.table === 'v_coffee_pass_balances' ? { code: '42P01', message: 'relation "v_coffee_pass_balances" does not exist' } : null));
    const res = await summary();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('2026-10-coffee-pass.sql');
  });
});
