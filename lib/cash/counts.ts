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
export const SHORTAGE_STATUSES = ['pending', 'approved', 'waived'] as const;
export type ShortageStatus = (typeof SHORTAGE_STATUSES)[number];

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

// ── Shortage state machine ──────────────────────────────────────────────────
//
// A shortage has a stored `status` and, once deducted, a `payroll_run_id`
// (the run that consumed it, CC-5). Together:
//
//   pending ──approve──▶ approved ──consume──▶ approved + payroll_run_id
//      │  ▲                          ◀──release── (that run reversed)
//      │  └─reassign (stays pending, user_id moves)
//      └────waive─────▶ waived
//
//   * approve / waive / reassign are the OWNER's, from pending only. A
//     decision is final from the review screen: an approved shortage may
//     already be in a payroll draft the owner is reading, and silently
//     undoing it would make that draft wrong (CC-D4).
//   * consume / release are PAYROLL's: finalize marks the approved rows it
//     deducted; reversing that run releases them so the corrected run can
//     deduct them again. Nothing else ever touches payroll_run_id.
//
// Every writer filters its UPDATE on the `from` state below (compare-and-set):
// the decision route on status = 'pending', payroll on status = 'approved'.
// Before, the decision route checked status in a read and then updated by id
// alone, so a reassign racing an approve could re-attribute an approved,
// deductible shortage to someone else.

export type ShortageAction = 'approve' | 'waive' | 'reassign' | 'consume' | 'release';
export type ShortageActor = 'owner' | 'payroll';

export interface ShortageFacts {
  status: ShortageStatus;
  /** The payroll run that deducted it, if any. */
  payrollRunId: string | null;
}

export interface ShortageTransitionRule {
  action: ShortageAction;
  from: ShortageStatus;
  to: ShortageStatus;
  actor: ShortageActor;
  requiresNote?: boolean;
  guard?: (s: ShortageFacts) => { ok: boolean; message?: string };
}

const notConsumed = (s: ShortageFacts) =>
  s.payrollRunId
    ? { ok: false, message: "This shortage has already been paid out and can't be changed." }
    : { ok: true };

export const SHORTAGE_TRANSITIONS: readonly ShortageTransitionRule[] = [
  { action: 'approve', from: 'pending', to: 'approved', actor: 'owner', guard: notConsumed },
  { action: 'waive', from: 'pending', to: 'waived', actor: 'owner', requiresNote: true, guard: notConsumed },
  { action: 'reassign', from: 'pending', to: 'pending', actor: 'owner', requiresNote: true, guard: notConsumed },
  { action: 'consume', from: 'approved', to: 'approved', actor: 'payroll', guard: notConsumed },
  {
    action: 'release',
    from: 'approved',
    to: 'approved',
    actor: 'payroll',
    guard: (s) => (s.payrollRunId ? { ok: true } : { ok: false, message: 'That shortage is not on any payroll run.' }),
  },
];

/** A consumed shortage has been deducted on a payslip — immutable from the review screen. */
export function isShortageLocked(s: { payrollRunId?: string | null; payroll_run_id?: string | null }): boolean {
  return Boolean(s.payrollRunId ?? s.payroll_run_id);
}

export interface ShortageTransitionCheck {
  ok: boolean;
  code?: 'not_allowed' | 'locked' | 'note_required';
  message?: string;
  rule?: ShortageTransitionRule;
}

export function canShortageTransition(
  s: ShortageFacts,
  action: ShortageAction,
  opts: { note?: string } = {},
): ShortageTransitionCheck {
  const rule = SHORTAGE_TRANSITIONS.find((t) => t.action === action && t.from === s.status);
  if (!rule) {
    // A paid-out shortage gets the specific message whatever is attempted.
    if (s.payrollRunId) {
      return { ok: false, code: 'locked', message: "This shortage has already been paid out and can't be changed." };
    }
    return {
      ok: false,
      code: 'not_allowed',
      message: s.status === 'pending' ? `A pending shortage cannot be ${action}d.` : `This shortage was already ${s.status}.`,
    };
  }
  const g = rule.guard?.(s);
  if (g && !g.ok) return { ok: false, code: 'locked', message: g.message, rule };
  if (rule.requiresNote && opts.note !== undefined && opts.note.trim().length === 0) {
    return { ok: false, code: 'note_required', message: `A note is required to ${action} a shortage.`, rule };
  }
  return { ok: true, rule };
}

/** UI helper: may the owner still decide (approve / waive / reassign) this shortage? */
export function canDecideShortage(s: ShortageFacts): boolean {
  return canShortageTransition(s, 'approve').ok;
}

export type { CashDenoms };
