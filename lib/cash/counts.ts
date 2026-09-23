// Cash counts at clock-in / clock-out (docs/PHASE-5-CASH-COUNTS.md) — the
// shared contract. Pure rules + API shapes only; the DB engine lives in
// lib/cash/checkpoints.ts (server-only).
//
// The drawer is ONE continuous chain of checkpoints. At each count:
//   expected = previous.counted + cash settled − cash refunded − cash out + cash in
//   variance = counted − expected        (negative = short)
// A shortage beyond tolerance is charged, pending owner approval, to the person
// whose count revealed it (owner decision 2026-09-23); the owner can approve
// (→ payroll deduction), waive, or reassign it.

import type { CashDenoms } from '@/lib/types';

export type CashCountKind = 'clock_in' | 'clock_out' | 'day_open' | 'day_close' | 'manual' | 'override';
export type PunchType = 'in' | 'out';
export type ShortageStatus = 'pending' | 'approved' | 'waived';

/** An override lets one staffer skip one count for this long after it's granted. */
export const OVERRIDE_TTL_MINUTES = 30;
/** Minimum override reason length — "ok" is not a reason. */
export const MIN_OVERRIDE_REASON = 5;

export function kindForPunch(type: PunchType): 'clock_in' | 'clock_out' {
  return type === 'in' ? 'clock_in' : 'clock_out';
}

export interface CashFlowsInWindow {
  cashSettledInr: number;
  cashRefundedInr: number;
  cashOutInr: number;
  cashInInr: number;
}

/** expected = previous counted + settled − refunded − out + in. */
export function expectedAtCount(previousCountedInr: number, flows: CashFlowsInWindow): number {
  return (
    previousCountedInr + flows.cashSettledInr - flows.cashRefundedInr - flows.cashOutInr + flows.cashInInr
  );
}

/**
 * The shortage to charge for a variance, or 0. Only a shortfall BEYOND the
 * tolerance is charged, and the whole shortfall is charged (not just the part
 * above tolerance) — tolerance absorbs miscounted coins, it is not an allowance.
 * An overage is never charged; it is recorded for the owner to see.
 */
export function shortageToCharge(varianceInr: number | null, toleranceInr: number): number {
  if (varianceInr === null || varianceInr >= 0) return 0;
  const short = -varianceInr;
  return short > Math.max(0, toleranceInr) ? short : 0;
}

export function overrideReasonProblem(reason: unknown): string | null {
  if (typeof reason !== 'string' || reason.trim().length < MIN_OVERRIDE_REASON) {
    return `Give a reason (at least ${MIN_OVERRIDE_REASON} characters).`;
  }
  if (reason.trim().length > 300) return 'Keep the reason under 300 characters.';
  return null;
}

// ── API contract ────────────────────────────────────────────────────────────

/** GET /api/attendance/me gains `cash` (existing fields unchanged). */
export interface PunchCashRequirement {
  /** True when attendance_settings.cash_count_required AND this staffer handles cash. */
  required: boolean;
  /** An unused, unexpired override for the next in/out punch, if any. */
  override: { punchType: PunchType; reason: string; grantedByName: string; expiresAt: string } | null;
}

/**
 * POST /api/attendance/punch body gains `cash_denoms?: CashDenoms`.
 * When a count is required and there's no usable override, a punch without
 * cash_denoms is refused 428 { error, code: 'CASH_COUNT_REQUIRED' }.
 * The count is recorded only once the punch itself is accepted (geofence etc.),
 * and the response gains `cashCount?: CashCountResult`.
 */
export interface CashCountResult {
  id: string;
  kind: CashCountKind;
  countedTotalInr: number | null;
  expectedTotalInr: number | null;
  varianceInr: number | null;
  /** > 0 when a shortage row was raised against the counter. */
  shortageInr: number;
}

/** POST /api/cash-counts/overrides (manager/owner) */
export interface CreateOverrideBody {
  userId: string;
  punchType: PunchType;
  reason: string;
}

/** POST /api/cash-movements (manager/owner) */
export interface CashMovementBody {
  direction: 'out' | 'in';
  amountInr: number;
  reason: string;
}

/** Owner review: PATCH /api/owner/cash-shortages/[id] */
export type ShortageDecisionBody =
  | { action: 'approve'; note?: string }
  | { action: 'waive'; note: string }
  | { action: 'reassign'; userId: string; note: string };

export type { CashDenoms };
