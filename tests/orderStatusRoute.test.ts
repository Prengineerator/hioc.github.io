import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level integration test for PATCH /api/orders/[id]/status (F1t). Mocks
// the Supabase admin client, auth, notifications, and broadcast so the actual
// route handler's decision logic — auth gate, transition validation, guarded
// update, event write — is exercised end-to-end without a live DB.

// Shared, per-test mutable state the mocks read from.
const state: {
  actor: { user: { id: string }; role: string } | null;
  current: Record<string, unknown> | null;
  updated: Record<string, unknown> | null;
  patch?: Record<string, unknown>;
  eventRow?: Record<string, unknown>;
  compPatch?: Record<string, unknown>; // the FND3-5 payment_status='paid' comp write
  amendmentRow?: Record<string, unknown>; // the order_amendments comp audit row
} = { actor: null, current: null, updated: null };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          // The main guarded transition write carries status+version; the FND3-5
          // comp override is a bare payment_status='paid' write (no status).
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
          Promise.resolve(
            ctx.isUpdate ? { data: state.updated, error: null } : { data: state.current, error: null },
          ),
        single: () => Promise.resolve({ data: state.current, error: null }),
      });
      return chain;
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({
  getStaffOrOwner: () => Promise.resolve(state.actor),
  actorRoleFor: (role: string) => (role === 'owner' || role === 'manager' ? 'owner' : 'staff'),
  // FND3-5 comp gate: a manager/owner session resolves to a user, staff → null.
  getManagerUser: () =>
    Promise.resolve(
      state.actor && (state.actor.role === 'owner' || state.actor.role === 'manager')
        ? state.actor.user
        : null,
    ),
}));
// RCT-1: the route fires sendBillNotification at settle (to === 'completed').
// Hoisted so the vi.mock factory can reference the spy, and so tests can assert
// on it.
const { sendBillNotification } = vi.hoisted(() => ({
  sendBillNotification: vi.fn(() => Promise.resolve({ email: false, whatsapp: false })),
}));
vi.mock('@/lib/notifications/engine', () => ({
  sendOrderNotification: () => Promise.resolve({ sent: true }),
  sendBillNotification,
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));
vi.mock('@/lib/store/settings', () => ({ getStoreSettings: () => Promise.resolve({ default_prep_min: 15 }) }));
// Phase-2 added loyalty earn/reverse hooks to the status route; mock them so the
// route imports without pulling in the real (server-only) ledger module.
vi.mock('@/lib/loyalty/ledger', () => ({
  earnForOrder: () => Promise.resolve(),
  reverseForOrder: () => Promise.resolve(),
}));

// Imported after mocks are registered (vi.mock is hoisted).
const { PATCH } = await import('@/app/api/orders/[id]/status/route');

const UUID = '3642e4aa-a517-4885-99bd-543376074602';
const params = { params: { id: UUID } };
function req(body: unknown) {
  return new Request(`http://t/api/orders/${UUID}/status`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  state.actor = { user: { id: 'staff-1' }, role: 'staff' };
  state.current = { id: UUID, status: 'received', version: 0, customer_phone: '+919000000000', order_number: 1001, order_type: 'takeaway', payment_status: 'unpaid' };
  state.updated = { id: UUID, status: 'accepted', version: 1, order_number: 1001, customer_phone: '+919000000000', order_type: 'takeaway', payment_status: 'unpaid', pickup_code: '1234', promised_ready_at: null, reject_reason: '' };
  state.patch = undefined;
  state.eventRow = undefined;
  state.compPatch = undefined;
  state.amendmentRow = undefined;
  sendBillNotification.mockClear();
});

describe('PATCH /api/orders/[id]/status', () => {
  it('401s when there is no staff/owner session', async () => {
    state.actor = null;
    const res = await PATCH(req({ status: 'accepted' }), params);
    expect(res.status).toBe(401);
  });

  it('accepts a valid received → accepted transition and writes an event', async () => {
    const res = await PATCH(req({ status: 'accepted' }), params);
    expect(res.status).toBe(200);
    expect(state.patch?.status).toBe('accepted');
    expect(state.patch?.version).toBe(1); // current.version + 1
    expect(state.eventRow?.to_status).toBe('accepted');
    expect(state.eventRow?.actor_id).toBe('staff-1');
  });

  it('409s an illegal transition (completed → preparing) and writes no event', async () => {
    state.current = { ...state.current!, status: 'completed' };
    const res = await PATCH(req({ status: 'preparing' }), params);
    expect(res.status).toBe(409);
    expect(state.eventRow).toBeUndefined();
  });

  it('400s a reject with no reason', async () => {
    const res = await PATCH(req({ status: 'rejected' }), params);
    expect(res.status).toBe(400);
  });

  it('accepts a reject when a reason is provided and records it', async () => {
    state.updated = { ...state.updated!, status: 'rejected', reject_reason: 'out of stock' };
    const res = await PATCH(req({ status: 'rejected', reason: 'out of stock' }), params);
    expect(res.status).toBe(200);
    expect(state.patch?.reject_reason).toBe('out of stock');
    expect(state.eventRow?.to_status).toBe('rejected');
  });

  it('409s when the guarded update matches no row (lost optimistic race)', async () => {
    state.updated = null; // guarded update returns no row
    const res = await PATCH(req({ status: 'accepted' }), params);
    expect(res.status).toBe(409);
  });

  // RCT-1: the settled bill fires only when a transition COMPLETES an order.
  it('fires the settle bill (RCT-1) on a completing transition', async () => {
    // paid dine_in ready → completed (a legal settle; the staff order skipped
    // the placement send, so this delivers its bill).
    state.current = {
      id: UUID, status: 'ready', version: 3, customer_phone: '+919000000000',
      order_number: 1002, order_type: 'dine_in', payment_status: 'paid',
    };
    state.updated = { ...state.current, status: 'completed', version: 4 };
    const res = await PATCH(req({ status: 'completed' }), params);
    expect(res.status).toBe(200);
    expect(sendBillNotification).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire the settle bill on a non-completing transition', async () => {
    // received → accepted (default fixture) settles nothing.
    const res = await PATCH(req({ status: 'accepted' }), params);
    expect(res.status).toBe(200);
    expect(sendBillNotification).not.toHaveBeenCalled();
  });

  // FND3-5: dine-in must be settled before it completes (guard → 409), unless a
  // manager comps it. Takeaway (default fixture) is unaffected by these rules.
  describe('dine-in settlement (FND3-5)', () => {
    const readyDineIn = (paymentStatus: string) => ({
      id: UUID,
      status: 'ready',
      version: 3,
      customer_phone: null,
      order_number: 1002,
      order_type: 'dine_in',
      payment_status: paymentStatus,
    });

    it('409s an unpaid dine_in ready → completed and writes no event', async () => {
      state.current = readyDineIn('unpaid');
      const res = await PATCH(req({ status: 'completed' }), params);
      expect(res.status).toBe(409);
      expect(state.eventRow).toBeUndefined();
    });

    it('200s a paid dine_in ready → completed', async () => {
      state.current = readyDineIn('paid');
      state.updated = { ...readyDineIn('paid'), status: 'completed', version: 4 };
      const res = await PATCH(req({ status: 'completed' }), params);
      expect(res.status).toBe(200);
      expect(state.patch?.status).toBe('completed');
    });

    it('403s a comp attempt by a non-manager staffer', async () => {
      state.actor = { user: { id: 'staff-1' }, role: 'staff' };
      state.current = readyDineIn('unpaid');
      const res = await PATCH(req({ status: 'completed', comp: { reason: 'on the house' } }), params);
      expect(res.status).toBe(403);
      expect(state.compPatch).toBeUndefined();
      expect(state.amendmentRow).toBeUndefined();
    });

    it('lets a manager comp an unpaid dine_in to completion (paid + audited)', async () => {
      state.actor = { user: { id: 'mgr-1' }, role: 'owner' };
      state.current = readyDineIn('unpaid');
      state.updated = { ...readyDineIn('paid'), status: 'completed', version: 4 };
      const res = await PATCH(
        req({ status: 'completed', comp: { reason: 'VIP on the house' } }),
        params,
      );
      expect(res.status).toBe(200);
      expect(state.compPatch?.payment_status).toBe('paid'); // paid-equivalent set
      expect(state.amendmentRow?.kind).toBe('comp'); // audit row written
      expect(state.amendmentRow?.staff_id).toBe('mgr-1');
      expect((state.amendmentRow?.payload as { reason: string }).reason).toBe('VIP on the house');
      expect(state.patch?.status).toBe('completed'); // then the transition lands
    });

    it('400s a manager comp with an empty reason', async () => {
      state.actor = { user: { id: 'mgr-1' }, role: 'owner' };
      state.current = readyDineIn('unpaid');
      const res = await PATCH(req({ status: 'completed', comp: { reason: '  ' } }), params);
      expect(res.status).toBe(400);
    });
  });
});
