// Date helpers for app/api/orders — "today" is defined in Asia/Kolkata
// (IST, UTC+5:30, no DST) regardless of the server's own timezone.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Returns an ISO-8601 UTC timestamp for the start of the current calendar
 * day in Asia/Kolkata (i.e. today's 00:00:00 IST, expressed as the
 * equivalent UTC instant) — suitable for a `created_at >= ...` filter.
 */
export function startOfTodayIstIso(): string {
  const nowIstMs = Date.now() + IST_OFFSET_MS;
  const istWallClock = new Date(nowIstMs);

  const y = istWallClock.getUTCFullYear();
  const m = istWallClock.getUTCMonth();
  const d = istWallClock.getUTCDate();

  const midnightIstAsUtcMs = Date.UTC(y, m, d, 0, 0, 0) - IST_OFFSET_MS;
  return new Date(midnightIstAsUtcMs).toISOString();
}

/**
 * The Asia/Kolkata calendar date as 'YYYY-MM-DD', `daysAgo` days back — the
 * key the IST-dated analytics views (v_daily_sales.sale_date) use.
 *
 * Not `startOfTodayIstIso().slice(0, 10)`: IST midnight is 18:30 UTC on the
 * PREVIOUS day, so that slice is always yesterday's date.
 */
export function istDateString(daysAgo = 0, nowMs: number = Date.now()): string {
  const ist = new Date(nowMs + IST_OFFSET_MS - daysAgo * 24 * 60 * 60 * 1000);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
