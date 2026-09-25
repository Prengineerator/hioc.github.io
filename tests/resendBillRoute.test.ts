import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-3 — POST /api/orders/[id]/resend-bill migrated to getCounterActor().
// Focus: the auth gate (classic session OR enrolled-device operator, neither
// -> 401), the uuid/not-found guards, and the rate limit — the send itself is
// sendBillNotification's job, already covered elsewhere.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  rateLimitAllowed: boolean;
  order: Record<string, unknown> | null;
  sendResult: { whatsapp: string; email: string; reasons: Record<string, string> };
} = {
  actor: null,
  rateLimitAllowed: true,
  order: { id: 'order-1' },
  sendResult: { whatsapp: 'sent', email: 'sent', reasons: {} },
};

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/api/rateLimit', () => ({ rateLimitOk: () => Promise.resolve(state.rateLimitAllowed) }));
vi.mock('@/lib/orders/getOrder', () => ({ getOrderWithCoupon: () => Promise.resolve(state.order) }));
vi.mock('@/lib/notifications/engine', () => ({ sendBillNotification: () => Promise.resolve(state.sendResult) }));

const { POST } = await import('@/app/api/orders/[id]/resend-bill/route');

const VALID_ID = '11111111-1111-1111-1111-111111111111';
function ctx(id: string) {
  return { params: { id } };
}

beforeEach(() => {
  state.actor = null;
  state.rateLimitAllowed = true;
  state.order = { id: 'order-1' };
  state.sendResult = { whatsapp: 'sent', email: 'sent', reasons: {} };
});

describe('POST /api/orders/[id]/resend-bill', () => {
  it('401s with no session and no operator', async () => {
    const res = await POST(new Request('https://x'), ctx(VALID_ID));
    expect(res.status).toBe(401);
  });

  it('404s a malformed id before touching the database', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    const res = await POST(new Request('https://x'), ctx('not-a-uuid'));
    expect(res.status).toBe(404);
  });

  it('429s when the rate limit is exceeded', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.rateLimitAllowed = false;
    const res = await POST(new Request('https://x'), ctx(VALID_ID));
    expect(res.status).toBe(429);
  });

  it('404s when the order does not exist', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    state.order = null;
    const res = await POST(new Request('https://x'), ctx(VALID_ID));
    expect(res.status).toBe(404);
  });

  it('resends for a classic staff session', async () => {
    state.actor = { user: { id: 'staff-1' }, role: 'staff', via: 'session' };
    const res = await POST(new Request('https://x'), ctx(VALID_ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toEqual({ whatsapp: 'sent', email: 'sent' });
  });

  it('PIN-3: resends for an enrolled-device operator with no classic session', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    const res = await POST(new Request('https://x'), ctx(VALID_ID));
    expect(res.status).toBe(200);
  });
});
