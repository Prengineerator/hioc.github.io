import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level test for GET /api/cron/suggest-digest, mirroring
// tests/expireOrdersRoute.test.ts's mocking style: mock Supabase and the
// digest/queries modules so the route's CRON_SECRET gate and its
// store-a-digest-row behaviour are exercised without network or DB.

const state: { inserted: Record<string, unknown>[] } = { inserted: [] };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => ({
      insert: (row: Record<string, unknown>) => {
        state.inserted.push(row);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

vi.mock('@/lib/suggest/queries', () => ({
  getSuggestionStats: () =>
    Promise.resolve({
      stats: { sessions: 3, sessionsWithAdd: 1, sessionsCheckout: 1, sessionsOrdered: 1 },
      missingTables: false,
    }),
}));

vi.mock('@/lib/suggest/digest', () => ({
  generateWeeklyDigest: () =>
    Promise.resolve({ summary: 'Template summary with 3 bullets.', source: 'template', model: null, costUsdMicros: 0 }),
}));

process.env.CRON_SECRET = 'cron_secret';

// Imported after mocks are registered (vi.mock is hoisted).
const { GET } = await import('@/app/api/cron/suggest-digest/route');

const run = (headers: Record<string, string> = { authorization: 'Bearer cron_secret' }) =>
  GET(new Request('http://localhost/api/cron/suggest-digest', { headers }));

beforeEach(() => {
  state.inserted = [];
});

describe('GET /api/cron/suggest-digest', () => {
  it('401s with no authorization header', async () => {
    const res = await run({});
    expect(res.status).toBe(401);
    expect(state.inserted).toEqual([]);
  });

  it('401s with the wrong secret', async () => {
    const res = await run({ authorization: 'Bearer wrong-secret' });
    expect(res.status).toBe(401);
    expect(state.inserted).toEqual([]);
  });

  it('fails closed when CRON_SECRET is unset', async () => {
    const prev = process.env.CRON_SECRET;
    delete process.env.CRON_SECRET;
    try {
      const res = await run({ authorization: 'Bearer cron_secret' });
      expect(res.status).toBe(401);
      expect(state.inserted).toEqual([]);
    } finally {
      process.env.CRON_SECRET = prev;
    }
  });

  it('computes the week and stores a digest row on success', async () => {
    const res = await run();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, source: 'template', sessions: 3 });

    expect(state.inserted).toHaveLength(1);
    const row = state.inserted[0];
    expect(row.source).toBe('template');
    expect(row.model).toBeNull();
    expect(row.summary).toBe('Template summary with 3 bullets.');
    expect(typeof row.week_start).toBe('string');
    expect(row.week_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
