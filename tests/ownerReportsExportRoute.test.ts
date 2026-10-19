import { beforeEach, describe, expect, it, vi } from 'vitest';

// Handler-level test for GET /api/owner/reports/export, in the style of
// tests/ownerReportsCronRoute.test.ts: auth, the admin client and the report
// registry are mocked, so the route's own work — the owner gate, the report
// lookup, the date range, the CSV and its file name — runs without a database.

const state = {
  owner: true,
  loaded: [] as { key: string; from: string; to: string }[],
  failWith: null as Error | null,
};

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: async () => (state.owner ? { id: 'owner-1' } : null) }));

vi.mock('@/lib/api/date', () => ({ istDateIso: () => '2026-10-19' }));

const admin = { admin: true };
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => admin }));

vi.mock('@/lib/reports/exports/registry', () => {
  const def = (key: string) => ({
    key,
    group: 'sales',
    title: key,
    description: key,
    load: async (client: unknown, from: string, to: string) => {
      if (client !== admin) throw new Error('not the admin client');
      state.loaded.push({ key, from, to });
      if (state.failWith) throw state.failWith;
      return { columns: ['Invoice no', 'Bill total (INR)'], rows: [['HIOC-000001', 120], ['=SUM(A1)', 5.5]] };
    },
  });
  const reports = [def('orders'), def('gstr1-b2cs')];
  return { findReport: (key: string | null) => reports.find((r) => r.key === key) };
});

const { GET } = await import('@/app/api/owner/reports/export/route');

const get = (query: string) => GET(new Request(`http://localhost/api/owner/reports/export?${query}`));

beforeEach(() => {
  state.owner = true;
  state.loaded = [];
  state.failWith = null;
});

describe('GET /api/owner/reports/export', () => {
  it('401s when the caller is not the owner, without loading anything', async () => {
    state.owner = false;
    const res = await get('report=orders&from=2026-09-01&to=2026-09-30');
    expect(res.status).toBe(401);
    expect(state.loaded).toEqual([]);
  });

  it('404s for an unknown or missing report', async () => {
    expect((await get('report=nope&from=2026-09-01&to=2026-09-30')).status).toBe(404);
    expect((await get('from=2026-09-01&to=2026-09-30')).status).toBe(404);
    expect(state.loaded).toEqual([]);
  });

  it('400s for a bad range', async () => {
    const bad = [
      'from=2026-09-30&to=2026-09-01', // backwards
      'from=2026-02-30&to=2026-03-01', // not a real date
      'from=2026-10-01&to=2026-10-25', // ends in the future
      'from=2026-06-01&to=2026-09-30', // 122 days
    ];
    for (const q of bad) {
      const res = await get(`report=orders&${q}`);
      expect(res.status, q).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    }
    expect(state.loaded).toEqual([]);
  });

  it('allows exactly 93 days and refuses 94', async () => {
    expect((await get('report=orders&from=2026-07-01&to=2026-10-01')).status).toBe(200);
    expect((await get('report=orders&from=2026-06-30&to=2026-10-01')).status).toBe(400);
  });

  it('400s for a bad month or one that has not started', async () => {
    for (const month of ['2026-13', '2026-00', '2026-9', 'september', '26-09', '2026-09-01', '2026-11']) {
      const res = await get(`report=orders&month=${month}`);
      expect(res.status, month).toBe(400);
    }
    expect(state.loaded).toEqual([]);
  });

  it('serves a whole month as a CSV named for the month', async () => {
    const res = await get('report=orders&month=2026-09');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="hioc-orders-2026-09.csv"');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(state.loaded).toEqual([{ key: 'orders', from: '2026-09-01', to: '2026-09-30' }]);
    // A UTF-8 BOM for Excel (res.text() would strip it), CRLF, and a formula-looking cell defanged by toCsv.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes)).toBe(
      '﻿Invoice no,Bill total (INR)\r\nHIOC-000001,120\r\n\'=SUM(A1),5.5\r\n',
    );
  });

  it('names from/to that cover a whole calendar month the same way', async () => {
    const res = await get('report=gstr1-b2cs&from=2026-02-01&to=2026-02-28');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="hioc-gstr1-b2cs-2026-02.csv"');
    expect(state.loaded).toEqual([{ key: 'gstr1-b2cs', from: '2026-02-01', to: '2026-02-28' }]);
  });

  it('names a custom range from_to_to', async () => {
    const res = await get('report=orders&from=2026-09-05&to=2026-09-20');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="hioc-orders-2026-09-05_to_2026-09-20.csv"');
    expect(state.loaded).toEqual([{ key: 'orders', from: '2026-09-05', to: '2026-09-20' }]);
  });

  it('runs the month in progress up to today, named by its dates', async () => {
    const res = await get('report=orders&month=2026-10');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="hioc-orders-2026-10-01_to_2026-10-19.csv"');
    expect(state.loaded).toEqual([{ key: 'orders', from: '2026-10-01', to: '2026-10-19' }]);
  });

  it('lets month win over from/to, and defaults a bare request to today', async () => {
    await get('report=orders&month=2026-08&from=2026-09-05&to=2026-09-20');
    await get('report=orders');
    expect(state.loaded).toEqual([
      { key: 'orders', from: '2026-08-01', to: '2026-08-31' },
      { key: 'orders', from: '2026-10-19', to: '2026-10-19' },
    ]);
  });

  it('500s, and logs, when the report cannot be built', async () => {
    state.failWith = new Error('boom');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await get('report=orders&month=2026-09');
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('Could not build the report');
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
