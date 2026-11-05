// PAY-1 — one staffer, one business date, one honest set of numbers.
//
// Pure: it takes sessions + rules + employment + any day mark and returns a
// rollup, reading nothing and calling nothing. Everything downstream — the
// owner's sheet, the approval queue, the payroll engine — reads from here, so
// there is exactly one definition of "how long did they work".
//
// The two rules most likely to be got wrong, stated up front because both cost
// someone money in opposite directions:
//
//   * OVERLAPPING sessions are MERGED, not summed. Summing them pays twice for
//     the same minutes. Overlap is a data error (usually a correction gone
//     wrong), so it is merged and flagged rather than silently trusted.
//   * The AUTO-BREAK applies only to a day with exactly ONE session. If someone
//     punched out for their break, deducting a notional break on top charges
//     them for it twice.

import { istBusinessDate, istMinutesOfDay, parseTimeToMinutes } from '@/lib/attendance/businessDate';

export interface DayRules {
  gracePeriodMin: number;
  otThresholdMin: number;
  autoBreakMin: number;
  autoBreakAfterMin: number;
  halfDayMinMinutes: number;
  absentBelowMinutes: number;
  /** IST times the café's shifts begin. Defaults to CAFE_SHIFT_STARTS. */
  shiftStartTimes?: string[];
  /** How early a clock-in may be and still round up to a shift start. Defaults to EARLY_CLOCK_IN_ROUND_MIN. */
  earlyClockInRoundMin?: number;
}

/**
 * When the café's shifts begin, IST: the 10:00 opening (morning shift), the
 * 10-hour 14:00 shift and the 9-hour 15:00 shift. The first is also opening
 * time — nothing before it counts.
 */
export const CAFE_SHIFT_STARTS = ['10:00', '14:00', '15:00'];

/** A clock-in up to this many minutes before a shift start counts from the start. */
export const EARLY_CLOCK_IN_ROUND_MIN = 30;

/**
 * The instant a clock-in starts COUNTING from (the owner's rule):
 *
 *   * before opening (10:00) → 10:00, however early. The café isn't open.
 *   * up to 30 minutes before a later shift start → that start. 13:58 counts
 *     from 14:00, 14:58 from 15:00.
 *   * anything else → the punch itself. Someone called in at 13:06 genuinely
 *     started at 13:06.
 *
 * The rounding targets are the CAFÉ's shift starts, not just the staffer's own,
 * because people swap: a 15:00 staffer covering the morning shift clocks in at
 * 09:58 and must count from 10:00, not from 15:00.
 *
 * One exception, so rounding never costs someone twice: a clock-in that is
 * already LATE for the staffer's own shift (after their own start but before
 * the next café start) is left alone. A 14:00 staffer arriving at 14:40 is
 * marked late; rounding them on to 15:00 as well would also dock 20 minutes
 * they did work.
 *
 * Rounding only ever moves a start LATER and never past the clock-out, so it
 * can shorten a day but cannot invent time.
 */
export function countedClockInMs(params: {
  clockInAt: string;
  clockOutAt: string | null;
  ownShiftStart: string | null;
  shiftStartTimes?: string[];
  earlyClockInRoundMin?: number;
}): number {
  const inMs = Date.parse(params.clockInAt);
  if (!Number.isFinite(inMs)) return inMs;

  const starts = (params.shiftStartTimes ?? CAFE_SHIFT_STARTS)
    .map(parseTimeToMinutes)
    .filter((m): m is number => m !== null)
    .sort((a, b) => a - b);
  if (starts.length === 0) return inMs;

  const windowMs = Math.max(0, params.earlyClockInRoundMin ?? EARLY_CLOCK_IN_ROUND_MIN) * 60_000;
  const dayStartMs = Date.parse(`${istBusinessDate(inMs)}T00:00:00+05:30`);
  const at = (minutes: number) => dayStartMs + minutes * 60_000;

  let target: number | null = null;
  if (inMs < at(starts[0])) {
    target = at(starts[0]);
  } else {
    const own = params.ownShiftStart ? parseTimeToMinutes(params.ownShiftStart) : null;
    if (own !== null) {
      const nextAfterOwn = starts.find((s) => s > own);
      const lateForOwn = inMs >= at(own) && (nextAfterOwn === undefined || inMs < at(nextAfterOwn));
      if (lateForOwn) return inMs;
    }
    const next = starts.find((s) => at(s) > inMs);
    if (next !== undefined && at(next) - inMs <= windowMs) target = at(next);
  }

  if (target === null) return inMs;
  const outMs = params.clockOutAt ? Date.parse(params.clockOutAt) : NaN;
  if (Number.isFinite(outMs) && target >= outMs) return inMs;
  return target;
}

export interface DayEmployment {
  contractedHoursPerDay: number;
  shiftStartTime: string;
  shiftEndTime: string;
  weeklyOffDow: number | null; // 0 = Sunday .. 6 = Saturday
}

export interface DaySession {
  id: string;
  clockInAt: string;
  clockOutAt: string | null;
  status: 'open' | 'closed' | 'auto_closed' | 'void';
  source: 'punch' | 'manual';
  approvedAt: string | null;
  flags: string[];
}

export type DayMark = 'paid_leave' | 'unpaid_leave' | null;

export type DayStatus =
  | 'present'
  | 'half_day'
  | 'absent'
  | 'weekly_off'
  | 'paid_leave'
  | 'unpaid_leave'
  | 'not_employed'
  | 'needs_approval';

export interface DayRollup {
  date: string;
  status: DayStatus;
  /** Minutes that COUNT, after merging overlaps and deducting any auto-break. */
  workedMinutes: number;
  /** Before rounding and the auto-break — what the punches literally say. */
  rawMinutes: number;
  /** Minutes of an early first clock-in that don't count (rounded up to the shift start). */
  earlyMinutes: number;
  autoBreakMinutes: number;
  /** Minutes beyond the contracted day (or all of them on a weekly off, D5-5). */
  otMinutes: number;
  lateMinutes: number;
  isLate: boolean;
  firstIn: string | null;
  /**
   * When the day started COUNTING: firstIn after the early-clock-in rounding
   * (09:59 → 10:00). What a payslip shows as "in", so in → out matches the
   * hours counted.
   */
  countedFirstIn: string | null;
  lastOut: string | null;
  sessionCount: number;
  /** True while any session is unresolved — the day contributes ZERO until an owner acts. */
  needsApproval: boolean;
  flags: string[];
}

interface Interval {
  start: number;
  end: number;
}

/**
 * Merges overlapping/touching intervals. The reason this is not a sum: two
 * sessions covering 10:00–14:00 and 13:00–15:00 are five hours of wall clock,
 * not six, and paying six is paying for an hour nobody worked.
 */
export function mergeIntervals(intervals: Interval[]): { merged: Interval[]; hadOverlap: boolean } {
  if (intervals.length <= 1) return { merged: [...intervals], hadOverlap: false };

  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [{ ...sorted[0] }];
  let hadOverlap = false;

  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const next = sorted[i];
    if (next.start < last.end) {
      hadOverlap = true;
      last.end = Math.max(last.end, next.end);
    } else if (next.start === last.end) {
      // Touching, not overlapping: a punch-out and an immediate punch-in. Join
      // them so the auto-break rule sees one continuous stretch, but this is
      // not a data error, so do not flag it.
      last.end = Math.max(last.end, next.end);
    } else {
      merged.push({ ...next });
    }
  }
  return { merged, hadOverlap };
}

/**
 * Rolls one staffer's day up.
 *
 * `employment` is null when nobody was employed on that date, which is
 * different from being absent — a month grid must show a blank for the days
 * before someone joined, not a row of absences.
 */
export function rollUpDay(params: {
  date: string;
  sessions: DaySession[];
  rules: DayRules;
  employment: DayEmployment | null;
  mark?: DayMark;
  /**
   * True when this date is the staffer's APPROVED day off from the weekly leave
   * plan (LEAVE). Overrides the fixed `weeklyOffDow` when supplied.
   *
   * The fixed day remains the fallback for any week with no plan — every week
   * before this feature existed, and any week nobody filled in. Dropping it
   * would silently restate historical payroll.
   */
  scheduledOff?: boolean;
  /** 0 = Sunday .. 6 = Saturday for `date`. Passed in so this stays pure. */
  dayOfWeek: number;
}): DayRollup {
  const { date, rules, employment, mark = null, dayOfWeek, scheduledOff } = params;

  const live = params.sessions.filter((s) => s.status !== 'void');
  const flags = Array.from(new Set(live.flatMap((s) => s.flags ?? [])));

  const empty: DayRollup = {
    date,
    status: 'absent',
    workedMinutes: 0,
    rawMinutes: 0,
    earlyMinutes: 0,
    autoBreakMinutes: 0,
    otMinutes: 0,
    lateMinutes: 0,
    isLate: false,
    firstIn: null,
    countedFirstIn: null,
    lastOut: null,
    sessionCount: live.length,
    needsApproval: false,
    flags,
  };

  if (!employment) return { ...empty, status: 'not_employed' };

  // An unresolved session makes the whole day unresolved. Paying a guessed
  // number is the one outcome D5-4 exists to prevent, so the day contributes
  // zero until an owner approves or corrects it — even if other sessions that
  // day are perfectly fine.
  const unresolved = live.some(
    (s) => s.status === 'open' || (s.status === 'auto_closed' && !s.approvedAt),
  );

  // Only the day's FIRST clock-in is rounded up to a shift start — coming back
  // from a break at 14:58 is not "arriving early for the 15:00 shift".
  const firstSession = live.reduce<DaySession | null>(
    (first, s) => (!first || Date.parse(s.clockInAt) < Date.parse(first.clockInAt) ? s : first),
    null,
  );

  const intervals: Interval[] = [];
  const counted: Interval[] = [];
  let countedFirstStart: number | null = null;
  for (const s of live) {
    if (!s.clockOutAt) continue;
    const start = Date.parse(s.clockInAt);
    const end = Date.parse(s.clockOutAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // An unapproved auto-close contributes nothing, so it must not reach the
    // interval set — otherwise "needs approval" would still quietly pay.
    if (s.status === 'auto_closed' && !s.approvedAt) continue;
    intervals.push({ start, end });
    const countedStart =
      s === firstSession
        ? countedClockInMs({
            clockInAt: s.clockInAt,
            clockOutAt: s.clockOutAt,
            ownShiftStart: employment.shiftStartTime,
            shiftStartTimes: rules.shiftStartTimes,
            earlyClockInRoundMin: rules.earlyClockInRoundMin,
          })
        : start;
    if (countedStart < end) counted.push({ start: countedStart, end });
    if (s === firstSession) countedFirstStart = countedStart;
  }

  const { merged, hadOverlap } = mergeIntervals(intervals);
  if (hadOverlap) flags.push('overlapping_sessions');

  const minutesIn = (list: Interval[]) =>
    Math.round(list.reduce((acc, i) => acc + (i.end - i.start), 0) / 60_000);
  const rawMinutes = minutesIn(merged);
  const countedMinutes = minutesIn(mergeIntervals(counted).merged);
  const earlyMinutes = Math.max(0, rawMinutes - countedMinutes);

  // Auto-break: single-session days only (see the header note).
  const autoBreakMinutes =
    live.length === 1 && rules.autoBreakMin > 0 && countedMinutes > rules.autoBreakAfterMin
      ? Math.min(rules.autoBreakMin, countedMinutes)
      : 0;
  const workedMinutes = Math.max(0, countedMinutes - autoBreakMinutes);

  const starts = live.map((s) => Date.parse(s.clockInAt)).filter(Number.isFinite);
  const ends = live
    .map((s) => (s.clockOutAt ? Date.parse(s.clockOutAt) : NaN))
    .filter(Number.isFinite);
  const firstIn = starts.length ? new Date(Math.min(...starts)).toISOString() : null;
  const lastOut = ends.length ? new Date(Math.max(...ends)).toISOString() : null;
  const countedFirstIn =
    countedFirstStart !== null && Number.isFinite(countedFirstStart)
      ? new Date(countedFirstStart).toISOString()
      : firstIn;

  // Lateness is measured from the first punch of the day against the contracted
  // shift start, with the grace period subtracted.
  const shiftStart = parseTimeToMinutes(employment.shiftStartTime);
  let lateMinutes = 0;
  if (firstIn && shiftStart !== null) {
    const arrived = istMinutesOfDay(firstIn);
    // An overnight shift starting at 22:00 and a 00:30 arrival would look 21.5
    // hours "early" by raw subtraction; only count lateness on the same side of
    // midnight, which is the only case a grace period is meaningful for.
    const diff = arrived - shiftStart;
    if (diff > rules.gracePeriodMin && diff < 12 * 60) {
      lateMinutes = diff - rules.gracePeriodMin;
    }
  }

  // An approved leave day IS the week's off day. When the weekly plan has
  // spoken it is authoritative; otherwise fall back to the fixed rostered day.
  const isWeeklyOff =
    scheduledOff !== undefined
      ? scheduledOff
      : employment.weeklyOffDow !== null && employment.weeklyOffDow === dayOfWeek;
  const contractedMinutes = Math.round(employment.contractedHoursPerDay * 60);

  // D5-5: everything worked on a weekly off is overtime.
  const otMinutes = isWeeklyOff
    ? workedMinutes
    : Math.max(0, workedMinutes - contractedMinutes - rules.otThresholdMin);

  // An unresolved day pays NOTHING, including the parts of it that look fine.
  // `rawMinutes` deliberately survives: the owner approving the day needs to
  // see what it would be worth, and zeroing that too would make the approval
  // queue useless. But `workedMinutes` is the number every consumer treats as
  // payable, so it must not carry the resolved half of a day that is still a
  // guess — a caller that reads it without also checking `status` should still
  // arrive at the right answer.
  const payable = unresolved ? 0 : workedMinutes;

  const base: DayRollup = {
    date,
    status: 'absent',
    workedMinutes: payable,
    rawMinutes,
    earlyMinutes,
    autoBreakMinutes,
    otMinutes: unresolved ? 0 : otMinutes,
    lateMinutes,
    isLate: lateMinutes > 0,
    firstIn,
    countedFirstIn,
    lastOut,
    sessionCount: live.length,
    needsApproval: unresolved,
    flags: Array.from(new Set(flags)),
  };

  // Status ladder, most specific first. `needs_approval` outranks everything
  // because the numbers behind it are not yet trustworthy.
  if (unresolved) return { ...base, status: 'needs_approval' };
  if (mark === 'paid_leave') return { ...base, status: 'paid_leave' };
  if (mark === 'unpaid_leave') return { ...base, status: 'unpaid_leave' };
  if (isWeeklyOff && workedMinutes === 0) return { ...base, status: 'weekly_off' };
  if (isWeeklyOff) return { ...base, status: 'present' }; // worked their day off
  if (workedMinutes < rules.absentBelowMinutes) return { ...base, status: 'absent' };
  if (workedMinutes < rules.halfDayMinMinutes) return { ...base, status: 'half_day' };
  return { ...base, status: 'present' };
}

/** 0 = Sunday .. 6 = Saturday for an IST business date ('YYYY-MM-DD'). */
export function dayOfWeekFor(businessDate: string): number {
  const [y, m, d] = businessDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}
