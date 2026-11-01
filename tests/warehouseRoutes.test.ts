import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level tests for the warehouse (docs/WAREHOUSE-SPEC.md): the staff
// routes when a request is filled from the warehouse (dispatch is the
// warehouse side's, the deliverer can't count it in, a transfer on the road
// can't be cancelled, the owner is alerted), the returns route, and the
// owner's routes (owner-only, 404 while the warehouse is off, each action
// through its database function with the right arguments). Also that a
// database without the warehouse migration still serves the store-room flow.
// The Supabase admin client is a small in-memory fake.

const OWNER = '00000000-0000-4000-8000-000000000009';
const MANAGER = '00000000-0000-4000-8000-000000000001';
const ASHA = '00000000-0000-4000-8000-000000000002';
const VIKRAM = '00000000-0000-4000-8000-000000000003';
const MEERA = '00000000-0000-4000-8000-000000000004';
const REQ = '00000000-0000-4000-8000-0000000000a1';
const MILK = '00000000-0000-4000-8000-0000000000b1';
const CUPS = '00000000-0000-4000-8000-0000000000b2';
const DEVICE = '00000000-0000-4000-8000-0000000000d1';

type Row = Record<string, unknown>;

const state: {
  flags: Record<string, boolean>;
  actor: { user: { id: string }; role: string; via: string } | null;
  owner: { id: string } | null;
  device: { id: string } | null;
  tables: Record<string, Row[]>;
  rpcCalls: { name: string; args: Row }[];
  rpcResult: { data: unknown; error: { message: string; code?: string } | null };
  updates: { table: string; patch: Row; filters: [string, string, unknown][] }[];
  upserts: { table: string; row: Row }[];
  legacyDb: boolean;
} = {
  flags: {},
  actor: null,
  owner: null,
  device: null,
  tables: {},
  rpcCalls: [],
  rpcResult: { data: null, error: null },
  updates: [],
  upserts: [],
  legacyDb: false,
};

vi.mock('@/lib/flags', () => ({ flags: new Proxy({}, { get: (_t, key) => state.flags[key as string] ?? false }) }));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.actor),
  getOwnerUser: () => Promise.resolve(state.owner),
}));
vi.mock('@/lib/api/device', () => ({ getEnrolledDevice: () => Promise.resolve(state.device) }));
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve(state.device ? 'pos' : 'web') }));
vi.mock('@/lib/staff/displayName', () => ({ getStaffDisplayNames: () => Promise.resolve(new Map()) }));
vi.mock('@/lib/cash/date', () => ({ istBusinessDate: () => '2026-11-01' }));
vi.mock('@/lib/reports/ownerDigestServer', () => ({ ownerLoginEmails: () => Promise.resolve(['owner@hioc.in']) }));
const { sendStockAssignedEmail, sendOwnerAlert, queued } = vi.hoisted(() => ({
  sendStockAssignedEmail: vi.fn((_a: unknown, _args: Record<string, unknown>) =>
    Promise.resolve({ kind: 'stock_assigned', status: 'sent', detail: '' }),
  ),
  sendOwnerAlert: vi.fn((_a: unknown, _event: string, _id: string) => Promise.resolve([])),
  queued: [] as Promise<unknown>[],
}));
vi.mock('@/lib/inventory/notify', () => ({ sendStockAssignedEmail }));
vi.mock('@/lib/api/background', () => ({ runAfterResponse: (p: Promise<unknown>) => queued.push(p) }));
vi.mock('@/lib/inventory/ownerAlerts', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/inventory/ownerAlerts')>();
  return { ...real, sendOwnerAlert };
});

const MISSING_ROUTE = { code: '42703', message: 'column stock_requests.route does not exist' };

function makeAdmin() {
  return {
    rpc: (name: string, args: Row) => {
      state.rpcCalls.push({ name, args });
      return Promise.resolve(state.rpcResult);
    },
    from: (table: string) => {
      const filters: [string, string, unknown][] = [];
      let patch: Row | null = null;
      let selected = '';
      let window: [number, number] | null = null;
      const rows = (): Row[] => state.tables[table] ?? [];
      const legacyMiss = () => state.legacyDb && table === 'stock_requests' && /\broute\b|deliverer_name/.test(selected);
      const matching = () =>
        rows().filter((r) =>
          filters.every(([op, col, val]) =>
            op === 'eq'
              ? (r[col] ?? (col === 'route' ? 'store_room' : undefined)) === val
              : op === 'in'
                ? (val as unknown[]).includes(r[col] ?? (col === 'route' ? 'store_room' : undefined))
                : op === 'is-null'
                  ? r[col] === null || r[col] === undefined
                  : true,
          ),
        );
      const chain: Record<string, unknown> = {
        select: (cols?: string) => {
          selected = cols ?? '';
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        range: (from: number, to: number) => {
          window = [from, to];
          return chain;
        },
        gt: () => chain,
        eq: (col: string, val: unknown) => (filters.push(['eq', col, val]), chain),
        in: (col: string, val: unknown[]) => (filters.push(['in', col, val]), chain),
        is: (col: string, val: unknown) => (filters.push(['is-null', col, val]), chain),
        update: (p: Row) => {
          patch = p;
          return chain;
        },
        upsert: (row: Row) => {
          state.upserts.push({ table, row });
          return chain;
        },
        insert: () => Promise.resolve({ error: null }),
        maybeSingle: () => {
          if (legacyMiss()) return Promise.resolve({ data: null, error: MISSING_ROUTE });
          if (table === 'warehouse_alert_settings') {
            const last = state.upserts.filter((u) => u.table === table).at(-1)?.row ?? {};
            return Promise.resolve({ data: { enabled: true, email_owner_logins: true, emails: [], whatsapp_phones: [], ...last }, error: null });
          }
          const hit = matching()[0] ?? null;
          if (patch) {
            state.updates.push({ table, patch, filters: [...filters] });
            if (hit) Object.assign(hit, patch);
          }
          return Promise.resolve({ data: hit, error: null });
        },
        then: (resolve: (v: unknown) => void) => {
          if (legacyMiss()) return resolve({ data: null, error: MISSING_ROUTE });
          if (patch) state.updates.push({ table, patch, filters: [...filters] });
          const [from, to] = window ?? [0, 999];
          const list = matching().slice(from, to + 1);
          resolve({ data: list, error: null, count: matching().length });
        },
      };
      return chain;
    },
    auth: { admin: { getUserById: () => Promise.resolve({ data: { user: { email: 'owner@hioc.in' } }, error: null }) } },
  };
}
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => makeAdmin() }));

const requestsRoute = await import('@/app/api/inventory/requests/route');
const requestRoute = await import('@/app/api/inventory/requests/[id]/route');
const returnsRoute = await import('@/app/api/inventory/returns/route');
const ownerRoute = await import('@/app/api/owner/warehouse/route');
const ownerWaitingRoute = await import('@/app/api/owner/warehouse/waiting/route');
const ownerRequestRoute = await import('@/app/api/owner/warehouse/requests/[id]/route');
const purchasesRoute = await import('@/app/api/owner/warehouse/purchases/route');
const levelRoute = await import('@/app/api/owner/warehouse/items/[id]/route');
const adjustRoute = await import('@/app/api/owner/warehouse/items/[id]/adjust/route');
const alertsRoute = await import('@/app/api/owner/warehouse/alerts/route');
const sheetRoute = await import('@/app/api/owner/warehouse/sheet/route');

const as = (id: string, role = 'staff') => ({ user: { id }, role, via: 'session' });
const json = (url: string, method: string, body: unknown) =>
  new Request(`http://t${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const staffPatch = (body: unknown) => requestRoute.PATCH(json(`/api/inventory/requests/${REQ}`, 'PATCH', body), { params: { id: REQ } });
const ownerPatch = (body: unknown) =>
  ownerRequestRoute.PATCH(json(`/api/owner/warehouse/requests/${REQ}`, 'PATCH', body), { params: { id: REQ } });

function request(over: Row = {}): Row {
  return {
    id: REQ,
    request_number: 12,
    status: 'requested',
    route: 'from_warehouse',
    requested_by: ASHA,
    assigned_to: null,
    picked_by: null,
    has_discrepancy: false,
    resolved_at: null,
    deliverer_name: '',
    deliverer_phone: '',
    note: '',
    created_at: '2026-11-01T04:00:00Z',
    stock_request_lines: [
      { item_id: MILK, qty_requested: 10, qty_picked: null, qty_received: null, inventory_items: { name: 'Milk', unit: 'l', tracks_expiry: true } },
      { item_id: CUPS, qty_requested: 500, qty_picked: null, qty_received: null, inventory_items: { name: 'Cups', unit: 'pcs', tracks_expiry: false } },
    ],
    ...over,
  };
}

const { resetRequestColumnsMemo } = await import('@/lib/inventory/server');

beforeEach(() => {
  resetRequestColumnsMemo();
  state.flags = { inventory: true, warehouse: true };
  state.actor = null;
  state.owner = null;
  state.device = null;
  state.legacyDb = false;
  state.tables = {
    stock_requests: [request()],
    inventory_items: [
      { id: MILK, name: 'Milk', unit: 'l', category: 'Dairy', par_level: 5, reorder_qty: 10, tracks_expiry: true, is_active: true, shortfall_since_count: 0, last_counted_at: null },
      { id: CUPS, name: 'Cups', unit: 'pcs', category: 'Packaging', par_level: 0, reorder_qty: 0, tracks_expiry: false, is_active: true, shortfall_since_count: 0, last_counted_at: null },
    ],
    profiles: [
      { id: MANAGER, name: 'Boss', role: 'manager' },
      { id: ASHA, name: 'Asha', role: 'staff' },
      { id: VIKRAM, name: 'Vikram', role: 'staff' },
      { id: MEERA, name: 'Meera', role: 'staff' },
    ],
  };
  state.rpcCalls = [];
  state.rpcResult = { data: null, error: null };
  state.updates = [];
  state.upserts = [];
  queued.length = 0;
  sendStockAssignedEmail.mockClear();
  sendOwnerAlert.mockClear();
});

const setRequest = (over: Row) => {
  state.tables.stock_requests = [request(over)];
};

describe('Request stock, with the warehouse on', () => {
  it('is filled from the warehouse, and the owner is alerted after the reply', async () => {
    state.actor = as(ASHA);
    state.rpcResult = { data: REQ, error: null };
    const res = await requestsRoute.POST(json('/api/inventory/requests', 'POST', { lines: [{ itemId: MILK, qty: 10 }] }));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: REQ, route: 'from_warehouse' });
    expect(state.rpcCalls).toEqual([{ name: 'warehouse_create_request', args: { p_actor: ASHA, p_note: '', p_lines: [{ item_id: MILK, qty: 10 }] } }]);
    expect(queued).toHaveLength(1);
    expect(sendOwnerAlert).toHaveBeenCalledWith(expect.anything(), 'request_placed', REQ);
  });

  it('with the warehouse off it is a store-room request, and nobody is alerted', async () => {
    state.flags.warehouse = false;
    state.actor = as(ASHA);
    state.rpcResult = { data: REQ, error: null };
    await requestsRoute.POST(json('/api/inventory/requests', 'POST', { lines: [{ itemId: MILK, qty: 10 }] }));
    expect(state.rpcCalls[0].name).toBe('inventory_create_request');
    expect(sendOwnerAlert).not.toHaveBeenCalled();
  });

  it('a failed request alerts nobody', async () => {
    state.actor = as(ASHA);
    state.rpcResult = { data: null, error: { message: 'inventory: one of those items is no longer stocked' } };
    expect((await requestsRoute.POST(json('/api/inventory/requests', 'POST', { lines: [{ itemId: MILK, qty: 1 }] }))).status).toBe(409);
    expect(sendOwnerAlert).not.toHaveBeenCalled();
  });
});

describe('choosing who delivers', () => {
  it('someone without a login, by name and phone — no email', async () => {
    state.actor = as(MANAGER, 'manager');
    const res = await staffPatch({ action: 'assign', deliverer: { name: 'Ravi (driver)', phone: '9812345678' } });
    expect(await res.json()).toEqual({ ok: true, emailed: 'skipped' });
    expect(state.updates[0].patch).toMatchObject({
      status: 'assigned',
      assigned_to: null,
      deliverer_name: 'Ravi (driver)',
      deliverer_phone: '+919812345678',
    });
    expect(sendStockAssignedEmail).not.toHaveBeenCalled();
  });

  it('a team member is emailed that it is theirs to deliver, and any outside name is cleared', async () => {
    state.actor = as(MANAGER, 'manager');
    await staffPatch({ action: 'assign', assigneeId: VIKRAM });
    expect(state.updates[0].patch).toMatchObject({ assigned_to: VIKRAM, deliverer_name: '', deliverer_phone: '' });
    expect(sendStockAssignedEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ assigneeId: VIKRAM, delivery: 'from_warehouse' }));
  });

  it('a store-room request still takes a team member only', async () => {
    setRequest({ route: 'store_room' });
    state.actor = as(MANAGER, 'manager');
    expect((await staffPatch({ action: 'assign', deliverer: { name: 'Ravi' } })).status).toBe(400);
    expect(state.updates).toEqual([]);
  });

  it('the owner can choose from the Warehouse page', async () => {
    state.owner = { id: OWNER };
    expect((await ownerPatch({ action: 'assign', assigneeId: VIKRAM })).status).toBe(200);
    expect(state.updates[0].patch).toMatchObject({ assigned_to: VIKRAM, assigned_by: OWNER });
  });
});

describe('dispatch (what left the warehouse)', () => {
  beforeEach(() => setRequest({ status: 'assigned', assigned_to: VIKRAM }));
  const lines = [
    { itemId: MILK, qty: 10 },
    { itemId: CUPS, qty: 600 },
  ];

  it('the delivery person can’t record it', async () => {
    state.actor = as(VIKRAM);
    expect((await staffPatch({ action: 'pick', lines })).status).toBe(403);
    expect(state.rpcCalls).toEqual([]);
  });

  it('a manager records it through warehouse_dispatch, and hears what the sheet couldn’t cover', async () => {
    state.actor = as(MANAGER, 'manager');
    state.rpcResult = { data: { short: [{ item_id: CUPS, shortfall: 100 }] }, error: null };
    const res = await staffPatch({ action: 'pick', lines });
    expect(await res.json()).toEqual({ ok: true, short: [{ itemId: CUPS, shortfall: 100 }] });
    expect(state.rpcCalls).toEqual([
      { name: 'warehouse_dispatch', args: { p_request_id: REQ, p_actor: MANAGER, p_lines: [{ item_id: MILK, qty: 10 }, { item_id: CUPS, qty: 600 }] } },
    ]);
  });

  it('the owner records it from the Warehouse page', async () => {
    state.owner = { id: OWNER };
    state.rpcResult = { data: { short: [] }, error: null };
    expect((await ownerPatch({ action: 'pick', lines })).status).toBe(200);
    expect(state.rpcCalls[0]).toMatchObject({ name: 'warehouse_dispatch', args: { p_actor: OWNER } });
  });

  it('a store-room request still picks through inventory_pick', async () => {
    setRequest({ route: 'store_room', status: 'assigned', assigned_to: VIKRAM });
    state.actor = as(VIKRAM);
    expect((await staffPatch({ action: 'pick', lines })).status).toBe(200);
    expect(state.rpcCalls[0].name).toBe('inventory_pick');
  });
});

describe('counting it in at the POS', () => {
  beforeEach(() => {
    setRequest({ status: 'picked', assigned_to: VIKRAM, picked_by: OWNER });
    state.device = { id: DEVICE };
  });
  const lines = [
    { itemId: MILK, qty: 9, expiryDate: '2026-11-05' },
    { itemId: CUPS, qty: 600 },
  ];

  it('not by whoever delivered it', async () => {
    state.actor = as(VIKRAM);
    expect((await staffPatch({ action: 'receive', lines })).status).toBe(403);
    expect(state.rpcCalls).toEqual([]);
  });

  it('by someone else, through inventory_receive; a difference alerts the owner', async () => {
    state.actor = as(MEERA);
    state.rpcResult = { data: { has_discrepancy: true }, error: null };
    const res = await staffPatch({ action: 'receive', lines });
    expect(await res.json()).toEqual({ ok: true, hasDiscrepancy: true });
    expect(state.rpcCalls[0]).toMatchObject({ name: 'inventory_receive', args: { p_request_id: REQ, p_actor: MEERA, p_device_id: DEVICE } });
    expect(sendOwnerAlert).toHaveBeenCalledWith(expect.anything(), 'arrived_different', REQ);
  });

  it('a delivery that matches alerts nobody', async () => {
    state.actor = as(MEERA);
    state.rpcResult = { data: { has_discrepancy: false }, error: null };
    await staffPatch({ action: 'receive', lines });
    expect(sendOwnerAlert).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  it('a transfer on the road can’t be cancelled', async () => {
    setRequest({ status: 'picked', assigned_to: VIKRAM, picked_by: OWNER });
    state.actor = as(MANAGER, 'manager');
    expect((await staffPatch({ action: 'cancel', reason: 'changed my mind' })).status).toBe(409);
    expect(state.updates).toEqual([]);
  });

  it('before it leaves, the write is guarded to requested/assigned only', async () => {
    setRequest({ status: 'assigned', assigned_to: VIKRAM });
    state.actor = as(MANAGER, 'manager');
    expect((await staffPatch({ action: 'cancel', reason: 'not needed' })).status).toBe(200);
    expect(state.updates[0].filters).toContainEqual(['in', 'status', ['requested', 'assigned']]);
  });
});

describe('the staff route does not offer the owner’s steps', () => {
  it('receive_return and resolve are 400 there', async () => {
    state.actor = as(MANAGER, 'manager');
    expect((await staffPatch({ action: 'receive_return', lines: [] })).status).toBe(400);
    expect((await staffPatch({ action: 'resolve', lines: [] })).status).toBe(400);
  });
});

describe('owner routes', () => {
  it('are owner only — a manager’s counter session is not enough', async () => {
    state.actor = as(MANAGER, 'manager');
    expect((await ownerRoute.GET()).status).toBe(403);
    expect((await ownerPatch({ action: 'assign', assigneeId: VIKRAM })).status).toBe(403);
    expect((await purchasesRoute.POST(json('/x', 'POST', { lines: [] }))).status).toBe(403);
  });

  it('404 while the warehouse is off', async () => {
    state.owner = { id: OWNER };
    state.flags.warehouse = false;
    expect((await ownerRoute.GET()).status).toBe(404);
    expect((await ownerWaitingRoute.GET()).status).toBe(404);
    expect((await alertsRoute.GET()).status).toBe(404);
  });

  it('GET loads the sheet and the transfers, with what is waiting', async () => {
    state.owner = { id: OWNER };
    state.tables.stock_requests = [
      request(),
      request({ id: 'r2', request_number: 13, status: 'picked', route: 'to_warehouse', picked_at: '2026-11-01T05:00:00Z', stock_request_lines: [{ item_id: CUPS, qty_requested: 100, qty_picked: 100, qty_received: null, inventory_items: { name: 'Cups', unit: 'pcs', tracks_expiry: false } }] }),
    ];
    state.tables.warehouse_items = [{ item_id: MILK, par_level: 20, shortfall_since_count: 0, last_counted_at: null }];
    state.tables.warehouse_batches = [
      { id: 'wb1', item_id: MILK, qty_received: 14, qty_remaining: 14, expiry_date: '2026-11-10', received_at: '2026-10-30T00:00:00Z', source: 'purchase', supplier: 'Dairy' },
    ];
    state.tables.inventory_batches = [{ id: 'b1', item_id: MILK, qty_received: 6, qty_remaining: 6, expiry_date: '2026-11-04', received_at: '2026-10-30T00:00:00Z', source: 'receive' }];
    const res = await ownerRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.waiting).toEqual({ toAssign: 1, toDispatch: 0, toReceive: 1, toSettle: 0, total: 2 });
    const milk = body.items.find((i: { id: string }) => i.id === MILK);
    expect(milk).toMatchObject({ storeOnHand: 6, awaitingDispatch: 10, warehouse: { onHand: 14, parLevel: 20, low: true } });
    const cups = body.items.find((i: { id: string }) => i.id === CUPS);
    expect(cups.inTransit).toEqual({ toStore: 0, toWarehouse: 100 });
    expect(body.requests.map((r: { number: number; route: string }) => [r.number, r.route])).toEqual([
      [12, 'from_warehouse'],
      [13, 'to_warehouse'],
    ]);
  });

  it('the sheet downloads as a CSV', async () => {
    state.owner = { id: OWNER };
    const res = await sheetRoute.GET();
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('hioc-warehouse-sheet-2026-11-01.csv');
    expect(await res.text()).toContain('Warehouse on hand');
  });
});

describe('owner: counting a return in, and settling', () => {
  it('counts a return in through warehouse_receive_return; a perishable needs its date', async () => {
    setRequest({ route: 'to_warehouse', status: 'picked', assigned_to: null, deliverer_name: 'Ravi', picked_by: MANAGER, requested_by: MANAGER });
    state.owner = { id: OWNER };
    expect((await ownerPatch({ action: 'receive_return', lines: [{ itemId: MILK, qty: 2 }, { itemId: CUPS, qty: 100 }] })).status).toBe(400);
    state.rpcResult = { data: { has_discrepancy: false }, error: null };
    const res = await ownerPatch({
      action: 'receive_return',
      lines: [
        { itemId: MILK, qty: 2, expiryDate: '2026-11-08' },
        { itemId: CUPS, qty: 100 },
      ],
    });
    expect(await res.json()).toEqual({ ok: true, hasDiscrepancy: false });
    expect(state.rpcCalls).toEqual([
      {
        name: 'warehouse_receive_return',
        args: {
          p_request_id: REQ,
          p_actor: OWNER,
          p_lines: [
            { item_id: MILK, qty: 2, expiry_date: '2026-11-08' },
            { item_id: CUPS, qty: 100, expiry_date: null },
          ],
        },
      },
    ]);
  });

  it('settles each line that arrived different through warehouse_resolve', async () => {
    setRequest({
      status: 'received',
      has_discrepancy: true,
      assigned_to: VIKRAM,
      stock_request_lines: [
        { item_id: MILK, qty_requested: 12, qty_picked: 12, qty_received: 10, inventory_items: { name: 'Milk' } },
        { item_id: CUPS, qty_requested: 100, qty_picked: 100, qty_received: 100, inventory_items: { name: 'Cups' } },
      ],
    });
    state.owner = { id: OWNER };
    // The matched line is not settled; a short line can't be "accepted".
    expect((await ownerPatch({ action: 'resolve', lines: [{ itemId: CUPS, resolution: 'lost' }] })).status).toBe(400);
    expect((await ownerPatch({ action: 'resolve', lines: [{ itemId: MILK, resolution: 'accepted' }] })).status).toBe(400);
    const res = await ownerPatch({ action: 'resolve', note: ' van ', lines: [{ itemId: MILK, resolution: 'back_to_origin' }] });
    expect(res.status).toBe(200);
    expect(state.rpcCalls).toEqual([
      { name: 'warehouse_resolve', args: { p_request_id: REQ, p_actor: OWNER, p_note: 'van', p_lines: [{ item_id: MILK, resolution: 'back_to_origin' }] } },
    ]);
  });

  it('refuses to settle something that arrived as sent', async () => {
    setRequest({ status: 'received', has_discrepancy: false });
    state.owner = { id: OWNER };
    expect((await ownerPatch({ action: 'resolve', lines: [] })).status).toBe(409);
  });
});

describe('returns (Send back to warehouse)', () => {
  const body = { lines: [{ itemId: CUPS, qty: 100 }], note: 'too many', deliverer: { name: 'Ravi (driver)' } };

  it('is a manager’s', async () => {
    state.actor = as(ASHA);
    expect((await returnsRoute.POST(json('/api/inventory/returns', 'POST', body))).status).toBe(403);
  });

  it('404 while the warehouse is off', async () => {
    state.flags.warehouse = false;
    state.actor = as(MANAGER, 'manager');
    expect((await returnsRoute.POST(json('/api/inventory/returns', 'POST', body))).status).toBe(404);
  });

  it('goes through warehouse_create_return, and the owner is alerted', async () => {
    state.actor = as(MANAGER, 'manager');
    state.rpcResult = { data: REQ, error: null };
    const res = await returnsRoute.POST(json('/api/inventory/returns', 'POST', body));
    expect(res.status).toBe(201);
    expect(state.rpcCalls).toEqual([
      {
        name: 'warehouse_create_return',
        args: {
          p_actor: MANAGER,
          p_note: 'too many',
          p_assignee: null,
          p_deliverer_name: 'Ravi (driver)',
          p_deliverer_phone: '',
          p_lines: [{ item_id: CUPS, qty: 100 }],
        },
      },
    ]);
    expect(sendOwnerAlert).toHaveBeenCalledWith(expect.anything(), 'return_sent', REQ);
  });

  it('a team member carrying it is emailed; someone off the team is refused', async () => {
    state.actor = as(MANAGER, 'manager');
    state.rpcResult = { data: REQ, error: null };
    await returnsRoute.POST(json('/api/inventory/returns', 'POST', { lines: body.lines, assigneeId: VIKRAM }));
    expect(sendStockAssignedEmail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ assigneeId: VIKRAM, delivery: 'to_warehouse' }));
    state.rpcCalls = [];
    const stranger = '00000000-0000-4000-8000-0000000000ff';
    expect((await returnsRoute.POST(json('/api/inventory/returns', 'POST', { lines: body.lines, assigneeId: stranger }))).status).toBe(400);
    expect(state.rpcCalls).toEqual([]);
  });

  it('shows the database’s refusal (more than the store holds) as a 409', async () => {
    state.actor = as(MANAGER, 'manager');
    state.rpcResult = { data: null, error: { message: 'inventory: the store only has 5 pcs of Cups — count it before sending it back' } };
    const res = await returnsRoute.POST(json('/api/inventory/returns', 'POST', body));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'The store only has 5 pcs of Cups — count it before sending it back' });
  });
});

describe('owner: the warehouse sheet', () => {
  beforeEach(() => {
    state.owner = { id: OWNER };
  });

  it('a purchase goes through warehouse_purchase; a retired item is refused', async () => {
    state.tables.inventory_items[1].is_active = false;
    expect((await purchasesRoute.POST(json('/x', 'POST', { lines: [{ itemId: CUPS, qty: 10 }] }))).status).toBe(400);
    const res = await purchasesRoute.POST(
      json('/x', 'POST', { supplier: ' Dairy Co ', lines: [{ itemId: MILK, qty: 20, expiryDate: '2026-11-10' }] }),
    );
    expect(res.status).toBe(201);
    expect(state.rpcCalls).toEqual([
      { name: 'warehouse_purchase', args: { p_actor: OWNER, p_supplier: 'Dairy Co', p_note: '', p_lines: [{ item_id: MILK, qty: 20, expiry_date: '2026-11-10' }] } },
    ]);
  });

  it('sets the warehouse low level by upsert', async () => {
    const res = await levelRoute.PATCH(json('/x', 'PATCH', { parLevel: '20' }), { params: { id: MILK } });
    expect(res.status).toBe(200);
    expect(state.upserts[0]).toMatchObject({ table: 'warehouse_items', row: { item_id: MILK, par_level: 20, updated_by: OWNER } });
    expect((await levelRoute.PATCH(json('/x', 'PATCH', { parLevel: -1 }), { params: { id: MILK } })).status).toBe(400);
  });

  it('a write-off needs a reason; a count goes through warehouse_adjust', async () => {
    expect((await adjustRoute.POST(json('/x', 'POST', { kind: 'waste', qty: 1 }), { params: { id: MILK } })).status).toBe(400);
    state.rpcResult = { data: { on_hand: 12 }, error: null };
    const res = await adjustRoute.POST(json('/x', 'POST', { kind: 'count', qty: 12 }), { params: { id: MILK } });
    expect(await res.json()).toEqual({ ok: true, onHand: 12 });
    expect(state.rpcCalls).toEqual([
      { name: 'warehouse_adjust', args: { p_item_id: MILK, p_actor: OWNER, p_kind: 'count', p_qty: 12, p_batch_id: null, p_reason: '' } },
    ]);
  });

  it('saves the alert settings', async () => {
    const res = await alertsRoute.PATCH(json('/x', 'PATCH', { emails: ['P@X.com'], whatsappPhones: ['9876543210'] }));
    expect(res.status).toBe(200);
    expect(state.upserts[0]).toMatchObject({
      table: 'warehouse_alert_settings',
      row: { is_singleton: true, emails: ['p@x.com'], whatsapp_phones: ['+919876543210'], updated_by: OWNER },
    });
    const body = await res.json();
    expect(body.recipients.emails).toEqual(['owner@hioc.in', 'p@x.com']);
    expect((await alertsRoute.PATCH(json('/x', 'PATCH', { emails: ['nope'] }))).status).toBe(400);
  });
});

describe('a database without the warehouse migration', () => {
  beforeEach(() => {
    state.legacyDb = true;
    state.flags.warehouse = false;
    setRequest({ route: undefined, status: 'requested' });
  });

  it('the Requests list still loads, every request a store-room one', async () => {
    state.actor = as(ASHA);
    const res = await requestsRoute.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests.map((r: { route: string }) => r.route)).toEqual(['store_room']);
  });

  it('remembers the miss: the next load goes straight to the original columns (no failed read, no error logged)', async () => {
    state.actor = as(ASHA);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect((await requestsRoute.GET()).status).toBe(200);
      const afterFirst = errors.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0); // the first read failed and was logged
      expect((await requestsRoute.GET()).status).toBe(200);
      expect(errors.mock.calls.length).toBe(afterFirst);
    } finally {
      errors.mockRestore();
    }
  });

  it('assigning still works, and writes no warehouse column', async () => {
    state.actor = as(MANAGER, 'manager');
    expect((await staffPatch({ action: 'assign', assigneeId: VIKRAM })).status).toBe(200);
    expect(state.updates[0].patch).not.toHaveProperty('deliverer_name');
  });
});
