import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-3 — POST /api/orders/[id]/refund migrated to getCounterActor(). Focus:
// the auth + permission gate (classic session OR enrolled-device operator,
// hasPermission('refund', roleHint)) for the COUNTER-refund path (no gateway
// payment on the order), which is the common case at a till.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  permitted: boolean;
  order: Record<string, unknown> | null;
  refundInsert?: Record<string, unknown>;
} = { actor: null, permitted: true, order: null };

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));

const hasPermissionCalls: unknown[][] = [];
vi.mock('@/lib/permissions', () => ({
  hasPermission: (...args: unknown[]) => {
    hasPermissionCalls.push(args);
    return Promise.resolve(state.permitted);
  },
}));

vi.mock('@/lib/payments/gateway', () => ({ createGatewayRefund: () => Promise.resolve(null) }));
vi.mock('@/lib/loyalty/ledger', () => ({ reverseForOrder: () => Promise.resolve() }));
vi.mock('@/lib/orders/idempotency', () => ({ readIdempotencyKey: () => null }));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        in: () => chain,
        insert: (row: Record<string, unknown>) => {
          if (table === 'refunds') state.refundInsert = row;
          return chain;
        },
        update: () => chain,
        maybeSingle: () => {
          if (table === 'orders') return Promise.resolve({ data: state.order, error: null });
          if (table === 'payments') return Promise.resolve({ data: null, error: null }); // no gateway payment -> counter path
          return Promise.resolve({ data: null, error: null });
        },
        single: () => Promise.resolve({ data: { ...state.refundInsert, id: 'refund-1' }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      });
      return chain;
    },
  }),
}));

const { POST } = await import('@/app/api/orders/[id]/refund/route');

const ORDER_ID = '11111111-1111-1111-1111-111111111111';
function req(body: unknown) {
  return new Request(`https://hioc.in/api/orders/${ORDER_ID}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const call = (body: unknown) => POST(req(body), { params: { id: ORDER_ID } });

beforeEach(() => {
  state.actor = null;
  state.permitted = true;
  state.order = { id: ORDER_ID, payment_status: 'paid', payment_method: 'cash', total_inr: 200, subtotal_inr: 200 };
  state.refundInsert = undefined;
  hasPermissionCalls.length = 0;
});

describe('POST /api/orders/[id]/refund', () => {
  it('401s with no session and no operator', async () => {
    const res = await call({ reason: 'wrong item' });
    expect(res.status).toBe(401);
  });

  it('403s a permitted-false caller (e.g. plain staff, refund defaults to manager)', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.permitted = false;
    const res = await call({ reason: 'wrong item' });
    expect(res.status).toBe(403);
  });

  it('refunds for a classic manager session', async () => {
    state.actor = { user: { id: 'mgr-1' }, role: 'manager', via: 'session' };
    const res = await call({ reason: 'wrong item' });
    expect(res.status).toBe(200);
    expect(state.refundInsert?.created_by).toBe('mgr-1');
  });

  it('PIN-3: an enrolled-device manager operator (no classic session) can refund too', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'manager', via: 'device' };
    const res = await call({ reason: 'wrong item' });
    expect(res.status).toBe(200);
    expect(state.refundInsert?.created_by).toBe('ravi');
  });

  it('passes the operator role as hasPermission()\'s roleHint', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'manager', via: 'device' };
    await call({ reason: 'wrong item' });
    expect(hasPermissionCalls[0]).toEqual([{ id: 'ravi' }, 'refund', 'manager']);
  });
});
