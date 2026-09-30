import { describe, expect, it, vi } from 'vitest';

// The paging helpers behind every read that can outgrow PostgREST's 1,000-row
// cap: `fetchAll` (lib/reports/reconcileServer.ts, the loop) and `selectAll`
// (lib/inventory/server.ts, which fits it to a query and returns one
// `{ data, error }`). They are tested against a source that, like PostgREST,
// answers at most 1,000 rows however many were asked for.

vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => ({}) }));

const { fetchAll } = await import('@/lib/reports/reconcileServer');
const { selectAll } = await import('@/lib/inventory/server');

type PageResult = { data: number[] | null; error: { code?: string; message?: string } | null };

/** A table of `n` rows (0..n-1) behind a paged read, and every range asked of it. */
function source(n: number, opts: { failAt?: number } = {}) {
  const calls: [number, number][] = [];
  const page = (from: number, to: number): Promise<PageResult> => {
    calls.push([from, to]);
    if (opts.failAt === from) {
      return Promise.resolve({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } });
    }
    const rows = Array.from({ length: n }, (_, i) => i).slice(from, Math.min(to + 1, from + 1000));
    return Promise.resolve({ data: rows, error: null });
  };
  return { page, calls };
}

describe('fetchAll', () => {
  it('reads every page of a table that is not a multiple of the page size', async () => {
    const src = source(2345);
    const rows = await fetchAll<number>(src.page);
    expect(rows).toHaveLength(2345);
    expect(rows).toEqual(Array.from({ length: 2345 }, (_, i) => i)); // in order, none twice, none dropped
    expect(src.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('stops after an empty page when the count is an exact multiple of the page size', async () => {
    const src = source(2000);
    const rows = await fetchAll<number>(src.page);
    expect(rows).toHaveLength(2000);
    expect(src.calls).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it('is one request for a short table, and one for an empty one', async () => {
    const short = source(37);
    expect(await fetchAll<number>(short.page)).toHaveLength(37);
    expect(short.calls).toEqual([[0, 999]]);

    const empty = source(0);
    expect(await fetchAll<number>(empty.page)).toEqual([]);
    expect(empty.calls).toEqual([[0, 999]]);
  });

  it('reads a null data as no rows', async () => {
    expect(await fetchAll<number>(() => Promise.resolve({ data: null, error: null }))).toEqual([]);
  });

  it('rejects when page 2 fails, with the database error, and reads no further', async () => {
    const src = source(2345, { failAt: 1000 });
    await expect(fetchAll<number>(src.page)).rejects.toMatchObject({
      message: 'canceling statement due to statement timeout',
      code: '57014',
    });
    expect(src.calls).toEqual([[0, 999], [1000, 1999]]);
  });
});

describe('selectAll', () => {
  // A query builder: a fresh one per page, ranged by the helper.
  const query = (src: ReturnType<typeof source>) => {
    let built = 0;
    return {
      build: () => {
        built += 1;
        return { range: (from: number, to: number) => src.page(from, to) };
      },
      built: () => built,
    };
  };

  it('returns all the rows as { data, error: null }, building a fresh query for each page', async () => {
    const src = source(2345);
    const q = query(src);
    const res = await selectAll<number>(q.build);
    expect(res.error).toBeNull();
    expect(res.data).toEqual(Array.from({ length: 2345 }, (_, i) => i));
    expect(q.built()).toBe(3);
  });

  it('returns an empty list for an empty table, and for an exact multiple of the page size', async () => {
    expect(await selectAll<number>(query(source(0)).build)).toEqual({ data: [], error: null });
    const res = await selectAll<number>(query(source(3000)).build);
    expect(res.data).toHaveLength(3000);
  });

  it('gives { data: null, error } when page 2 fails, never the rows of page 1', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const src = source(2345, { failAt: 1000 });
      const res = await selectAll<number>(query(src).build);
      expect(res).toEqual({
        data: null,
        error: { code: '57014', message: 'canceling statement due to statement timeout' },
      });
      expect(src.calls).toEqual([[0, 999], [1000, 1999]]);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });
});
