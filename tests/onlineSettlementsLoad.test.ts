import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadCoverage } from '@/lib/online-settlements/load';

// loadCoverage (lib/online-settlements/load.ts): what the Online orders page
// uses to open on a period that shows every platform with reports.

type Row = { platform: string; ordered_at: string };

/** Just enough of the admin client for select → eq → order → limit on online_settlement_orders. */
function fakeAdmin(rows: Row[], error?: string): SupabaseClient {
  return {
    from(table: string) {
      expect(table).toBe('online_settlement_orders');
      let list = [...rows];
      let ascending = true;
      const q = {
        select: () => q,
        eq: (col: keyof Row, v: string) => {
          list = list.filter((r) => r[col] === v);
          return q;
        },
        order: (_col: string, o: { ascending: boolean }) => {
          ascending = o.ascending;
          return q;
        },
        limit: async (n: number) => {
          if (error) return { data: null, error: { message: error } };
          const sorted = [...list].sort((a, b) => Date.parse(a.ordered_at) - Date.parse(b.ordered_at));
          if (!ascending) sorted.reverse();
          return { data: sorted.slice(0, n).map((r) => ({ ordered_at: r.ordered_at })), error: null };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

describe('loadCoverage', () => {
  it("gives the first order overall and each platform's latest", async () => {
    const c = await loadCoverage(
      fakeAdmin([
        { platform: 'zomato', ordered_at: '2026-05-01T07:48:17+00:00' },
        { platform: 'zomato', ordered_at: '2026-05-31T16:34:47+00:00' },
        { platform: 'swiggy', ordered_at: '2026-10-12T14:04:51+00:00' },
        { platform: 'swiggy', ordered_at: '2026-10-17T17:22:26+00:00' },
      ]),
    );
    expect(c).toEqual({
      first: '2026-05-01T07:48:17+00:00',
      last: '2026-10-17T17:22:26+00:00',
      latest: { zomato: '2026-05-31T16:34:47+00:00', swiggy: '2026-10-17T17:22:26+00:00' },
    });
  });

  it('leaves out a platform with no orders, and is empty with none at all', async () => {
    expect((await loadCoverage(fakeAdmin([{ platform: 'zomato', ordered_at: '2026-05-31T16:34:47+00:00' }]))).latest).toEqual({
      zomato: '2026-05-31T16:34:47+00:00',
    });
    expect(await loadCoverage(fakeAdmin([]))).toEqual({ first: null, last: null, latest: {} });
  });

  it('throws on a query error', async () => {
    await expect(loadCoverage(fakeAdmin([], 'boom'))).rejects.toThrow(/boom/);
  });
});
