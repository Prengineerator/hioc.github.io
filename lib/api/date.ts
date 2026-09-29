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
 * YYYY-MM-DD of the Asia/Kolkata calendar day containing `date`. This is the
 * value to compare against SQL `(created_at AT TIME ZONE 'Asia/Kolkata')::date`
 * columns (v_daily_sales.sale_date, business_date, order_date). Do NOT derive
 * it from startOfTodayIstIso().slice(0, 10): IST midnight is 18:30 UTC of the
 * PREVIOUS day, so that slice is yesterday's date.
 */
export function istDateIso(date: Date = new Date()): string {
  return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * IST calendar date `n` days before the IST day of `now` (n = 0 is today).
 * Steps whole calendar days on the IST wall clock, so it is DST-free and
 * independent of the time of day.
 */
export function istDateDaysAgo(n: number, now: Date = new Date()): string {
  return istDateIso(new Date(now.getTime() - n * 24 * 60 * 60 * 1000));
}
