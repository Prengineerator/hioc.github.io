import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET/PUT /api/pos/kot-routing. What it guards: every counter actor can SEE
// where each category's slip goes, but only a manager or the owner can change
// it, and nothing reaches the database without normalizeKotRouting().

const state: {
  actor: { user: { id: string }; role: string; via: string } | null;
  stored: unknown;
  readError: { code?: string; message: string } | null;
  updated?: Record<string, unknown>;
  updateError: { code?: string; message: string } | null;
} = { actor: null, stored: null, readError: null, updateError: null };

vi.mock('@/lib/api/auth', () => ({ getCounterActor: () => Promise.resolve(state.actor) }));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        update: (payload: Record<string, unknown>) => {
          state.updated = payload;
          return chain;
        },
        maybeSingle: () =>
          Promise.resolve(
            state.updated
              ? state.updateError
                ? { data: null, error: state.updateError }
                : { data: { kot_routing: state.updated.kot_routing }, error: null }
              : { data: state.readError ? null : { kot_routing: state.stored }, error: state.readError },
          ),
        then: (resolve: (v: unknown) => void) =>
          resolve(
            table === 'menu_items'
              ? {
                  data: [
                    { category: 'Coffee', sort_order: 1 },
                    { category: 'Coffee', sort_order: 2 },
                    { category: 'Stick Waffles', sort_order: 3 },
                  ],
                  error: null,
                }
              : { data: null, error: null },
          ),
      });
      return chain;
    },
  }),
}));

const { GET, PUT } = await import('@/app/api/pos/kot-routing/route');

const staff = { user: { id: 'u1' }, role: 'staff', via: 'session' };
const manager = { user: { id: 'u2' }, role: 'manager', via: 'device' };

function put(body: unknown) {
  return PUT(
    new Request('http://t/api/pos/kot-routing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.actor = null;
  state.stored = { counters: [{ name: 'Bar', categories: ['Coffee'] }], full_copy: false };
  state.readError = null;
  state.updated = undefined;
  state.updateError = null;
});

describe('GET /api/pos/kot-routing', () => {
  it('401s without a counter actor', async () => {
    expect((await GET()).status).toBe(401);
  });

  it('shows staff the setup and the menu categories, read-only', async () => {
    state.actor = staff;
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      routing: state.stored,
      categories: ['Coffee', 'Stick Waffles'],
      canEdit: false,
    });
  });

  it('tells a manager they can edit', async () => {
    state.actor = manager;
    expect((await (await GET()).json()).canEdit).toBe(true);
  });

  it('reads as the default setup before the migration is applied', async () => {
    state.actor = staff;
    state.readError = { code: '42703', message: 'column store_settings.kot_routing does not exist' };
    const body = await (await GET()).json();
    expect(body.routing).toEqual({ counters: [], full_copy: false });
  });
});

describe('PUT /api/pos/kot-routing', () => {
  const valid = { counters: [{ name: ' Coffee Bar ', categories: ['Coffee'] }], full_copy: true };

  it('401s without a counter actor and 403s for plain staff, writing nothing', async () => {
    expect((await put(valid)).status).toBe(401);
    state.actor = staff;
    expect((await put(valid)).status).toBe(403);
    expect(state.updated).toBeUndefined();
  });

  it('rejects an invalid setup with its reason, writing nothing', async () => {
    state.actor = manager;
    const res = await put({
      counters: [
        { name: 'Bar', categories: ['Coffee'] },
        { name: 'Kitchen', categories: ['Coffee'] },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('"Coffee" is on both "Bar" and "Kitchen"');
    expect(state.updated).toBeUndefined();
  });

  it('saves the normalized setup for a manager', async () => {
    state.actor = manager;
    const res = await put(valid);
    expect(res.status).toBe(200);
    expect(state.updated).toEqual({
      kot_routing: { counters: [{ name: 'Coffee Bar', categories: ['Coffee'] }], full_copy: true },
    });
    expect((await res.json()).routing.counters[0].name).toBe('Coffee Bar');
  });

  it('names the migration when the column is missing', async () => {
    state.actor = manager;
    state.updateError = { code: '42703', message: 'column does not exist' };
    const res = await put(valid);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toContain('2026-09-kot-counters.sql');
  });
});
