import { describe, expect, it } from 'vitest';
import {
  activeFilterCount,
  distinctValues,
  filterRows,
  nextSort,
  sortRows,
  toDateKey,
  toNumber,
  type FilterableColumn,
} from '@/lib/ui/tableFilter';

interface Row {
  name: string | null;
  amount: number | null;
  status: string;
  at: string | null;
}

const rows: Row[] = [
  { name: 'Asha', amount: 120, status: 'Paid', at: '2026-09-27' },
  { name: 'bhavna', amount: 45, status: 'Due', at: '2026-09-28T20:00:00Z' }, // 29 Sep 01:30 IST
  { name: null, amount: null, status: 'Paid', at: null },
  { name: 'Chirag', amount: 1200, status: 'Paid', at: '2026-09-29' },
];

const cols: FilterableColumn<Row>[] = [
  { key: 'name', filter: 'text', value: (r) => r.name },
  { key: 'amount', filter: 'number', value: (r) => r.amount },
  { key: 'status', filter: 'select', value: (r) => r.status },
  { key: 'at', filter: 'date', value: (r) => r.at },
];
const col = (k: string) => cols.find((c) => c.key === k)!;
const names = (rs: Row[]) => rs.map((r) => r.name);

describe('nextSort', () => {
  it('cycles asc -> desc -> none and restarts on another column', () => {
    const a = nextSort(null, 'name');
    expect(a).toEqual({ key: 'name', dir: 'asc' });
    const d = nextSort(a, 'name');
    expect(d).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSort(d, 'name')).toBeNull();
    expect(nextSort(d, 'amount')).toEqual({ key: 'amount', dir: 'asc' });
  });
});

describe('sortRows', () => {
  it('sorts numbers numerically and keeps empty cells last in both directions', () => {
    expect(rows.length).toBe(4);
    expect(sortRows(rows, col('amount'), 'asc').map((r) => r.amount)).toEqual([45, 120, 1200, null]);
    expect(sortRows(rows, col('amount'), 'desc').map((r) => r.amount)).toEqual([1200, 120, 45, null]);
  });

  it('sorts text case-insensitively', () => {
    expect(names(sortRows(rows, col('name'), 'asc'))).toEqual(['Asha', 'bhavna', 'Chirag', null]);
  });

  it('sorts numeric-looking strings naturally', () => {
    const c: FilterableColumn<{ t: string }> = { key: 't', filter: 'text', value: (r) => r.t };
    const out = sortRows([{ t: 'T10' }, { t: 'T2' }, { t: 'T1' }], c, 'asc');
    expect(out.map((r) => r.t)).toEqual(['T1', 'T2', 'T10']);
  });

  it('returns the input unchanged with no direction and does not mutate', () => {
    expect(sortRows(rows, col('name'), null)).toBe(rows);
    const copy = [...rows];
    sortRows(rows, col('amount'), 'desc');
    expect(rows).toEqual(copy);
  });
});

describe('filterRows', () => {
  it('text is a case-insensitive contains', () => {
    expect(names(filterRows(rows, cols, { name: { text: 'BHA' } }))).toEqual(['bhavna']);
    expect(filterRows(rows, cols, { name: { text: '  ' } })).toBe(rows);
  });

  it('select matches exactly', () => {
    expect(filterRows(rows, cols, { status: { text: 'Due' } })).toHaveLength(1);
    expect(filterRows(rows, cols, { status: { text: 'Paid' } })).toHaveLength(3);
  });

  it('number honours min, max, both, and drops empty cells when bounded', () => {
    expect(filterRows(rows, cols, { amount: { min: '100' } }).map((r) => r.amount)).toEqual([120, 1200]);
    expect(filterRows(rows, cols, { amount: { max: '120' } }).map((r) => r.amount)).toEqual([120, 45]);
    expect(filterRows(rows, cols, { amount: { min: '50', max: '500' } }).map((r) => r.amount)).toEqual([120]);
    expect(filterRows(rows, cols, { amount: { min: 'abc' } })).toHaveLength(4);
  });

  it('date compares the IST day, inclusive, for both date-only and timestamps', () => {
    const from = filterRows(rows, cols, { at: { min: '2026-09-29' } });
    expect(from.map((r) => r.name)).toEqual(['bhavna', 'Chirag']);
    const to = filterRows(rows, cols, { at: { max: '2026-09-28' } });
    expect(names(to)).toEqual(['Asha']);
    const both = filterRows(rows, cols, { at: { min: '2026-09-27', max: '2026-09-29' } });
    expect(both).toHaveLength(3);
  });

  it('ANDs filters across columns', () => {
    const out = filterRows(rows, cols, { status: { text: 'Paid' }, amount: { min: '100' } });
    expect(names(out)).toEqual(['Asha', 'Chirag']);
  });

  it('ignores filters on columns of kind none', () => {
    const c: FilterableColumn<Row>[] = [{ key: 'name', filter: 'none', value: (r) => r.name }];
    expect(filterRows(rows, c, { name: { text: 'zzz' } })).toBe(rows);
  });
});

describe('helpers', () => {
  it('distinctValues is sorted and skips blanks', () => {
    expect(distinctValues(rows, col('status'))).toEqual(['Due', 'Paid']);
    expect(distinctValues(rows, col('name'))).toEqual(['Asha', 'bhavna', 'Chirag']);
  });

  it('activeFilterCount counts only non-empty filters', () => {
    expect(activeFilterCount({ a: { text: 'x' }, b: { min: '', max: '' }, c: { max: '3' } })).toBe(2);
  });

  it('toNumber tolerates rupee formatting', () => {
    expect(toNumber('₹1,200')).toBe(1200);
    expect(toNumber('')).toBeNaN();
    expect(toNumber(null)).toBeNaN();
  });

  it('toDateKey maps timestamps to the IST day', () => {
    expect(toDateKey('2026-09-28T20:00:00Z')).toBe('2026-09-29');
    expect(toDateKey('2026-09-28')).toBe('2026-09-28');
    expect(toDateKey('nonsense')).toBeNull();
  });
});
