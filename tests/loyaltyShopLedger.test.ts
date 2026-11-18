import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shop-order Beanies (E5): earn on delivery, reserve at checkout via RPC, one
// 'reverse' row on return. Uses a small in-memory fake of the admin client.

type Row = Record<string, unknown>;
const db: {
  tables: Record<string, Row[]>;
  rpcResult: { data: unknown; error: unknown };
  rpcCalls: { fn: string; args: Row }[];
  insertError: { code: string } | null;
  upserts: Row[];
  log: string[];
} = { tables: {}, rpcResult: { data: 'reserved', error: null }, rpcCalls: [], insertError: null, upserts: [], log: [] };

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    rpc: (fn: string, args: Row) => {
      db.rpcCalls.push({ fn, args });
      return Promise.resolve(db.rpcResult);
    },
    from: (table: string) => {
      const filters: ((r: Row) => boolean)[] = [];
      const q: Record<string, unknown> = {};
      const run = () => ({ data: (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r))), error: null });
      q.select = () => q;
      q.eq = (c: string, v: unknown) => (filters.push((r) => r[c] === v), q);
      q.in = (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q);
      q.maybeSingle = () => Promise.resolve({ data: run().data[0] ?? null, error: null });
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej);
      q.insert = (row: Row) => {
        if (db.insertError) return Promise.resolve({ error: db.insertError });
        (db.tables[table] ??= []).push({ ...row });
        db.log.push(`insert:${table}`);
        return Promise.resolve({ error: null });
      };
      q.upsert = (row: Row) => {
        db.upserts.push(row);
        db.log.push(`upsert:${table}`);
        return Promise.resolve({ error: null });
      };
      return q;
    },
  }),
}));

import {
  earnForShopOrder,
  redeemForShopOrder,
  reverseForShopOrder,
  shopEarnBaseInr,
} from '@/lib/loyalty/ledger';

const ORDER = 'so-1';
const USER = 'u-1';

function seed(order: Partial<Row> = {}, ledger: Row[] = []) {
  db.tables = {
    loyalty_config: [{ is_singleton: true, points_per_inr: 0.1, min_redeem_points: 20 }],
    shop_orders: [
      { id: ORDER, status: 'delivered', user_id: USER, total_inr: 999, shipping_inr: 60, order_number: 42, ...order },
    ],
    loyalty_transactions: ledger,
  };
}
const ledger = () => db.tables.loyalty_transactions;

beforeEach(() => {
  db.rpcResult = { data: 'reserved', error: null };
  db.rpcCalls = [];
  db.insertError = null;
  db.upserts = [];
  db.log = [];
  vi.spyOn(console, 'error').mockImplementation(() => {});
  seed();
});

describe('shopEarnBaseInr', () => {
  it('is total minus shipping, never negative', () => {
    expect(shopEarnBaseInr({ total_inr: 999, shipping_inr: 60 })).toBe(939);
    expect(shopEarnBaseInr({ total_inr: 40, shipping_inr: 60 })).toBe(0);
  });
});

describe('earnForShopOrder', () => {
  it('earns floor(base x rate) once delivered, and syncs the cache after the write', async () => {
    expect(await earnForShopOrder(ORDER)).toBe(93);
    expect(ledger()).toEqual([
      expect.objectContaining({ user_id: USER, shop_order_id: ORDER, order_id: null, type: 'earn', points: 93 }),
    ]);
    expect(ledger()[0].note).toBe('Earned on shop order HIOC-S42');
    expect(db.upserts[0]).toMatchObject({ user_id: USER, points_balance: 93 });
    expect(db.log.indexOf('upsert:loyalty_accounts')).toBeGreaterThan(db.log.indexOf('insert:loyalty_transactions'));
  });

  it('does nothing unless delivered with an account', async () => {
    seed({ status: 'shipped' });
    expect(await earnForShopOrder(ORDER)).toBe(0);
    seed({ user_id: null });
    expect(await earnForShopOrder(ORDER)).toBe(0);
    expect(await earnForShopOrder('missing')).toBe(0);
    expect(ledger()).toHaveLength(0);
  });

  it('never earns twice (existing row)', async () => {
    expect(await earnForShopOrder(ORDER)).toBe(93);
    expect(await earnForShopOrder(ORDER)).toBe(0);
    expect(ledger()).toHaveLength(1);
  });

  it('treats a 23505 race as nothing to do', async () => {
    db.insertError = { code: '23505' };
    expect(await earnForShopOrder(ORDER)).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
  });

  it('is blocked after a reverse', async () => {
    seed({}, [{ user_id: USER, shop_order_id: ORDER, type: 'reverse', points: 5 }]);
    expect(await earnForShopOrder(ORDER)).toBe(0);
  });

  it('writes nothing when the base earns zero points', async () => {
    seed({ total_inr: 60 });
    expect(await earnForShopOrder(ORDER)).toBe(0);
    expect(ledger()).toHaveLength(0);
  });
});

describe('redeemForShopOrder', () => {
  it('calls the RPC and maps reserved, syncing the cache', async () => {
    expect(await redeemForShopOrder(ORDER, USER, 39, 39, 'HIOC-S42')).toBe('reserved');
    expect(db.rpcCalls).toEqual([
      {
        fn: 'reserve_shop_beanies',
        args: {
          p_user_id: USER,
          p_shop_order_id: ORDER,
          p_points: 39,
          p_note: 'Used 39 Beanies for ₹39 off shop order HIOC-S42',
        },
      },
    ]);
    expect(db.upserts).toHaveLength(1);
  });

  it('maps already_reserved and insufficient without syncing', async () => {
    db.rpcResult = { data: 'already_reserved', error: null };
    expect(await redeemForShopOrder(ORDER, USER, 39, 39, 'x')).toBe('already_reserved');
    db.rpcResult = { data: 'insufficient', error: null };
    expect(await redeemForShopOrder(ORDER, USER, 39, 39, 'x')).toBe('insufficient');
    expect(db.upserts).toHaveLength(0);
  });

  it('returns error when the RPC is missing or answers oddly', async () => {
    db.rpcResult = { data: null, error: { code: '42883', message: 'no function' } };
    expect(await redeemForShopOrder(ORDER, USER, 39, 39, 'x')).toBe('error');
    db.rpcResult = { data: null, error: { code: 'PGRST202' } };
    expect(await redeemForShopOrder(ORDER, USER, 39, 39, 'x')).toBe('error');
    db.rpcResult = { data: 'weird', error: null };
    expect(await redeemForShopOrder(ORDER, USER, 39, 39, 'x')).toBe('error');
  });

  it('rejects invalid input without calling the RPC', async () => {
    for (const p of [0, -5, 1.5, NaN]) expect(await redeemForShopOrder(ORDER, USER, p, 1, 'x')).toBe('error');
    expect(await redeemForShopOrder('', USER, 5, 1, 'x')).toBe('error');
    expect(await redeemForShopOrder(ORDER, '', 5, 1, 'x')).toBe('error');
    expect(db.rpcCalls).toHaveLength(0);
  });
});

describe('reverseForShopOrder', () => {
  it('gives reserved Beanies back (+points)', async () => {
    seed({ status: 'cancelled' }, [{ user_id: USER, shop_order_id: ORDER, type: 'redeem', points: -39 }]);
    expect(await reverseForShopOrder(ORDER, 'payment failed')).toBe(39);
    const rev = ledger().find((r) => r.type === 'reverse')!;
    expect(rev).toMatchObject({ user_id: USER, shop_order_id: ORDER, order_id: null, points: 39 });
    expect(rev.note).toBe('Returned — payment failed (shop order HIOC-S42)');
    expect(db.upserts).toHaveLength(1);
  });

  it('nets earn and redeem into one row, and takes back a pure earn', async () => {
    seed({}, [
      { user_id: USER, shop_order_id: ORDER, type: 'earn', points: 93 },
      { user_id: USER, shop_order_id: ORDER, type: 'redeem', points: -39 },
    ]);
    expect(await reverseForShopOrder(ORDER, 'refunded')).toBe(-54);
    expect(ledger().filter((r) => r.type === 'reverse')).toHaveLength(1);
    seed({}, [{ user_id: USER, shop_order_id: ORDER, type: 'earn', points: 93 }]);
    expect(await reverseForShopOrder(ORDER, 'refunded')).toBe(-93);
  });

  it('is a no-op the second time and with nothing to reverse', async () => {
    seed({}, [{ user_id: USER, shop_order_id: ORDER, type: 'redeem', points: -39 }]);
    expect(await reverseForShopOrder(ORDER, 'x')).toBe(39);
    expect(await reverseForShopOrder(ORDER, 'x')).toBe(0);
    expect(ledger()).toHaveLength(2);
    seed();
    expect(await reverseForShopOrder(ORDER, 'x')).toBe(0);
  });

  it('tolerates a 23505 race and omits the order number if unreadable', async () => {
    seed({}, [{ user_id: USER, shop_order_id: ORDER, type: 'redeem', points: -39 }]);
    db.insertError = { code: '23505' };
    expect(await reverseForShopOrder(ORDER, 'x')).toBe(0);
    db.insertError = null;
    db.tables.shop_orders = [];
    expect(await reverseForShopOrder(ORDER, 'x')).toBe(39);
    expect(ledger().find((r) => r.type === 'reverse')!.note).toBe('Returned — x');
  });
});
