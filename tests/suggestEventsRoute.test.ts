import { beforeEach, describe, expect, it, vi } from 'vitest';

// Phase 7 · SUG-9 — POST /api/suggest/events.

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const MENU_ITEM_ID = '22222222-2222-4222-8222-222222222222';

const state: {
  session: { id: string; created_at: string } | null;
  inserted: Record<string, unknown>[];
  rateLimitOk: boolean;
  suggestFlag: boolean;
} = { session: null, inserted: [], rateLimitOk: true, suggestFlag: true };

vi.mock('@/lib/flags', () => ({
  flags: {
    get suggest() {
      return state.suggestFlag;
    },
  },
}));

vi.mock('@/lib/api/rateLimit', () => ({
  clientIp: () => '127.0.0.1',
  rateLimitOk: () => Promise.resolve(state.rateLimitOk),
}));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        maybeSingle: () => {
          if (table === 'suggestion_sessions') return Promise.resolve({ data: state.session, error: null });
          return Promise.resolve({ data: null, error: null });
        },
        insert: (payload: Record<string, unknown>) => {
          if (table === 'suggestion_events') {
            state.inserted.push(payload);
            return Promise.resolve({ error: null });
          }
          return Promise.resolve({ error: null });
        },
      });
      return chain;
    },
  }),
}));

const { POST } = await import('@/app/api/suggest/events/route');

function post(body: unknown) {
  return POST(
    new Request('http://t/api/suggest/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.session = { id: SESSION_ID, created_at: new Date().toISOString() };
  state.inserted = [];
  state.rateLimitOk = true;
  state.suggestFlag = true;
});

describe('POST /api/suggest/events', () => {
  it('rejects "ordered" — server-only (playbook S-4)', async () => {
    const res = await post({ sessionId: SESSION_ID, event: 'ordered' });
    expect(res.status).toBe(400);
    expect(state.inserted).toEqual([]);
  });

  it('rejects "shown" — also server-only', async () => {
    const res = await post({ sessionId: SESSION_ID, event: 'shown' });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown event name', async () => {
    const res = await post({ sessionId: SESSION_ID, event: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('rejects a malformed sessionId', async () => {
    const res = await post({ sessionId: 'not-a-uuid', event: 'added_to_cart' });
    expect(res.status).toBe(400);
  });

  it('404s for a session that does not exist', async () => {
    state.session = null;
    const res = await post({ sessionId: SESSION_ID, event: 'added_to_cart' });
    expect(res.status).toBe(404);
    expect(state.inserted).toEqual([]);
  });

  it('404s for a session older than the max age', async () => {
    state.session = { id: SESSION_ID, created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() };
    const res = await post({ sessionId: SESSION_ID, event: 'added_to_cart' });
    expect(res.status).toBe(404);
  });

  it('accepts a good event and returns 204', async () => {
    const res = await post({ sessionId: SESSION_ID, event: 'added_to_cart', menuItemId: MENU_ITEM_ID });
    expect(res.status).toBe(204);
    expect(state.inserted).toEqual([{ session_id: SESSION_ID, event: 'added_to_cart', menu_item_id: MENU_ITEM_ID }]);
  });

  it('accepts a good event with no menuItemId', async () => {
    const res = await post({ sessionId: SESSION_ID, event: 'browse_menu' });
    expect(res.status).toBe(204);
    expect(state.inserted).toEqual([{ session_id: SESSION_ID, event: 'browse_menu', menu_item_id: null }]);
  });

  it('rejects a malformed menuItemId', async () => {
    const res = await post({ sessionId: SESSION_ID, event: 'feedback_up', menuItemId: 'not-a-uuid' });
    expect(res.status).toBe(400);
  });

  it('429s when rate-limited', async () => {
    state.rateLimitOk = false;
    const res = await post({ sessionId: SESSION_ID, event: 'added_to_cart' });
    expect(res.status).toBe(429);
  });

  it('404s when the flag is off', async () => {
    state.suggestFlag = false;
    const res = await post({ sessionId: SESSION_ID, event: 'added_to_cart' });
    expect(res.status).toBe(404);
    expect(state.inserted).toEqual([]);
  });
});
