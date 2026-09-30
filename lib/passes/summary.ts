// The owner's HIOC Ritual numbers (docs/COFFEE-PASS-SPEC.md CP-D19, CP-D21,
// GET /api/owner/passes/summary): what was sold, what was refunded, what is
// still owed to customers, what was served on passes, and what lapsed unused.
//
// Pure: rows in, numbers out. No database, no clock of its own (`now` is an
// argument), so the route only fetches and every rule below is unit-tested.
//
// Money is integer rupees. A pass's value PER CUP is what the customer paid for
// it (price_inr / drinks_total), the same figure the spec's liability query uses,
// so "liability" and "expired unused" are in the customer's own money, not in
// menu prices. Each total is summed exactly and rounded ONCE at the end, so a
// pile of passes never drifts by a rupee per pass.

import { istDateDaysAgo, istDateIso } from '@/lib/api/date';
import { istDayRange } from '@/lib/cash/date';
import { passState } from '@/lib/passes/rules';
import type { PassState } from '@/lib/passes/types';

/** The default window: this many IST days ending today, today included. */
export const SUMMARY_DEFAULT_DAYS = 30;
/** The longest window one request may ask for. */
export const SUMMARY_MAX_DAYS = 366;
/** How many passes the "recent" list shows. */
export const SUMMARY_RECENT_LIMIT = 20;

// ---------------------------------------------------------------------------
// The range: IST calendar days, both ends inclusive
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function daysInclusive(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000) + 1;
}

/**
 * Reads `?from=&to=` (IST dates, YYYY-MM-DD) into a range. Nothing given = the
 * last 30 days including today. Only `to` given = the 30 days ending there; only
 * `from` given = from there to today. Refuses a date that is not real, a start
 * after the end, an end in the future, and a window over a year.
 *
 * `now` is an argument so the default window is testable.
 */
export function parseSummaryRange(
  fromRaw: unknown,
  toRaw: unknown,
  now: Date = new Date(),
): { ok: true; from: string; to: string } | { ok: false; message: string } {
  const today = istDateIso(now);
  const given = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
  const fromGiven = given(fromRaw);
  const toGiven = given(toRaw);
  if ((fromRaw !== null && fromRaw !== undefined && typeof fromRaw !== 'string') ||
      (toRaw !== null && toRaw !== undefined && typeof toRaw !== 'string')) {
    return { ok: false, message: 'Dates must be real dates (YYYY-MM-DD).' };
  }
  if ((fromGiven && !isRealDate(fromGiven)) || (toGiven && !isRealDate(toGiven))) {
    return { ok: false, message: 'Dates must be real dates (YYYY-MM-DD).' };
  }
  const to = toGiven ?? today;
  const from =
    fromGiven ??
    // 30 days ending at `to`: `to` itself and the 29 before it.
    istDateDaysAgo(SUMMARY_DEFAULT_DAYS - 1, new Date(Date.parse(`${to}T12:00:00Z`)));
  if (from > to) return { ok: false, message: 'The start date is after the end date.' };
  if (to > today) return { ok: false, message: 'The range can’t end in the future.' };
  if (daysInclusive(from, to) > SUMMARY_MAX_DAYS) {
    return { ok: false, message: `Pick at most ${SUMMARY_MAX_DAYS} days at a time.` };
  }
  return { ok: true, from, to };
}

/** The UTC instants bounding the range: [00:00 IST of `from`, 00:00 IST of the day after `to`). */
export function summaryRangeBounds(from: string, to: string): { startIso: string; endIso: string } {
  return { startIso: istDayRange(from).startIso, endIso: istDayRange(to).endIso };
}

// ---------------------------------------------------------------------------
// Rows in
// ---------------------------------------------------------------------------

/** One pass with its derived balance (a v_coffee_pass_balances row). */
export interface SummaryPassRow {
  id: string;
  user_id: string;
  plan_name: string;
  drinks_total: number;
  drinks_remaining: number;
  /** What the customer paid for the pass (before GST). */
  price_inr: number;
  status: 'active' | 'refunded' | 'void';
  expires_at: string;
  created_at: string;
}

/** One redemption (coffee_pass_redemptions). Reversed ones are ignored here. */
export interface SummaryRedemptionRow {
  drinks: number;
  covered_inr: number;
  created_at: string;
  reversed_at: string | null;
}

/** A pass holder's profile: enough to name them and show the last four digits. */
export interface SummaryHolder {
  name: string;
  phone: string;
}

/** The v_coffee_pass_balances columns SummaryPassRow reads. */
export const SUMMARY_PASS_COLUMNS =
  'id, user_id, plan_name, drinks_total, drinks_remaining, price_inr, status, expires_at, created_at';

const toNumber = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** A view row as the summary reads it. Anything that is not 'refunded' or 'void' reads as 'active'. */
export function toSummaryPassRow(row: Record<string, unknown>): SummaryPassRow {
  return {
    id: String(row.id),
    user_id: String(row.user_id),
    plan_name: String(row.plan_name ?? ''),
    drinks_total: toNumber(row.drinks_total),
    drinks_remaining: toNumber(row.drinks_remaining),
    price_inr: toNumber(row.price_inr),
    status: row.status === 'refunded' || row.status === 'void' ? row.status : 'active',
    expires_at: String(row.expires_at),
    created_at: String(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// The numbers out
// ---------------------------------------------------------------------------

export interface PassProgramSummary {
  range: { from: string; to: string };
  /** Passes created in the range, excluding refunded and void ones, in total. */
  sold: { count: number; inr: number };
  /** The same, by plan: biggest revenue first, then by name. */
  sold_by_plan: { plan_name: string; count: number; inr: number }[];
  /** Passes created in the range that have since been refunded. */
  refunded: { count: number; inr: number };
  /** As of now: passes still usable, their cups, and what those cups are worth at the price paid. */
  active: { passes: number; cups_outstanding: number; liability_inr: number };
  /** Cups served on passes in the range, and the menu value they covered. Reversed cups do not count. */
  redeemed: { cups: number; covered_inr: number };
  /** Cups that lapsed unused: passes whose expiry fell in the range and that still had cups left. */
  expired_unused: { cups: number; inr: number };
  recent: {
    id: string;
    holder_name: string;
    /** Last four digits only, e.g. '••••••3210'. Empty when no number is on file. */
    holder_phone_masked: string;
    plan_name: string;
    created_at: string;
    drinks_total: number;
    drinks_remaining: number;
    expires_at: string;
    state: PassState;
  }[];
}

/**
 * '+919876543210' -> '••••••3210': the last four digits and nothing else. The
 * owner page and the counter do not need a customer's full number to tell two
 * passes apart, and a screenshot of it should not leak one.
 */
export function maskPhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length < 4) return '';
  return `••••••${digits.slice(-4)}`;
}

/** What the customer paid for the cups still on a pass: remaining x price / total, unrounded. */
function cupsValue(p: Pick<SummaryPassRow, 'drinks_remaining' | 'price_inr' | 'drinks_total'>): number {
  if (p.drinks_total <= 0) return 0;
  return (Math.max(0, p.drinks_remaining) * p.price_inr) / p.drinks_total;
}

/**
 * Builds the owner summary.
 *
 * `passes` may be a superset and may repeat a pass (the route unions a few
 * queries): each is counted once, and every rule below re-checks its own
 * condition instead of trusting how the rows were fetched. It should hold every
 * pass created in the range plus every pass still status 'active' that expires
 * on or after the range start.
 *
 * Rules, all in IST days:
 *  - sold: created in the range, not refunded or void. inr = price_inr.
 *  - refunded: created in the range, status 'refunded' (the pass has no refund
 *    date, so it is counted in the period it was SOLD: sold + refunded is
 *    everything that was bought in the range).
 *  - active (as of `now`): passState is 'active'. liability_inr = the sum of
 *    remaining x price / drinks_total, rounded once.
 *  - redeemed: non-reversed redemptions created in the range.
 *  - expired_unused: status 'active', expires_at in the range and already past,
 *    with cups left; inr at price / drinks_total per cup.
 *  - recent: the newest SUMMARY_RECENT_LIMIT of `recent`, whatever the range.
 */
export function buildPassSummary(input: {
  passes: SummaryPassRow[];
  redemptions: SummaryRedemptionRow[];
  recent: SummaryPassRow[];
  holders: Record<string, SummaryHolder | undefined>;
  from: string;
  to: string;
  now: Date;
}): PassProgramSummary {
  const { from, to, now } = input;
  const { startIso, endIso } = summaryRangeBounds(from, to);
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  const nowMs = now.getTime();
  const inRange = (iso: string) => {
    const t = Date.parse(iso);
    return t >= start && t < end;
  };

  const byId = new Map<string, SummaryPassRow>();
  for (const p of input.passes) byId.set(p.id, p);

  const byPlan = new Map<string, { plan_name: string; count: number; inr: number }>();
  let soldCount = 0;
  let soldInr = 0;
  let refundedCount = 0;
  let refundedInr = 0;
  let activePasses = 0;
  let cupsOutstanding = 0;
  let liability = 0;
  let expiredCups = 0;
  let expiredValue = 0;

  for (const p of byId.values()) {
    if (inRange(p.created_at)) {
      if (p.status === 'refunded') {
        refundedCount += 1;
        refundedInr += p.price_inr;
      } else if (p.status !== 'void') {
        soldCount += 1;
        soldInr += p.price_inr;
        const line = byPlan.get(p.plan_name) ?? { plan_name: p.plan_name, count: 0, inr: 0 };
        line.count += 1;
        line.inr += p.price_inr;
        byPlan.set(p.plan_name, line);
      }
    }

    if (passState(p, now) === 'active') {
      activePasses += 1;
      cupsOutstanding += Math.max(0, p.drinks_remaining);
      liability += cupsValue(p);
    }

    const expiresMs = Date.parse(p.expires_at);
    if (p.status === 'active' && p.drinks_remaining > 0 && inRange(p.expires_at) && expiresMs <= nowMs) {
      expiredCups += p.drinks_remaining;
      expiredValue += cupsValue(p);
    }
  }

  let redeemedCups = 0;
  let redeemedInr = 0;
  for (const r of input.redemptions) {
    if (r.reversed_at || !inRange(r.created_at)) continue;
    redeemedCups += r.drinks;
    redeemedInr += r.covered_inr;
  }

  const recent = [...input.recent]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, SUMMARY_RECENT_LIMIT)
    .map((p) => {
      const holder = input.holders[p.user_id];
      return {
        id: p.id,
        holder_name: (holder?.name ?? '').trim() || 'Customer',
        holder_phone_masked: maskPhone(holder?.phone),
        plan_name: p.plan_name,
        created_at: p.created_at,
        drinks_total: p.drinks_total,
        drinks_remaining: p.drinks_remaining,
        expires_at: p.expires_at,
        state: passState(p, now),
      };
    });

  return {
    range: { from, to },
    sold: { count: soldCount, inr: soldInr },
    sold_by_plan: [...byPlan.values()].sort((a, b) => b.inr - a.inr || a.plan_name.localeCompare(b.plan_name)),
    refunded: { count: refundedCount, inr: refundedInr },
    active: { passes: activePasses, cups_outstanding: cupsOutstanding, liability_inr: Math.round(liability) },
    redeemed: { cups: redeemedCups, covered_inr: redeemedInr },
    expired_unused: { cups: expiredCups, inr: Math.round(expiredValue) },
    recent,
  };
}
