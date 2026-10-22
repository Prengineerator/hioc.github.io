// Cell and header helpers the platform parsers share (zomato.ts, swiggy.ts).
// The reports are spreadsheets people made for people: numbers can be text
// ('  12', '24.0%', '₹1234.50  '), headers carry line breaks and trailing
// spaces, and 'NA' means nothing. Everything here is tolerant of that.

/** First line of a header cell, trimmed, lower-cased, spaces collapsed. */
export function headerKey(cell: unknown): string {
  return String(cell ?? '')
    .split('\n')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// field → how its header reads. `exact` must equal the header key; `prefix`
// must start it (for headers a platform words differently between versions).
export type Matcher = { exact?: string; prefix?: string };

/** Header cell index per field. A column is taken by one field only, in the order the fields are listed. */
export function mapColumns<F extends string>(header: unknown[], columns: Record<F, Matcher>): Partial<Record<F, number>> {
  const keys = header.map(headerKey);
  const out: Partial<Record<F, number>> = {};
  const taken = new Set<number>();
  for (const [field, m] of Object.entries(columns) as [F, Matcher][]) {
    const idx = keys.findIndex(
      (k, i) => !taken.has(i) && k !== '' && (m.exact ? k === m.exact : k.startsWith(m.prefix as string)),
    );
    if (idx >= 0) {
      out[field] = idx;
      taken.add(idx);
    }
  }
  return out;
}

/** A report number: numbers as-is; '1,234.50', '₹ 20', '24.0%' parsed; 'NA', '', '-' and junk → 0. */
export function num(v: unknown): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v !== 'string') return 0;
  const n = Number(v.replace(/[₹,\s%]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/** A cell as trimmed text; empty and 'NA' are ''. */
export function text(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s.toUpperCase() === 'NA' ? '' : s;
}

const STATUS: Record<string, string> = {
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  REJECTED: 'rejected',
  TIMEDOUT: 'timed_out',
  'TIMED OUT': 'timed_out',
};

export function normalizeStatus(v: unknown): string {
  const s = text(v).toUpperCase();
  return STATUS[s] ?? s.toLowerCase().replace(/\s+/g, '_');
}

/** '2026-04-01 11:05:31' (IST wall clock) → '2026-04-01T11:05:31+05:30'; null if unreadable. */
export function istTimestamp(v: unknown): string | null {
  const m = text(v).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}+05:30`;
}

export const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** '01 April 26' / '01 Apr 2026' → '2026-04-01'; null if unreadable. */
export function dayMonthYear(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{2}|\d{4})$/);
  if (!m) return null;
  const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
  if (month < 0) return null;
  const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return `${year}-${String(month + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
