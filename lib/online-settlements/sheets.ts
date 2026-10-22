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

// A plain number, no leading zeros ('007' stays text, '0.5' is a number).
const PLAIN_NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/** A CSV cell as the xlsx path would hold it: plain numbers as numbers, unless more than 15 digits. */
function csvCell(s: string): string | number {
  if (!PLAIN_NUMBER.test(s) || s.replace(/\D/g, '').length > 15) return s;
  return Number(s);
}

/**
 * RFC 4180 CSV (UTF-8, optional byte-order mark, comma separated, CRLF or LF)
 * into the same rows-of-cells shape as one workbook sheet. A line that is
 * empty is an empty row; blank lines at the end are dropped.
 */
export function readCsv(bytes: Uint8Array): unknown[][] {
  // TextDecoder drops a leading byte-order mark.
  const text = new TextDecoder('utf-8').decode(bytes);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const endRow = () => {
    if (row.length || field) row.push(field);
    rows.push(row);
    row = [];
    field = '';
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (row.length || field) endRow();
  while (rows.length && rows[rows.length - 1].length === 0) rows.pop();
  return rows.map((r) => r.map(csvCell));
}
