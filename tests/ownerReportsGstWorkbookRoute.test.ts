import { beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import type { GstComputation } from '@/lib/reports/exports/gstTypes';
import { gstComputationFixture } from '@/tests/helpers/gstComputationFixture';

// Handler-level test for GET /api/owner/reports/gst-workbook, in the style of
// tests/ownerReportsExportRoute.test.ts: auth, the admin client and the GST
// computation are mocked; the route's own work — the owner gate, the period, the
// real workbook builder, the headers and the file name — runs without a database.

const state = {
  owner: true,
  loaded: [] as { client: unknown; from: string; to: string }[],
  failWith: null as Error | null,
  computation: null as GstComputation | null,
};

vi.mock('@/lib/api/auth', () => ({ getOwnerUser: async () => (state.owner ? { id: 'owner-1' } : null) }));

vi.mock('@/lib/api/date', () => ({ istDateIso: () => '2026-10-19' }));

const admin = { admin: true };
vi.mock('@/lib/supabase-server', () => ({ createAdminSupabaseClient: () => admin }));

vi.mock('@/lib/reports/exports/gstComputationServer', () => ({
  loadGstComputation: async (client: unknown, from: string, to: string) => {
    state.loaded.push({ client, from, to });
    if (state.failWith) throw state.failWith;
    return state.computation;
  },
}));

const { GET } = await import('@/app/api/owner/reports/gst-workbook/route');

const get = (query: string) => GET(new Request(`http://localhost/api/owner/reports/gst-workbook?${query}`));

beforeEach(() => {
  state.owner = true;
  state.loaded = [];
  state.failWith = null;
  state.computation = gstComputationFixture();
});

describe('GET /api/owner/reports/gst-workbook', () => {
  it('401s when the caller is not the owner, without loading anything', async () => {
    state.owner = false;
    const res = await get('month=2026-09');
    expect(res.status).toBe(401);
    expect(state.loaded).toEqual([]);
  });

  it('400s for a bad range or month', async () => {
    const bad = [
      'from=2026-09-30&to=2026-09-01', // backwards
      'from=2026-02-30&to=2026-03-01', // not a real date
      'from=2026-10-01&to=2026-10-25', // ends in the future
      'from=2026-06-01&to=2026-09-30', // 122 days
      'month=2026-13',
      'month=september',
      'month=2026-11', // not started
    ];
    for (const q of bad) {
      const res = await get(q);
      expect(res.status, q).toBe(400);
      expect(typeof (await res.json()).error).toBe('string');
    }
    expect(state.loaded).toEqual([]);
  });

  it('serves a whole month as an .xlsx named for the GSTIN and return period', async () => {
    const res = await get('month=2026-09');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="HIOC-GST-09AGJPA9390E1Z9-092026.xlsx"');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(state.loaded).toEqual([{ client: admin, from: '2026-09-01', to: '2026-09-30' }]);

    const bytes = Buffer.from(await res.arrayBuffer());
    expect(res.headers.get('Content-Length')).toBe(String(bytes.byteLength));
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK'); // a zip, which is what .xlsx is
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ExcelJS.Buffer); // exceljs' typings predate Node's generic Buffer
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Summary',
      'GSTR-1 Table 7 (B2CS)',
      'GSTR-1 Table 8 (Nil-Exempt)',
      'GSTR-1 Table 12 (HSN)',
      'GSTR-1 Table 13 (Docs)',
      'Day-wise register',
      'Invoice register',
      'Glossary',
    ]);
    expect(wb.getWorksheet('Summary')!.getCell('A1').value).toBe('GST working — October 2026');
  });

  it('names from/to that cover a whole calendar month the same way', async () => {
    const res = await get('from=2026-02-01&to=2026-02-28');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="HIOC-GST-09AGJPA9390E1Z9-022026.xlsx"');
    expect(state.loaded).toEqual([{ client: admin, from: '2026-02-01', to: '2026-02-28' }]);
  });

  it('names a custom range from_to_to', async () => {
    const res = await get('from=2026-09-05&to=2026-09-20');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="HIOC-GST-09AGJPA9390E1Z9-2026-09-05_to_2026-09-20.xlsx"',
    );
    expect(state.loaded).toEqual([{ client: admin, from: '2026-09-05', to: '2026-09-20' }]);
  });

  it('runs the month in progress up to today, named by its dates', async () => {
    const res = await get('month=2026-10');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="HIOC-GST-09AGJPA9390E1Z9-2026-10-01_to_2026-10-19.xlsx"',
    );
    expect(state.loaded).toEqual([{ client: admin, from: '2026-10-01', to: '2026-10-19' }]);
  });

  it('lets month win over from/to, and defaults a bare request to today', async () => {
    await get('month=2026-08&from=2026-09-05&to=2026-09-20');
    await get('');
    expect(state.loaded.map(({ from, to }) => ({ from, to }))).toEqual([
      { from: '2026-08-01', to: '2026-08-31' },
      { from: '2026-10-19', to: '2026-10-19' },
    ]);
  });

  it('keeps a hostile GSTIN out of the file name header', async () => {
    state.computation!.business.gstin = '09ABC"\r\nSet-Cookie: x=1';
    const res = await get('month=2026-09');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="HIOC-GST-09ABCSetCookiex1-092026.xlsx"');
  });

  it('500s, and logs, when the computation cannot be loaded', async () => {
    state.failWith = new Error('boom');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await get('month=2026-09');
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('Could not build the workbook');
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it('500s, and logs, when the workbook cannot be built', async () => {
    state.computation = { ...gstComputationFixture(), business: undefined } as unknown as GstComputation;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await get('month=2026-09');
      expect(res.status).toBe(500);
      expect((await res.json()).error).toBe('Could not build the workbook');
      expect(log).toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
