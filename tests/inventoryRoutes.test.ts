import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level tests for /api/inventory/** (docs/INVENTORY-SPEC.md). What
// they guard: the flag and the counter-actor gate, that each step of a stock
// request is taken only by the person the rules allow (assign = manager,
// pick = assignee, receive = at the POS by someone other than the picker),
// that expiry dates are demanded before anything reaches the database, and
// that each write goes through its atomic database function with the right
// arguments, and that the recipe editor is sent an add-on's GENERAL lines
// only (the recipe book's per-item / per-size lines are counted, not sent).
// The Supabase admin client is a small in-memory fake. It behaves like
// PostgREST where that matters: it supports .range(), and it answers at most
// MAX_ROWS rows to any one request (Supabase's default "max rows"), so a read
// that forgets to page comes back short, as it would against the real API.

const MANAGER = '00000000-0000-4000-8000-000000000001';
const ASHA = '00000000-0000-4000-8000-000000000002'; // requester
const VIKRAM = '00000000-0000-4000-8000-000000000003'; // picker
const MEERA = '00000000-0000-4000-8000-000000000004'; // verifier at the POS
const REQ = '00000000-0000-4000-8000-0000000000a1';
const MILK = '00000000-0000-4000-8000-0000000000b1';
const CUPS = '00000000-0000-4000-8000-0000000000b2';
const DEVICE = '00000000-0000-4000-8000-0000000000d1';

type Row = Record<string, unknown>;

const state: {
  flag: boolean;
  actor: { user: { id: string }; role: string; via: string } | null;
  device: { id: string } | null;
  request: Row | null;
  items: Row[];
  profiles: Row[];
  /** Any other table the routes read (menu_items, recipe_lines, …). */
  tables: Record<string, Row[]>;
  rpcCalls: { name: string; args: Row }[];
  rpcResult: { data: unknown; error: { message: string; code?: string } | null };
  updates: { table: string; patch: Row; filters: [string, string, unknown][] }[];
  menuEdit: boolean;
  /** Make the ranged read of `table` that starts at row `from` fail (a later page). */
  failRange: { table: string; from: number } | null;
} = {
  flag: true,
  actor: null,
  device: null,
  request: null,
  items: [],
  profiles: [],
  tables: {},
  rpcCalls: [],
  rpcResult: { data: null, error: null },
  updates: [],
  menuEdit: true,
  failRange: null,
};

/** PostgREST's default cap on the rows one request returns. */
const MAX_ROWS = 1000;

vi.mock('@/lib/flags', () => ({
  flags: new Proxy({}, { get: (_t, key) => (key === 'inventory' ? state.flag : true) }),
}));
vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/api/device', () => ({ getEnrolledDevice: () => Promise.resolve(state.device) }));
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve(state.device ? 'pos' : 'web') }));
vi.mock('@/lib/staff/displayName', () => ({ getStaffDisplayNames: () => Promise.resolve(new Map()) }));
vi.mock('@/lib/cash/date', () => ({ istBusinessDate: () => '2026-09-26' }));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(state.menuEdit) }));
const { sendStockAssignedEmail } = vi.hoisted(() => ({
  sendStockAssignedEmail: vi.fn((_admin: unknown, _args: Record<string, unknown>) =>
    Promise.resolve({ kind: 'stock_assigned', status: 'sent', detail: '' }),
  ),
}));
vi.mock('@/lib/inventory/notify', () => ({ sendStockAssignedEmail }));

function makeAdmin() {
  return {
    rpc: (name: string, args: Row) => {
      state.rpcCalls.push({ name, args });
      return Promise.resolve(state.rpcResult);
    },
    from: (table: string) => {
      const filters: [string, string, unknown][] = [];
      let patch: Row | null = null;
      let ordered = false;
      let window: [number, number] | null = null;
      const rows = (): Row[] => {
        if (table === 'stock_requests') return state.tables.stock_requests ?? (state.request ? [state.request] : []);
        if (table === 'inventory_items') return state.items;
        if (table === 'profiles') return state.profiles;
        return state.tables[table] ?? [];
      };
      const matching = () =>
        rows().filter((r) =>
          filters.every(([op, col, val]) =>
            op === 'eq'
              ? r[col] === val
              : op === 'in'
                ? (val as unknown[]).includes(r[col])
                : op === 'is-null'
                  ? r[col] === null || r[col] === undefined
                  : op === 'not-null'
                    ? r[col] !== null && r[col] !== undefined
                    : true,
          ),
        );
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => {
          ordered = true;
          return chain;
        },
        limit: () => chain,
        // Offset paging repeats or skips rows unless the sort is fixed, so a
        // .range() with no .order() is a bug the fake refuses to serve.
        range: (from: number, to: number) => {
          if (!ordered) throw new Error(`fake admin: ${table} .range() without .order() would page unstably`);
          window = [from, to];
          return chain;
        },
        gt: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push(['eq', col, val]);
          return chain;
        },
        in: (col: string, val: unknown[]) => {
          filters.push(['in', col, val]);
          return chain;
        },
        // .is(col, null) and .not(col, 'is', null) — the only forms the routes use.
        is: (col: string, val: unknown) => {
          if (val !== null) throw new Error('fake admin: .is() is only faked for null');
          filters.push(['is-null', col, val]);
          return chain;
        },
        not: (col: string, op: string, val: unknown) => {
          if (op !== 'is' || val !== null) throw new Error('fake admin: .not() is only faked for is null');
          filters.push(['not-null', col, val]);
          return chain;
        },
        update: (p: Row) => {
          patch = p;
          return chain;
        },
        maybeSingle: () => {
          const hit = matching()[0] ?? null;
          if (patch) {
            state.updates.push({ table, patch, filters: [...filters] });
            if (hit) Object.assign(hit, patch);
          }
          return Promise.resolve({ data: hit, error: null });
        },
        then: (resolve: (v: unknown) => void) => {
          if (patch) state.updates.push({ table, patch, filters: [...filters] });
          if (state.failRange && state.failRange.table === table && window?.[0] === state.failRange.from) {
            resolve({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } });
            return;
          }
          // No .range(): the whole answer, cut at MAX_ROWS like PostgREST.
          const [from, to] = window ?? [0, MAX_ROWS - 1];
          resolve({ data: matching().slice(from, Math.min(to + 1, from + MAX_ROWS)), error: null });
        },
      };
      return chain;
    },
  };
}
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => makeAdmin() }));

const requestsRoute = await import('@/app/api/inventory/requests/route');
const requestRoute = await import('@/app/api/inventory/requests/[id]/route');
const receiptsRoute = await import('@/app/api/inventory/receipts/route');
const settingsRoute = await import('@/app/api/inventory/settings/route');
const addonRoute = await import('@/app/api/inventory/addon-recipes/[optionId]/route');
const recipesRoute = await import('@/app/api/inventory/recipes/route');
const itemsRoute = await import('@/app/api/inventory/items/route');

const as = (id: string, role = 'staff') => ({ user: { id }, role, via: 'session' });

function json(url: string, method: string, body: unknown) {
  return new Request(`http://t${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const patch = (body: unknown) => requestRoute.PATCH(json(`/api/inventory/requests/${REQ}`, 'PATCH', body), { params: { id: REQ } });

beforeEach(() => {
  state.flag = true;
  state.actor = null;
  state.device = null;
  state.items = [
    { id: MILK, name: 'Milk', tracks_expiry: true, is_active: true },
    { id: CUPS, name: 'Cups', tracks_expiry: false, is_active: true },
  ];
  state.tables = {};
  state.failRange = null;
  state.profiles = [
    { id: MANAGER, name: 'Boss', role: 'manager' },
    { id: ASHA, name: 'Asha', role: 'staff' },
    { id: VIKRAM, name: 'Vikram', role: 'staff' },
    { id: MEERA, name: 'Meera', role: 'staff' },
  ];
  state.request = {
    id: REQ,
    status: 'requested',
    requested_by: ASHA,
    assigned_to: null,
    picked_by: null,
    stock_request_lines: [{ item_id: MILK }, { item_id: CUPS }],
  };
  state.rpcCalls = [];
  state.rpcResult = { data: null, error: null };
  state.updates = [];
  state.menuEdit = true;
  sendStockAssignedEmail.mockClear();
});

describe('gate', () => {
  it('401s without a counter actor', async () => {
    expect((await requestsRoute.POST(json('/api/inventory/requests', 'POST', { lines: [] }))).status).toBe(401);
  });

  it('404s everything while the inventory flag is off', async () => {
    state.flag = false;
    state.actor = as(ASHA);
    expect((await patch({ action: 'cancel' })).status).toBe(404);
  });
});

describe('POST /api/inventory/requests — the Request stock button', () => {
  it('lets any staffer request, through the atomic function', async () => {
    state.actor = as(ASHA);
    state.rpcResult = { data: REQ, error: null };
    const res = await requestsRoute.POST(
      json('/api/inventory/requests', 'POST', { lines: [{ itemId: MILK, qty: '10' }], note: ' before 5pm ' }),
    );
    expect(res.status).toBe(201);
    expect(state.rpcCalls).toEqual([
      { name: 'inventory_create_request', args: { p_actor: ASHA, p_note: 'before 5pm', p_lines: [{ item_id: MILK, qty: 10 }] } },
    ]);
  });

  it('400s an empty request without touching the database', async () => {
    state.actor = as(ASHA);
    const res = await requestsRoute.POST(json('/api/inventory/requests', 'POST', { lines: [] }));
    expect(res.status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
  });

  it('shows the database function’s own refusal as a 409', async () => {
    state.actor = as(ASHA);
    state.rpcResult = { data: null, error: { message: 'inventory: one of those items is no longer stocked' } };
    const res = await requestsRoute.POST(json('/api/inventory/requests', 'POST', { lines: [{ itemId: MILK, qty: 1 }] }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'One of those items is no longer stocked' });
  });
});

describe('assign', () => {
  it('403s a plain staffer', async () => {
    state.actor = as(ASHA);
    expect((await patch({ action: 'assign', assigneeId: VIKRAM })).status).toBe(403);
  });

  it('lets a manager assign an active team member, status-guarded', async () => {
    state.actor = as(MANAGER, 'manager');
    const res = await patch({ action: 'assign', assigneeId: VIKRAM });
    expect(res.status).toBe(200);
    const u = state.updates[0];
    expect(u.patch).toMatchObject({ status: 'assigned', assigned_to: VIKRAM, assigned_by: MANAGER });
    expect(u.filters).toContainEqual(['in', 'status', ['requested', 'assigned']]);
  });

  it('emails the picker, and says so', async () => {
    state.actor = as(MANAGER, 'manager');
    const res = await patch({ action: 'assign', assigneeId: VIKRAM });
    expect(await res.json()).toEqual({ ok: true, emailed: 'sent' });
    expect(sendStockAssignedEmail).toHaveBeenCalledWith(expect.anything(), {
      requestId: REQ,
      assigneeId: VIKRAM,
      assignedByName: 'Boss',
    });
  });

  it('does not email a manager who assigns it to themselves', async () => {
    state.actor = as(MANAGER, 'manager');
    const res = await patch({ action: 'assign', assigneeId: MANAGER });
    expect(await res.json()).toEqual({ ok: true, emailed: 'skipped' });
    expect(sendStockAssignedEmail).not.toHaveBeenCalled();
  });

  it('refuses someone who is not on the active team', async () => {
    state.actor = as(MANAGER, 'manager');
    state.profiles = state.profiles.filter((p) => p.id !== VIKRAM);
    expect((await patch({ action: 'assign', assigneeId: VIKRAM })).status).toBe(400);
    expect(state.updates).toEqual([]);
  });
});

describe('pick', () => {
  beforeEach(() => {
    Object.assign(state.request!, { status: 'assigned', assigned_to: VIKRAM });
  });

  it('403s anyone but the assignee', async () => {
    state.actor = as(MEERA);
    expect((await patch({ action: 'pick', lines: [{ itemId: MILK, qty: 1 }, { itemId: CUPS, qty: 1 }] })).status).toBe(403);
  });

  it('400s a pick that skips a line', async () => {
    state.actor = as(VIKRAM);
    expect((await patch({ action: 'pick', lines: [{ itemId: MILK, qty: 1 }] })).status).toBe(400);
  });

  it('records the assignee’s pick through inventory_pick', async () => {
    state.actor = as(VIKRAM);
    const res = await patch({ action: 'pick', lines: [{ itemId: MILK, qty: 10 }, { itemId: CUPS, qty: 0 }] });
    expect(res.status).toBe(200);
    expect(state.rpcCalls[0]).toEqual({
      name: 'inventory_pick',
      args: {
        p_request_id: REQ,
        p_actor: VIKRAM,
        p_is_manager: false,
        p_lines: [
          { item_id: MILK, qty: 10 },
          { item_id: CUPS, qty: 0 },
        ],
      },
    });
  });
});

describe('receive — verified at the POS', () => {
  const lines = [
    { itemId: MILK, qty: 8, expiryDate: '2026-10-05' },
    { itemId: CUPS, qty: 100 },
  ];
  beforeEach(() => {
    Object.assign(state.request!, { status: 'picked', assigned_to: VIKRAM, picked_by: VIKRAM });
  });

  it('403s on the staff website', async () => {
    state.actor = as(MEERA);
    const res = await patch({ action: 'receive', lines });
    expect(res.status).toBe(403);
    expect(state.rpcCalls).toEqual([]);
  });

  it('403s the picker verifying their own pick', async () => {
    state.actor = as(VIKRAM);
    state.device = { id: DEVICE };
    expect((await patch({ action: 'receive', lines })).status).toBe(403);
  });

  it('400s a perishable without an expiry date', async () => {
    state.actor = as(MEERA);
    state.device = { id: DEVICE };
    const res = await patch({ action: 'receive', lines: [{ itemId: MILK, qty: 8 }, { itemId: CUPS, qty: 100 }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Enter the expiry date for Milk.' });
    expect(state.rpcCalls).toEqual([]);
  });

  it('receives through inventory_receive with the device, and reports a discrepancy', async () => {
    state.actor = as(MEERA);
    state.device = { id: DEVICE };
    state.rpcResult = { data: { batches: 2, has_discrepancy: true }, error: null };
    const res = await patch({ action: 'receive', lines });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, hasDiscrepancy: true });
    expect(state.rpcCalls[0]).toEqual({
      name: 'inventory_receive',
      args: {
        p_request_id: REQ,
        p_actor: MEERA,
        p_device_id: DEVICE,
        p_lines: [
          { item_id: MILK, qty: 8, expiry_date: '2026-10-05' },
          { item_id: CUPS, qty: 100, expiry_date: null },
        ],
      },
    });
  });
});

describe('cancel', () => {
  it('lets the requester withdraw an unassigned request without a reason', async () => {
    state.actor = as(ASHA);
    expect((await patch({ action: 'cancel' })).status).toBe(200);
    expect(state.updates[0].patch).toMatchObject({ status: 'cancelled', cancelled_by: ASHA });
    expect(state.updates[0].filters).toContainEqual(['in', 'status', ['requested']]);
  });

  it('needs a reason from a manager cancelling someone else’s request', async () => {
    state.actor = as(MANAGER, 'manager');
    Object.assign(state.request!, { status: 'assigned', assigned_to: VIKRAM });
    expect((await patch({ action: 'cancel' })).status).toBe(400);
    expect((await patch({ action: 'cancel', reason: 'ordered twice' })).status).toBe(200);
  });
});

describe('POST /api/inventory/receipts — a delivery with no request', () => {
  const body = { lines: [{ itemId: MILK, qty: 5, expiryDate: '2026-10-01' }] };

  it('is for a manager', async () => {
    state.actor = as(MEERA);
    state.device = { id: DEVICE };
    expect((await receiptsRoute.POST(json('/api/inventory/receipts', 'POST', body))).status).toBe(403);
  });

  it('is at the POS only', async () => {
    state.actor = as(MANAGER, 'manager');
    expect((await receiptsRoute.POST(json('/api/inventory/receipts', 'POST', body))).status).toBe(403);
  });

  it('receives with no request id', async () => {
    state.actor = as(MANAGER, 'manager');
    state.device = { id: DEVICE };
    const res = await receiptsRoute.POST(json('/api/inventory/receipts', 'POST', body));
    expect(res.status).toBe(201);
    expect(state.rpcCalls[0]).toEqual({
      name: 'inventory_receive',
      args: { p_request_id: null, p_actor: MANAGER, p_device_id: DEVICE, p_lines: [{ item_id: MILK, qty: 5, expiry_date: '2026-10-01' }] },
    });
  });
});

describe('PATCH /api/inventory/settings — auto-hide switch', () => {
  const body = (b: unknown) => json('/api/inventory/settings', 'PATCH', b);

  it('is for a manager', async () => {
    state.actor = as(ASHA);
    expect((await settingsRoute.PATCH(body({ autoHide: false }))).status).toBe(403);
  });

  it('saves the switch and re-checks the menu at once', async () => {
    state.actor = as(MANAGER, 'manager');
    const res = await settingsRoute.PATCH(body({ autoHide: false }));
    expect(res.status).toBe(200);
    expect(state.updates[0]).toMatchObject({ table: 'store_settings', patch: { stock_auto_hide: false } });
    expect(state.rpcCalls.map((c) => c.name)).toEqual(['inventory_refresh_availability']);
  });

  it('400s anything but a boolean', async () => {
    state.actor = as(MANAGER, 'manager');
    expect((await settingsRoute.PATCH(body({ autoHide: 'no' }))).status).toBe(400);
  });
});

describe('PUT /api/inventory/addon-recipes/[optionId]', () => {
  const OPTION = '00000000-0000-4000-8000-0000000000e1';
  const put = (b: unknown) =>
    addonRoute.PUT(json(`/api/inventory/addon-recipes/${OPTION}`, 'PUT', b), { params: { optionId: OPTION } });

  it('needs the menu_edit permission', async () => {
    state.actor = as(ASHA);
    state.device = { id: DEVICE };
    state.menuEdit = false;
    expect((await put({ lines: [] })).status).toBe(403);
  });

  it('is edited on the POS only', async () => {
    state.actor = as(ASHA);
    expect((await put({ lines: [] })).status).toBe(403);
  });

  it('saves through inventory_set_addon_recipe', async () => {
    state.actor = as(ASHA);
    state.device = { id: DEVICE };
    state.rpcResult = { data: 1, error: null };
    const res = await put({ lines: [{ itemId: CUPS, qty: 1 }] });
    expect(res.status).toBe(200);
    expect(state.rpcCalls[0]).toEqual({
      name: 'inventory_set_addon_recipe',
      args: { p_option_id: OPTION, p_actor: ASHA, p_lines: [{ item_id: CUPS, qty: 1 }] },
    });
  });
});

describe('GET /api/inventory/recipes — add-on scopes', () => {
  const LATTE = '00000000-0000-4000-8000-0000000000c1';
  const ESPRESSO = '00000000-0000-4000-8000-0000000000c2';
  const SUGAR = '00000000-0000-4000-8000-0000000000e2'; // has a general recipe and two scoped ones
  const OAT = '00000000-0000-4000-8000-0000000000e3'; // scoped lines only
  const DECAF = '00000000-0000-4000-8000-0000000000e4'; // general recipe only

  beforeEach(() => {
    state.actor = as(ASHA);
    state.device = { id: DEVICE };
    state.tables = {
      menu_items: [{ id: LATTE, name: 'Latte', category: 'Coffee', sort_order: 1, menu_item_variants: [{ id: 'v1', label: 'Large ', sort_order: 1 }] }],
      recipe_lines: [{ menu_item_id: LATTE, size_label: '', item_id: MILK, qty: '200.000' }],
      addon_groups: [
        {
          id: 'g1',
          display_name: 'Extras',
          sort_order: 1,
          addon_options: [
            { id: SUGAR, name: 'Sugar', sort_order: 1 },
            { id: OAT, name: 'Oat', sort_order: 2 },
            { id: DECAF, name: 'Decaf', sort_order: 3 },
          ],
        },
      ],
      addon_recipe_lines: [
        { addon_option_id: SUGAR, item_id: CUPS, qty: '20.000', menu_item_id: null, size_label: '' },
        { addon_option_id: SUGAR, item_id: CUPS, qty: '25.000', menu_item_id: LATTE, size_label: 'Large' },
        { addon_option_id: SUGAR, item_id: CUPS, qty: '10.000', menu_item_id: ESPRESSO, size_label: '' },
        { addon_option_id: OAT, item_id: MILK, qty: '200.000', menu_item_id: LATTE, size_label: '' },
        { addon_option_id: DECAF, item_id: MILK, qty: '5.000', menu_item_id: null, size_label: '' },
      ],
    };
  });

  it('sends the editor only the general add-on lines, and counts the scoped ones per add-on', async () => {
    const res = await recipesRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.addonLines).toEqual([
      { optionId: SUGAR, itemId: CUPS, qty: 20 },
      { optionId: DECAF, itemId: MILK, qty: 5 },
    ]);
    expect(body.addonScopedCounts).toEqual({ [SUGAR]: 2, [OAT]: 1 });
    expect(body.addons.map((a: { id: string }) => a.id)).toEqual([SUGAR, OAT, DECAF]);
    expect(body.lines).toEqual([{ menuItemId: LATTE, sizeLabel: '', itemId: MILK, qty: 200 }]);
  });

  it('has no scoped counts when the recipe book set none', async () => {
    state.tables.addon_recipe_lines = (state.tables.addon_recipe_lines as Row[]).filter((l) => l.menu_item_id === null);
    const body = await (await recipesRoute.GET()).json();
    expect(body.addonScopedCounts).toEqual({});
    expect(body.addonLines).toHaveLength(2);
  });
});

// PostgREST returns at most 1,000 rows per request and does not say so, so every
// read that can outgrow that is paged. The fake above cuts an unpaged answer at
// MAX_ROWS exactly as PostgREST does: these fail if a read forgets to page. The
// real recipe book alone is well past 1,000 recipe_lines (~86 items x up to 2
// sizes x ~8-12 lines) and ~370 add-on lines.
describe('reads past the 1,000-row cap', () => {
  const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, '0')}`;

  describe('GET /api/inventory/recipes', () => {
    const OPTIONS = [id('a0000001', 1), id('a0000001', 2), id('a0000001', 3)];
    const LINES = 2345;
    const GENERAL = 1000; // an exact multiple of the page size: the last page is empty
    const SCOPED = 1501;
    const ITEMS = 1234;

    beforeEach(() => {
      state.actor = as(ASHA);
      state.device = { id: DEVICE };
      state.items = Array.from({ length: ITEMS }, (_, i) => ({
        id: id('b0000001', i),
        name: `Item ${i}`,
        unit: 'g',
        is_active: true,
      }));
      state.tables = {
        menu_items: [{ id: id('c0000001', 1), name: 'Latte', category: 'Coffee', sort_order: 1, menu_item_variants: [] }],
        addon_groups: [
          {
            id: 'g1',
            display_name: 'Extras',
            sort_order: 1,
            addon_options: OPTIONS.map((o, i) => ({ id: o, name: `Option ${i}`, sort_order: i })),
          },
        ],
        recipe_lines: Array.from({ length: LINES }, (_, i) => ({
          id: id('d0000001', i),
          menu_item_id: id('c0000001', i % 86),
          size_label: i % 2 ? 'Large' : '',
          item_id: id('b0000001', i),
          qty: '1.500',
        })),
        addon_recipe_lines: [
          ...Array.from({ length: GENERAL }, (_, i) => ({
            id: id('e0000001', i),
            addon_option_id: OPTIONS[i % 3],
            item_id: id('b0000001', i),
            qty: '2.000',
            menu_item_id: null,
            size_label: '',
          })),
          ...Array.from({ length: SCOPED }, (_, i) => ({
            id: id('e0000002', i),
            addon_option_id: OPTIONS[i % 3],
            item_id: id('b0000001', i),
            qty: '3.000',
            menu_item_id: id('c0000001', i % 86),
            size_label: '',
          })),
        ],
      };
    });

    it('returns every recipe line, add-on line and stock item, not the first 1,000 of each', async () => {
      const res = await recipesRoute.GET();
      expect(res.status).toBe(200);
      const body = await res.json();

      expect(body.lines).toHaveLength(LINES);
      // No line twice, none dropped: each (item, size, ingredient) is there once.
      expect(new Set(body.lines.map((l: { itemId: string }) => l.itemId)).size).toBe(LINES);
      expect(body.lines[LINES - 1]).toEqual({
        menuItemId: id('c0000001', (LINES - 1) % 86),
        sizeLabel: (LINES - 1) % 2 ? 'Large' : '',
        itemId: id('b0000001', LINES - 1),
        qty: 1.5,
      });

      expect(body.addonLines).toHaveLength(GENERAL);
      expect(new Set(body.addonLines.map((l: { itemId: string }) => l.itemId)).size).toBe(GENERAL);

      // The scoped-count query is paged too: the counts add up to every scoped line.
      const counted = Object.values(body.addonScopedCounts as Record<string, number>).reduce((a, b) => a + b, 0);
      expect(counted).toBe(SCOPED);
      expect(body.addonScopedCounts).toEqual({ [OPTIONS[0]]: 501, [OPTIONS[1]]: 500, [OPTIONS[2]]: 500 });

      expect(body.items).toHaveLength(ITEMS);
      expect(body.items[ITEMS - 1]).toMatchObject({ id: id('b0000001', ITEMS - 1), name: `Item ${ITEMS - 1}`, unit: 'g', isActive: true });
    });

    it('fails outright when a later page fails, rather than sending a partial recipe book', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        state.failRange = { table: 'recipe_lines', from: 1000 };
        const res = await recipesRoute.GET();
        expect(res.status).toBe(500);
        expect((await res.json()).error).toMatch(/^Could not load recipes/);
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('GET /api/inventory/items — the Stock tab', () => {
    it('returns every item, every live batch and every open request', async () => {
      state.actor = as(ASHA);
      const ITEMS = 1300;
      const BATCHES = 2100;
      const OPEN = 1050;
      const itemId = (i: number) => id('b0000002', i);
      state.items = Array.from({ length: ITEMS }, (_, i) => ({
        id: itemId(i),
        name: `Item ${i}`,
        unit: 'g',
        category: 'Dry',
        par_level: 0,
        reorder_qty: 0,
        tracks_expiry: false,
        is_active: true,
        shortfall_since_count: 0,
        last_counted_at: null,
      }));
      state.request = null;
      state.tables = {
        inventory_batches: Array.from({ length: BATCHES }, (_, i) => ({
          id: id('f0000001', i),
          item_id: itemId(i % ITEMS), // items 0..799 have two batches, the rest one
          qty_received: 10,
          qty_remaining: 5,
          expiry_date: null,
          received_at: '2026-09-01T00:00:00Z',
          source: 'receive',
        })),
        stock_requests: Array.from({ length: OPEN }, (_, i) => ({
          id: id('f0000002', i),
          request_number: i + 1,
          status: 'requested',
          stock_request_lines: [{ item_id: itemId(0) }],
        })),
      };

      const res = await itemsRoute.GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.items).toHaveLength(ITEMS);
      const batches = body.items.reduce((n: number, i: { batches: unknown[] }) => n + i.batches.length, 0);
      expect(batches).toBe(BATCHES);
      expect(body.items[0].batches).toHaveLength(2);
      expect(body.items[0].onHand).toBe(10);
      expect(body.items[ITEMS - 1].batches).toHaveLength(1);
      expect(body.items[0].openRequestNumbers).toHaveLength(OPEN);
    });

    it('says it could not load stock when a later page of the items fails', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        state.actor = as(ASHA);
        state.items = Array.from({ length: 1500 }, (_, i) => ({ id: id('b0000003', i), name: `Item ${i}` }));
        state.failRange = { table: 'inventory_items', from: 1000 };
        const res = await itemsRoute.GET();
        expect(res.status).toBe(500);
        expect((await res.json()).error).toMatch(/^Could not load stock/);
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe('GET /api/inventory/requests', () => {
    it('returns every open request, however many there are', async () => {
      state.actor = as(ASHA);
      const OPEN = 1050;
      state.tables = {
        stock_requests: Array.from({ length: OPEN }, (_, i) => ({
          id: id('f0000003', i),
          request_number: i + 1,
          status: 'requested',
          note: '',
          requested_by: ASHA,
          assigned_to: null,
          picked_by: null,
          received_by: null,
          created_at: '2026-09-01T00:00:00Z',
          assigned_at: null,
          picked_at: null,
          received_at: null,
          has_discrepancy: false,
          cancel_reason: '',
          stock_request_lines: [],
        })),
      };
      const res = await requestsRoute.GET();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.requests).toHaveLength(OPEN);
      expect(body.requests[OPEN - 1].number).toBe(OPEN);
    });
  });
});
