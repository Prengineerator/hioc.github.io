// IST (Asia/Kolkata, UTC+5:30, no DST) calendar helpers for the marketing agent.
//
// Every "day", "week", "month" and "hour" the agent reasons about — the send
// window, the daily cap, the monthly budget, the weekly-active chart, coupon
// expiry — is an IST one, whatever the server's own timezone is (Vercel runs in
// UTC; a laptop runs in whatever it likes). The offset is a constant, so this is
// plain arithmetic: no Intl, no timezone database, nothing that can differ
// between hosts. The same convention as lib/api/date.ts, which supplies the
// date-string primitive; the rest (week start, hour, end of day) is built here.
//
// Pure and client-safe. Every function takes the instant as a parameter — there
// is no Date.now() in this file.

import { istDateIso } from '@/lib/api/date';

export const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** An instant in any of the shapes callers hold one in. */
export type Instant = Date | string | number;

/** Epoch ms of an instant; NaN when it cannot be parsed (callers treat that as "unknown"). */
export function toMs(instant: Instant): number {
  return instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant);
}

/** The IST calendar date containing `instant`, 'YYYY-MM-DD'. */
export function istDate(instant: Instant): string {
  return istDateIso(new Date(toMs(instant)));
}

/** Midnight IST at the start of the IST day containing `instant`, as a UTC instant. */
export function istDayStart(instant: Instant): Date {
  const shifted = toMs(instant) + IST_OFFSET_MS;
  return new Date(shifted - (((shifted % DAY_MS) + DAY_MS) % DAY_MS) - IST_OFFSET_MS);
}

/** Midnight IST on the 1st of the IST month containing `instant`, as a UTC instant. */
export function istMonthStart(instant: Instant): Date {
  const shifted = new Date(toMs(instant) + IST_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - IST_OFFSET_MS);
}

/** IST wall-clock hour, 0–23. */
export function istHour(instant: Instant): number {
  return new Date(toMs(instant) + IST_OFFSET_MS).getUTCHours();
}

/**
 * True while the IST hour is in [startHour, endHour) — the send window. An end
 * of 24 means "until midnight", so 20:00–24:00 covers 23:59 and stops at 00:00.
 */
export function isWithinSendWindow(instant: Instant, startHour: number, endHour: number): boolean {
  const hour = istHour(instant);
  return hour >= startHour && hour < endHour;
}

/** 'YYYY-MM-DD' shifted by whole days (calendar arithmetic, not 24h steps). */
export function addDaysToIstDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (both 'YYYY-MM-DD'); negative when `to` is earlier. */
export function daysBetweenIstDates(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / DAY_MS);
}

/** The Monday (IST) of the week containing `instant`, 'YYYY-MM-DD'. Weeks run Mon–Sun. */
export function istWeekStart(instant: Instant): string {
  const date = istDate(instant);
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDaysToIstDate(date, -((dow + 6) % 7));
}

/**
 * The last millisecond (23:59:59.999 IST) of the IST day `plusDays` after the
 * IST day containing `instant`, as a UTC instant. This is how "valid for N days"
 * is defined: through the end of that calendar day, not 24h × N from the send.
 */
export function endOfIstDay(instant: Instant, plusDays = 0): Date {
  const target = addDaysToIstDate(istDate(instant), plusDays);
  const [y, m, d] = target.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1) - IST_OFFSET_MS - 1);
}
