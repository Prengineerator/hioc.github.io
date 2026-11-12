// Payroll run lifecycle — one staffer's month, frozen or reversed.
//
// The truthful picture, which the 'draft' in the schema used to obscure:
//
//   (computed fresh, never stored) ──finalize──▶ finalized ──reverse──▶ reversed
//
//   * A DRAFT IS NEVER STORED. The payroll screen computes every unfinalized
//     staffer fresh from attendance + rules on every request
//     (app/api/owner/payroll GET), and finalize inserts a row that is already
//     'finalized'. 'draft' survives in the DB CHECK and in PayrollRunStatus
//     only because removing it would be a schema change for no behaviour; no
//     code writes it and nothing should start to.
//   * finalized → reversed is the only move a stored run makes, it needs a
//     reason, and it is terminal: a corrected month is a NEW run, because
//     what was paid and what it was corrected to are both the record.
//   * One ACTIVE (non-reversed) run per staffer per period — the unique index
//     idx_payroll_runs_active_period_user. A reversed run never blocks a re-run.
//
// Pure — safe in client components.

import type { PayrollRunStatus } from '@/lib/types';

export const PAYROLL_RUN_STATUSES = [
  'draft',
  'finalized',
  'reversed',
] as const satisfies readonly PayrollRunStatus[];

type UnlistedRunStatus = Exclude<PayrollRunStatus, (typeof PAYROLL_RUN_STATUSES)[number]>;
export const PAYROLL_RUN_STATUSES_EXHAUSTIVE: UnlistedRunStatus extends never ? true : never = true;

/** What a stored run can actually be. 'draft' is declared but unused (see above). */
export const STORED_PAYROLL_RUN_STATUSES: readonly PayrollRunStatus[] = ['finalized', 'reversed'];

export const TERMINAL_PAYROLL_RUN_STATUSES: readonly PayrollRunStatus[] = ['reversed'];

/** A run that still counts — it locks the month and blocks a second finalize. */
export const ACTIVE_PAYROLL_RUN_STATUS: PayrollRunStatus = 'finalized';

export type PayrollRunAction = 'finalize' | 'reverse';

export interface PayrollRunTransitionRule {
  action: PayrollRunAction;
  /** `null` = no stored run yet (the staffer is a fresh draft). */
  from: PayrollRunStatus | null;
  to: PayrollRunStatus;
  actor: 'owner';
  requiresReason?: boolean;
}

export const PAYROLL_RUN_TRANSITIONS: readonly PayrollRunTransitionRule[] = [
  { action: 'finalize', from: null, to: 'finalized', actor: 'owner' },
  // A run whose own finalize failed half-way (no line written) is retired the
  // same way — reversed, with the reason saying so (app/api/owner/payroll).
  { action: 'reverse', from: 'finalized', to: 'reversed', actor: 'owner', requiresReason: true },
];

export interface PayrollRunTransitionCheck {
  ok: boolean;
  code?: 'not_allowed' | 'reason_required';
  message?: string;
  rule?: PayrollRunTransitionRule;
}

export function canPayrollRunTransition(
  from: PayrollRunStatus | null,
  action: PayrollRunAction,
  opts: { reason?: string } = {},
): PayrollRunTransitionCheck {
  const rule = PAYROLL_RUN_TRANSITIONS.find((t) => t.action === action && t.from === from);
  if (!rule) {
    return {
      ok: false,
      code: 'not_allowed',
      message:
        action === 'finalize'
          ? 'This person is already finalized for that month. Reverse it first to change anything.'
          : "That person's payroll isn't finalized for that month.",
    };
  }
  if (rule.requiresReason && (opts.reason === undefined || opts.reason.trim().length === 0)) {
    return { ok: false, code: 'reason_required', message: 'A reason is required to reverse a payroll run.', rule };
  }
  return { ok: true, rule };
}

/** UI helper: is this line a frozen, reversible run? */
export function canReversePayrollRun(status: PayrollRunStatus | null | undefined): boolean {
  return canPayrollRunTransition(status ?? null, 'reverse', { reason: 'x' }).ok;
}
