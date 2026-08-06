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

import { istMinutesOfDay, parseTimeToMinutes } from '@/lib/attendance/businessDate';

export interface DayRules {
  gracePeriodMin: number;
  otThresholdMin: number;
  autoBreakMin: number;
  autoBreakAfterMin: number;
  halfDayMinMinutes: number;
  absentBelowMinutes: number;
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
  /** Before the auto-break deduction — what the punches literally say. */
  rawMinutes: number;
  autoBreakMinutes: number;
  /** Minutes beyond the contracted day (or all of them on a weekly off, D5-5). */
  otMinutes: number;
  lateMinutes: number;
  isLate: boolean;
  firstIn: string | null;
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
  /** 0 = Sunday .. 6 = Saturday for `date`. Passed in so this stays pure. */
  dayOfWeek: number;
}): DayRollup {
  const { date, rules, employment, mark = null, dayOfWeek } = params;

  const live = params.sessions.filter((s) => s.status !== 'void');
  const flags = Array.from(new Set(live.flatMap((s) => s.flags ?? [])));

  const empty: DayRollup = {
    date,
    status: 'absent',
    workedMinutes: 0,
    rawMinutes: 0,
    autoBreakMinutes: 0,
    otMinutes: 0,
    lateMinutes: 0,
    isLate: false,
    firstIn: null,
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

  const intervals: Interval[] = [];
  for (const s of live) {
    if (!s.clockOutAt) continue;
    const start = Date.parse(s.clockInAt);
    const end = Date.parse(s.clockOutAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    // An unapproved auto-close contributes nothing, so it must not reach the
    // interval set — otherwise "needs approval" would still quietly pay.
    if (s.status === 'auto_closed' && !s.approvedAt) continue;
    intervals.push({ start, end });
  }

  const { merged, hadOverlap } = mergeIntervals(intervals);
  if (hadOverlap) flags.push('overlapping_sessions');

  const rawMinutes = Math.round(merged.reduce((acc, i) => acc + (i.end - i.start), 0) / 60_000);

  // Auto-break: single-session days only (see the header note).
  const autoBreakMinutes =
    live.length === 1 && rules.autoBreakMin > 0 && rawMinutes > rules.autoBreakAfterMin
      ? Math.min(rules.autoBreakMin, rawMinutes)
      : 0;
  const workedMinutes = Math.max(0, rawMinutes - autoBreakMinutes);

  const starts = live.map((s) => Date.parse(s.clockInAt)).filter(Number.isFinite);
  const ends = live
    .map((s) => (s.clockOutAt ? Date.parse(s.clockOutAt) : NaN))
    .filter(Number.isFinite);
  const firstIn = starts.length ? new Date(Math.min(...starts)).toISOString() : null;
  const lastOut = ends.length ? new Date(Math.max(...ends)).toISOString() : null;

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

  const isWeeklyOff = employment.weeklyOffDow !== null && employment.weeklyOffDow === dayOfWeek;
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
    autoBreakMinutes,
    otMinutes: unresolved ? 0 : otMinutes,
    lateMinutes,
    isLate: lateMinutes > 0,
    firstIn,
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
