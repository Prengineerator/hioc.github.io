import { describe, expect, it } from 'vitest';
import { ingestSettlementFile } from '@/lib/online-settlements/ingest';
import { readWorkbook, unsafeWorkbookReason, WorkbookRefused } from '@/lib/online-settlements/sheets';
import { memoryStore } from './helpers/memorySettlementStore';
import { buildZomatoWorkbook } from './helpers/zomatoSettlementFixture';

// The size check on a workbook before exceljs unpacks it
// (lib/online-settlements/sheets.ts): it reads only the zip's file list, so
// these zips are built by hand, with the sizes the file list declares and no
// real contents.

const TOO_LARGE = 'The workbook is too large to open safely';
const DAMAGED = 'The workbook is damaged: its file list cannot be read';
const MB = 1024 * 1024;

interface Entry {
  name: string;
  /** Size the file list declares; the bytes behind it are just `data`. */
  size?: number;
  packed?: number;
  offset?: number;
}

/** A minimal zip: one tiny stored file per entry, then the file list, then the end record. */
function buildZip(entries: Entry[], end: { total?: number; size?: number; offset?: number; zip64Locator?: boolean; comment?: string } = {}): Uint8Array {
  const data = new TextEncoder().encode('x');
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let at = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name);
    const local = Buffer.alloc(30 + name.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    local.set(data, 30 + name.length);
    locals.push(local);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt32LE(e.packed ?? data.length, 20);
    entry.writeUInt32LE(e.size ?? data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(e.offset ?? at, 42);
    name.copy(entry, 46);
    central.push(entry);
    at += local.length;
  }
  const dir = Buffer.concat(central);
  const comment = Buffer.from(end.comment ?? '');
  const eocd = Buffer.alloc(22 + comment.length);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(end.total ?? entries.length, 8);
  eocd.writeUInt16LE(end.total ?? entries.length, 10);
  eocd.writeUInt32LE(end.size ?? dir.length, 12);
  eocd.writeUInt32LE(end.offset ?? at, 16);
  eocd.writeUInt16LE(comment.length, 20);
  comment.copy(eocd, 22);
  const locator = Buffer.alloc(end.zip64Locator ? 20 : 0);
  if (end.zip64Locator) locator.writeUInt32LE(0x07064b50, 0);
  return new Uint8Array(Buffer.concat([...locals, dir, locator, eocd]));
}

describe('unsafeWorkbookReason', () => {
  it('lets a real workbook through, and exceljs reads it', async () => {
    const bytes = await buildZomatoWorkbook({
      period: '22 Sep 2026 - 28 Sep 2026',
      orders: [{ id: '9000000001', date: '2026-09-28 13:00:00', subtotal: 300, payout: 150 }],
    });
    expect(unsafeWorkbookReason(bytes)).toBeNull();
    expect(Object.keys(await readWorkbook(bytes))).toContain('Order Level');
  });

  it('lets a small zip with a comment through', () => {
    expect(unsafeWorkbookReason(buildZip([{ name: 'xl/workbook.xml' }, { name: 'xl/sharedStrings.xml', size: 40 * MB }], { comment: 'made by hand' }))).toBeNull();
  });

  it('refuses a file list that declares 200 MB of contents', async () => {
    const bomb = buildZip([{ name: 'xl/worksheets/sheet1.xml', size: 200 * MB }]);
    expect(unsafeWorkbookReason(bomb)).toBe(TOO_LARGE);
    await expect(readWorkbook(bomb)).rejects.toThrow(WorkbookRefused);
    await expect(readWorkbook(bomb)).rejects.toThrow(TOO_LARGE);
  });

  it('adds the entries up: no single one needs to be huge', () => {
    const many = Array.from({ length: 3 }, (_, i) => ({ name: `part${i}.xml`, size: 40 * MB }));
    expect(unsafeWorkbookReason(buildZip(many))).toBe(TOO_LARGE);
    expect(unsafeWorkbookReason(buildZip(many.slice(0, 2)))).toBeNull();
  });

  it('refuses more than 2,000 entries', () => {
    const entries = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `f${i}` }));
    expect(unsafeWorkbookReason(buildZip(entries(2000)))).toBeNull();
    expect(unsafeWorkbookReason(buildZip(entries(2001)))).toBe(TOO_LARGE);
  });

  it('counts the entries the file list holds, not the number the end record claims', () => {
    const lying = buildZip([{ name: 'a', size: 90 * MB }, { name: 'b', size: 90 * MB }], { total: 1 });
    expect(unsafeWorkbookReason(lying)).toBe(TOO_LARGE);
  });

  it('refuses ZIP64 markers wherever they are', () => {
    expect(unsafeWorkbookReason(buildZip([{ name: 'a', size: 0xffffffff }]))).toBe(TOO_LARGE);
    expect(unsafeWorkbookReason(buildZip([{ name: 'a', packed: 0xffffffff }]))).toBe(TOO_LARGE);
    expect(unsafeWorkbookReason(buildZip([{ name: 'a', offset: 0xffffffff }]))).toBe(TOO_LARGE);
    expect(unsafeWorkbookReason(buildZip([{ name: 'a' }], { offset: 0xffffffff }))).toBe(TOO_LARGE);
    expect(unsafeWorkbookReason(buildZip([{ name: 'a' }], { size: 0xffffffff }))).toBe(TOO_LARGE);
    expect(unsafeWorkbookReason(buildZip([{ name: 'a' }], { total: 0xffff }))).toBe(TOO_LARGE);
    expect(unsafeWorkbookReason(buildZip([{ name: 'a' }], { zip64Locator: true }))).toBe(TOO_LARGE);
  });

  it('refuses a file list that cannot be walked', () => {
    expect(unsafeWorkbookReason(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).toBe(DAMAGED);
    expect(unsafeWorkbookReason(new Uint8Array(100).fill(7))).toBe(DAMAGED);
    // End record says the list starts after the end record itself.
    expect(unsafeWorkbookReason(buildZip([{ name: 'a' }], { offset: 5000 }))).toBe(DAMAGED);
    // An empty list.
    expect(unsafeWorkbookReason(buildZip([]))).toBe(DAMAGED);
    // The last entry's name runs past the end record.
    const bytes = buildZip([{ name: 'a' }]);
    const at = bytes.length - 22 - 47; // the one entry's start
    new DataView(bytes.buffer).setUint16(at + 28, 500, true);
    expect(unsafeWorkbookReason(bytes)).toBe(DAMAGED);
  });
});

describe('a workbook that is refused', () => {
  it('is recorded as a failed report with the reason, and the file is kept', async () => {
    const m = memoryStore();
    const bomb = buildZip([{ name: 'xl/worksheets/sheet1.xml', size: 200 * MB }]);

    const out = await ingestSettlementFile(m.store, { bytes: bomb, fileName: 'Zomato_Settlement_Report_1.xlsx', source: 'email', platformHint: 'zomato' });

    expect(out).toMatchObject({ status: 'failed', platform: 'zomato', message: TOO_LARGE });
    expect(m.reports).toHaveLength(1);
    expect(m.reports[0]).toMatchObject({ status: 'failed', error: TOO_LARGE });
    expect(m.files.size).toBe(1);
    expect(m.orders.size).toBe(0);
  });
});
