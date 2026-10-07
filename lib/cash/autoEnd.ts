// A cash day that nobody closed ends on its own (owner decision 2026-10-07).
//
// The café runs past midnight, so a day is not over at 12 am: it ends at
// 3:00 am IST the morning after the date it was opened — the same hour the
// attendance job clocks out a forgotten shift (/api/cron/close-attendance). A
// day still open at that hour has ENDED: its figures (cash sales, refunds,
// cash in/out, expected cash) stop at 3:00 am, whenever it is counted. Nobody
// counted the drawer, so it is not closed: the next person to log in counts it
// and closes it (any staffer — no manager needed for a day that is already
// over), then opens the new day.
//
// The counter takes no orders until the day is open: every day, the first
// thing on the POS is counting the float, and when yesterday was left open,
// closing yesterday first.
//
// Pure, so the gate, the routes and the cron share one rule. IST is UTC+5:30
// with no DST, so the arithmetic needs no timezone database.

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The IST hour, the morning after its date, at which a cash day still open ends. */
export const CASH_DAY_END_HOUR_IST = 3;

/** The instant (UTC ISO) a cash day opened on `businessDate` ends: 3:00 am IST the next morning. */
export function cashDayEndsAt(businessDate: string): string {
  const [y, m, d] = businessDate.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + DAY_MS + CASH_DAY_END_HOUR_IST * 60 * 60 * 1000 - IST_OFFSET_MS;
  return new Date(ms).toISOString();
}

export interface DayClock {
  status: string;
  business_date: string;
}

/** An OPEN day past its end: it has ended, and only its count is missing. */
export function isCashDayOverdue(day: DayClock | null | undefined, nowMs: number): boolean {
  if (!day || day.status !== 'open') return false;
  return nowMs >= Date.parse(cashDayEndsAt(day.business_date));
}

/** Where an open day's figures stop: now, or its end once it has ended. */
export function cashDayWindowEnd(day: DayClock, nowIso: string): string {
  return isCashDayOverdue(day, Date.parse(nowIso)) ? cashDayEndsAt(day.business_date) : nowIso;
}

/**
 * What the counter must do before it can take orders:
 *   'close_overdue' — a day was left open past its end: count it and close it;
 *   'open'          — no day is open: count the float and open today;
 *   null            — a day is open and running.
 */
export type CashDayGateStep = 'close_overdue' | 'open' | null;

export function cashDayGateStep(openDay: DayClock | null | undefined, nowMs: number): CashDayGateStep {
  if (!openDay) return 'open';
  return isCashDayOverdue(openDay, nowMs) ? 'close_overdue' : null;
}

/**
 * Staff pages that stay usable while the day is not open: the cash drawer
 * itself (where the gate sends them), clocking in and out, leave, and the
 * device / printer / account settings a manager may need to get the counter
 * working at all.
 */
const UNGATED_PREFIXES = [
  '/staff/cash',
  '/staff/attendance',
  '/staff/leave',
  '/staff/settings',
  '/staff/device',
  '/staff/printers',
  '/staff/login',
  '/staff/reset-password',
];

export function isGatedStaffPath(pathname: string): boolean {
  if (!pathname.startsWith('/staff')) return false;
  // '/staff/cash' must not also let '/staff/cash-movements' through.
  return !UNGATED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
