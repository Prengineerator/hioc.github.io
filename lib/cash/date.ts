// IST business-date helpers for cash days (OPS-2). "Today" and a day's UTC
// bounds are defined in Asia/Kolkata (IST, UTC+5:30, no DST) regardless of the
// server's own timezone — the same convention as lib/api/date.ts, kept local to
// lib/cash so this ticket owns its helpers.

import { businessDateOf } from '@/lib/businessDay';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Today's business date as 'YYYY-MM-DD' — the cash_days.business_date for a
 * day opened right now. The business day turns over at 3:00 am IST, not
 * midnight (lib/businessDay.ts): a day opened at 1 am is dated the evening
 * before, and ends on its own at the 3 am that follows (lib/cash/autoEnd.ts).
 */
export function istBusinessDate(nowMs: number = Date.now()): string {
  return businessDateOf(nowMs);
}

/**
 * The [start, end) UTC instants bounding an IST calendar day (midnight to
 * midnight), for a `created_at >= start AND created_at < end` filter. The 3 am
 * business day is lib/businessDay.ts businessDayRange.
 */
export function istDayRange(date: string): { startIso: string; endIso: string } {
  const [y, m, d] = date.split('-').map((n) => Number(n));
  const startMs = Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0) - IST_OFFSET_MS;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
}
