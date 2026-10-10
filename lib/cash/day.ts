// Pure rules for the cash day lifecycle: Open → Close → Handover (owner
// request 2026-09-29). Framework-free so the SAME functions run in the browser
// (live mirror while counting) and in the route (the authority) and cannot
// drift. Nothing here reads a client-sent total: every figure derives from raw
// denomination counts.

import type { CashDenoms } from '@/lib/types';
import { DENOMINATIONS, denomsTotalInr, expectedCashInr, sanitizeDenoms } from '@/lib/cash/denoms';

/** A variance / unpaid-override reason must say something: "ok" is not a reason. */
export const MIN_CASH_REASON_LEN = 5;
export const MAX_CASH_REASON_LEN = 300;

export function cashReasonProblem(reason: unknown, what: string): string | null {
  const r = typeof reason === 'string' ? reason.trim() : '';
  if (r.length < MIN_CASH_REASON_LEN) return `Give a reason for ${what} (at least ${MIN_CASH_REASON_LEN} characters).`;
  if (r.length > MAX_CASH_REASON_LEN) return `Keep the reason for ${what} under ${MAX_CASH_REASON_LEN} characters.`;
  return null;
}

// ── Match column (count vs expected, per denomination) ───────────────────────

export interface DenomMatchRow {
  key: string;
  label: string;
  value: number;
  expected: number;
  actual: number;
  /** actual − expected count: 0 = ✓, +2 = two too many, −1 = one short. */
  diff: number;
}

function count(denoms: CashDenoms | null | undefined, key: string): number {
  const n = Number(denoms?.[key]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Per-denomination comparison of what was counted against what was expected. */
export function matchDenoms(actual: CashDenoms | null | undefined, expected: CashDenoms | null | undefined): DenomMatchRow[] {
  return DENOMINATIONS.map((d) => {
    const a = count(actual, d.key);
    const e = count(expected, d.key);
    return { key: d.key, label: d.label, value: d.value, expected: e, actual: a, diff: a - e };
  });
}

/** Signed ₹ difference between two denomination maps (actual − expected). */
export function matchTotalDiffInr(actual: CashDenoms | null | undefined, expected: CashDenoms | null | undefined): number {
  return denomsTotalInr(actual) - denomsTotalInr(expected);
}

/** "✓" for equal, "+2" / "−1" (true minus sign) otherwise. */
export function formatCountDiff(diff: number): string {
  if (diff === 0) return '✓';
  return diff > 0 ? `+${diff}` : `−${Math.abs(diff)}`;
}

// ── Open ─────────────────────────────────────────────────────────────────────

export interface OpenEvaluation {
  /** Float counted now − float left at the last close; null when there was no handover to compare with. */
  differenceInr: number | null;
  /** The float left at the last close, or null. */
  expectedFloatInr: number | null;
  problem: string | null;
}

/**
 * Opening the day: the counted float is compared with the float left at the
 * last close. Any difference needs a reason. With no previous handover (first
 * ever day, or a day closed before this feature) there is nothing to compare
 * and no reason is needed.
 */
export function evaluateOpen(input: {
  countedInr: number;
  floatLeftInr: number | null;
  reason: string;
}): OpenEvaluation {
  if (input.floatLeftInr === null) {
    return { differenceInr: null, expectedFloatInr: null, problem: null };
  }
  const differenceInr = input.countedInr - input.floatLeftInr;
  const problem =
    differenceInr !== 0 ? cashReasonProblem(input.reason, 'the float difference') : null;
  return { differenceInr, expectedFloatInr: input.floatLeftInr, problem };
}

// ── Handover ─────────────────────────────────────────────────────────────────

/**
 * The reason on the cash_movements 'out' row a close writes for the cash taken
 * out to the owner/bank (PATCH /api/cash-days). That row is how the drawer
 * chain knows the cash left; it is not an expense or a day's cash out, and
 * reports show it as the day's handover instead (cash_days.handover_inr).
 */
export function handoverMovementReason(businessDate: string): string {
  return `Day close handover (${businessDate}): cash taken out to owner/bank`;
}

/** True for the cash-out a day close wrote for its handover. */
export function isHandoverMovement(reason: string | null | undefined): boolean {
  return (reason ?? '').trim().toLowerCase().startsWith('day close handover');
}

/** Each denomination capped at what was actually counted (the float can't exceed the drawer). */
export function capDenoms(wanted: CashDenoms | null | undefined, limit: CashDenoms | null | undefined): CashDenoms {
  const out: CashDenoms = {};
  for (const d of DENOMINATIONS) {
    out[d.key] = Math.min(count(wanted, d.key), count(limit, d.key));
  }
  return out;
}

export interface HandoverSplit {
  countedInr: number;
  floatLeftInr: number;
  /** Cash taken out to owner/bank: COMPUTED as counted − float left, never typed. */
  takenOutInr: number;
  /** Denominations where more is being left than was counted. */
  exceeds: { key: string; label: string; counted: number; floatLeft: number }[];
  ok: boolean;
}

export function splitHandover(counted: CashDenoms | null | undefined, floatLeft: CashDenoms | null | undefined): HandoverSplit {
  const exceeds: HandoverSplit['exceeds'] = [];
  for (const d of DENOMINATIONS) {
    const c = count(counted, d.key);
    const f = count(floatLeft, d.key);
    if (f > c) exceeds.push({ key: d.key, label: d.label, counted: c, floatLeft: f });
  }
  const countedInr = denomsTotalInr(sanitizeDenoms(counted));
  const floatLeftInr = denomsTotalInr(sanitizeDenoms(floatLeft));
  return { countedInr, floatLeftInr, takenOutInr: countedInr - floatLeftInr, exceeds, ok: exceeds.length === 0 };
}

// ── Unpaid-order gate ────────────────────────────────────────────────────────

export interface UnpaidGate {
  /** Closing may go ahead. */
  allowed: boolean;
  /** True when it only goes ahead because a manager/owner overrode with a reason. */
  overridden: boolean;
  code: 'UNPAID_ORDERS' | 'UNPAID_OVERRIDE_FORBIDDEN' | 'UNPAID_OVERRIDE_REASON' | null;
  message: string | null;
}

/**
 * Orders created since the day opened and still unpaid block the close: their
 * cash would land after the count and read as a surplus tomorrow. A manager or
 * owner may close anyway, with a reason; a plain staffer may not.
 */
export function unpaidGate(input: { unpaidCount: number; isManager: boolean; overrideReason: string }): UnpaidGate {
  const { unpaidCount, isManager } = input;
  const wantsOverride = input.overrideReason.trim().length > 0;
  if (unpaidCount <= 0) return { allowed: true, overridden: false, code: null, message: null };
  const noun = unpaidCount === 1 ? '1 unpaid order' : `${unpaidCount} unpaid orders`;
  if (!wantsOverride) {
    return {
      allowed: false,
      overridden: false,
      code: 'UNPAID_ORDERS',
      message: `${noun} since the day opened — settle ${unpaidCount === 1 ? 'it' : 'them'} before closing.`,
    };
  }
  if (!isManager) {
    return {
      allowed: false,
      overridden: false,
      code: 'UNPAID_OVERRIDE_FORBIDDEN',
      message: `${noun} — only a manager or owner can close the day with unpaid orders.`,
    };
  }
  const reasonProblem = cashReasonProblem(input.overrideReason, 'closing with unpaid orders');
  if (reasonProblem) {
    return { allowed: false, overridden: false, code: 'UNPAID_OVERRIDE_REASON', message: reasonProblem };
  }
  return { allowed: true, overridden: true, code: null, message: null };
}

/** Counted ₹0 while cash was expected is the production accident: demand an explicit second confirmation. */
export function zeroCountNeedsConfirm(countedInr: number, expectedInr: number): boolean {
  return countedInr === 0 && expectedInr > 0;
}

// ── Close ────────────────────────────────────────────────────────────────────

export interface CashDayFlows {
  cashSalesInr: number;
  cashRefundsInr: number;
  cashInInr: number;
  cashOutInr: number;
}

export type CloseProblemCode =
  | 'FLOAT_EXCEEDS_COUNT'
  | 'REASON_REQUIRED'
  | 'ZERO_COUNT_UNCONFIRMED'
  | 'UNPAID_ORDERS'
  | 'UNPAID_OVERRIDE_FORBIDDEN'
  | 'UNPAID_OVERRIDE_REASON';

export interface CloseProblem {
  code: CloseProblemCode;
  message: string;
}

export interface CloseEvaluation {
  countedInr: number;
  expectedInr: number;
  /** counted − expected (negative = short). */
  varianceInr: number;
  floatLeftInr: number;
  takenOutInr: number;
  overridden: boolean;
  /** Everything still stopping the close, most important first. Empty = ready. */
  problems: CloseProblem[];
}

/**
 * The whole close decision in one pure function, shared by the close form (to
 * show what is still missing) and PATCH /api/cash-days (to enforce it).
 */
export function evaluateClose(input: {
  openingTotalInr: number;
  flows: CashDayFlows;
  closingDenoms: CashDenoms;
  floatLeftDenoms: CashDenoms;
  closeReason: string;
  confirmZeroCount: boolean;
  unpaidCount: number;
  isManager: boolean;
  unpaidOverrideReason: string;
}): CloseEvaluation {
  const closing = sanitizeDenoms(input.closingDenoms);
  const floatLeft = sanitizeDenoms(input.floatLeftDenoms);
  const countedInr = denomsTotalInr(closing);
  const expectedInr = expectedCashInr(
    input.openingTotalInr,
    input.flows.cashSalesInr,
    input.flows.cashRefundsInr,
    input.flows.cashInInr,
    input.flows.cashOutInr,
  );
  const varianceInr = countedInr - expectedInr;
  const split = splitHandover(closing, floatLeft);

  const problems: CloseProblem[] = [];
  if (!split.ok) {
    const first = split.exceeds[0];
    problems.push({
      code: 'FLOAT_EXCEEDS_COUNT',
      message: `Float left has ${first.floatLeft} × ${first.label} but only ${first.counted} were counted.`,
    });
  }
  if (zeroCountNeedsConfirm(countedInr, expectedInr) && !input.confirmZeroCount) {
    problems.push({
      code: 'ZERO_COUNT_UNCONFIRMED',
      message: `You counted ₹0 but ₹${expectedInr} is expected — confirm the drawer really is empty.`,
    });
  }
  if (varianceInr !== 0) {
    const p = cashReasonProblem(input.closeReason, 'the over/short');
    if (p) problems.push({ code: 'REASON_REQUIRED', message: p });
  }
  const gate = unpaidGate({
    unpaidCount: input.unpaidCount,
    isManager: input.isManager,
    overrideReason: input.unpaidOverrideReason,
  });
  if (!gate.allowed && gate.code && gate.message) problems.push({ code: gate.code, message: gate.message });

  return {
    countedInr,
    expectedInr,
    varianceInr,
    floatLeftInr: split.floatLeftInr,
    takenOutInr: split.takenOutInr,
    overridden: gate.overridden,
    problems,
  };
}
