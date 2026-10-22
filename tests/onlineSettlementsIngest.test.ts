import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { ingestSettlementFile } from '@/lib/online-settlements/ingest';
import { memoryStore } from './helpers/memorySettlementStore';
import { buildZomatoWorkbook, type FixtureOrder } from './helpers/zomatoSettlementFixture';

// The ingest pipeline (lib/online-settlements/ingest.ts) against an in-memory
// SettlementStore: dedupe by file hash, newer-report-wins per order and per
// deduction, Swiggy files saved for later, and what is refused.

const order = (o: Partial<FixtureOrder> & { id: string }): FixtureOrder => ({
  date: '2026-09-28 13:00:00', subtotal: 300, promo: 60, commission: 60, payout: 150, ...o,
});
const NAME = (from: string, to: string) => `Zomato_Settlement_Report_20788341_${from}_${to}.xlsx`;

describe('ingestSettlementFile', () => {
  it('reads a Zomato report into orders and ads, keeping the raw file', async () => {
    const m = memoryStore();
    const bytes = await buildZomatoWorkbook({
      period: '22 Sep 2026 - 28 Sep 2026',
      orders: [order({ id: '9000000001' }), order({ id: '9000000002', status: 'REJECTED', payout: -40 })],
      ads: [{ campaign: '43275915', window: '22 September 26 - 28 September 26', amount: 913.4 }],
    });
    const out = await ingestSettlementFile(m.store, { bytes, fileName: NAME('22_Sep_2026', '28_Sep_2026'), source: 'email', platformHint: 'zomato' });

    expect(out).toMatchObject({ status: 'read', platform: 'zomato', orders: 2, periodStart: '2026-09-22', periodEnd: '2026-09-28', olderRowsSkipped: 0 });
    expect(m.reports).toHaveLength(1);
    expect(m.reports[0]).toMatchObject({ status: 'read', source: 'email', orders_count: 2, deductions_count: 1, period_end: '2026-09-28' });
    expect(m.reports[0].storage_path).toMatch(/^zomato\/[0-9a-f]{2}\/[0-9a-f]{64}-Zomato_Settlement_Report/);
    expect(m.files.size).toBe(1);
    expect(m.orders.get('zomato|9000000002')).toMatchObject({ status: 'rejected', payout_inr: -40, report_period_end: '2026-09-28' });
    expect([...m.deductions.values()][0]).toMatchObject({ kind: 'ads', amount_inr: 913.4, period_start: '2026-09-22' });
  });

  it('skips the same file the second time, however it arrives', async () => {
    const m = memoryStore();
    const bytes = await buildZomatoWorkbook({ period: '22 Sep 2026 - 28 Sep 2026', orders: [order({ id: '9000000001' })] });
    await ingestSettlementFile(m.store, { bytes, fileName: NAME('22_Sep_2026', '28_Sep_2026'), source: 'email' });
    const again = await ingestSettlementFile(m.store, { bytes, fileName: 'renamed.xlsx', source: 'upload' });
    expect(again.status).toBe('duplicate');
    expect(m.reports).toHaveLength(1);
  });

  it('lets a newer report settle an order, and never lets an older one undo it', async () => {
    const m = memoryStore();
    const week1 = await buildZomatoWorkbook({
      period: '22 Sep 2026 - 28 Sep 2026',
      orders: [order({ id: '9000000001', settlement: 'pending', settlementDate: 'NA', utr: 'NA' })],
    });
    const week2 = await buildZomatoWorkbook({
      period: '29 Sep 2026 - 05 Oct 2026',
      orders: [order({ id: '9000000001', settlement: 'settled', settlementDate: '2026-10-08 05:30:00', utr: 'CITIN2' })],
    });

    await ingestSettlementFile(m.store, { bytes: week1, fileName: 'w1.xlsx', source: 'upload', platformHint: 'zomato' });
    expect(m.orders.get('zomato|9000000001')).toMatchObject({ settlement_status: 'pending', utr: '' });

    await ingestSettlementFile(m.store, { bytes: week2, fileName: 'w2.xlsx', source: 'upload', platformHint: 'zomato' });
    expect(m.orders.get('zomato|9000000001')).toMatchObject({ settlement_status: 'settled', utr: 'CITIN2', settlement_date: '2026-10-08' });

    // Re-reading the older report (say it failed first time and was retried): nothing changes.
    const m2 = memoryStore();
    await ingestSettlementFile(m2.store, { bytes: week2, fileName: 'w2.xlsx', source: 'upload', platformHint: 'zomato' });
    const old = await ingestSettlementFile(m2.store, { bytes: week1, fileName: 'w1.xlsx', source: 'upload', platformHint: 'zomato' });
    expect(old).toMatchObject({ status: 'read', olderRowsSkipped: 1 });
    expect(m2.orders.get('zomato|9000000001')).toMatchObject({ settlement_status: 'settled', utr: 'CITIN2' });
    expect(m2.reports[1].warnings.join(' ')).toMatch(/1 row\(s\) left as they were/);
  });

  it('saves Swiggy files for later instead of guessing at their format', async () => {
    const m = memoryStore();
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Summary').addRow(['Swiggy payout']);
    const bytes = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);

    const out = await ingestSettlementFile(m.store, { bytes, fileName: 'Payout_Annexure.xlsx', source: 'email', platformHint: 'swiggy' });
    expect(out).toMatchObject({ status: 'unsupported', platform: 'swiggy' });
    expect(m.reports[0]).toMatchObject({ platform: 'swiggy', status: 'unsupported' });
    expect(m.files.size).toBe(1);

    // The next daily check sees it again: not reported as new.
    const again = await ingestSettlementFile(m.store, { bytes, fileName: 'Payout_Annexure.xlsx', source: 'email', platformHint: 'swiggy' });
    expect(again.status).toBe('duplicate');
    expect(m.reports).toHaveLength(1);
  });

  it('refuses files that are not settlement reports', async () => {
    const m = memoryStore();
    const pdf = await ingestSettlementFile(m.store, { bytes: new Uint8Array([1, 2, 3]), fileName: 'invoice.pdf', source: 'upload' });
    expect(pdf).toMatchObject({ status: 'failed', message: expect.stringMatching(/Not a spreadsheet/) });

    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Sheet1').addRow(['Monthly stock count']);
    const other = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const unknown = await ingestSettlementFile(m.store, { bytes: other, fileName: 'stock.xlsx', source: 'upload' });
    expect(unknown).toMatchObject({ status: 'failed', message: 'Not a Zomato or Swiggy settlement report' });
    expect(m.reports).toHaveLength(0);

    // Claimed to be Zomato but isn't a settlement workbook: recorded as unreadable, with why.
    const claimed = await ingestSettlementFile(m.store, { bytes: other, fileName: 'stock.xlsx', source: 'email', platformHint: 'zomato' });
    expect(claimed).toMatchObject({ status: 'failed', platform: 'zomato', message: expect.stringMatching(/Order Level/) });
    expect(m.reports[0]).toMatchObject({ status: 'failed' });
  });
});
