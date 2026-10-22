import ExcelJS from 'exceljs';
import type { Sheets } from './types';

// Reads an .xlsx into plain values (sheet → rows → cells, all 0-based) so the
// parsers stay pure functions over arrays, testable without a workbook, the
// same split as lib/petpooja/orders.ts.
//
// exceljs hands back a few non-primitive cell shapes; each is flattened to
// what a person sees in Excel:
//   formula   {formula, result}  → the cached result
//   rich text {richText: [...]}  → the joined text
//   hyperlink {text, hyperlink}  → the text
//   error     {error}            → null
//   Date                          → 'YYYY-MM-DD HH:MM:SS'. Excel dates carry no
//     time zone; exceljs returns the wall-clock value as if it were UTC, so the
//     UTC parts ARE the time printed in the sheet (IST for these reports).

function two(n: number): string {
  return String(n).padStart(2, '0');
}

export function plainCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return (
      `${value.getUTCFullYear()}-${two(value.getUTCMonth() + 1)}-${two(value.getUTCDate())} ` +
      `${two(value.getUTCHours())}:${two(value.getUTCMinutes())}:${two(value.getUTCSeconds())}`
    );
  }
  if (typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if ('result' in v) return plainCell(v.result);
    if (Array.isArray(v.richText)) {
      return (v.richText as { text?: string }[]).map((p) => p.text ?? '').join('');
    }
    if ('text' in v) return plainCell(v.text);
    if ('error' in v) return null;
    return null;
  }
  return value;
}

/** True when the bytes start like a zip container (every .xlsx is one). */
export function looksLikeXlsx(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export async function readWorkbook(bytes: Uint8Array): Promise<Sheets> {
  const wb = new ExcelJS.Workbook();
  // exceljs' typings predate Node's generic Buffer; the bytes are what it wants.
  await wb.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  const sheets: Sheets = {};
  wb.eachSheet((ws) => {
    const rows: unknown[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: unknown[] = [];
      for (let c = 1; c <= row.cellCount; c++) cells.push(plainCell(row.getCell(c).value));
      rows.push(cells);
    }
    sheets[ws.name] = rows;
  });
  return sheets;
}
