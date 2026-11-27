import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadStrategyData } from '@/lib/online-settlements/loadStrategy';

// loadStrategyData (lib/online-settlements/loadStrategy.ts): paged, Zomato-only reads.

interface Call {
  table: string;
  eq: [string, string][];
  gte: [string, string][];
  select: string;
  order: string[];
  range: [number, number];
}

/** Just enough of the admin client for select → eq/gte → order → range, one table's rows served by range. */
function fakeAdmin(rows: Record<string, unknown[]>, error?: { table: string; code?: string; message: string }) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const call: Call = { table, select: '', eq: [], gte: [], order: [], range: [0, 0] };
      const q = {
        select: (cols: string) => ((call.select = cols), q),
        eq: (c: string, v: string) => (call.eq.push([c, v]), q),
        gte: (c: string, v: string) => (call.gte.push([c, v]), q),
        order: (c: string) => (call.order.push(c), q),
        range: async (a: number, b: number) => {
          call.range = [a, b];
          calls.push(call);
          if (error && error.table === table) return { data: null, error };
          const served = table === 'online_settlement_orders' && call.select.startsWith('customer_ref') ? rows.first ?? [] : rows[table];
          return { data: served.slice(a, b + 1), error: null };
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { admin, calls };
}

const NOW = new Date('2026-11-27T00:00:00Z');
const many = (n: number) => Array.from({ length: n }, (_, i) => ({ order_id: `o${i}` }));
const orderCalls = (calls: Call[]) => calls.filter((c) => c.table === 'online_settlement_orders' && !c.select.startsWith('customer_ref'));

describe('loadStrategyData', () => {
  it('pages orders and deductions past the 1,000-row cap, for Zomato only', async () => {
    const { admin, calls } = fakeAdmin({ online_settlement_orders: many(2500), online_settlement_deductions: many(1000) }, undefined);
    const d = await loadStrategyData(admin, NOW);
    expect(d.migrated).toBe(true);
    expect(d.orders).toHaveLength(2500);
    expect(d.deductions).toHaveLength(1000);
    expect(orderCalls(calls).map((c) => c.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
    // a full last page means one more request, which comes back empty
    expect(calls.filter((c) => c.table === 'online_settlement_deductions').map((c) => c.range)).toEqual([[0, 999], [1000, 1999]]);
    for (const c of calls.filter((x) => !x.select.startsWith('customer_ref'))) expect(c.eq).toEqual([['platform', 'zomato']]);
    expect(orderCalls(calls)[0].order).toEqual(['ordered_at', 'platform', 'order_id']);
    expect(calls.find((c) => c.table === 'online_settlement_deductions')!.order).toEqual(['kind', 'label', 'ref', 'period_text']);
  });

  it('reads the last 400 days of orders', async () => {
    const { admin, calls } = fakeAdmin({ online_settlement_orders: [], online_settlement_deductions: [] });
    await loadStrategyData(admin, NOW);
    expect(orderCalls(calls)[0].gte).toEqual([['ordered_at', new Date(NOW.getTime() - 400 * 86400000).toISOString()]]);
  });

  it('reads every delivered Zomato order for first-order days: light columns, all history, paged', async () => {
    const first = [
      { customer_ref: 'a', ordered_at: '2025-01-01T10:00:00+00:00', platform: 'zomato', order_id: '1' },
      { customer_ref: 'b', ordered_at: '2025-01-02T20:00:00+00:00', platform: 'zomato', order_id: '2' }, // 01:30 IST the next day
      { customer_ref: 'a', ordered_at: '2025-03-01T10:00:00+00:00', platform: 'zomato', order_id: '3' },
      { customer_ref: null, ordered_at: '2025-03-02T10:00:00+00:00', platform: 'zomato', order_id: '4' },
      ...Array.from({ length: 1000 }, (_, i) => ({ customer_ref: `x${i}`, ordered_at: '2025-04-01T10:00:00+00:00', platform: 'zomato', order_id: `p${i}` })),
    ];
    const { admin, calls } = fakeAdmin({ online_settlement_orders: [], online_settlement_deductions: [], first });
    const d = await loadStrategyData(admin, NOW);
    const reads = calls.filter((c) => c.select.startsWith('customer_ref'));
    expect(reads.map((c) => c.range)).toEqual([[0, 999], [1000, 1999]]);
    expect(reads[0].select).toBe('customer_ref, ordered_at, platform, order_id');
    expect(reads[0].eq).toEqual([['platform', 'zomato'], ['status', 'delivered']]);
    expect(reads[0].gte).toEqual([]); // no date limit
    expect(reads[0].order).toEqual(['ordered_at', 'platform', 'order_id']);
    expect(d.firstOrderDay.get('a')).toBe('2025-01-01');
    expect(d.firstOrderDay.get('b')).toBe('2025-01-03');
    expect(d.firstOrderDay.size).toBe(1002);
  });

  it('reports a missing table as not migrated', async () => {
    for (const table of ['online_settlement_orders', 'online_settlement_deductions']) {
      const { admin } = fakeAdmin(
        { online_settlement_orders: [], online_settlement_deductions: [] },
        { table, code: 'PGRST205', message: "Could not find the table 'public.online_settlement_orders' in the schema cache" },
      );
      expect(await loadStrategyData(admin, NOW)).toEqual({ migrated: false, orders: [], firstOrderDay: new Map(), deductions: [] });
    }
  });

  it('throws on any other query error', async () => {
    const { admin } = fakeAdmin({ online_settlement_orders: [] }, { table: 'online_settlement_orders', message: 'boom' });
    await expect(loadStrategyData(admin, NOW)).rejects.toThrow(/boom/);
  });
});
