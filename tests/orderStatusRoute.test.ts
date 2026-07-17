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
} = { actor: null, current: null, updated: null };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: () => {
      const ctx = { isUpdate: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          state.patch = p;
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          state.eventRow = row;
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
  actorRoleFor: (role: string) => (role === 'owner' ? 'owner' : 'staff'),
}));
vi.mock('@/lib/notifications/engine', () => ({ sendOrderNotification: () => Promise.resolve({ sent: true }) }));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));
vi.mock('@/lib/store/settings', () => ({ getStoreSettings: () => Promise.resolve({ default_prep_min: 15 }) }));

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
  state.current = { id: UUID, status: 'received', version: 0, customer_phone: '+919000000000', order_number: 1001 };
  state.updated = { id: UUID, status: 'accepted', version: 1, order_number: 1001, customer_phone: '+919000000000', pickup_code: '1234', promised_ready_at: null, reject_reason: '' };
  state.patch = undefined;
  state.eventRow = undefined;
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
});
