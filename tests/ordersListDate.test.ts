import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/orders?date=YYYY-MM-DD — the Orders tab's date filter. A real,
// non-future IST day selects every order placed on that day (its IST
// midnight-to-midnight window in UTC); without it the board stays "today".

const state: { filters: [string, string, unknown][] } = { filters: [] };

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve({ user: { id: 'staff-1' }, role: 'staff', via: 'session' }),
}));
vi.mock('@/lib/api/date', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/date')>('@/lib/api/date');
  return { ...actual, istDateIso: () => '2026-09-29', startOfTodayIstIso: () => '2026-09-28T18:30:00.000Z' };
});
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        limit: () => chain,
        order: () => chain,
        gte: (col: string, v: unknown) => {
          state.filters.push(['gte', col, v]);
          return chain;
        },
        lt: (col: string, v: unknown) => {
          state.filters.push(['lt', col, v]);
          return chain;
        },
        then: (resolve: (v: unknown) => void) => resolve({ data: [], error: null }),
      });
      return chain;
    },
  }),
}));

const { GET } = await import('@/app/api/orders/route');
const get = (qs: string) => GET(new Request(`https://hioc.in/api/orders${qs}`));

beforeEach(() => {
  state.filters = [];
});

describe('GET /api/orders?date=', () => {
  it('selects the whole IST day', async () => {
    expect((await get('?date=2026-09-27')).status).toBe(200);
    expect(state.filters).toEqual([
      ['gte', 'created_at', '2026-09-26T18:30:00.000Z'],
      ['lt', 'created_at', '2026-09-27T18:30:00.000Z'],
    ]);
  });

  it('keeps showing today without a date', async () => {
    await get('');
    expect(state.filters).toEqual([['gte', 'created_at', '2026-09-28T18:30:00.000Z']]);
  });

  it('400s a nonsense or future date', async () => {
    expect((await get('?date=2026-02-30')).status).toBe(400);
    expect((await get('?date=27-09-2026')).status).toBe(400);
    expect((await get('?date=2026-09-30')).status).toBe(400);
    expect(state.filters).toEqual([]);
  });
});
