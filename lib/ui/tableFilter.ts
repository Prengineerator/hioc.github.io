// Pure sort/filter logic behind components/ui/DataTable.tsx, so the rules are
// unit-tested once and every table in the owner dashboard and staff screens
// behaves the same. No React, no DOM.
//
// A column exposes a single comparable `value(row)`; the filter kind decides
// how the per-column filter input is interpreted against it:
//   text   - case-insensitive "contains"
//   select - exact match on one of the distinct values
//   number - inclusive min / max
//   date   - inclusive from / to on the IST calendar day (value is a
//            'YYYY-MM-DD' date or an ISO timestamp)

import { istDateIso } from '@/lib/api/date';

export type FilterKind = 'text' | 'select' | 'number' | 'date' | 'none';
export type CellValue = string | number | null | undefined;

export interface FilterableColumn<T> {
  key: string;
  filter: FilterKind;
  value: (row: T) => CellValue;
}

/**
 * One column's filter input. text and select use `text`; number uses min/max;
 * date uses min/max as from/to ('YYYY-MM-DD', what <input type="date"> emits).
 */
export interface ColumnFilter {
  text?: string;
  min?: string;
  max?: string;
}

export type FilterState = Record<string, ColumnFilter>;

export type SortDir = 'asc' | 'desc';
export interface SortState {
  key: string;
  dir: SortDir;
}

function isBlank(v: CellValue): v is null | undefined | '' {
  return v === null || v === undefined || v === '';
}

/** A number from a cell or a filter box; tolerates "₹1,200". NaN when not numeric. */
export function toNumber(v: CellValue): number {
  if (typeof v === 'number') return v;
  if (isBlank(v)) return NaN;
  return Number(String(v).replace(/[₹,\s]/g, ''));
}

/** The IST 'YYYY-MM-DD' of a date-only string or an ISO timestamp; null if unparseable. */
export function toDateKey(v: CellValue): string | null {
  if (isBlank(v)) return null;
  const s = String(v);
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : istDateIso(new Date(ms));
}

/** Header-click cycle for one column: none -> asc -> desc -> none. */
export function nextSort(current: SortState | null, key: string): SortState | null {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  if (current.dir === 'asc') return { key, dir: 'desc' };
  return null;
}

function compareCells(a: CellValue, b: CellValue): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable sort by one column; empty cells always sink to the bottom, either direction. */
export function sortRows<T>(rows: T[], column: FilterableColumn<T> | undefined, dir: SortDir | null): T[] {
  if (!column || !dir) return rows;
  const sign = dir === 'asc' ? 1 : -1;
  return rows
    .map((row, i) => ({ row, i, v: column.value(row) }))
    .sort((x, y) => {
      const xb = isBlank(x.v);
      const yb = isBlank(y.v);
      if (xb || yb) return xb === yb ? x.i - y.i : xb ? 1 : -1;
      return sign * compareCells(x.v, y.v) || x.i - y.i;
    })
    .map((e) => e.row);
}

function matchesFilter(kind: FilterKind, cell: CellValue, f: ColumnFilter): boolean {
  switch (kind) {
    case 'text': {
      const q = (f.text ?? '').trim().toLowerCase();
      return !q || String(cell ?? '').toLowerCase().includes(q);
    }
    case 'select': {
      const want = f.text ?? '';
      return want === '' || String(cell ?? '') === want;
    }
    case 'number': {
      const min = f.min?.trim() ? toNumber(f.min) : NaN;
      const max = f.max?.trim() ? toNumber(f.max) : NaN;
      if (Number.isNaN(min) && Number.isNaN(max)) return true;
      const n = toNumber(cell);
      if (Number.isNaN(n)) return false;
      return (Number.isNaN(min) || n >= min) && (Number.isNaN(max) || n <= max);
    }
    case 'date': {
      const from = f.min?.trim() ?? '';
      const to = f.max?.trim() ?? '';
      if (!from && !to) return true;
      const day = toDateKey(cell);
      if (!day) return false;
      return (!from || day >= from) && (!to || day <= to);
    }
    default:
      return true;
  }
}

/** Rows that satisfy every active column filter (AND across columns). */
export function filterRows<T>(rows: T[], columns: FilterableColumn<T>[], filters: FilterState): T[] {
  const active = columns.filter((c) => c.filter !== 'none' && filters[c.key] && isFilterActive(filters[c.key]));
  if (active.length === 0) return rows;
  return rows.filter((row) => active.every((c) => matchesFilter(c.filter, c.value(row), filters[c.key])));
}

export function isFilterActive(f: ColumnFilter | undefined): boolean {
  if (!f) return false;
  return Boolean(f.text?.trim() || f.min?.trim() || f.max?.trim());
}

export function activeFilterCount(filters: FilterState): number {
  return Object.values(filters).filter(isFilterActive).length;
}

/** Sorted distinct non-empty values of a column, for a select filter's options. */
export function distinctValues<T>(rows: T[], column: FilterableColumn<T>): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    const v = column.value(row);
    if (!isBlank(v)) seen.add(String(v));
  }
  return [...seen].sort((a, b) => compareCells(a, b));
}
