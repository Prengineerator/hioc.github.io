// The CSV writer for the owner's downloadable reports (lib/reports/exports).
// Made for Excel and the accountant: a UTF-8 BOM so ₹ and names survive, CRLF
// line endings, numbers rounded past float noise, and text that starts with
// = + - @ prefixed with a quote so a cell can never run as a formula.

export type CsvValue = string | number | null | undefined;

/** A report as a table: the header row and the data rows, cells in column order. */
export interface CsvTable {
  columns: string[];
  rows: CsvValue[][];
}

/** Rounds money to paise. */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function csvCell(v: CsvValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '';
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(table: CsvTable): string {
  const lines = [table.columns, ...table.rows].map((row) => row.map(csvCell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
