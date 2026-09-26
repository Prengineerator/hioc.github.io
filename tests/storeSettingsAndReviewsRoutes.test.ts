import { beforeEach, describe, expect, it, vi } from 'vitest';

// PIN-3 — PATCH /api/store-settings and GET/PATCH /api/reviews[/id]
// migrated to getCounterActor(). None had a route test before.

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
} = { actor: null };

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.actor),
  getAuthUser: () => Promise.resolve(null),
}));

vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () => Promise.resolve({ gst_percent: 5 }),
  sanitizeSettingsPatch: (body: Record<string, unknown>) => body,
  updateStoreSettings: (patch: Record<string, unknown>) => Promise.resolve({ ...patch, id: 's1' }),
}));
vi.mock('@/lib/store/hours', () => ({ computeStoreOpenState: () => ({ acceptingOrders: true, reason: null }) }));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        update: () => chain,
        maybeSingle: () => Promise.resolve({ data: { id: 'review-1' }, error: null }),
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      });
      return chain;
    },
  }),
}));

const { PATCH: patchStoreSettings } = await import('@/app/api/store-settings/route');
const { GET: getReviews } = await import('@/app/api/reviews/route');
const { PATCH: patchReview } = await import('@/app/api/reviews/[id]/route');

const REVIEW_ID = '11111111-1111-1111-1111-111111111111';

beforeEach(() => {
  state.actor = null;
});

describe('PATCH /api/store-settings', () => {
  function req(body: unknown) {
    return new Request('https://hioc.in/api/store-settings', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('401s with no session and no operator', async () => {
    expect((await patchStoreSettings(req({ accepting_orders: false }))).status).toBe(401);
  });

  it('PIN-3: an enrolled-device operator (no classic session) can flip the busy toggle', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    const res = await patchStoreSettings(req({ accepting_orders: false }));
    expect(res.status).toBe(200);
  });

  it('only a manager or the owner can allow ordering on the staff website', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    expect((await patchStoreSettings(req({ staff_web_ordering: true }))).status).toBe(403);
    state.actor = { user: { id: 'mgr' }, role: 'manager', via: 'session' };
    expect((await patchStoreSettings(req({ staff_web_ordering: true }))).status).toBe(200);
    expect((await patchStoreSettings(req({ staff_web_ordering: 'yes' }))).status).toBe(400);
  });
});

describe('GET /api/reviews (moderation list, no order_id)', () => {
  it('401s with no session and no operator', async () => {
    const res = await getReviews(new Request('https://hioc.in/api/reviews'));
    expect(res.status).toBe(401);
  });

  it('PIN-3: an enrolled-device operator can see the moderation list', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    const res = await getReviews(new Request('https://hioc.in/api/reviews'));
    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/reviews/[id]', () => {
  const ctx = { params: { id: REVIEW_ID } };
  function req(body: unknown) {
    return new Request(`https://hioc.in/api/reviews/${REVIEW_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('401s with no session and no operator', async () => {
    expect((await patchReview(req({ hidden: true }), ctx)).status).toBe(401);
  });

  it('PIN-3: an enrolled-device operator can moderate a review', async () => {
    state.actor = { user: { id: 'ravi' }, role: 'staff', via: 'device' };
    const res = await patchReview(req({ hidden: true }), ctx);
    expect(res.status).toBe(200);
  });
});
