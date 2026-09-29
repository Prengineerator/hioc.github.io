import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// PATCH /api/owner/cash-movements/[id]: the owner tags a PAST cash-out as a
// store expense (or clears the tag). Only `category` is ever written, and a
// closed cash day's frozen expense total is refreshed.

type Row = Record<string, unknown>;

const MOVE_ID = '11111111-1111-4111-8111-111111111111';
const DAY_ID = '22222222-2222-4222-8222-222222222222';

const state: {
  owner: { id: string } | null;
  movement: Row | null;
  updates: Row[];
  updateError: { code?: string; message: string } | null;
  closedDays: Row[];
  /** The categorised cash-outs the day-total query sees. */
  dayMoves: Row[];
  dayWrites: { id: string; payload: Row }[];
  dayWindow: { gt?: string; lte?: string } | null;
} = {
  owner: { id: 'owner-1' },
  movement: null,
  updates: [],
  updateError: null,
  closedDays: [],
  dayMoves: [],
  dayWrites: [],
  dayWindow: null,
};

vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const self = () => chain;
      if (table === 'cash_movements') {
        let updatePayload: Row | null = null;
        let summing = false;
        chain.select = (cols: string) => {
          if (cols.startsWith('amount_inr')) summing = true;
          return chain;
        };
        chain.eq = self;
        chain.not = self;
        chain.gt = (_c: string, v: string) => {
          state.dayWindow = { ...(state.dayWindow ?? {}), gt: v };
          return chain;
        };
        chain.lte = (_c: string, v: string) => {
          state.dayWindow = { ...(state.dayWindow ?? {}), lte: v };
          return Promise.resolve({ data: summing ? state.dayMoves : [], error: null });
        };
        chain.update = (p: Row) => {
          updatePayload = p;
          state.updates.push(p);
          return chain;
        };
        chain.maybeSingle = () => {
          if (updatePayload) {
            if (state.updateError) return Promise.resolve({ data: null, error: state.updateError });
            return Promise.resolve({ data: { id: MOVE_ID, category: updatePayload.category }, error: null });
          }
          return Promise.resolve({ data: state.movement, error: null });
        };
        return chain;
      }
      if (table === 'cash_days') {
        let payload: Row | null = null;
        chain.select = self;
        chain.eq = (col: string, v: unknown) => {
          if (payload) {
            state.dayWrites.push({ id: String(v), payload });
            return Promise.resolve({ error: null });
          }
          return chain;
        };
        chain.lt = self;
        chain.gte = () => Promise.resolve({ data: state.closedDays, error: null });
        chain.update = (p: Row) => {
          payload = p;
          return chain;
        };
        return chain;
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: () => Promise.resolve(state.owner) }));

const { PATCH } = await import('@/app/api/owner/cash-movements/[id]/route');

function call(body: unknown, id = MOVE_ID) {
  return PATCH(
    new Request(`http://t/api/owner/cash-movements/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: { id } },
  );
}

const CASH_OUT: Row = {
  id: MOVE_ID,
  direction: 'out',
  reason: 'ice for the bar',
  created_at: '2026-09-28T10:00:00.000Z',
};

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-29T12:00:00.000Z'));
  state.owner = { id: 'owner-1' };
  state.movement = { ...CASH_OUT };
  state.updates = [];
  state.updateError = null;
  state.closedDays = [];
  state.dayMoves = [];
  state.dayWrites = [];
  state.dayWindow = null;
});

describe('PATCH /api/owner/cash-movements/[id]', () => {
  it('403s a non-owner', async () => {
    state.owner = null;
    const res = await call({ category: 'ice' });
    expect(res.status).toBe(403);
    expect(state.updates).toHaveLength(0);
  });

  it('400s an unknown category, a missing category, or a non-string one', async () => {
    expect((await call({ category: 'yacht' })).status).toBe(400);
    expect((await call({})).status).toBe(400);
    expect((await call({ category: 7 })).status).toBe(400);
    expect(state.updates).toHaveLength(0);
  });

  it('404s a missing row or a malformed id', async () => {
    state.movement = null;
    expect((await call({ category: 'ice' })).status).toBe(404);
    expect((await call({ category: 'ice' }, 'not-a-uuid')).status).toBe(404);
  });

  it('400s a cash in', async () => {
    state.movement = { ...CASH_OUT, direction: 'in' };
    const res = await call({ category: 'ice' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Only a cash out can be an expense');
    expect(state.updates).toHaveLength(0);
  });

  it('400s the day-close handover, whatever its casing', async () => {
    state.movement = { ...CASH_OUT, reason: 'DAY CLOSE HANDOVER (2026-09-28): cash taken out to owner/bank' };
    const res = await call({ category: 'other' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('The day-close handover is not an expense');
    expect(state.updates).toHaveLength(0);
  });

  it('sets a category and approves the expense (an owner act); amount, direction and reason are never written', async () => {
    const res = await call({ category: 'ice' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ movement: { id: MOVE_ID, category: 'ice', categoryLabel: 'Ice cubes' } });
    expect(state.updates).toEqual([
      { category: 'ice', approved_at: '2026-09-29T12:00:00.000Z', approved_by: 'owner-1' },
    ]);
  });

  it('clears the category with null', async () => {
    state.movement = { ...CASH_OUT, category: 'ice' };
    const res = await call({ category: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ movement: { id: MOVE_ID, category: null, categoryLabel: '' } });
    expect(state.updates).toEqual([{ category: null, approved_at: null, approved_by: null }]);
  });

  it('409s a voided (undone) row and writes nothing', async () => {
    state.movement = { ...CASH_OUT, category: 'ice', voided_at: '2026-09-28T10:05:00.000Z' };
    const res = await call({ category: 'water' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/undone/);
    expect(state.updates).toHaveLength(0);
    expect((await call({ category: null })).status).toBe(409);
    expect(state.updates).toHaveLength(0);
  });

  it('409s with the migration hint when the category column is missing', async () => {
    state.updateError = { code: '42703', message: 'column "category" of relation "cash_movements" does not exist' };
    const res = await call({ category: 'ice' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/2026-10-cash-expenses\.sql/);
  });

  it('re-freezes the expense total of the closed day that contains the movement', async () => {
    state.closedDays = [{ id: DAY_ID, opened_at: '2026-09-28T04:00:00.000Z', closed_at: '2026-09-28T16:00:00.000Z' }];
    // The third row was undone: it never left the drawer, so it is not in the frozen total.
    state.dayMoves = [
      { amount_inr: 120, voided_at: null },
      { amount_inr: 80, voided_at: null },
      { amount_inr: 500, voided_at: '2026-09-28T09:00:00.000Z' },
    ];
    const res = await call({ category: 'ice' });
    expect(res.status).toBe(200);
    expect(state.dayWindow).toEqual({ gt: '2026-09-28T04:00:00.000Z', lte: '2026-09-28T16:00:00.000Z' });
    expect(state.dayWrites).toEqual([{ id: DAY_ID, payload: { expenses_inr: 200 } }]);
  });

  it('writes 0 when the last expense of a closed day is cleared', async () => {
    state.movement = { ...CASH_OUT, category: 'ice' };
    state.closedDays = [{ id: DAY_ID, opened_at: '2026-09-28T04:00:00.000Z', closed_at: '2026-09-28T16:00:00.000Z' }];
    state.dayMoves = [];
    await call({ category: null });
    expect(state.dayWrites).toEqual([{ id: DAY_ID, payload: { expenses_inr: 0 } }]);
  });

  it('leaves cash_days alone when no closed day contains the movement (open day is live)', async () => {
    const res = await call({ category: 'ice' });
    expect(res.status).toBe(200);
    expect(state.dayWrites).toEqual([]);
  });
});
