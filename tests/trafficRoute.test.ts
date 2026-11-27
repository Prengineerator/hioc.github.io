import { beforeEach, describe, expect, it, vi } from 'vitest';

// First-party traffic tracking: POST /api/traffic and the order-side writer
// (lib/traffic/record.ts recordTrafficConversion).

const SID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36';

const state: {
  inserted: Record<string, unknown>[];
  insertError: { code?: string; message?: string } | null;
  rateLimitOk: boolean;
  enabled: boolean;
} = { inserted: [], insertError: null, rateLimitOk: true, enabled: true };

vi.mock('@/lib/flags', () => ({
  flags: {
    get trafficTracking() {
      return state.enabled;
    },
  },
}));

vi.mock('@/lib/api/rateLimit', () => ({
  clientIp: () => '127.0.0.1',
  rateLimitOk: () => Promise.resolve(state.rateLimitOk),
}));

vi.mock('@/lib/supabase-server', () => ({
  createAdminSupabaseClient: () => ({
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        if (table !== 'traffic_events') return Promise.resolve({ error: { message: `unexpected table ${table}` } });
        if (state.insertError) return Promise.resolve({ error: state.insertError });
        state.inserted.push(payload);
        return Promise.resolve({ error: null });
      },
    }),
  }),
}));

const { POST } = await import('@/app/api/traffic/route');
const { recordTrafficConversion, trafficContext } = await import('@/lib/traffic/record');
const { createAdminSupabaseClient } = await import('@/lib/supabase-server');

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new Request('http://t/api/traffic', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': PHONE_UA, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  state.inserted = [];
  state.insertError = null;
  state.rateLimitOk = true;
  state.enabled = true;
});

describe('POST /api/traffic', () => {
  it('stores a view with the source decided on the server', async () => {
    const res = await post(
      { sid: SID, route: '/shop', landing: true, referrer: 'https://l.instagram.com/?u=x', utm_source: 'IG', utm_medium: 'Story' },
      { 'x-vercel-ip-country': 'in', 'x-vercel-ip-city': 'New%20Delhi' },
    );
    expect(res.status).toBe(204);
    expect(state.inserted).toEqual([
      {
        event: 'view',
        session_id: SID,
        page_group: 'shop',
        route: '/shop',
        landing: true,
        source: 'instagram',
        referrer_host: 'l.instagram.com',
        utm_source: 'ig',
        utm_medium: 'story',
        utm_campaign: null,
        utm_content: null,
        utm_term: null,
        device: 'mobile',
        country: 'IN',
        city: 'New Delhi',
        order_id: null,
        shop_order_id: null,
        value_inr: null,
      },
    ]);
  });

  it('keeps no IP address or User-Agent in the row', async () => {
    await post({ sid: SID, route: '/menu' }, { 'x-forwarded-for': '203.0.113.9' });
    const stored = JSON.stringify(state.inserted);
    expect(stored).not.toContain('203.0.113.9');
    expect(stored).not.toContain('Pixel');
  });

  it('refuses a malformed body or an untracked page', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post({ sid: 'x', route: '/menu' })).status).toBe(400);
    expect((await post({ sid: SID, route: '/staff/orders' })).status).toBe(400);
    expect(state.inserted).toEqual([]);
  });

  it('answers 204 to a crawler and stores nothing', async () => {
    const res = await post({ sid: SID, route: '/menu' }, { 'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' });
    expect(res.status).toBe(204);
    expect(state.inserted).toEqual([]);
  });

  it('rate-limits per IP', async () => {
    state.rateLimitOk = false;
    expect((await post({ sid: SID, route: '/menu' })).status).toBe(429);
    expect(state.inserted).toEqual([]);
  });

  it('still answers 204 before the table exists', async () => {
    state.insertError = { code: 'PGRST205', message: "Could not find the table 'public.traffic_events'" };
    expect((await post({ sid: SID, route: '/menu' })).status).toBe(204);
  });

  it('is a 404 while tracking is switched off', async () => {
    state.enabled = false;
    expect((await post({ sid: SID, route: '/menu' })).status).toBe(404);
  });
});

describe('recordTrafficConversion', () => {
  const context = trafficContext(new Request('http://t/', { headers: { 'user-agent': PHONE_UA } }));
  const admin = createAdminSupabaseClient();
  const attribution = { sid: SID, referrer: 'google.com', utm: { utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null } };

  it('records the order a visit ended in', async () => {
    await recordTrafficConversion(admin, { event: 'order', attribution, route: '/checkout', context, orderId: 'ord-1', valueInr: 320.4 });
    expect(state.inserted).toEqual([
      expect.objectContaining({ event: 'order', session_id: SID, page_group: 'orders', route: '/checkout', source: 'google', order_id: 'ord-1', value_inr: 320 }),
    ]);
  });

  it('records a shop checkout against the Shop', async () => {
    await recordTrafficConversion(admin, { event: 'shop_order', attribution, route: '/shop', context, shopOrderId: 'shop-1', valueInr: 599 });
    expect(state.inserted[0]).toMatchObject({ event: 'shop_order', page_group: 'shop', shop_order_id: 'shop-1', order_id: null });
  });

  it('records nothing without a visit, or with tracking off', async () => {
    await recordTrafficConversion(admin, { event: 'order', attribution: null, route: '/checkout', context, orderId: 'ord-1', valueInr: 1 });
    state.enabled = false;
    await recordTrafficConversion(admin, { event: 'order', attribution, route: '/checkout', context, orderId: 'ord-1', valueInr: 1 });
    expect(state.inserted).toEqual([]);
  });

  it('never throws, even when the insert fails', async () => {
    state.insertError = { code: '23514', message: 'check violation' };
    await expect(
      recordTrafficConversion(admin, { event: 'order', attribution, route: '/checkout', context, orderId: 'ord-1', valueInr: 1 }),
    ).resolves.toBeUndefined();
  });
});
