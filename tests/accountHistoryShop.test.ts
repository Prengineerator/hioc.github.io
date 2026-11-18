import { beforeEach, describe, expect, it, vi } from 'vitest';

// Café + shop history (docs/SHOP-V2-SPEC.md E4): the pure merge/filter/
// ownership rules, plus the route driven against a small scripted database.

import {
  filterChannelRows,
  isValidHistoryChannel,
  mergeChannelRows,
  ownsShopOrder,
  paginateOrderRows,
  type ChannelRow,
} from '@/lib/account/history';
import { shopOrder } from './helpers/shopFixture';

const row = (channel: 'cafe' | 'shop', id: string, created_at: string, active = false): ChannelRow => ({
  channel, id, created_at, active,
});

describe('mergeChannelRows', () => {
  it('de-dupes by channel and id, but keeps the same id in two channels', () => {
    const merged = mergeChannelRows([
      [row('shop', 'a', '2026-11-01T10:00:00Z')],
      [row('shop', 'a', '2026-11-01T10:00:00Z'), row('cafe', 'a', '2026-11-01T10:00:00Z')],
    ]);
    expect(merged).toHaveLength(2);
  });

  it('is newest first with a stable tie-break on equal timestamps', () => {
    const t = '2026-11-02T10:00:00Z';
    const a = [row('cafe', 'b', t), row('shop', 'a', t), row('cafe', 'c', t)];
    const one = mergeChannelRows([a]);
    const two = mergeChannelRows([[...a].reverse()]);
    expect(one.map((r) => `${r.channel}:${r.id}`)).toEqual(['shop:a', 'cafe:c', 'cafe:b']);
    expect(two).toEqual(one);
  });

  it('pages across both tables without overlap or gaps', () => {
    const cafe = Array.from({ length: 7 }, (_, i) => row('cafe', `c${i}`, `2026-11-0${i + 1}T10:00:00Z`));
    const shop = Array.from({ length: 6 }, (_, i) => row('shop', `s${i}`, `2026-11-0${i + 1}T12:00:00Z`));
    const merged = mergeChannelRows([cafe, shop]);
    const p1 = paginateOrderRows(merged, 1, 10);
    const p2 = paginateOrderRows(merged, 2, 10);
    expect(p1.items).toHaveLength(10);
    expect(p2.items).toHaveLength(3);
    expect(p1.hasMore).toBe(true);
    expect(p2.hasMore).toBe(false);
    expect(p1.total).toBe(13);
    const keys = [...p1.items, ...p2.items].map((r) => `${r.channel}:${r.id}`);
    expect(new Set(keys).size).toBe(13);
    expect(keys).toEqual(merged.map((r) => `${r.channel}:${r.id}`));
    // newest first: the oldest café order is last
    expect(keys[12]).toBe('cafe:c0');
  });
});

describe('filterChannelRows', () => {
  const rows = [row('cafe', 'c1', '2026-11-03T00:00:00Z', true), row('shop', 's1', '2026-11-02T00:00:00Z', true), row('shop', 's2', '2026-11-01T00:00:00Z', false)];
  it('filters by channel', () => {
    expect(filterChannelRows(rows, 'all', null)).toHaveLength(3);
    expect(filterChannelRows(rows, 'cafe', null).map((r) => r.id)).toEqual(['c1']);
    expect(filterChannelRows(rows, 'shop', null).map((r) => r.id)).toEqual(['s1', 's2']);
  });
  it('filters active and past on top', () => {
    expect(filterChannelRows(rows, 'shop', 'active').map((r) => r.id)).toEqual(['s1']);
    expect(filterChannelRows(rows, 'all', 'past').map((r) => r.id)).toEqual(['s2']);
  });
  it('validates the channel param', () => {
    expect(['all', 'cafe', 'shop'].every(isValidHistoryChannel)).toBe(true);
    expect(isValidHistoryChannel('web')).toBe(false);
    expect(isValidHistoryChannel(null)).toBe(false);
  });
});

describe('ownsShopOrder', () => {
  const verified = { phone: '+919876543210', phone_verified: true };
  const unverified = { phone: '+919876543210', phone_verified: false };
  const guest = { user_id: null, phone: '+919876543210', email: 'Riya@Example.com' };

  it('owns by user_id', () => {
    expect(ownsShopOrder({ ...guest, user_id: 'u1' }, 'u1', null)).toBe(true);
  });
  it('owns a guest order by verified phone only', () => {
    expect(ownsShopOrder(guest, 'u1', verified)).toBe(true);
    expect(ownsShopOrder(guest, 'u1', unverified)).toBe(false);
    expect(ownsShopOrder(guest, 'u1', { phone: '+910000000000', phone_verified: true })).toBe(false);
  });
  it('owns a guest order by verified email, case-insensitively', () => {
    expect(ownsShopOrder(guest, 'u1', null, 'riya@example.com')).toBe(true);
    expect(ownsShopOrder(guest, 'u1', null, null)).toBe(false);
    expect(ownsShopOrder(guest, 'u1', null, 'other@example.com')).toBe(false);
  });
  it('never matches an order claimed by someone else', () => {
    expect(ownsShopOrder({ ...guest, user_id: 'u2' }, 'u1', verified, 'riya@example.com')).toBe(false);
  });
});

// ---- the route ------------------------------------------------------------

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  user: { id: 'u1', email: 'riya@example.com', email_confirmed_at: '2026-11-01T00:00:00Z' } as Record<string, unknown> | null,
  tables: {} as Record<string, Row[]>,
  missingShop: false,
  queries: [] as string[],
}));

type Filter = { op: string; col: string; val: unknown };
function fakeFrom(table: string) {
  const filters: Filter[] = [];
  const chain: Record<string, unknown> = {};
  const add = (op: string) => (col: string, a: unknown, b?: unknown) => {
    filters.push({ op, col, val: op === 'not' ? b : a });
    if (op === 'not') filters[filters.length - 1].val = { op: a, list: b };
    return chain;
  };
  chain.select = () => chain;
  chain.or = () => chain;
  chain.eq = add('eq');
  chain.is = add('is');
  chain.in = add('in');
  chain.not = add('not');
  chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
  chain.then = (resolve: (v: unknown) => void) => {
    if (table === 'shop_orders' && h.missingShop) {
      return resolve({ data: null, error: { code: '42P01', message: 'relation "shop_orders" does not exist' } });
    }
    let rows = h.tables[table] ?? [];
    for (const f of filters) {
      rows = rows.filter((r) => {
        const v = r[f.col];
        if (f.op === 'eq') return v === f.val;
        if (f.op === 'is') return v === null || v === undefined;
        if (f.op === 'in') return (f.val as unknown[]).includes(v);
        if (f.op === 'not') {
          const list = String((f.val as { list: string }).list).replace(/[()]/g, '').split(',');
          return !list.includes(v as string);
        }
        return true;
      });
    }
    h.queries.push(`${table}:${filters.map((f) => f.col).join(',')}`);
    return resolve({ data: rows, error: null });
  };
  return chain;
}
const admin = {
  from(table: string) {
    if (table === 'profiles') {
      const c: Record<string, unknown> = { select: () => c, eq: () => c };
      c.maybeSingle = () => Promise.resolve({ data: h.tables.profiles?.[0] ?? null, error: null });
      return c;
    }
    return fakeFrom(table);
  },
};
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => admin }));
vi.mock('@/lib/api/auth', () => ({ getAuthUser: () => Promise.resolve(h.user) }));
vi.mock('@/lib/legacy/history', () => ({ latestLegacyBillsForPhone: () => Promise.resolve([]) }));

import { GET } from '@/app/api/account/history/route';

const call = (qs = '') => GET(new Request(`http://localhost/api/account/history${qs}`));

beforeEach(() => {
  h.missingShop = false;
  h.queries = [];
  h.user = { id: 'u1', email: 'riya@example.com', email_confirmed_at: '2026-11-01T00:00:00Z' };
  h.tables = {
    profiles: [{ phone: '+919876543210', phone_verified: true }],
    orders: [],
    shop_orders: [
      { ...shopOrder({ id: 's-paid', user_id: 'u1', status: 'paid', created_at: '2026-11-05T00:00:00Z' }) },
      { ...shopOrder({ id: 's-pending', user_id: 'u1', status: 'payment_pending', created_at: '2026-11-06T00:00:00Z' }) },
      { ...shopOrder({ id: 's-expired', user_id: 'u1', status: 'expired', created_at: '2026-11-07T00:00:00Z' }) },
      { ...shopOrder({ id: 's-guest', user_id: null, status: 'delivered', created_at: '2026-11-04T00:00:00Z' }) },
      { ...shopOrder({ id: 's-theirs', user_id: 'u2', status: 'paid', created_at: '2026-11-08T00:00:00Z' }) },
    ],
  };
});

describe('GET /api/account/history with the shop', () => {
  it('rejects an unknown channel', async () => {
    const res = await call('?channel=web');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('channel must be "all", "cafe" or "shop"');
  });

  it('lists shop orders, never unpaid, expired or someone else\'s', async () => {
    const res = await call('?channel=shop');
    const body = await res.json();
    expect(body.channel).toBe('shop');
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['s-paid', 's-guest']);
    expect(body.items[0].channel).toBe('shop');
    expect(body.orders).toEqual([]);
    expect(body.total).toBe(2);
    // no address on a history row
    expect(body.items[0].order.address_line1).toBeUndefined();
  });

  it('does not match guest orders by an unverified phone', async () => {
    h.tables.profiles = [{ phone: '+919876543210', phone_verified: false }];
    h.user = { id: 'u1', email: null, email_confirmed_at: null };
    const body = await (await call('?channel=shop')).json();
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['s-paid']);
  });

  it('skips the shop queries for channel=cafe and the café queries for channel=shop', async () => {
    await call('?channel=cafe');
    expect(h.queries.some((q) => q.startsWith('shop_orders'))).toBe(false);
    h.queries = [];
    await call('?channel=shop');
    expect(h.queries.some((q) => q.startsWith('orders:'))).toBe(false);
  });

  it('filters shop Active/Past', async () => {
    const active = await (await call('?channel=shop&status=active')).json();
    expect(active.items.map((i: { id: string }) => i.id)).toEqual(['s-paid']);
    const past = await (await call('?channel=shop&status=past')).json();
    expect(past.items.map((i: { id: string }) => i.id)).toEqual(['s-guest']);
  });

  it('survives a missing shop table', async () => {
    h.missingShop = true;
    const res = await call();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
  });
});
