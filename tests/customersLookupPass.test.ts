import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/customers/lookup and HIOC Ritual (docs/COFFEE-PASS-SPEC.md §7): with
// the feature on, a found ACCOUNT also answers with `passes`, the usable ones
// only, so the counter can offer "Use pass" and show what is left. Never a user
// id. With the feature off the field is absent altogether, and a phone with no
// account has nothing to show.

const flagState = vi.hoisted(() => ({ coffeePass: true }));
vi.mock('@/lib/flags', () => ({ flags: flagState }));

const state: {
  customer: { userId: string; name: string } | null;
  orderRows: { created_at: string; customer_name?: string }[];
} = { customer: null, orderRows: [] };

vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve({ user: { id: 'staff-1' }, role: 'staff', via: 'session' }),
}));
vi.mock('@/lib/api/rateLimit', () => ({ rateLimitOk: () => Promise.resolve(true) }));
vi.mock('@/lib/loyalty/customerLink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/loyalty/customerLink')>();
  return { ...actual, findVerifiedCustomerByPhone: () => Promise.resolve(state.customer) };
});
vi.mock('@/lib/loyalty/ledger', () => ({ getBalance: () => Promise.resolve(50) }));
vi.mock('@/lib/legacy/history', () => ({
  legacyOrderStatsForPhone: () => Promise.resolve({ count: 0, lastOrderAt: null }),
  legacyCustomerByPhone: () => Promise.resolve(null),
}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: () => {
      const chain = {
        select: () => chain,
        or: () => chain,
        order: () => chain,
        limit: () => Promise.resolve({ data: state.orderRows.slice(0, 1), count: state.orderRows.length, error: null }),
      };
      return chain;
    },
  }),
}));
const passesServer = vi.hoisted(() => ({ loadUsablePassSummaries: vi.fn() }));
vi.mock('@/lib/passes/server', () => passesServer);

const { GET } = await import('@/app/api/customers/lookup/route');

const summary = (over: Record<string, unknown> = {}) => ({
  id: 'pass-1',
  plan_id: 'plan-weekly',
  plan_name: 'Weekly Ritual',
  drinks_total: 7,
  drinks_used: 2,
  drinks_credited: 0,
  drinks_remaining: 5,
  drink_value_inr: 150,
  max_per_day: null,
  used_today: 0,
  price_inr: 750,
  starts_at: '2026-10-05T04:30:00.000Z',
  expires_at: '2026-10-12T18:30:00.000Z',
  status: 'active',
  state: 'active',
  order_id: 'sale-1',
  ...over,
});
const lookup = (phone = '9000000000') => GET(new Request(`https://hioc.in/api/customers/lookup?phone=${phone}`));

beforeEach(() => {
  vi.clearAllMocks();
  flagState.coffeePass = true;
  state.customer = { userId: 'cust-42', name: 'Asha' };
  state.orderRows = [{ created_at: '2026-10-01T08:00:00Z' }];
  passesServer.loadUsablePassSummaries.mockResolvedValue([summary()]);
});

describe('GET /api/customers/lookup — HIOC Ritual passes', () => {
  it('adds the account\'s usable passes to a found account', async () => {
    const body = await (await lookup()).json();
    expect(body).toMatchObject({ found: true, source: 'account', name: 'Asha', points_balance: 50, order_count: 1 });
    expect(body.passes).toHaveLength(1);
    expect(body.passes[0]).toMatchObject({ id: 'pass-1', plan_name: 'Weekly Ritual', drinks_remaining: 5 });
    expect(passesServer.loadUsablePassSummaries.mock.calls[0][1]).toBe('cust-42');
  });

  it('never exposes a user id, in the passes or anywhere else', async () => {
    const text = JSON.stringify(await (await lookup()).json());
    expect(text).not.toContain('cust-42');
    expect(text).not.toContain('user_id');
    expect(text).not.toContain('userId');
  });

  it('answers passes: [] for an account with none (the field is there whenever the feature is on)', async () => {
    passesServer.loadUsablePassSummaries.mockResolvedValue([]);
    expect((await (await lookup()).json()).passes).toEqual([]);
  });

  it('is absent while the feature is off, and the pass tables are never asked', async () => {
    flagState.coffeePass = false;
    const body = await (await lookup()).json();
    expect(body).not.toHaveProperty('passes');
    expect(body.found).toBe(true);
    expect(passesServer.loadUsablePassSummaries).not.toHaveBeenCalled();
  });

  it('is absent for a number with no account (order-history fallback)', async () => {
    state.customer = null;
    state.orderRows = [{ created_at: '2026-10-01T08:00:00Z', customer_name: 'Walk-in' }];
    const body = await (await lookup()).json();
    expect(body).toMatchObject({ found: true, source: 'order_history' });
    expect(body).not.toHaveProperty('passes');
    expect(passesServer.loadUsablePassSummaries).not.toHaveBeenCalled();
  });
});
