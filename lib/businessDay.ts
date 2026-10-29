// The café's business day (owner request, 30 Oct 2026).
//
// The café runs past midnight, so its day does not end at 12 am: it runs from
// 3:00 am IST to 3:00 am IST the next morning — the same hour a cash day nobody
// closed ends on its own (lib/cash/autoEnd.ts). An order placed at 12:40 am is
// part of the evening before: it stays on that day's POS order board, in that
// day's dashboard figures and on that day's row of the owner's reports.
//
// From BUSINESS_DAY_3AM_FROM on ("since now"). Every earlier day keeps its old
// midnight-to-midnight bounds, so nothing already reported moves; the first
// 3 am day therefore starts at midnight and runs 27 hours.
//
// The GST registers and the CSV downloads stay on the bill's calendar date (the
// date printed on the invoice) and do not use this.
//
// Pure and client-safe. IST is UTC+5:30 with no DST, so the arithmetic needs
// no timezone database.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The IST hour a business day starts at (and the day before it ends). */
export const BUSINESS_DAY_START_HOUR_IST = 3;

/** The first business day that runs to 3:00 am; earlier days end at midnight. */
export const BUSINESS_DAY_3AM_FROM = '2026-10-29';

const START_OFFSET_MS = BUSINESS_DAY_START_HOUR_IST * HOUR_MS;

type Instant = Date | string | number;

function toMs(instant: Instant): number {
  return instant instanceof Date ? instant.getTime() : typeof instant === 'number' ? instant : Date.parse(instant);
}

/** 'YYYY-MM-DD' of the IST calendar day containing `ms`. */
function istCalendarDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' shifted by whole calendar days. */
export function addBusinessDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The business date ('YYYY-MM-DD') an instant belongs to. */
export function businessDateOf(instant: Instant): string {
  const ms = toMs(instant);
  const shifted = istCalendarDate(ms - START_OFFSET_MS);
  return shifted >= BUSINESS_DAY_3AM_FROM ? shifted : istCalendarDate(ms);
}

/** Today's business date: until 3:00 am, still yesterday's. */
export function businessToday(now: Instant = Date.now()): string {
  return businessDateOf(now);
}

/** The business date `n` days before today's (n = 0 is today). */
export function businessDateDaysAgo(n: number, now: Instant = Date.now()): string {
  return addBusinessDays(businessToday(now), -n);
}

/** Epoch ms at which business date `date` starts: 3:00 am IST, or midnight for a day before the change. */
function businessDayStartMs(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const midnightMs = Date.UTC(y, m - 1, d) - IST_OFFSET_MS;
  return date > BUSINESS_DAY_3AM_FROM ? midnightMs + START_OFFSET_MS : midnightMs;
}

/** UTC instants bounding business days `from`..`to` inclusive, for `>= startIso AND < endIso`. */
export function businessRangeBounds(from: string, to: string): { startIso: string; endIso: string } {
  return {
    startIso: new Date(businessDayStartMs(from)).toISOString(),
    endIso: new Date(businessDayStartMs(addBusinessDays(to, 1))).toISOString(),
  };
}

/** UTC instants bounding one business day. */
export function businessDayRange(date: string): { startIso: string; endIso: string } {
  return businessRangeBounds(date, date);
}

/** When today's business day started, as a UTC ISO instant — for a `created_at >= ...` filter. */
export function startOfBusinessDayIso(now: Instant = Date.now()): string {
  return new Date(businessDayStartMs(businessToday(now))).toISOString();
}

/** When today's business day ends (the next 3:00 am IST), as a UTC ISO instant. */
export function endOfBusinessDayIso(now: Instant = Date.now()): string {
  return businessDayRange(businessToday(now)).endIso;
}
