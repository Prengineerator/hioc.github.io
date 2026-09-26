import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level tests for /api/inventory/** (docs/INVENTORY-SPEC.md). What
// they guard: the flag and the counter-actor gate, that each step of a stock
// request is taken only by the person the rules allow (assign = manager,
// pick = assignee, receive = at the POS by someone other than the picker),
// that expiry dates are demanded before anything reaches the database, and
// that each write goes through its atomic database function with the right
// arguments. The Supabase admin client is a small in-memory fake.

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
  rpcCalls: { name: string; args: Row }[];
  rpcResult: { data: unknown; error: { message: string; code?: string } | null };
  updates: { table: string; patch: Row; filters: [string, string, unknown][] }[];
} = {
  flag: true,
  actor: null,
  device: null,
  request: null,
  items: [],
  profiles: [],
  rpcCalls: [],
  rpcResult: { data: null, error: null },
  updates: [],
};

vi.mock('@/lib/flags', () => ({
  flags: new Proxy({}, { get: (_t, key) => (key === 'inventory' ? state.flag : true) }),
}));
vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/api/device', () => ({ getEnrolledDevice: () => Promise.resolve(state.device) }));
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve(state.device ? 'pos' : 'web') }));
vi.mock('@/lib/staff/displayName', () => ({ getStaffDisplayNames: () => Promise.resolve(new Map()) }));
vi.mock('@/lib/cash/date', () => ({ istBusinessDate: () => '2026-09-26' }));

function makeAdmin() {
  return {
    rpc: (name: string, args: Row) => {
      state.rpcCalls.push({ name, args });
      return Promise.resolve(state.rpcResult);
    },
    from: (table: string) => {
      const filters: [string, string, unknown][] = [];
      let patch: Row | null = null;
      const rows = (): Row[] => {
        if (table === 'stock_requests') return state.request ? [state.request] : [];
        if (table === 'inventory_items') return state.items;
        if (table === 'profiles') return state.profiles;
        return [];
      };
      const matching = () =>
        rows().filter((r) =>
          filters.every(([op, col, val]) =>
            op === 'eq' ? r[col] === val : op === 'in' ? (val as unknown[]).includes(r[col]) : true,
          ),
        );
      const chain: Record<string, unknown> = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        gt: () => chain,
        eq: (col: string, val: unknown) => {
          filters.push(['eq', col, val]);
          return chain;
        },
        in: (col: string, val: unknown[]) => {
          filters.push(['in', col, val]);
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
        then: (resolve: (v: unknown) => void) => resolve({ data: matching(), error: null }),
      };
      return chain;
    },
  };
}
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => makeAdmin() }));

const requestsRoute = await import('@/app/api/inventory/requests/route');
const requestRoute = await import('@/app/api/inventory/requests/[id]/route');
const receiptsRoute = await import('@/app/api/inventory/receipts/route');

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
