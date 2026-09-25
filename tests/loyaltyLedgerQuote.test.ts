import { beforeEach, describe, expect, it, vi } from 'vitest';

// lib/loyalty/ledger.ts's quoteRedemption() — focused on the `knownBalance`
// perf parameter added so POST /api/orders/quote can hand over the balance it
// already fetched for its own response instead of paying for a second
// identical loyalty_transactions scan a moment later. Every other call site
// (POST /api/orders, GET /api/loyalty/quote) omits it and is unaffected.

const state: {
  config: Record<string, unknown> | null;
  txRows: { points: number }[];
  balanceCalls: number;
} = { config: null, txRows: [], balanceCalls: 0 };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'loyalty_config') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: state.config, error: null }),
            }),
          }),
        };
      }
      if (table === 'loyalty_transactions') {
        return {
          select: () => ({
            eq: () => {
              state.balanceCalls += 1;
              return Promise.resolve({ data: state.txRows, error: null });
            },
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { quoteRedemption } from '@/lib/loyalty/ledger';

beforeEach(() => {
  state.balanceCalls = 0;
  state.config = {
    min_redeem_points: 10,
    inr_per_point: 0.5,
    max_redeem_pct: 50,
  };
  state.txRows = [{ points: 200 }];
});

describe('quoteRedemption — knownBalance', () => {
  it('fetches the balance itself when knownBalance is omitted (unchanged default)', async () => {
    const quote = await quoteRedemption('user-1', 50, 1000);
    expect(state.balanceCalls).toBe(1);
    expect(quote).toMatchObject({ ok: true, points: 50, discountInr: 25 });
  });

  it('skips the balance fetch entirely when knownBalance is provided', async () => {
    const quote = await quoteRedemption('user-1', 50, 1000, 200);
    expect(state.balanceCalls).toBe(0);
    expect(quote).toMatchObject({ ok: true, points: 50, discountInr: 25 });
  });

  it('still rejects over-redemption using the passed-in balance, with no query at all', async () => {
    const quote = await quoteRedemption('user-1', 500, 1000, 200);
    expect(state.balanceCalls).toBe(0);
    expect(quote.ok).toBe(false);
    expect(quote.reason).toContain('200 points available');
  });

  it('a knownBalance of 0 is honored, not treated as "unknown" (falsy-but-valid)', async () => {
    const quote = await quoteRedemption('user-1', 10, 1000, 0);
    expect(state.balanceCalls).toBe(0);
    expect(quote.ok).toBe(false);
    expect(quote.reason).toContain('0 points available');
  });
});
