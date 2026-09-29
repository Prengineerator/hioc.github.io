'use client';

// Reusable client-side table with sortable headers and a per-column filter
// row, used by every table in the owner dashboard and the staff menu screen.
// The caller passes rows plus column definitions; sorting/filtering never
// leaves the browser and never changes the rows themselves, so editable tables
// (coupons, dining tables) keep working — they simply see fewer rows.
//
// The sort/filter rules live in lib/ui/tableFilter.ts (pure, unit-tested).
// The table scrolls horizontally inside its own wrapper so a wide table never
// widens the page on a phone.

import { Fragment, useMemo, useState, type ReactNode } from 'react';
import {
  activeFilterCount,
  distinctValues,
  filterRows,
  nextSort,
  sortRows,
  type CellValue,
  type ColumnFilter,
  type FilterKind,
  type FilterState,
  type SortState,
} from '@/lib/ui/tableFilter';

export interface DataTableColumn<T> {
  key: string;
  header: string;
  /** What sorting and filtering compare against (not necessarily what is shown). */
  value: (row: T) => CellValue;
  /** The cell's content; defaults to the value, with "—" for an empty one. */
  render?: (row: T) => ReactNode;
  /** Filter input under the header. 'date' values are 'YYYY-MM-DD' or ISO timestamps. */
  filter: FilterKind;
  align?: 'left' | 'right' | 'center';
  /** Defaults to true unless filter is 'none'. */
  sortable?: boolean;
  /** Pins the column while the table scrolls sideways (first column of a wide grid). */
  sticky?: boolean;
  /** Replaces the table's cellPadding for this column (e.g. a narrow day column). */
  padding?: string;
  /** Extra classes on the header cell / body cells (colour, weight, nowrap, width). */
  headerClassName?: string;
  cellClassName?: string | ((row: T) => string);
  /**
   * Make this row's cell span the next N columns (the columns it covers are
   * skipped for that row) — e.g. one "no data yet" message across a detail group.
   */
  cellSpan?: (row: T) => number;
}

interface DataTableProps<T> {
  rows: T[];
  columns: DataTableColumn<T>[];
  rowKey: (row: T) => string;
  /** Shown instead of the table when there are no rows at all. */
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
  /** Extra <tr>(s) rendered right after a row, e.g. an expanded detail panel. */
  renderRowAfter?: (row: T) => ReactNode;
  /**
   * A section-header <tr> to insert before `row` (or null), given the row shown
   * before it. Only used while no column sort is active — once the owner sorts,
   * the caller's grouping no longer holds, so the headers are dropped.
   */
  groupHeader?: (row: T, prev: T | null) => ReactNode;
  initialSort?: SortState | null;
  /** Table min width in px, so narrow screens scroll instead of squashing columns. */
  minWidth?: number;
  /** Padding for header and body cells. */
  cellPadding?: string;
  /** Header text style; the default is the small uppercase label used across the dashboard. */
  headerTextClassName?: string;
  /** Classes for the scrolling wrapper, e.g. a bordered card look. */
  scrollClassName?: string;
  className?: string;
}

const ALIGN: Record<NonNullable<DataTableColumn<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
};

const INPUT =
  'h-7 w-full min-w-0 rounded border border-line bg-white px-1.5 text-xs font-normal normal-case tracking-normal text-charcoal outline-none focus:border-tan';

function stickyClass(col: { sticky?: boolean }): string {
  return col.sticky ? 'sticky left-0 z-10 bg-white' : '';
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  emptyMessage,
  onRowClick,
  rowClassName,
  renderRowAfter,
  groupHeader,
  initialSort = null,
  minWidth,
  cellPadding = 'py-1.5 pr-3',
  headerTextClassName = 'text-[10px] font-semibold uppercase tracking-wide text-muted',
  scrollClassName = '',
  className = '',
}: DataTableProps<T>) {
  const [filters, setFilters] = useState<FilterState>({});
  const [sort, setSort] = useState<SortState | null>(initialSort);

  const sortColumn = sort ? columns.find((c) => c.key === sort.key) : undefined;
  const shown = useMemo(
    () => sortRows(filterRows(rows, columns, filters), sortColumn, sort?.dir ?? null),
    [rows, columns, filters, sortColumn, sort?.dir],
  );

  // Select options come from the unfiltered rows so choosing one value never
  // hides the others from the dropdown.
  const options = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const c of columns) if (c.filter === 'select') out[c.key] = distinctValues(rows, c);
    return out;
  }, [rows, columns]);

  if (rows.length === 0) {
    return emptyMessage ? <p className="py-6 text-center text-sm text-muted">{emptyMessage}</p> : null;
  }

  const nActive = activeFilterCount(filters);
  const hasFilters = columns.some((c) => c.filter !== 'none');

  const setFilter = (key: string, patch: Partial<ColumnFilter>) =>
    setFilters((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  const clear = () => setFilters({});

  const cellsFor = (row: T) => {
    const cells: ReactNode[] = [];
    for (let i = 0; i < columns.length; i++) {
      const c = columns[i];
      const extra = typeof c.cellClassName === 'function' ? c.cellClassName(row) : (c.cellClassName ?? '');
      const span = Math.min(Math.max(c.cellSpan?.(row) ?? 1, 1), columns.length - i);
      cells.push(
        <td
          key={c.key}
          colSpan={span > 1 ? span : undefined}
          className={`${c.padding ?? cellPadding} ${ALIGN[c.align ?? 'left']} ${stickyClass(c)} ${extra}`}
        >
          {c.render ? c.render(row) : (defaultCell(c.value(row)) ?? '—')}
        </td>,
      );
      i += span - 1;
    }
    return cells;
  };

  return (
    <div className={className}>
      <div className="mb-1.5 flex items-center justify-between gap-3 text-xs text-muted">
        <span>
          Showing {shown.length} of {rows.length}
        </span>
        {nActive > 0 ? (
          <button type="button" onClick={clear} className="font-bold text-tan-dark hover:underline">
            Clear filters
          </button>
        ) : null}
      </div>

      <div className={`overflow-x-auto ${scrollClassName}`}>
        <table className="w-full border-collapse text-sm" style={minWidth ? { minWidth } : undefined}>
          <thead>
            <tr className={`text-left ${headerTextClassName} ${hasFilters ? '' : 'border-b border-line'}`}>
              {columns.map((c) => {
                const sortable = c.sortable ?? c.filter !== 'none';
                const active = sort?.key === c.key ? sort.dir : null;
                const align = ALIGN[c.align ?? 'left'];
                return (
                  <th
                    key={c.key}
                    scope="col"
                    aria-sort={active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : undefined}
                    className={`${c.padding ?? cellPadding} ${align} ${stickyClass(c)} ${c.headerClassName ?? ''}`}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={() => setSort((s) => nextSort(s, c.key))}
                        title="Click to sort"
                        className={`inline-flex items-center gap-1 [text-transform:inherit] hover:text-charcoal ${
                          c.align === 'right' ? 'flex-row-reverse' : ''
                        }`}
                      >
                        <span>{c.header}</span>
                        <span aria-hidden className={active ? 'text-tan-dark' : 'text-transparent'}>
                          {active === 'desc' ? '▼' : '▲'}
                        </span>
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
            </tr>
            {hasFilters ? (
              <tr className="border-b border-line">
                {columns.map((c) => (
                  <th
                    key={c.key}
                    className={`${c.filter === 'none' ? '' : 'pb-2 pr-3'} align-top font-normal ${stickyClass(c)}`}
                  >
                    <FilterInput
                      column={c}
                      state={filters[c.key]}
                      options={options[c.key]}
                      onChange={(patch) => setFilter(c.key, patch)}
                    />
                  </th>
                ))}
              </tr>
            ) : null}
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <Fragment key={rowKey(row)}>
                {!sort && groupHeader ? groupHeader(row, i > 0 ? shown[i - 1] : null) : null}
                <tr
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={`border-b border-[#f2efe9] ${onRowClick ? 'cursor-pointer hover:bg-[#faf7f4]' : ''} ${
                    rowClassName?.(row) ?? ''
                  }`}
                >
                  {cellsFor(row)}
                </tr>
                {renderRowAfter?.(row)}
              </Fragment>
            ))}
            {shown.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="py-6 text-center text-sm text-muted">
                  No rows match these filters.{' '}
                  <button type="button" onClick={clear} className="font-bold text-tan-dark hover:underline">
                    Clear filters
                  </button>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function defaultCell(v: CellValue): ReactNode {
  return v === null || v === undefined || v === '' ? null : String(v);
}

function FilterInput<T>({
  column,
  state,
  options,
  onChange,
}: {
  column: DataTableColumn<T>;
  state: ColumnFilter | undefined;
  options: string[] | undefined;
  onChange: (patch: Partial<ColumnFilter>) => void;
}) {
  const label = column.header;
  switch (column.filter) {
    case 'text':
      return (
        <input
          type="search"
          value={state?.text ?? ''}
          onChange={(e) => onChange({ text: e.target.value })}
          placeholder="Filter"
          aria-label={`Filter ${label}`}
          className={INPUT}
        />
      );
    case 'select':
      return (
        <select
          value={state?.text ?? ''}
          onChange={(e) => onChange({ text: e.target.value })}
          aria-label={`Filter ${label}`}
          className={INPUT}
        >
          <option value="">All</option>
          {(options ?? []).map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );
    case 'number':
      return (
        <div className="flex gap-1">
          <input
            type="number"
            inputMode="decimal"
            value={state?.min ?? ''}
            onChange={(e) => onChange({ min: e.target.value })}
            placeholder="Min"
            aria-label={`${label} minimum`}
            className={`${INPUT} min-w-[3.5rem]`}
          />
          <input
            type="number"
            inputMode="decimal"
            value={state?.max ?? ''}
            onChange={(e) => onChange({ max: e.target.value })}
            placeholder="Max"
            aria-label={`${label} maximum`}
            className={`${INPUT} min-w-[3.5rem]`}
          />
        </div>
      );
    case 'date':
      return (
        <div className="flex flex-col gap-1">
          <input
            type="date"
            value={state?.min ?? ''}
            onChange={(e) => onChange({ min: e.target.value })}
            aria-label={`${label} from`}
            title="From"
            className={`${INPUT} min-w-[7.5rem]`}
          />
          <input
            type="date"
            value={state?.max ?? ''}
            onChange={(e) => onChange({ max: e.target.value })}
            aria-label={`${label} to`}
            title="To"
            className={`${INPUT} min-w-[7.5rem]`}
          />
        </div>
      );
    default:
      return null;
  }
}
