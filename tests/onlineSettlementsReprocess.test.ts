import { describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { ingestSettlementFile, sha256Hex, type ReportRow } from '@/lib/online-settlements/ingest';
import { reprocessSavedReports } from '@/lib/online-settlements/reprocess';
import type { Platform } from '@/lib/online-settlements/types';
import { memoryStore } from './helpers/memorySettlementStore';
import { buildZomatoWorkbook } from './helpers/zomatoSettlementFixture';

// "Re-read saved reports" (lib/online-settlements/reprocess.ts) against an
// in-memory SettlementStore: saved Swiggy files stay 'unsupported', a 'failed'
// file that is a good report now reads (on the same report row), missing
// files are counted, and reports already read are never touched.

const EMAIL = {
  email_message_id: '<msg-1@zomato.com>',
  email_from: 'reports@zomato.com',
  email_subject: 'Your weekly settlement report',
  email_received_at: '2026-09-30T04:00:00.000Z',
};

async function swiggyBytes() {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Summary').addRow(['Swiggy payout']);
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

async function otherBytes() {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Sheet1').addRow(['Monthly stock count']);
  return new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

const zomatoBytes = (id: string) =>
  buildZomatoWorkbook({
    period: '22 Sep 2026 - 28 Sep 2026',
    orders: [
      { id: `${id}1`, date: '2026-09-28 13:00:00', subtotal: 300, payout: 150 },
      { id: `${id}2`, date: '2026-09-27 13:00:00', subtotal: 200, payout: 100 },
    ],
  });

/** A report row as it was left by an earlier run: the file is kept in Storage (unless `stored` is false). */
function seed(
  m: ReturnType<typeof memoryStore>,
  bytes: Uint8Array,
  o: { fileName: string; platform: Platform; status: ReportRow['status']; stored?: boolean; path?: string },
) {
  const sha = sha256Hex(bytes);
  const path = o.path ?? `${o.platform}/${sha.slice(0, 2)}/${sha}-${o.fileName}`;
  if (o.stored !== false) m.files.set(path, bytes);
  const row = {
    id: `report-${m.reports.length + 1}`,
    platform: o.platform,
    source: 'email',
    file_name: o.fileName,
    file_sha256: sha,
    file_bytes: bytes.length,
    storage_path: o.stored === false && !o.path ? null : path,
    ...EMAIL,
    restaurant_ref: null,
    period_start: null,
    period_end: null,
    status: o.status,
    error: 'Earlier error',
    orders_count: 0,
    deductions_count: 0,
    warnings: [],
    read_at: null,
  } as ReportRow & { id: string };
  m.reports.push(row);
  return row;
}

describe('reprocessSavedReports', () => {
  it('reads what can be read now and reports the rest, never touching a report already read', async () => {
    const m = memoryStore();
    // Already read: must come through untouched and unread.
    const readRow = await ingestSettlementFile(m.store, {
      bytes: await zomatoBytes('800000000'),
      fileName: 'Zomato_Settlement_Report_20788341_22_Sep_2026_28_Sep_2026.xlsx',
      source: 'email',
      platformHint: 'zomato',
    });
    expect(readRow.status).toBe('read');
    const before = structuredClone(m.reports[0]);
    const readPath = m.reports[0].storage_path as string;

    const swiggy = seed(m, await swiggyBytes(), { fileName: 'Swiggy_Payout.xlsx', platform: 'swiggy', status: 'unsupported' });
    // Failed at the time (say a parser bug), but the file is a good Zomato report.
    const fixed = seed(m, await zomatoBytes('900000000'), { fileName: 'Zomato_Settlement_Report_29_Sep.xlsx', platform: 'zomato', status: 'failed' });
    const gone = seed(m, await otherBytes(), { fileName: 'gone.xlsx', platform: 'zomato', status: 'failed', stored: false, path: 'zomato/zz/gone.xlsx' });
    const noCopy = seed(m, new Uint8Array([9, 9]), { fileName: 'never-saved.xlsx', platform: 'swiggy', status: 'unsupported', stored: false });
    m.reads.length = 0;

    const result = await reprocessSavedReports(m.store, m.reports, {});

    expect(result).toMatchObject({ checked: 4, read: 1, stillUnsupported: 1, failed: 0, missingFile: 2, notReached: 0 });
    expect(result.files.map((f) => [f.reportId, f.status])).toEqual([
      [swiggy.id, 'stillUnsupported'],
      [fixed.id, 'read'],
      [gone.id, 'missingFile'],
      [noCopy.id, 'missingFile'],
    ]);
    expect(result.files[1]).toMatchObject({ orders: 2, periodStart: '2026-09-22', periodEnd: '2026-09-28' });

    // The read report: not downloaded, not changed.
    expect(m.reads).not.toContain(readPath);
    expect(m.reads).toHaveLength(3); // swiggy, fixed, gone (noCopy has no path to ask for)
    expect(m.reports[0]).toEqual(before);

    // The failed file became a read report on its own row, with the email details it came with.
    expect(m.reports).toHaveLength(5);
    expect(m.reports.find((r) => r.id === fixed.id)).toMatchObject({
      status: 'read', error: null, orders_count: 2, period_end: '2026-09-28', source: 'email', ...EMAIL,
    });
    expect(m.reports.find((r) => r.id === fixed.id)?.storage_path).toMatch(/^zomato\//);
    expect(m.orders.get('zomato|9000000001')).toMatchObject({ report_id: fixed.id, payout_inr: 150 });

    // Swiggy stays saved, waiting; the missing ones are left as they were.
    expect(m.reports.find((r) => r.id === swiggy.id)).toMatchObject({ status: 'unsupported', platform: 'swiggy' });
    expect(m.reports.find((r) => r.id === gone.id)).toMatchObject({ status: 'failed', error: 'Earlier error' });
    expect(m.reports.find((r) => r.id === noCopy.id)).toMatchObject({ status: 'unsupported', storage_path: null });

    // Pressing it again changes nothing: the fixed one is read now, so it isn't looked at.
    const again = await reprocessSavedReports(m.store, m.reports, {});
    expect(again).toMatchObject({ checked: 3, read: 0, stillUnsupported: 1, missingFile: 2 });
  });

  it('counts a file that is still not a settlement report as failed, with the reason on the report', async () => {
    const m = memoryStore();
    const stock = seed(m, await otherBytes(), { fileName: 'stock.xlsx', platform: 'zomato', status: 'failed' });

    const result = await reprocessSavedReports(m.store, m.reports, {});

    expect(result).toMatchObject({ checked: 1, read: 0, failed: 1 });
    expect(result.files[0]).toMatchObject({ reportId: stock.id, status: 'failed', message: expect.stringMatching(/Order Level/) });
    expect(m.reports).toHaveLength(1);
    expect(m.reports[0]).toMatchObject({ status: 'failed', error: expect.stringMatching(/Order Level/) });
  });

  it('keeps going when one file cannot be fetched or read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const m = memoryStore();
    seed(m, await zomatoBytes('700000000'), { fileName: 'a.xlsx', platform: 'zomato', status: 'failed' });
    const good = seed(m, await zomatoBytes('600000000'), { fileName: 'b.xlsx', platform: 'zomato', status: 'failed' });
    const flaky = { ...m.store, readFile: async (p: string) => (p.endsWith('-a.xlsx') ? Promise.reject(new Error('storage down')) : m.store.readFile(p)) };

    const result = await reprocessSavedReports(flaky, m.reports, {});

    expect(result).toMatchObject({ checked: 2, read: 1, failed: 1 });
    expect(result.files[0]).toMatchObject({ status: 'failed', message: 'storage down' });
    expect(m.reports.find((r) => r.id === good.id)?.status).toBe('read');
    errorSpy.mockRestore();
  });

  it('can be limited to one platform', async () => {
    const m = memoryStore();
    const swiggy = seed(m, await swiggyBytes(), { fileName: 'Swiggy_Payout.xlsx', platform: 'swiggy', status: 'unsupported' });
    const zomato = seed(m, await zomatoBytes('500000000'), { fileName: 'z.xlsx', platform: 'zomato', status: 'failed' });

    const result = await reprocessSavedReports(m.store, m.reports, { platform: 'swiggy' });

    expect(result).toMatchObject({ checked: 1, stillUnsupported: 1, read: 0 });
    expect(m.reads).toEqual([swiggy.storage_path]);
    expect(m.reports.find((r) => r.id === zomato.id)?.status).toBe('failed');
  });

  it('stops at the time budget and says how many it did not get to', async () => {
    const m = memoryStore();
    seed(m, await swiggyBytes(), { fileName: 'one.xlsx', platform: 'swiggy', status: 'unsupported' });
    seed(m, await zomatoBytes('400000000'), { fileName: 'two.xlsx', platform: 'zomato', status: 'failed' });

    const result = await reprocessSavedReports(m.store, m.reports, { deadline: 0 });

    expect(result).toMatchObject({ checked: 0, notReached: 2, files: [] });
    expect(m.reads).toEqual([]);
  });

  it('does not lose the saved copy when it cannot be stored a second time', async () => {
    const m = memoryStore();
    const row = seed(m, await zomatoBytes('300000000'), { fileName: 'c.xlsx', platform: 'zomato', status: 'failed' });
    const path = row.storage_path;

    const result = await reprocessSavedReports({ ...m.store, saveFile: async () => false }, m.reports, {});

    expect(result.read).toBe(1);
    expect(m.reports[0]).toMatchObject({ status: 'read', storage_path: path });
  });
});
