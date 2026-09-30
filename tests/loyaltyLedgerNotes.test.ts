import { beforeEach, describe, expect, it, vi } from 'vitest';

// The `note` written on a NEW ledger row is shown to the customer on /rewards.
// Existing rows keep whatever they were written with; only new rows speak in
// Beanies.

const state: {
  inserted: Record<string, unknown>[];
  ledger: { user_id: string; points: number; created_at: string }[];
} = { inserted: [], ledger: [] };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      if (table === 'loyalty_config') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: { points_expiry_days: 30, min_redeem_points: 20, inr_per_point: 1, max_redeem_pct: 100 },
                  error: null,
                }),
            }),
          }),
        };
      }
      if (table === 'loyalty_transactions') {
        return {
          // expireLoyaltyPoints: .select().order().order().range()
          // syncAccountCache:    .select().eq()
          select: () => ({
            order: () => ({ order: () => ({ range: () => Promise.resolve({ data: state.ledger, error: null }) }) }),
            eq: () => Promise.resolve({ data: state.ledger, error: null }),
          }),
          insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
            state.inserted.push(...(Array.isArray(rows) ? rows : [rows]));
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === 'loyalty_accounts') {
        return { upsert: () => Promise.resolve({ error: null }) };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

import { expireLoyaltyPoints } from '@/lib/loyalty/ledger';

beforeEach(() => {
  state.inserted = [];
  state.ledger = [];
});

describe('expireLoyaltyPoints — the note a customer will read', () => {
  it('says Beanies, with the configured window', async () => {
    state.ledger = [{ user_id: 'u1', points: 40, created_at: '2026-01-01T00:00:00Z' }];
    const result = await expireLoyaltyPoints(new Date('2026-09-30T00:00:00Z'));
    expect(result).toEqual({ users: 1, points: 40 });
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      type: 'expire',
      points: -40,
      note: 'Expired — Beanies older than 30 days',
    });
    expect(String(state.inserted[0].note)).not.toMatch(/point/i);
  });
});
