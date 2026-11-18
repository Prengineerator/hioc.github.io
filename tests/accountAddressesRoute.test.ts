import { beforeEach, describe, expect, it, vi } from 'vitest';

// /api/account/addresses: auth, shapes, the 10 limit, default handling,
// de-dupe, order copy, and 404 for other people's rows. The Supabase client is
// a tiny in-memory fake that honours .eq filters, so the explicit user_id
// check is actually exercised (the fake has no RLS of its own).

type Row = Record<string, unknown>;
const h = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  user: { id: 'u1' } as { id: string } | null,
  rpc: vi.fn(),
  seq: 0,
}));

function builder(table: string) {
  let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
  let payload: Row = {};
  const filters: [string, unknown][] = [];
  let single: 'one' | 'maybe' | null = null;
  const match = (r: Row) => filters.every(([k, v]) => r[k] === v);
  const run = () => {
    const rows = (h.tables[table] ??= []);
    if (op === 'insert') {
      const row = { id: `00000000-0000-4000-8000-${String(++h.seq).padStart(12, '0')}`, is_default: false, last_used_at: null, created_at: new Date(1e12 + h.seq * 1000).toISOString(), ...payload };
      rows.push(row);
      return { data: single ? row : [row], error: null };
    }
    const hit = rows.filter(match);
    if (op === 'update') hit.forEach((r) => Object.assign(r, payload));
    if (op === 'delete') h.tables[table] = rows.filter((r) => !match(r));
    if (single === 'one') return { data: hit[0] ?? null, error: null };
    if (single === 'maybe') return { data: hit[0] ?? null, error: null };
    return { data: hit, error: null };
  };
  const b: Record<string, unknown> = {
    select: () => b,
    insert: (p: Row) => ((op = 'insert'), (payload = p), b),
    update: (p: Row) => ((op = 'update'), (payload = p), b),
    delete: () => ((op = 'delete'), b),
    eq: (k: string, v: unknown) => (filters.push([k, v]), b),
    maybeSingle: () => ((single = 'maybe'), Promise.resolve(run())),
    single: () => ((single = 'one'), Promise.resolve(run())),
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
  };
  return b;
}
const client = { from: builder, rpc: (...a: unknown[]) => h.rpc(...a) };

vi.mock('@/lib/supabase-server', () => ({ createServerSupabaseClient: () => client, createAdminSupabaseClient: () => client }));
vi.mock('@/lib/api/auth', () => ({ getAuthUser: () => Promise.resolve(h.user) }));
// The address book must work with the shop switched off.
vi.mock('@/lib/flags', () => ({ flags: { shop: false } }));

const list = await import('@/app/api/account/addresses/route');
const one = await import('@/app/api/account/addresses/[id]/route');
const def = await import('@/app/api/account/addresses/[id]/default/route');

const ID = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;
const req = (method: string, body?: unknown) =>
  new Request('http://t/api/account/addresses', { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: { id } });

const valid = (o: Row = {}) => ({
  label: 'Home',
  customer_name: 'Asha Rao',
  phone: '9876543210',
  address_line1: '12 MG Road',
  address_line2: '',
  landmark: '',
  city: 'Bengaluru',
  state: 'Karnataka',
  pincode: '560001',
  ...o,
});
const stored = (n: number, o: Row = {}): Row => ({
  ...valid(),
  phone: '+919876543210',
  id: ID(n),
  user_id: 'u1',
  is_default: false,
  last_used_at: null,
  created_at: new Date(1e12 + n * 1000).toISOString(),
  location_lat: null,
  location_lng: null,
  location_source: null,
  ...o,
});

beforeEach(() => {
  h.tables = { customer_addresses: [], shop_orders: [] };
  h.user = { id: 'u1' };
  h.seq = 0;
  h.rpc.mockReset();
  h.rpc.mockImplementation(async (_fn: string, args: { p_address_id: string }) => {
    for (const r of h.tables.customer_addresses) if (r.user_id === 'u1') r.is_default = r.id === args.p_address_id;
    return { error: null };
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('auth', () => {
  it('answers 401 when signed out, on every route', async () => {
    h.user = null;
    expect((await list.GET()).status).toBe(401);
    expect((await list.POST(req('POST', valid()))).status).toBe(401);
    expect((await one.PATCH(req('PATCH', {}), ctx(ID(1)))).status).toBe(401);
    expect((await one.DELETE(req('DELETE'), ctx(ID(1)))).status).toBe(401);
    expect((await def.POST(req('POST'), ctx(ID(1)))).status).toBe(401);
  });
});

describe('GET', () => {
  it('returns the caller\'s addresses sorted, with the max, uncached, and works with flags.shop off', async () => {
    h.tables.customer_addresses = [
      stored(1),
      stored(2, { is_default: true }),
      stored(3, { last_used_at: '2026-05-01T00:00:00Z' }),
      stored(4, { user_id: 'someone-else' }),
    ];
    const res = await list.GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const body = await res.json();
    expect(body.max).toBe(10);
    expect(body.addresses.map((x: Row) => x.id)).toEqual([ID(2), ID(3), ID(1)]);
  });
});

describe('POST', () => {
  it('a validation error carries the field', async () => {
    const res = await list.POST(req('POST', valid({ pincode: '12' })));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ field: 'pincode', error: expect.any(String) });
  });

  it('the first address becomes the default; the second does not', async () => {
    const r1 = await list.POST(req('POST', valid()));
    expect(r1.status).toBe(201);
    expect((await r1.json()).address).toMatchObject({ is_default: true, phone: '+919876543210', user_id: 'u1' });
    const r2 = await list.POST(req('POST', valid({ address_line1: '99 Church Street' })));
    expect((await r2.json()).address.is_default).toBe(false);
  });

  it('is_default true on a later address goes through the RPC', async () => {
    await list.POST(req('POST', valid()));
    const res = await list.POST(req('POST', valid({ address_line1: '99 Church Street', is_default: true })));
    expect(h.rpc).toHaveBeenCalledWith('make_customer_address_default', expect.any(Object));
    expect((await res.json()).address.is_default).toBe(true);
  });

  it('the 11th address answers 409 with the message', async () => {
    h.tables.customer_addresses = Array.from({ length: 10 }, (_, i) => stored(i + 1, { address_line1: `${i + 1} Some Street`, is_default: i === 0 }));
    const res = await list.POST(req('POST', valid({ address_line1: '500 New Street' })));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('You can save up to 10 addresses. Delete one to add another.');
    expect(h.tables.customer_addresses).toHaveLength(10);
  });

  it('a duplicate returns the existing address (200) with its label updated', async () => {
    h.tables.customer_addresses = [stored(1, { is_default: true })];
    const res = await list.POST(req('POST', valid({ label: 'Work', address_line1: '12 mg road' })));
    expect(res.status).toBe(200);
    expect((await res.json()).address).toMatchObject({ id: ID(1), label: 'Work' });
    expect(h.tables.customer_addresses).toHaveLength(1);
    expect(h.tables.customer_addresses[0].label).toBe('Work');
  });

  it('a duplicate with no label keeps the existing label (Work stays Work)', async () => {
    h.tables.customer_addresses = [stored(1, { is_default: true, label: 'Work' })];
    h.tables.shop_orders = [{ ...valid(), phone: '+919876543210', id: ID(900), user_id: 'u1' }];
    const res = await list.POST(req('POST', { from_shop_order_id: ID(900) }));
    expect(res.status).toBe(200);
    expect((await res.json()).address).toMatchObject({ id: ID(1), label: 'Work' });
    expect(h.tables.customer_addresses).toHaveLength(1);
    expect(h.tables.customer_addresses[0].label).toBe('Work');
  });

  it('a field POST with no label also keeps the existing label', async () => {
    h.tables.customer_addresses = [stored(1, { is_default: true, label: "Mum's place" })];
    const { label: _l, ...noLabel } = valid();
    const res = await list.POST(req('POST', noLabel));
    expect(res.status).toBe(200);
    expect(h.tables.customer_addresses[0].label).toBe("Mum's place");
  });

  it('the trigger backstop: a P0001 customer_addresses_limit insert error answers 409 with the message', async () => {
    h.tables.customer_addresses = Array.from({ length: 9 }, (_, i) => stored(i + 1, { address_line1: `${i + 1} Some Street`, is_default: i === 0 }));
    const orig = client.from;
    client.from = ((table: string) => {
      const b = orig(table) as Record<string, unknown>;
      b.insert = () => ({
        select: () => ({ single: () => Promise.resolve({ data: null, error: { code: 'P0001', message: 'customer_addresses_limit' } }) }),
      });
      return b;
    }) as never;
    const res = await list.POST(req('POST', valid({ address_line1: '500 New Street' })));
    client.from = orig;
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('You can save up to 10 addresses. Delete one to add another.');
    expect(h.tables.customer_addresses).toHaveLength(9);
  });

  it('a 23505 on the first address retries as non-default and still answers 201', async () => {
    const orig = client.from;
    const inserts: Row[] = [];
    client.from = ((table: string) => {
      const b = orig(table) as Record<string, unknown>;
      const realInsert = b.insert as (p: Row) => unknown;
      b.insert = (p: Row) => {
        inserts.push(p);
        if (inserts.length === 1) {
          return { select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }) }) };
        }
        return realInsert(p);
      };
      return b;
    }) as never;
    const res = await list.POST(req('POST', valid()));
    client.from = orig;
    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(2);
    expect(inserts[0].is_default).toBe(true);
    expect(inserts[1].is_default).toBe(false);
    expect(h.tables.customer_addresses).toHaveLength(1);
  });

  it('a duplicate still counts as allowed when the book is full', async () => {
    h.tables.customer_addresses = Array.from({ length: 10 }, (_, i) => stored(i + 1, { address_line1: `${i + 1} Some Street`, is_default: i === 0 }));
    const res = await list.POST(req('POST', valid({ address_line1: '3 Some Street' })));
    expect(res.status).toBe(200);
  });

  it('a 42P01 error answers 503 "not available yet"', async () => {
    const orig = client.from;
    client.from = (() => ({
      select: () => ({ eq: () => Promise.resolve({ data: null, error: { code: '42P01', message: 'no table' } }) }),
    })) as never;
    const res = await list.GET();
    client.from = orig;
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Saved addresses aren't available yet.");
  });

  it('PostgREST\'s missing-table code (PGRST205) also answers 503', async () => {
    const orig = client.from;
    client.from = (() => ({
      select: () => ({
        eq: () => Promise.resolve({ data: null, error: { code: 'PGRST205', message: "Could not find the table 'public.customer_addresses' in the schema cache" } }),
      }),
    })) as never;
    const res = await list.GET();
    client.from = orig;
    expect(res.status).toBe(503);
  });

  describe('from_shop_order_id', () => {
    const order = (o: Row = {}) => ({ ...valid(), phone: '+919876543210', id: ID(900), user_id: 'u1', location_lat: 12.97, location_lng: 77.59, location_source: 'gps', ...o });

    it('copies the frozen address of the caller\'s own order', async () => {
      h.tables.shop_orders = [order()];
      const res = await list.POST(req('POST', { from_shop_order_id: ID(900), label: 'Work' }));
      expect(res.status).toBe(201);
      expect((await res.json()).address).toMatchObject({ label: 'Work', city: 'Bengaluru', pincode: '560001', location_source: 'gps', is_default: true });
    });

    it('answers 404 for someone else\'s order, an unknown order and a non-uuid', async () => {
      h.tables.shop_orders = [order({ user_id: 'other' })];
      expect((await list.POST(req('POST', { from_shop_order_id: ID(900) }))).status).toBe(404);
      expect((await list.POST(req('POST', { from_shop_order_id: ID(901) }))).status).toBe(404);
      expect((await list.POST(req('POST', { from_shop_order_id: 'nope' }))).status).toBe(404);
      expect(h.tables.customer_addresses).toHaveLength(0);
    });
  });
});

describe('PATCH', () => {
  it('re-validates against the merged row and returns the address', async () => {
    h.tables.customer_addresses = [stored(1, { is_default: true })];
    const ok = await one.PATCH(req('PATCH', { city: 'Mysuru' }), ctx(ID(1)));
    expect(ok.status).toBe(200);
    expect((await ok.json()).address.city).toBe('Mysuru');
    const bad = await one.PATCH(req('PATCH', { pincode: 'abc' }), ctx(ID(1)));
    expect(bad.status).toBe(400);
    expect((await bad.json()).field).toBe('pincode');
  });

  it('answers 404 for another user\'s id', async () => {
    h.tables.customer_addresses = [stored(1, { user_id: 'someone-else' })];
    const res = await one.PATCH(req('PATCH', { city: 'Mysuru' }), ctx(ID(1)));
    expect(res.status).toBe(404);
    expect(h.tables.customer_addresses[0].city).toBe('Bengaluru');
  });
});

describe('DELETE', () => {
  it('answers 404 for another user\'s id and leaves the row', async () => {
    h.tables.customer_addresses = [stored(1, { user_id: 'someone-else' })];
    expect((await one.DELETE(req('DELETE'), ctx(ID(1)))).status).toBe(404);
    expect(h.tables.customer_addresses).toHaveLength(1);
  });

  it('deleting the default promotes the next one', async () => {
    h.tables.customer_addresses = [stored(1, { is_default: true }), stored(2, { address_line1: '2 Other Street', last_used_at: '2026-05-01T00:00:00Z' }), stored(3, { address_line1: '3 Other Street' })];
    const res = await one.DELETE(req('DELETE'), ctx(ID(1)));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, new_default_id: ID(2) });
    expect(h.tables.customer_addresses.find((r) => r.id === ID(2))?.is_default).toBe(true);
  });

  it('deleting a non-default changes no default', async () => {
    h.tables.customer_addresses = [stored(1, { is_default: true }), stored(2, { address_line1: '2 Other Street' })];
    const res = await one.DELETE(req('DELETE'), ctx(ID(2)));
    expect(await res.json()).toEqual({ deleted: true, new_default_id: null });
    expect(h.rpc).not.toHaveBeenCalled();
  });
});

describe('POST …/default', () => {
  it('calls the RPC and returns the address', async () => {
    h.tables.customer_addresses = [stored(1, { is_default: true }), stored(2, { address_line1: '2 Other Street' })];
    const res = await def.POST(req('POST'), ctx(ID(2)));
    expect(h.rpc).toHaveBeenCalledWith('make_customer_address_default', { p_address_id: ID(2) });
    expect(res.status).toBe(200);
    expect((await res.json()).address).toMatchObject({ id: ID(2), is_default: true });
  });

  it('answers 404 for another user\'s id without calling the RPC', async () => {
    h.tables.customer_addresses = [stored(1, { user_id: 'someone-else' })];
    expect((await def.POST(req('POST'), ctx(ID(1)))).status).toBe(404);
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
