// IST business-date helpers for cash days (OPS-2). "Today" and a day's UTC
// bounds are defined in Asia/Kolkata (IST, UTC+5:30, no DST) regardless of the
// server's own timezone — the same convention as lib/api/date.ts, kept local to
// lib/cash so this ticket owns its helpers.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The current IST calendar date as 'YYYY-MM-DD' — the cash_days.business_date
 * for a day opened right now.
 */
export function istBusinessDate(nowMs: number = Date.now()): string {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * The [start, end) UTC instants bounding an IST calendar day, for a
 * `created_at >= start AND created_at < end` filter over that business date.
 */
export function istDayRange(businessDate: string): { startIso: string; endIso: string } {
  const [y, m, d] = businessDate.split('-').map((n) => Number(n));
  const startMs = Date.UTC(y, (m || 1) - 1, d || 1, 0, 0, 0) - IST_OFFSET_MS;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return { startIso: new Date(startMs).toISOString(), endIso: new Date(endMs).toISOString() };
}
