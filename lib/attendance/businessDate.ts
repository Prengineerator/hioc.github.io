// GEO-3 — the IST business date.
//
// This MUST agree with the `set_attendance_business_date` trigger in
// supabase/2026-08-attendance.sql and with the convention cash_days already
// uses for the drawer. Two subsystems disagreeing about which day a 00:30 event
// belongs to produces a discrepancy nobody finds until month-end, and then
// nobody can explain.
//
// The cafe runs 10:00–24:00, so a shift that starts at 16:00 and ends at 01:30
// is one shift, not two days' work. It belongs, whole, to the date it STARTED.
//
// Asia/Kolkata is UTC+5:30 with no DST, so the offset is a constant — no
// timezone database, no DST edge cases, and the same arithmetic the DB trigger
// does.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * The IST calendar date containing `instant`, as 'YYYY-MM-DD'.
 *
 * Shifts the instant into IST wall-clock and reads the date off in UTC, which
 * is how you get a fixed-offset zone's local date without depending on the
 * host's own timezone (the server runs in UTC on Vercel and in whatever the
 * developer's laptop is set to locally — this must not vary between them).
 */
export function istBusinessDate(instant: Date | string | number): string {
  const ms = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(ms)) throw new TypeError('istBusinessDate: invalid instant');
  const shifted = new Date(ms + IST_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** IST wall-clock minutes since midnight — used for late detection against a shift start. */
export function istMinutesOfDay(instant: Date | string | number): number {
  const ms = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(ms)) throw new TypeError('istMinutesOfDay: invalid instant');
  const shifted = new Date(ms + IST_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

/** Parses 'HH:MM' or 'HH:MM:SS' to minutes since midnight. Returns null if unparseable. */
export function parseTimeToMinutes(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(time.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Whether a shift crosses midnight (its end time is earlier in the day than its
 * start). The auto-close job needs this: resolving a 01:30 shift end against the
 * clock-in's own date would put the end BEFORE the start and compute a negative
 * duration.
 */
export function shiftCrossesMidnight(startTime: string, endTime: string): boolean {
  const start = parseTimeToMinutes(startTime);
  const end = parseTimeToMinutes(endTime);
  if (start === null || end === null) return false;
  return end <= start;
}

/**
 * The UTC instant at which a shift that began at `clockInAt` is due to end.
 *
 * Rolls to the next calendar day when the shift crosses midnight, which is the
 * normal case for a cafe closing at 24:00.
 */
export function shiftEndInstant(
  clockInAt: Date | string | number,
  shiftStartTime: string,
  shiftEndTime: string,
): Date | null {
  const start = parseTimeToMinutes(shiftStartTime);
  const end = parseTimeToMinutes(shiftEndTime);
  if (start === null || end === null) return null;

  const inMs = clockInAt instanceof Date ? clockInAt.getTime() : new Date(clockInAt).getTime();
  if (!Number.isFinite(inMs)) return null;

  // Midnight IST of the clock-in's business date, as a UTC instant.
  const shifted = new Date(inMs + IST_OFFSET_MS);
  const midnightIstAsUtcMs =
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
    IST_OFFSET_MS;

  const dayRollover = end <= start ? 24 * 60 : 0;
  return new Date(midnightIstAsUtcMs + (end + dayRollover) * 60_000);
}
