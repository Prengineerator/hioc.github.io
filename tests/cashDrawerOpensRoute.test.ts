import { beforeEach, describe, expect, it, vi } from 'vitest';

// DRW-2 — POST/GET /api/cash-drawer/opens. What it guards: any counter actor
// can log an opening, but who opened it and on which counter come from the
// request's own session and device cookie — never the body — and only a
// manager/owner can read the log.

const ORDER_ID = '44444444-4444-4444-8444-444444444444';

const state: {
  actor: { user: { id: string }; role: string; via: string } | null;
  manager: { id: string } | null;
  device: { id: string } | null;
  inserted?: Record<string, unknown>;
  insertError: { message: string } | null;
  recent: Record<string, unknown>[];
  today: { reason: string }[];
} = { actor: null, manager: null, device: null, insertError: null, recent: [], today: [] };

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.actor),
  getManagerUser: () => Promise.resolve(state.manager),
}));
vi.mock('@/lib/api/device', () => ({ getEnrolledDevice: () => Promise.resolve(state.device) }));
vi.mock('@/lib/staff/displayName', () => ({
  getStaffDisplayNames: (_admin: unknown, ids: string[]) =>
    Promise.resolve(new Map(ids.map((id) => [id, id === 'staff-1' ? 'Ravi' : id]))),
}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        insert: (payload: Record<string, unknown>) => {
          state.inserted = payload;
          return chain;
        },
        select: () => chain,
        single: () =>
          Promise.resolve(
            state.insertError
              ? { data: null, error: state.insertError }
              : { data: { id: 'open-1', opened_at: '2026-09-26T10:00:00Z' }, error: null },
          ),
        order: () => chain,
        limit: () => Promise.resolve({ data: state.recent, error: null }),
        gte: () => Promise.resolve({ data: state.today, error: null }),
      });
      return chain;
    },
  }),
}));

const { POST, GET } = await import('@/app/api/cash-drawer/opens/route');

function post(body: unknown) {
  return POST(
    new Request('http://t/api/cash-drawer/opens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'device' };
  state.manager = null;
  state.device = { id: 'device-1' };
  state.inserted = undefined;
  state.insertError = null;
  state.recent = [];
  state.today = [];
});

describe('POST /api/cash-drawer/opens', () => {
  it('logs a manual opening against the actor and this counter', async () => {
    const res = await post({ reason: 'manual' });
    expect(res.status).toBe(201);
    expect(state.inserted).toEqual({ reason: 'manual', order_id: null, opened_by: 'staff-1', device_id: 'device-1' });
  });

  it('logs a cash-payment opening with its order', async () => {
    const res = await post({ reason: 'cash_payment', order_id: ORDER_ID });
    expect(res.status).toBe(201);
    expect(state.inserted?.order_id).toBe(ORDER_ID);
  });

  it('ignores a body that tries to name the staffer or the counter', async () => {
    await post({ reason: 'manual', opened_by: 'someone-else', device_id: 'other-device' });
    expect(state.inserted?.opened_by).toBe('staff-1');
    expect(state.inserted?.device_id).toBe('device-1');
  });

  it('records no counter when the request is not from an enrolled device', async () => {
    state.device = null;
    await post({ reason: 'manual' });
    expect(state.inserted?.device_id).toBeNull();
  });

  it('refuses anyone who is not at the counter', async () => {
    state.actor = null;
    expect((await post({ reason: 'manual' })).status).toBe(401);
    expect(state.inserted).toBeUndefined();
  });

  it('rejects an unknown reason or a malformed order id', async () => {
    expect((await post({ reason: 'because' })).status).toBe(400);
    expect((await post({ reason: 'cash_payment', order_id: 'nope' })).status).toBe(400);
    expect(state.inserted).toBeUndefined();
  });

  it('names the migration when the table is missing', async () => {
    state.insertError = { message: 'relation "cash_drawer_opens" does not exist' };
    const res = await post({ reason: 'manual' });
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain('2026-09-cash-drawer-log.sql');
  });
});

describe('GET /api/cash-drawer/opens', () => {
  it('is manager/owner only', async () => {
    const res = await GET(new Request('http://t/api/cash-drawer/opens'));
    expect(res.status).toBe(401);
  });

  it("returns today's counts by reason and the recent openings, named", async () => {
    state.manager = { id: 'owner-1' };
    state.today = [{ reason: 'cash_payment' }, { reason: 'cash_payment' }, { reason: 'manual' }];
    state.recent = [
      {
        id: 'open-2',
        opened_at: '2026-09-26T10:05:00Z',
        reason: 'manual',
        order_id: null,
        opened_by: 'staff-1',
        device_id: 'device-1',
        orders: null,
        pos_devices: { name: 'Counter 1' },
      },
      {
        id: 'open-1',
        opened_at: '2026-09-26T10:00:00Z',
        reason: 'cash_payment',
        order_id: ORDER_ID,
        opened_by: null,
        device_id: null,
        orders: [{ order_number: 42 }],
        pos_devices: null,
      },
    ];
    const res = await GET(new Request('http://t/api/cash-drawer/opens'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { today: unknown; opens: Record<string, unknown>[] };
    expect(body.today).toEqual({ total: 3, cashPayment: 2, manual: 1 });
    expect(body.opens[0]).toMatchObject({ reason: 'manual', openedByName: 'Ravi', deviceName: 'Counter 1' });
    expect(body.opens[1]).toMatchObject({ reason: 'cash_payment', orderNumber: 42, openedByName: 'Unknown staff' });
  });
});
