import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import vm from 'vm';
import { normalizeOwnerPath, safeOpenPath } from '@/lib/push/url';
import { parseMessage, parseSubscription, endpointHash } from '@/lib/push/validate';

// Phone notifications (docs/WEB-PUSH-SPEC.md). Supabase and web-push are mocked: a
// real push to a phone cannot be tested here.

type Res = { data?: unknown; error?: unknown; count?: number };
type Op = { table: string; op: string; args: unknown[]; filters: [string, unknown][] };
const h = vi.hoisted(() => ({
  flags: { webPush: true },
  user: { id: 'u1' } as { id: string } | null,
  owner: { id: 'owner1' } as { id: string } | null,
  ops: [] as Op[],
  // table -> op -> result
  results: {} as Record<string, Record<string, Res | ((rec: Op) => Res)>>,
}));

function chain(table: string) {
  const rec: Op = { table, op: 'select', args: [], filters: [] };
  h.ops.push(rec);
  const c: Record<string, unknown> = {};
  const result = (): Res => {
    const r = h.results[table]?.[rec.op];
    return (typeof r === 'function' ? r(rec) : r) ?? { data: [], error: null };
  };
  for (const m of ['select', 'order', 'range', 'limit']) c[m] = () => c;
  for (const m of ['insert', 'update', 'upsert', 'delete']) {
    c[m] = (...args: unknown[]) => {
      rec.op = m;
      rec.args = args;
      return c;
    };
  }
  for (const m of ['eq', 'in']) c[m] = (k: string, v: unknown) => (rec.filters.push([k, v]), c);
  c.single = () => Promise.resolve(result());
  c.maybeSingle = () => Promise.resolve(result());
  c.then = (res: (v: unknown) => void) => res(result());
  return c;
}

vi.mock('@/lib/flags', () => ({ flags: h.flags }));
vi.mock('server-only', () => ({}));
vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({ from: chain }),
}));
vi.mock('@/lib/api/auth', () => ({ getAuthUser: () => Promise.resolve(h.user), getOwnerUser: () => Promise.resolve(h.owner) }));
vi.mock('@/lib/api/rateLimit', () => ({ rateLimitOk: () => Promise.resolve(true), clientIp: () => '1.2.3.4' }));
const sendNotification = vi.fn();
vi.mock('web-push', () => ({ default: { sendNotification: (...a: unknown[]) => sendNotification(...a) } }));

const account = await import('@/app/api/account/push/route');
const click = await import('@/app/api/push/click/route');
const status = await import('@/app/api/account/push/status/route');
const ownerSummary = await import('@/app/api/owner/marketing/push/route');
const ownerTest = await import('@/app/api/owner/marketing/push/test/route');
const ownerSend = await import('@/app/api/owner/marketing/push/send/route');
const { sendToSubscriptions } = await import('@/lib/push/server');
const manifest = await import('@/app/hioc.webmanifest/route');

const req = (method: string, body?: unknown, url = 'http://t/api/x') =>
  new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } };
const MSG = { title: 'Fresh cold brew', body: 'Two for one until 6pm', url: '/menu' };
const UUID = '123e4567-e89b-42d3-a456-426614174000';

beforeEach(() => {
  h.flags.webPush = true;
  h.user = { id: 'u1' };
  h.owner = { id: 'owner1' };
  h.ops = [];
  h.results = {};
  sendNotification.mockReset().mockResolvedValue({});
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = 'pub';
  process.env.VAPID_PRIVATE_KEY = 'priv';
  process.env.VAPID_SUBJECT = 'mailto:a@b.co';
});

describe('same-origin URL rule', () => {
  const O = 'https://hioc.in';
  const cases: [unknown, string][] = [
    ['/menu', '/menu'],
    ['/shop?x=1#a', '/shop?x=1#a'],
    ['https://hioc.in/menu', '/menu'],
    ['https://evil.com/menu', '/'],
    ['//evil.com', '/'],
    ['/\\evil.com', '/'],
    ['javascript:alert(1)', '/'],
    ['', '/'],
    [undefined, '/'],
    [42, '/'],
    ['/' + 'a'.repeat(400), '/'],
    // Resolve first, then judge: these all resolve to a path starting '//' (another site).
    ['/.//evil.com', '/'],
    ['/a/..//evil.com', '/'],
    ['https://hioc.in/.//evil.com', '/'],
    ['https://hioc.in//evil.com', '/'],
    ['/./\t/evil.com', '/'],
    ['/\t/evil.com', '/'],
    ['/x/\\evil.com', '/'],
    ['/a/../menu', '/menu'],
  ];
  it.each(cases)('safeOpenPath(%j) -> %s', (input, out) => {
    expect(safeOpenPath(input, O)).toBe(out);
  });

  it('public/sw.js applies the same rule', () => {
    const src = readFileSync('public/sw.js', 'utf8');
    const ctx: Record<string, unknown> = { self: { addEventListener() {}, location: { origin: O } }, URL };
    vm.createContext(ctx);
    vm.runInContext(src + '\nthis.safePath = safePath;', ctx);
    const safePath = ctx.safePath as (a: unknown, b: string) => string;
    for (const [input, out] of cases) expect(safePath(input, O)).toBe(out);
  });

  it('owner paths', () => {
    expect(normalizeOwnerPath('/menu')).toBe('/menu');
    expect(normalizeOwnerPath('https://www.hioc.in/shop')).toBe('/shop');
    expect(normalizeOwnerPath('https://hioc.in.evil.com/x')).toBeNull();
    expect(normalizeOwnerPath('//evil.com')).toBeNull();
    expect(normalizeOwnerPath('menu')).toBeNull();
    expect(normalizeOwnerPath('/api/orders')).toBeNull();
  });

  it('owner paths: open-redirect shapes are refused, never stored as typed', () => {
    for (const bad of ['/.//evil.com', '/a/..//evil.com', 'https://hioc.in/.//evil.com', 'https://hioc.in//evil.com', '/./\t/evil.com', '/x/\\evil.com', '/menu/../shop', '/./menu', '/%2e%2e/menu', '/a/%2E/b', '/..']) {
      expect(normalizeOwnerPath(bad), bad).toBeNull();
    }
  });

  it('owner paths: customer pages only', () => {
    for (const bad of ['/staff', '/staff/orders', '/owner', '/owner/marketing', '/api', '/api/orders', '/staff-print', '/staff-print/1/receipt', '/STAFF/orders', '/%73taff/orders', 'https://hioc.in/owner/x', '/staff?x=1', '/owner#a']) {
      expect(normalizeOwnerPath(bad), bad).toBeNull();
    }
    expect(normalizeOwnerPath('/staffroom')).toBe('/staffroom');
    expect(normalizeOwnerPath('/menu?cat=cold#top')).toBe('/menu?cat=cold#top');
  });

  it('every stored path survives the click rule unchanged', () => {
    for (const ok of ['/menu', '/shop', '/menu?cat=cold', 'https://hioc.in/menu', 'https://www.hioc.in/shop?a=1']) {
      const stored = normalizeOwnerPath(ok);
      expect(stored, ok).not.toBeNull();
      expect(safeOpenPath(stored, O)).toBe(stored);
    }
  });
});

describe('validation', () => {
  it('subscription', () => {
    expect(parseSubscription(SUB).ok).toBe(true);
    expect(parseSubscription({ ...SUB, endpoint: 'http://x.com/a' }).ok).toBe(false);
    expect(parseSubscription({ ...SUB, endpoint: 'https://x.com/' + 'a'.repeat(1000) }).ok).toBe(false);
    expect(parseSubscription({ endpoint: SUB.endpoint }).ok).toBe(false);
    expect(parseSubscription({ ...SUB, keys: { p256dh: 'B'.repeat(201), auth: 'a'.repeat(22) } }).ok).toBe(false);
    expect(parseSubscription({ ...SUB, keys: { p256dh: SUB.keys.p256dh, auth: 'a'.repeat(101) } }).ok).toBe(false);
  });
  it('subscription hosts: only the browsers\' push services', () => {
    const ep = (u: string) => parseSubscription({ ...SUB, endpoint: u }).ok;
    for (const good of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/abc',
      'https://api.push.apple.com/3/device/abc',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ]) expect(ep(good), good).toBe(true);
    for (const bad of [
      'https://evil.com/x',
      'https://fcm.googleapis.com.evil.com/x',
      'https://evilfcm.googleapis.com/x',
      'https://push.apple.com/x',
      'https://notify.windows.com/x',
      'https://evil.com/.push.apple.com',
      'https://fcm.googleapis.com@evil.com/x',
      'https://user:pw@fcm.googleapis.com/x',
      'https://fcm.googleapis.com:8443/x',
      'https://127.0.0.1/x',
      'https://169.254.169.254/latest/meta-data',
      'https://[::1]/x',
      'https://localhost/x',
      'http://fcm.googleapis.com/x',
    ]) expect(ep(bad), bad).toBe(false);
  });
  it('message limits', () => {
    expect(parseMessage(MSG).ok).toBe(true);
    expect(parseMessage({ ...MSG, title: 'x'.repeat(41) }).ok).toBe(false);
    expect(parseMessage({ ...MSG, body: 'x'.repeat(121) }).ok).toBe(false);
    expect(parseMessage({ ...MSG, url: 'https://evil.com' }).ok).toBe(false);
  });
});

describe('flag off', () => {
  it('every route and the manifest 404', async () => {
    h.flags.webPush = false;
    const rs = await Promise.all([
      status.POST(req('POST', { endpoint: SUB.endpoint })),
      account.POST(req('POST', SUB)),
      account.DELETE(req('DELETE', { all: true })),
      click.POST(req('POST', { sendId: UUID })),
      ownerSummary.GET(),
      ownerTest.POST(req('POST', MSG)),
      ownerSend.POST(req('POST', { ...MSG, confirm_count: 1 })),
      Promise.resolve(manifest.GET()),
    ]);
    expect(rs.map((r) => r.status)).toEqual(Array(8).fill(404));
    expect(h.ops).toHaveLength(0);
  });
});

describe('POST/DELETE /api/account/push', () => {
  it('401 when signed out', async () => {
    h.user = null;
    expect((await account.POST(req('POST', SUB))).status).toBe(401);
    expect((await account.DELETE(req('DELETE', { all: true }))).status).toBe(401);
    expect((await status.POST(req('POST', {}))).status).toBe(401);
  });

  it('400 for a bad endpoint, with nothing written', async () => {
    const res = await account.POST(req('POST', { ...SUB, endpoint: 'http://insecure.example/x' }));
    expect(res.status).toBe(400);
    expect(h.ops).toHaveLength(0);
  });

  it('saves by endpoint for the session user and logs the consent', async () => {
    const res = await account.POST(req('POST', { ...SUB, source: 'profile' }));
    expect(res.status).toBe(200);
    const up = h.ops.find((o) => o.op === 'upsert');
    expect(up?.table).toBe('push_subscriptions');
    expect(up?.args[0]).toMatchObject({ user_id: 'u1', endpoint: SUB.endpoint });
    expect(up?.args[1]).toEqual({ onConflict: 'endpoint' });
    const ev = h.ops.find((o) => o.table === 'push_consent_events');
    expect(ev?.args[0]).toMatchObject({ user_id: 'u1', action: 'subscribe', source: 'profile', endpoint_hash: endpointHash(SUB.endpoint) });
  });

  it('stores an empty user agent (never null) and trims long ones to 300', async () => {
    await account.POST(req('POST', SUB));
    const up = h.ops.find((o) => o.op === 'upsert');
    expect((up?.args[0] as { user_agent: unknown }).user_agent).toBe('');
    h.ops = [];
    const r = new Request('http://t/x', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'u'.repeat(500) }, body: JSON.stringify(SUB) });
    await account.POST(r);
    expect(((h.ops.find((o) => o.op === 'upsert')?.args[0]) as { user_agent: string }).user_agent).toHaveLength(300);
  });

  it('caps at 10 devices: an 11th is a 409, re-saving one you have is fine', async () => {
    const ten = Array.from({ length: 10 }, (_, i) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/d${i}` }));
    h.results.push_subscriptions = { select: (rec) => (rec.filters.some(([k]) => k === 'user_id') ? { data: ten, error: null } : { data: null, error: null }) };
    const res = await account.POST(req('POST', SUB));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/10 devices/);
    expect(h.ops.some((o) => o.op === 'upsert')).toBe(false);

    const again = await account.POST(req('POST', { ...SUB, endpoint: ten[3].endpoint }));
    expect(again.status).toBe(200);
    expect(h.ops.some((o) => o.op === 'upsert')).toBe(true);
  });

  it('an endpoint moving from another account logs an unsubscribe for the previous customer', async () => {
    h.results.push_subscriptions = { select: (rec) => (rec.filters.some(([k]) => k === 'endpoint') ? { data: { user_id: 'old-user' }, error: null } : { data: [], error: null }) };
    expect((await account.POST(req('POST', SUB))).status).toBe(200);
    const events = h.ops.filter((o) => o.table === 'push_consent_events').map((o) => o.args[0]);
    expect(events).toContainEqual({ user_id: 'old-user', action: 'unsubscribe', source: 'moved_to_other_account', endpoint_hash: endpointHash(SUB.endpoint) });
    expect(events).toContainEqual(expect.objectContaining({ user_id: 'u1', action: 'subscribe' }));
  });

  it('status is a POST with the endpoint in the body', async () => {
    h.results.push_subscriptions = { select: { data: [{ endpoint: SUB.endpoint }, { endpoint: 'https://x/2' }], error: null } };
    const res = await status.POST(req('POST', { endpoint: SUB.endpoint }));
    expect(await res.json()).toEqual({ subscribed: true, devices: 2 });
    expect(await (await status.POST(req('POST', { endpoint: 'https://other' }))).json()).toEqual({ subscribed: false, devices: 2 });
    expect((await status.POST(req('POST', { endpoint: 5 }))).status).toBe(400);
    expect('GET' in account).toBe(false);
  });

  it('a missing table reads as "not set up", not a 500', async () => {
    h.results.push_subscriptions = { upsert: { error: { code: '42P01', message: 'relation "push_subscriptions" does not exist' } } };
    expect((await account.POST(req('POST', SUB))).status).toBe(409);
  });

  it('DELETE one device logs its hash; {all:true} logs one event with an empty hash', async () => {
    h.results.push_subscriptions = { delete: { data: [{ endpoint: 'https://a/1' }, { endpoint: 'https://a/2' }], error: null } };
    expect((await account.DELETE(req('DELETE', { all: true }))).status).toBe(200);
    const ev = h.ops.filter((o) => o.table === 'push_consent_events').pop();
    expect(ev?.args[0]).toEqual([{ user_id: 'u1', action: 'unsubscribe', source: 'unknown', endpoint_hash: '' }]);

    h.ops = [];
    h.results.push_subscriptions = { delete: { data: [{ endpoint: 'https://a/1' }], error: null } };
    await account.DELETE(req('DELETE', { endpoint: 'https://a/1' }));
    const del = h.ops.find((o) => o.op === 'delete');
    expect(del?.filters).toContainEqual(['user_id', 'u1']);
    expect(del?.filters).toContainEqual(['endpoint', 'https://a/1']);
    expect(h.ops.find((o) => o.table === 'push_consent_events')?.args[0]).toEqual([
      { user_id: 'u1', action: 'unsubscribe', source: 'unknown', endpoint_hash: endpointHash('https://a/1') },
    ]);
  });

  it('DELETE needs an endpoint or all', async () => {
    expect((await account.DELETE(req('DELETE', {}))).status).toBe(400);
  });
});

describe('POST /api/push/click', () => {
  it('rejects a non-uuid', async () => {
    expect((await click.POST(req('POST', { sendId: 'nope' }))).status).toBe(400);
    expect(h.ops).toHaveLength(0);
  });
  it('adds one with a guarded update through the admin client', async () => {
    h.results.push_sends = { select: { data: { clicked: 3, device_count: 10 }, error: null } };
    const res = await click.POST(req('POST', { sendId: UUID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const upd = h.ops.find((o) => o.op === 'update');
    expect(upd?.args[0]).toEqual({ clicked: 4 });
    expect(upd?.filters).toEqual([['id', UUID], ['clicked', 3]]);
  });
  it('never counts past the phones the send went to, and still answers ok', async () => {
    h.results.push_sends = { select: { data: { clicked: 10, device_count: 10 }, error: null } };
    const res = await click.POST(req('POST', { sendId: UUID }));
    expect(await res.json()).toEqual({ ok: true });
    expect(h.ops.some((o) => o.op === 'update')).toBe(false);
  });
  it('a 23514 from the counts check is swallowed and still answers ok', async () => {
    h.results.push_sends = {
      select: { data: { clicked: 9, device_count: 10 }, error: null },
      update: { error: { code: '23514', message: 'violates check constraint "push_sends_counts_check"' } },
    };
    const res = await click.POST(req('POST', { sendId: UUID }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
  it('an unknown send id is ok and writes nothing', async () => {
    h.results.push_sends = { select: { data: null, error: null } };
    expect((await click.POST(req('POST', { sendId: UUID }))).status).toBe(200);
    expect(h.ops.some((o) => o.op === 'update')).toBe(false);
  });
});

describe('owner routes', () => {
  it('401 for anyone but the owner', async () => {
    h.owner = null;
    expect((await ownerSummary.GET()).status).toBe(401);
    expect((await ownerTest.POST(req('POST', MSG))).status).toBe(401);
    expect((await ownerSend.POST(req('POST', { ...MSG, confirm_count: 1 }))).status).toBe(401);
  });

  it('not configured is a clear error and sends nothing', async () => {
    delete process.env.VAPID_PRIVATE_KEY;
    const res = await ownerSend.POST(req('POST', { ...MSG, confirm_count: 1 }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/not set up/i);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('needs a confirm count that matches the phones', async () => {
    h.results.push_subscriptions = { select: { data: [{ id: 's1', endpoint: 'https://a', p256dh: 'k', auth: 'a' }], error: null } };
    expect((await ownerSend.POST(req('POST', MSG))).status).toBe(400);
    expect((await ownerSend.POST(req('POST', { ...MSG, confirm_count: 5 }))).status).toBe(409);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('a second broadcast on the same day is a 409 and sends nothing', async () => {
    h.results.push_subscriptions = { select: { data: [{ id: 's1', endpoint: 'https://a', p256dh: 'k', auth: 'a' }], error: null } };
    h.results.push_sends = { insert: { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "push_sends_one_broadcast_per_day"' } } };
    const res = await ownerSend.POST(req('POST', { ...MSG, confirm_count: 1 }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already sent/i);
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('a broadcast records the counts', async () => {
    h.results.push_subscriptions = { select: { data: [{ id: 's1', endpoint: 'https://a', p256dh: 'k', auth: 'a' }], error: null } };
    h.results.push_sends = { insert: { data: { id: UUID }, error: null } };
    const res = await ownerSend.POST(req('POST', { ...MSG, confirm_count: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ delivered: 1, failed: 0, device_count: 1 });
    const ins = h.ops.find((o) => o.table === 'push_sends' && o.op === 'insert');
    expect(ins?.args[0]).toMatchObject({ kind: 'broadcast', device_count: 1, url: '/menu' });
    expect(h.ops.find((o) => o.table === 'push_sends' && o.op === 'update')?.args[0]).toEqual({ delivered: 1, failed: 0 });
  });

  it('test send needs one of the owner\'s own phones', async () => {
    const res = await ownerTest.POST(req('POST', MSG));
    expect(res.status).toBe(400);
    expect(sendNotification).not.toHaveBeenCalled();
  });
});

describe('410 cleanup', () => {
  it('deletes gone phones, keeps failing ones, stamps the rest', async () => {
    const subs = ['ok', 'gone', 'gone404', 'flaky'].map((id) => ({ id, endpoint: `https://p/${id}`, p256dh: 'k', auth: 'a' }));
    sendNotification.mockImplementation((s: { endpoint: string }) => {
      if (s.endpoint.endsWith('/gone')) return Promise.reject({ statusCode: 410 });
      if (s.endpoint.endsWith('/gone404')) return Promise.reject({ statusCode: 404 });
      if (s.endpoint.endsWith('/flaky')) return Promise.reject({ statusCode: 500 });
      return Promise.resolve({});
    });
    const admin = { from: chain } as unknown as Parameters<typeof sendToSubscriptions>[0];
    const out = await sendToSubscriptions(admin, subs, MSG, UUID, { publicKey: 'p', privateKey: 'q', subject: 'mailto:a@b.co' }, sendNotification as never);
    expect(out).toEqual({ delivered: 1, failed: 3, removed: 2, skipped: 0 });
    const del = h.ops.find((o) => o.op === 'delete');
    expect(del?.filters).toEqual([['id', ['gone', 'gone404']]]);
    const upd = h.ops.find((o) => o.op === 'update');
    expect(upd?.filters).toEqual([['id', ['ok']]]);
    expect(JSON.parse(sendNotification.mock.calls[0][1])).toMatchObject({ sendId: UUID, url: '/menu' });
  });

  it('stops at the time budget, counts the rest as skipped and failed, and still cleans up', async () => {
    const subs = Array.from({ length: 45 }, (_, i) => ({ id: `s${i}`, endpoint: `https://p/${i}`, p256dh: 'k', auth: 'a' }));
    const admin = { from: chain } as unknown as Parameters<typeof sendToSubscriptions>[0];
    const out = await sendToSubscriptions(admin, subs, MSG, UUID, { publicKey: 'p', privateKey: 'q', subject: 'mailto:a@b.co' }, sendNotification as never, undefined, -1);
    expect(out).toEqual({ delivered: 0, failed: 45, removed: 0, skipped: 45 });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('uses a short per-send timeout', async () => {
    const admin = { from: chain } as unknown as Parameters<typeof sendToSubscriptions>[0];
    await sendToSubscriptions(admin, [{ id: 's', endpoint: 'https://p/1', p256dh: 'k', auth: 'a' }], MSG, UUID, { publicKey: 'p', privateKey: 'q', subject: 'mailto:a@b.co' }, sendNotification as never);
    expect(sendNotification.mock.calls[0][2].timeout).toBeLessThanOrEqual(5000);
  });

  it('the broadcast writes the counts even when the send blows up', async () => {
    h.results.push_subscriptions = { select: { data: [{ id: 's1', endpoint: 'https://a', p256dh: 'k', auth: 'a' }], error: null } };
    h.results.push_sends = { insert: { data: { id: UUID }, error: null } };
    // A failure outside the per-phone catch: the payload cannot even be built.
    const bad = { toJSON() { throw new Error('boom'); } };
    const { sendAndRecord } = await import('@/lib/push/server');
    const admin = { from: chain } as unknown as Parameters<typeof sendAndRecord>[0];
    await expect(sendAndRecord(admin, [{ id: 's1', endpoint: 'https://a', p256dh: 'k', auth: 'a' }], { title: bad as never, body: 'b', url: '/menu' }, UUID, { publicKey: 'p', privateKey: 'q', subject: 'mailto:a@b.co' })).rejects.toThrow();
    expect(h.ops.find((o) => o.table === 'push_sends' && o.op === 'update')?.args[0]).toEqual({ delivered: 0, failed: 0 });
  });
});
