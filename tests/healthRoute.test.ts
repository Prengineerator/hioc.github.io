import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/health. The uptime watch and the incident manager decide "is the
// site down" from this route's status code, and a rollback can follow from it,
// so the three outcomes are pinned: database fine → 200, database error → 503,
// database call throwing or timing out → 503. The database's own error text
// must never reach the public body.

const state: {
  result: { error: { message: string } | null } | Error;
  table: string | null;
  signal: AbortSignal | null;
} = { result: { error: null }, table: null, signal: null };

const captured: unknown[] = [];

vi.mock('@/lib/monitoring', () => ({
  captureError: (err: unknown) => {
    captured.push(err);
  },
}));

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({
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
  }),
}));

const { GET } = await import('@/app/api/health/route');

beforeEach(() => {
  state.result = { error: null };
  state.table = null;
  state.signal = null;
  captured.length = 0;
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
