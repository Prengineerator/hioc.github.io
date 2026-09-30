import { beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH /api/orders/[id]/status and the SALE of a HIOC Ritual pass
// (docs/COFFEE-PASS-SPEC.md §7). A pass sale has no kitchen steps: a database
// trigger completes it the moment it is paid, so the route refuses every
// transition except withdrawing an UNPAID sale, and it must do so BEFORE the
// manager-comp logic, because a comp writes payment_status = 'paid' and paying a
// pass sale is what issues the pass. Mirrors the harness in
// tests/orderStatusRoute.test.ts.

const state: {
  actor: { user: { id: string }; role: string } | null;
  current: Record<string, unknown> | null;
  updated: Record<string, unknown> | null;
  patch?: Record<string, unknown>;
  eventRow?: Record<string, unknown>;
  compPatch?: Record<string, unknown>;
  amendmentRow?: Record<string, unknown>;
  selectArgs: string[];
} = { actor: null, current: null, updated: null, selectArgs: [] };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: (cols: string) => {
          if (table === 'orders') state.selectArgs.push(cols);
          return chain;
        },
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          if (table === 'orders' && !('status' in p)) state.compPatch = p;
          else state.patch = p;
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          if (table === 'order_amendments') state.amendmentRow = row;
          else state.eventRow = row;
          return Promise.resolve({ error: null });
        },
        eq: () => chain,
        maybeSingle: () =>
          Promise.resolve(ctx.isUpdate ? { data: state.updated, error: null } : { data: state.current, error: null }),
        single: () => Promise.resolve({ data: state.current, error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.actor),
  actorRoleFor: (role: string) => (role === 'owner' || role === 'manager' ? 'owner' : 'staff'),
}));
vi.mock('@/lib/permissions', () => ({
  hasPermission: (_user: unknown, _key: string, roleHint?: string) =>
    Promise.resolve(roleHint === 'owner' || roleHint === 'manager'),
}));
const spies = vi.hoisted(() => ({
  sendBillNotification: vi.fn(() => Promise.resolve()),
  sendOrderNotification: vi.fn(() => Promise.resolve({ sent: true })),
  earnForOrder: vi.fn(() => Promise.resolve()),
  reverseForOrder: vi.fn(() => Promise.resolve()),
  consumeStockForOrder: vi.fn((_orderId: string, _actorId: string | null) => Promise.resolve()),
  enqueueFeedbackRequest: vi.fn(() => Promise.resolve()),
}));
vi.mock('@/lib/notifications/engine', () => ({
  sendOrderNotification: spies.sendOrderNotification,
  sendBillNotification: spies.sendBillNotification,
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));
vi.mock('@/lib/store/settings', () => ({ getStoreSettings: () => Promise.resolve({ default_prep_min: 15 }) }));
vi.mock('@/lib/loyalty/ledger', () => ({ earnForOrder: spies.earnForOrder, reverseForOrder: spies.reverseForOrder }));
vi.mock('@/lib/inventory/server', () => ({ consumeStockForOrder: spies.consumeStockForOrder }));
vi.mock('@/lib/feedback/enqueue', () => ({ enqueueFeedbackRequest: spies.enqueueFeedbackRequest }));

const { PATCH } = await import('@/app/api/orders/[id]/status/route');

const UUID = '3642e4aa-a517-4885-99bd-543376074602';
const params = { params: { id: UUID } };
const req = (body: unknown) =>
  new Request(`http://t/api/orders/${UUID}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// A pass sale as the POS creates it: staff_pos, accepted, unpaid. (Online: placed, payment_pending.)
const passSale = (over: Record<string, unknown> = {}) => ({
  id: UUID,
  status: 'accepted',
  version: 2,
  customer_phone: '+919000000000',
  order_number: 2001,
  order_type: 'takeaway',
  payment_status: 'unpaid',
  order_kind: 'coffee_pass',
  ...over,
});

const NO_KITCHEN = 'A HIOC Ritual sale has no kitchen steps.';

beforeEach(() => {
  vi.clearAllMocks();
  state.actor = { user: { id: 'staff-1' }, role: 'staff' };
  state.current = passSale();
  state.updated = passSale({ status: 'cancelled', version: 3 });
  state.patch = undefined;
  state.eventRow = undefined;
  state.compPatch = undefined;
  state.amendmentRow = undefined;
  state.selectArgs = [];
});

describe('PATCH /api/orders/[id]/status — a HIOC Ritual sale', () => {
  it.each(['preparing', 'ready', 'completed', 'rejected', 'received', 'placed'])(
    'refuses accepted → %s with a 409 and writes nothing',
    async (to) => {
      const res = await PATCH(req({ status: to, reason: 'x' }), params);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(NO_KITCHEN);
      expect(state.patch).toBeUndefined();
      expect(state.eventRow).toBeUndefined();
    },
  );

  it('refuses every step for a sale that is already paid, even cancel (undo it by refunding it)', async () => {
    state.current = passSale({ status: 'completed', payment_status: 'paid' });
    for (const to of ['cancelled', 'preparing', 'accepted']) {
      const res = await PATCH(req({ status: to, reason: 'x' }), params);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(NO_KITCHEN);
    }
    expect(state.patch).toBeUndefined();
  });

  it('refuses the manager comp BEFORE it writes: no payment_status = paid, no audit row, so no free pass is issued', async () => {
    state.actor = { user: { id: 'mgr-1' }, role: 'owner' };
    state.current = passSale({ status: 'ready' });
    const res = await PATCH(req({ status: 'completed', comp: { reason: 'On the house' } }), params);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(NO_KITCHEN);
    expect(state.compPatch).toBeUndefined(); // the write that would have issued the pass
    expect(state.amendmentRow).toBeUndefined();
    expect(state.patch).toBeUndefined();
  });

  it('never earns Beanies, takes stock, asks for feedback or sends a bill for a refused completion', async () => {
    state.current = passSale({ status: 'ready', payment_status: 'paid' });
    const res = await PATCH(req({ status: 'completed' }), params);
    expect(res.status).toBe(409);
    expect(spies.earnForOrder).not.toHaveBeenCalled();
    expect(spies.consumeStockForOrder).not.toHaveBeenCalled();
    expect(spies.enqueueFeedbackRequest).not.toHaveBeenCalled();
    expect(spies.sendBillNotification).not.toHaveBeenCalled();
  });

  it('lets staff withdraw an UNPAID sale (accepted → cancelled with a reason)', async () => {
    const res = await PATCH(req({ status: 'cancelled', reason: 'Customer changed their mind' }), params);
    expect(res.status).toBe(200);
    expect(state.patch).toMatchObject({ status: 'cancelled', reject_reason: 'Customer changed their mind', version: 3 });
    expect(state.eventRow).toMatchObject({ from_status: 'accepted', to_status: 'cancelled' });
    // Still no completion hooks (this is a cancel, and the sale earned nothing).
    expect(spies.earnForOrder).not.toHaveBeenCalled();
    expect(spies.consumeStockForOrder).not.toHaveBeenCalled();
    expect(spies.enqueueFeedbackRequest).not.toHaveBeenCalled();
  });

  it("the state machine still has the last word on an unpaid cancel (one it does not allow a staffer stays refused)", async () => {
    // Cancelling a 'preparing' order is the owner's call: that rule is the machine's, unchanged.
    state.current = passSale({ status: 'preparing' });
    const res = await PATCH(req({ status: 'cancelled', reason: 'x' }), params);
    expect(res.status).toBe(403);
    expect(state.patch).toBeUndefined();
  });

  it('an online sale still waiting on the gateway (payment_pending) is not withdrawn from here: the expiry sweep owns that', async () => {
    state.current = passSale({ status: 'placed', payment_status: 'payment_pending' });
    const res = await PATCH(req({ status: 'cancelled', reason: 'x' }), params);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(NO_KITCHEN);
  });

  it('answers the same-status no-op like any order (nothing is written)', async () => {
    const res = await PATCH(req({ status: 'accepted' }), params);
    expect(res.status).toBe(200);
    expect(state.patch).toBeUndefined();
  });
});

describe('PATCH /api/orders/[id]/status — everything else is unchanged', () => {
  const menuOrder = (over: Record<string, unknown> = {}) => ({
    id: UUID,
    status: 'ready',
    version: 3,
    customer_phone: '+919000000000',
    order_number: 1002,
    order_type: 'dine_in',
    payment_status: 'paid',
    order_kind: 'menu',
    ...over,
  });

  it('a menu order completes and runs every hook, as before', async () => {
    state.current = menuOrder();
    state.updated = menuOrder({ status: 'completed', version: 4 });
    const res = await PATCH(req({ status: 'completed' }), params);
    expect(res.status).toBe(200);
    expect(spies.earnForOrder).toHaveBeenCalledWith(UUID);
    expect(spies.consumeStockForOrder).toHaveBeenCalledWith(UUID, 'staff-1');
    expect(spies.enqueueFeedbackRequest).toHaveBeenCalledTimes(1);
    expect(spies.sendBillNotification).toHaveBeenCalledTimes(1);
  });

  it('an order with no order_kind at all (a database before the migration) is a menu order', async () => {
    const { order_kind: _kind, ...legacy } = menuOrder();
    void _kind;
    state.current = legacy;
    state.updated = { ...legacy, status: 'completed', version: 4 };
    const res = await PATCH(req({ status: 'completed' }), params);
    expect(res.status).toBe(200);
    expect(spies.earnForOrder).toHaveBeenCalledTimes(1);
  });

  it('reads the order with `*`, so the route keeps working on a database without order_kind', async () => {
    state.current = menuOrder();
    state.updated = menuOrder({ status: 'completed', version: 4 });
    await PATCH(req({ status: 'completed' }), params);
    expect(state.selectArgs[0]).toBe('*');
  });
});
