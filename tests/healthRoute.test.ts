import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/health. The uptime watch and the incident manager decide "is the
// site down" from this route's status code, so the three outcomes are pinned:
// database fine → 200, database error → 503, database call throwing or timing
// out → 503. Three more things are pinned because each was a way to make the
// route lie or to abuse it:
//   * the database's own error text never reaches the public body;
//   * the read is made with the anon key alone, never with the caller's
//     cookies (a forged session cookie must not be able to turn it into a 503);
//   * a failing database is reported at most once a minute, not once a request.

const state: {
  result: { error: { message: string } | null } | Error;
  table: string | null;
  signal: AbortSignal | null;
  clientArgs: unknown[] | null;
} = { result: { error: null }, table: null, signal: null, clientArgs: null };

const captured: unknown[] = [];

vi.mock('@/lib/monitoring', () => ({
  captureError: (err: unknown) => {
    captured.push(err);
  },
}));

// The cookie-reading server clients must not be touched by this route at all.
vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => {
    throw new Error('health must not use the cookie-based client');
  },
  createAdminSupabaseClient: () => {
    throw new Error('health must not use the service-role client');
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => {
    state.clientArgs = args;
    return {
      from: (table: string) => {
        state.table = table;
        const chain: Record<string, unknown> = {};
        Object.assign(chain, {
          select: () => chain,
          limit: () => chain,
          abortSignal: (signal: AbortSignal) => {
            state.signal = signal;
            return chain;
          },
          then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
            state.result instanceof Error ? reject(state.result) : resolve(state.result),
        });
        return chain;
      },
    };
  },
}));

// A clock the tests move by hand, so the once-a-minute report limit can be
// crossed without waiting. Each test starts ten minutes after the last one.
let clock = 1_800_000_000_000;
const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);

const envBefore = {
  url: process.env.NEXT_PUBLIC_SUPABASE_URL,
  anon: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  service: process.env.SUPABASE_SERVICE_ROLE_KEY,
};
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://placeholder.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'placeholder-anon-key';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder-service-role-key';

const { GET } = await import('@/app/api/health/route');

beforeEach(() => {
  state.result = { error: null };
  state.table = null;
  state.signal = null;
  state.clientArgs = null;
  captured.length = 0;
  clock += 10 * 60_000;
});

afterAll(() => {
  nowSpy.mockRestore();
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore('NEXT_PUBLIC_SUPABASE_URL', envBefore.url);
  restore('NEXT_PUBLIC_SUPABASE_ANON_KEY', envBefore.anon);
  restore('SUPABASE_SERVICE_ROLE_KEY', envBefore.service);
});

describe('GET /api/health', () => {
  it('answers 200 when the database read succeeds', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.db).toBe('ok');
    expect(typeof body.checkedAt).toBe('string');
    expect(body).not.toHaveProperty('error');
    expect(captured).toHaveLength(0);
  });

  it('reads the anon-readable settings row, with a time limit', async () => {
    await GET();
    expect(state.table).toBe('store_settings');
    expect(state.signal).toBeInstanceOf(AbortSignal);
  });

  it('uses the anon key alone: no session, no cookies, never the service-role key', async () => {
    await GET();
    const [url, key, options] = state.clientArgs as [
      string,
      string,
      { auth: Record<string, unknown>; global: { fetch: unknown } },
    ];
    expect(url).toBe('https://placeholder.supabase.co');
    expect(key).toBe('placeholder-anon-key');
    expect(key).not.toBe(process.env.SUPABASE_SERVICE_ROLE_KEY);
    expect(options.auth).toEqual({
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    });
    // GET takes no request, so nothing the caller sends can reach the read.
    expect(GET.length).toBe(0);
    expect(typeof options.global.fetch).toBe('function');
  });

  it('makes every database read live, never from the Next.js data cache', async () => {
    await GET();
    const { global } = (state.clientArgs as [string, string, { global: { fetch: typeof fetch } }])[2];
    const seen: RequestInit[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
      seen.push(init ?? {});
      return Promise.resolve(new Response('[]'));
    }) as typeof fetch;
    try {
      await global.fetch('https://placeholder.supabase.co/rest/v1/store_settings', { method: 'GET' });
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(seen[0].cache).toBe('no-store');
    expect(seen[0].method).toBe('GET');
  });

  it('answers 503 when the database returns an error, without repeating it', async () => {
    state.result = { error: { message: 'connection to db.internal refused' } };
    const res = await GET();
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(text).not.toContain('db.internal');
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.db).toBe('unreachable');
    expect(body.error).toBe('Database check failed');
    expect(captured).toHaveLength(1);
  });

  it('answers 503 when the database call throws (timeout, network)', async () => {
    state.result = new Error('The operation was aborted due to timeout');
    const res = await GET();
    expect(res.status).toBe(503);
    expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
    expect(captured).toHaveLength(1);
  });

  it('reports a failing database at most once a minute, however often it is asked', async () => {
    state.result = { error: { message: 'down' } };
    for (let i = 0; i < 25; i += 1) {
      expect((await GET()).status).toBe(503);
      clock += 1_000;
    }
    expect(captured).toHaveLength(1);
    clock += 60_000;
    expect((await GET()).status).toBe(503);
    expect(captured).toHaveLength(2);
  });

  it('is never cached', async () => {
    expect((await GET()).headers.get('Cache-Control')).toBe('no-store');
  });

  it('names the commit being served, or null when it is unknown', async () => {
    const before = process.env.VERCEL_GIT_COMMIT_SHA;
    try {
      process.env.VERCEL_GIT_COMMIT_SHA = '3de3dd1b7928c57ca1248a5c9084661fe830c642';
      expect(((await (await GET()).json()) as { commit: unknown }).commit).toBe('3de3dd1');
      delete process.env.VERCEL_GIT_COMMIT_SHA;
      expect(((await (await GET()).json()) as { commit: unknown }).commit).toBeNull();
    } finally {
      if (before === undefined) delete process.env.VERCEL_GIT_COMMIT_SHA;
      else process.env.VERCEL_GIT_COMMIT_SHA = before;
    }
  });
});
