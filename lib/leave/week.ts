// Weekly leave planning — the week arithmetic.
//
// The rules, all decided with the owner:
//   * A leave week is identified by its MONDAY (an ISO date).
//   * Only Mon–Fri of that week can be taken off. The cafe is busiest at the
//     weekend, so Saturday and Sunday are never requestable — enforced here AND
//     by a CHECK constraint, because a UI-only rule is not a rule.
//   * Requests must be decided by the SATURDAY BEFORE the week starts, at
//     23:59:59 IST. After that the week is locked and the roster is settled
//     before anyone turns up on Monday.
//
// Pure, because every one of these boundaries is an off-by-one waiting to
// happen and the failure mode is somebody being marked absent on a day they had
// approved leave for.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export interface LeaveWeek {
  /** Monday of the week, 'YYYY-MM-DD'. */
  weekStart: string;
  /** Sunday of the week, 'YYYY-MM-DD' — the week's last day, not requestable. */
  weekEnd: string;
  /** The five requestable dates, Monday..Friday. */
  requestableDates: string[];
  /** Last instant a request may be made or decided (Saturday 23:59:59.999 IST, as UTC). */
  deadline: string;
}

function toIstParts(ms: number): { y: number; m: number; d: number; dow: number } {
  const shifted = new Date(ms + IST_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth(),
    d: shifted.getUTCDate(),
    // 0 = Sunday .. 6 = Saturday
    dow: shifted.getUTCDay(),
  };
}

/**
 * Formats an instant as its IST calendar date.
 *
 * The offset must be added back before reading the date off. Every timestamp in
 * this module is "IST midnight expressed as UTC", which is 18:30 the PREVIOUS
 * day in UTC — so formatting one directly yields the day before, and every
 * Monday computed here would come back as a Sunday.
 */
function isoDate(ms: number): string {
  return new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** Midnight IST of the given IST calendar date, as a UTC instant in ms. */
function istMidnightUtcMs(y: number, m: number, d: number): number {
  return Date.UTC(y, m, d) - IST_OFFSET_MS;
}

/** Parses 'YYYY-MM-DD' as an IST calendar date → UTC ms at IST midnight. */
export function parseWeekDate(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [y, m, d] = date.split('-').map(Number);
  const ms = istMidnightUtcMs(y, m - 1, d);
  return Number.isFinite(ms) ? ms : null;
}

/** True when 'YYYY-MM-DD' falls on a Monday. */
export function isMonday(date: string): boolean {
  const ms = parseWeekDate(date);
  if (ms === null) return false;
  return toIstParts(ms).dow === 1;
}

/**
 * Builds the week descriptor for a given Monday.
 *
 * The deadline is the Saturday BEFORE `weekStart` at 23:59:59.999 IST, i.e.
 * two days before the week begins — computed by stepping back from Monday
 * rather than forward from anything, so it cannot drift across a month or year
 * boundary.
 */
export function leaveWeekFor(weekStart: string): LeaveWeek | null {
  const startMs = parseWeekDate(weekStart);
  if (startMs === null || !isMonday(weekStart)) return null;

  const requestableDates = [0, 1, 2, 3, 4].map((i) => isoDate(startMs + i * DAY_MS));
  const weekEnd = isoDate(startMs + 6 * DAY_MS);

  // Saturday is two days before Monday. End of that IST day = the following
  // IST midnight minus a millisecond.
  const saturdayMs = startMs - 2 * DAY_MS;
  const deadline = new Date(saturdayMs + DAY_MS - 1).toISOString();

  return { weekStart, weekEnd, requestableDates, deadline };
}

/**
 * The week staff can currently plan.
 *
 * Monday–Saturday you are planning the week that starts the coming Monday.
 * On SUNDAY that week's Saturday deadline has already passed and its roster is
 * settled, so the plannable week jumps to the one after — otherwise a staffer
 * opening the app on Sunday would be shown a locked week with no way to act,
 * which reads as a broken screen rather than a closed window.
 */
export function plannableWeek(now: Date | number = Date.now()): LeaveWeek {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const { y, m, d, dow } = toIstParts(nowMs);
  const todayMs = istMidnightUtcMs(y, m, d);

  // Days forward to the next Monday. dow: 0=Sun,1=Mon..6=Sat.
  // Mon(1) → 7, Tue(2) → 6, ... Sat(6) → 2, Sun(0) → 1.
  const daysToNextMonday = dow === 0 ? 1 : 8 - dow;
  let targetMondayMs = todayMs + daysToNextMonday * DAY_MS;

  // Sunday: the coming Monday's deadline (yesterday) is gone — skip a week.
  if (dow === 0) targetMondayMs += 7 * DAY_MS;

  return leaveWeekFor(isoDate(targetMondayMs))!;
}

/** Whether `date` is one of the five requestable days of `week`. */
export function isRequestableDate(week: LeaveWeek, date: string): boolean {
  return week.requestableDates.includes(date);
}

/** Whether the window for `week` is still open at `now`. */
export function isWindowOpen(week: LeaveWeek, now: Date | number = Date.now()): boolean {
  const nowMs = now instanceof Date ? now.getTime() : now;
  return nowMs <= Date.parse(week.deadline);
}

/** Whole days from `now` until the deadline; 0 on the deadline day, negative after. */
export function daysUntilDeadline(week: LeaveWeek, now: Date | number = Date.now()): number {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const { y, m, d } = toIstParts(nowMs);
  const todayMs = istMidnightUtcMs(y, m, d);
  const saturdayMs = parseWeekDate(week.weekStart)! - 2 * DAY_MS;
  return Math.round((saturdayMs - todayMs) / DAY_MS);
}

/** 'Mon 10 Aug' for display, without re-crossing a timezone and shifting the date. */
export function formatLeaveDate(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
}
