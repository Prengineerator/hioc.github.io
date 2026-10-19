// Dates for the owner's downloadable reports: which IST days a ?month= or
// ?from=&to= asks for, the month the Downloads page opens on, and the file name
// a download gets. Pure, so the export route and both pages share one rule.

import { parseRange } from '@/lib/reports/reconcile';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** True for 'YYYY-MM' with a real month. */
export function isMonth(s: string): boolean {
  return MONTH.test(s);
}

/** Last day of a 'YYYY-MM' month as 'YYYY-MM-DD'. */
export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** The month before the one `today` (IST, 'YYYY-MM-DD') falls in — the month GST is filed for. */
export function previousMonth(today: string): string {
  const [y, m] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 7);
}

/**
 * The days a request asks for. `month` (YYYY-MM) wins over from/to. The month
 * in progress runs to today; a month that has not started, or any range
 * parseRange refuses (bad dates, backwards, future, over 93 days), is an error.
 */
export function resolvePeriod(
  params: { month?: unknown; from?: unknown; to?: unknown },
  today: string,
): { ok: true; from: string; to: string } | { ok: false; message: string } {
  if (typeof params.month === 'string' && params.month) {
    if (!isMonth(params.month)) return { ok: false, message: 'Month must look like 2026-09.' };
    const from = `${params.month}-01`;
    if (from > today) return { ok: false, message: 'That month has not started yet.' };
    const last = lastDayOfMonth(params.month);
    return parseRange(from, last > today ? today : last, today);
  }
  return parseRange(params.from, params.to, today);
}

/** The 'YYYY-MM' month from..to covers exactly, or null for any other range. */
export function wholeMonthOf(from: string, to: string): string | null {
  const month = from.slice(0, 7);
  return from === `${month}-01` && to === lastDayOfMonth(month) ? month : null;
}

/** hioc-<key>-<YYYY-MM>.csv for a whole calendar month, else hioc-<key>-<from>_to_<to>.csv. */
export function exportFileName(key: string, from: string, to: string): string {
  const month = wholeMonthOf(from, to);
  return month ? `hioc-${key}-${month}.csv` : `hioc-${key}-${from}_to_${to}.csv`;
}

/** The link that downloads one report for from..to. */
export function exportHref(key: string, from: string, to: string): string {
  return `/api/owner/reports/export?report=${encodeURIComponent(key)}&from=${from}&to=${to}`;
}
