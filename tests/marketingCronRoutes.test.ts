import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FakeDb } from './helpers/marketingDb';
import { newDb, rowsOf, seedSettings } from './helpers/marketingWorld';

// The two crons, the public opt-in link and the click redirect (spec §6).
//   crons          CRON_SECRET Bearer, fail CLOSED, GET and POST both, migration-missing is a no-op
//   /api/marketing/optin   public, only the link, only when the flag is on AND a number is set
//   /r/[token]     stamps the FIRST click only, then always 302 → /menu, never an error

const h = vi.hoisted(() => ({
  db: null as unknown as FakeDb,
  flags: { marketing: true },
  runDailyPlan: vi.fn(),
  runSendBatch: vi.fn(),
}));

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => h.db.client }));
vi.mock('@/lib/flags', () => ({ flags: h.flags }));
vi.mock('@/lib/marketing/server/planner', () => ({ runDailyPlan: h.runDailyPlan }));
vi.mock('@/lib/marketing/server/sender', () => ({ runSendBatch: h.runSendBatch }));

process.env.CRON_SECRET = 'cron_secret';

const plan = await import('@/app/api/cron/marketing-plan/route');
const send = await import('@/app/api/cron/marketing-send/route');
const optin = await import('@/app/api/marketing/optin/route');
const click = await import('@/app/r/[token]/route');

const req = (path: string, method: string, auth?: string) =>
  new Request(`http://localhost${path}`, { method, headers: auth ? { authorization: auth } : {} });

beforeEach(() => {
  h.db = newDb();
  seedSettings(h.db);
  h.flags.marketing = true;
  h.runDailyPlan.mockReset();
  h.runSendBatch.mockReset();
  h.runDailyPlan.mockResolvedValue({ enabled: true, attributed: 2, planned: [], expired: 0 });
  h.runSendBatch.mockResolvedValue({ enabled: true, claimed: 3, sent: 3, skipped: 0, failed: 0, interrupted: 0 });
  process.env.CRON_SECRET = 'cron_secret';
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe.each([
  ['marketing-plan', plan, () => h.runDailyPlan],
  ['marketing-send', send, () => h.runSendBatch],
] as const)('cron /api/cron/%s', (name, route, engine) => {
  const path = `/api/cron/${name}`;

  it.each(['GET', 'POST'] as const)('%s fails CLOSED without the bearer secret', async (method) => {
    const call = (auth?: string) => route[method](req(path, method, auth));
    expect((await call()).status).toBe(401);
    expect((await call('Bearer wrong')).status).toBe(401);
    expect((await call('cron_secret')).status).toBe(401); // no "Bearer "
    expect(engine()).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST'] as const)('%s fails closed when CRON_SECRET itself is unset', async (method) => {
    delete process.env.CRON_SECRET;
    const res = await route[method](req(path, method, 'Bearer undefined'));
    expect(res.status).toBe(401);
    expect(engine()).not.toHaveBeenCalled();
  });

  it.each(['GET', 'POST'] as const)('%s runs the engine and returns its result (pg_cron POSTs, Vercel GETs)', async (method) => {
    const res = await route[method](req(path, method, 'Bearer cron_secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(await engine().mock.results[0].value);
    expect(engine()).toHaveBeenCalledTimes(1);
  });

  it('passes a migration_missing no-op straight through (200, never an error)', async () => {
    engine().mockResolvedValue({ enabled: false, migration_missing: true });
    const res = await route.GET(req(path, 'GET', 'Bearer cron_secret'));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ enabled: false, migration_missing: true });
  });

  it('answers a bare 500 when the engine fails for any other reason', async () => {
    engine().mockRejectedValue(new Error('db exploded'));
    const res = await route.POST(req(path, 'POST', 'Bearer cron_secret'));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('exploded');
  });

  it('is not statically rendered and has room to work', () => {
    expect(route.dynamic).toBe('force-dynamic');
    expect(route.maxDuration).toBe(60);
  });
});

describe('GET /api/marketing/optin (public)', () => {
  it('gives the wa.me link — and ONLY the link — when the flag is on and a number is set', async () => {
    const res = await optin.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ available: true, wa_link: 'https://wa.me/919876500000?text=START' });
    // Nothing else from the settings row can ride along.
    expect(JSON.stringify(body)).not.toMatch(/budget|cost|cap|holdout/i);
  });

  it('is cacheable for 5 minutes', async () => {
    expect((await optin.GET()).headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('is unavailable with the flag off — without even reading the settings', async () => {
    h.flags.marketing = false;
    h.db.log.length = 0;
    const res = await optin.GET();
    expect(await res.json()).toEqual({ available: false, wa_link: null });
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('is unavailable until the owner has entered a number', async () => {
    seedSettings(h.db, { whatsapp_business_number: '' });
    expect(await (await optin.GET()).json()).toEqual({ available: false, wa_link: null });
    h.db.tables.marketing_settings = [];
    expect(await (await optin.GET()).json()).toEqual({ available: false, wa_link: null });
  });

  it('is unavailable — not an error — before the migration is applied', async () => {
    h.db.setMissing('marketing_settings', true);
    const res = await optin.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ available: false, wa_link: null });
  });

  it('needs no session: the route never asks who is calling', () => {
    expect(optin.dynamic).toBe('force-dynamic');
  });
});

describe('GET /r/[token] (public click redirect)', () => {
  const TOKEN = 'AbCdEf012-_x';
  const call = (token: string) => click.GET(new Request(`http://localhost/r/${token}`), { params: { token } });
  const row = () => rowsOf(h.db, 'marketing_recipients')[0];

  beforeEach(() => {
    h.db.tables.marketing_recipients = [{ id: 'r1', click_token: TOKEN, clicked_at: null, phone: '+919876543210' }];
  });

  it('stamps the click and sends the customer to the menu (302)', async () => {
    const res = await call(TOKEN);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/menu');
    expect(typeof row().clicked_at).toBe('string');
  });

  it('keeps the FIRST click: later clicks never move it', async () => {
    await call(TOKEN);
    const first = row().clicked_at;
    h.db.advance(60_000);
    const res = await call(TOKEN);
    expect(res.status).toBe(302);
    expect(row().clicked_at).toBe(first);
  });

  it('an unknown token still lands on the menu, and touches nothing', async () => {
    const res = await call('zzzzzzzzzzzz');
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/menu');
    expect(row().clicked_at).toBeNull();
  });

  it.each(['short', 'thisiswaytoolongtobeatoken', 'has space!!!', '../../etc/x', "'; drop table"])('a malformed token (%j) never reaches the database', async (token) => {
    h.db.log.length = 0;
    const res = await call(token);
    expect(res.status).toBe(302);
    expect(h.db.log).toEqual([]);
  });

  it('never errors: a database failure or a missing migration still ends at /menu', async () => {
    h.db.failNext('update marketing_recipients');
    expect((await call(TOKEN)).status).toBe(302);
    h.db.setMissing('marketing_recipients', true);
    const res = await call(TOKEN);
    expect(res.status).toBe(302);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/menu');
  });

  it('carries nothing personal: the redirect is a bare /menu', async () => {
    const res = await call(TOKEN);
    expect(new URL(res.headers.get('location')!).search).toBe('');
    expect(res.headers.get('location')).not.toContain('9876543210');
  });
});
