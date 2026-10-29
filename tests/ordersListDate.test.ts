import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/orders?date=YYYY-MM-DD — the Orders tab's date filter. A real,
// non-future business day selects every order placed on that day (3 am to
// 3 am IST from 29 Oct 2026, midnight to midnight before — lib/businessDay.ts);
// without it the board stays "today".

const state: { filters: [string, string, unknown][] } = { filters: [] };

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve({ user: { id: 'staff-1' }, role: 'staff', via: 'session' }),
}));
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
  // 12:40 am IST on Fri 6 Nov: the café's day is still Thursday the 5th.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-05T19:10:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GET /api/orders?date=', () => {
  it('selects the whole business day, 3 am to 3 am IST', async () => {
    expect((await get('?date=2026-11-02')).status).toBe(200);
    expect(state.filters).toEqual([
      ['gte', 'created_at', '2026-11-01T21:30:00.000Z'],
      ['lt', 'created_at', '2026-11-02T21:30:00.000Z'],
    ]);
  });

  it('keeps a day from before the change midnight to midnight', async () => {
    expect((await get('?date=2026-09-27')).status).toBe(200);
    expect(state.filters).toEqual([
      ['gte', 'created_at', '2026-09-26T18:30:00.000Z'],
      ['lt', 'created_at', '2026-09-27T18:30:00.000Z'],
    ]);
  });

  it('keeps showing today, since 3 am, without a date — past midnight too', async () => {
    await get('');
    expect(state.filters).toEqual([['gte', 'created_at', '2026-11-04T21:30:00.000Z']]);
  });

  it('400s a nonsense or future date', async () => {
    expect((await get('?date=2026-02-30')).status).toBe(400);
    expect((await get('?date=27-09-2026')).status).toBe(400);
    // The 6th has begun on the calendar, but its business day starts at 3 am.
    expect((await get('?date=2026-11-06')).status).toBe(400);
    expect(state.filters).toEqual([]);
  });
});
