// Leave request state machine — which moves a leave_requests row may make, and
// who makes them. The staff routes (app/api/leave), the manager route
// (app/api/leave/team) and the planner UI (components/staff/LeavePlanner.tsx)
// all read it from here.
//
// The rows feed payroll: an APPROVED day is that week's rostered day off
// (docs/PHASE-5-SPEC.md §7b), so a silent status change restates pay. The
// moves, as the product already behaves (the planner UI is the clearest
// statement of intent):
//
//   staff   ∅ | declined | withdrawn → requested   (ask; re-ask after a no)
//   staff   requested → requested                   (asking again for the same day)
//   staff   requested → withdrawn                   (change their mind, window open)
//   manager requested → approved | declined
//   manager approved ↔ declined                     (the team panel offers both)
//
// What is NOT a move, and used to happen anyway because the routes wrote
// without a status guard:
//
//   * approved → requested: the staff upsert reset an approved day to a fresh
//     request — the manager's decision silently gone, the day back in the
//     queue, payroll no longer seeing it as the day off;
//   * approved → withdrawn by the staffer: the planner disables an approved
//     day ("your manager approves it"); the server let a direct call through.
//
// Pure — safe in client components.

import type { LeaveStatus } from '@/lib/types';

export const LEAVE_STATUSES = [
  'requested',
  'approved',
  'declined',
  'withdrawn',
] as const satisfies readonly LeaveStatus[];

type UnlistedLeaveStatus = Exclude<LeaveStatus, (typeof LEAVE_STATUSES)[number]>;
export const LEAVE_STATUSES_EXHAUSTIVE: UnlistedLeaveStatus extends never ? true : never = true;

export type LeaveAction = 'request' | 'approve' | 'decline' | 'withdraw';

/** 'self' = the staffer whose leave it is; 'leave_approve' = the permission key. */
export type LeaveActor = 'self' | 'leave_approve';

export interface LeaveTransitionRule {
  action: LeaveAction;
  /** `null` = no row for that person and date yet. */
  from: LeaveStatus | null;
  to: LeaveStatus;
  actor: LeaveActor;
  /** A decline the staffer cannot read the reason for is the one an argument starts over. */
  requiresNote?: boolean;
}

export const LEAVE_TRANSITIONS: readonly LeaveTransitionRule[] = [
  { action: 'request', from: null, to: 'requested', actor: 'self' },
  { action: 'request', from: 'requested', to: 'requested', actor: 'self' },
  { action: 'request', from: 'declined', to: 'requested', actor: 'self' },
  { action: 'request', from: 'withdrawn', to: 'requested', actor: 'self' },
  { action: 'withdraw', from: 'requested', to: 'withdrawn', actor: 'self' },
  { action: 'approve', from: 'requested', to: 'approved', actor: 'leave_approve' },
  { action: 'approve', from: 'declined', to: 'approved', actor: 'leave_approve' },
  { action: 'decline', from: 'requested', to: 'declined', actor: 'leave_approve', requiresNote: true },
  { action: 'decline', from: 'approved', to: 'declined', actor: 'leave_approve', requiresNote: true },
];

/** Statuses that count against the per-week cap — what someone currently holds. */
export const HELD_LEAVE_STATUSES: readonly LeaveStatus[] = ['requested', 'approved'];

export type LeaveCheckCode = 'not_allowed' | 'not_found' | 'note_required';

export interface LeaveTransitionCheck {
  ok: boolean;
  code?: LeaveCheckCode;
  message?: string;
  rule?: LeaveTransitionRule;
}

export function findLeaveTransition(from: LeaveStatus | null, action: LeaveAction): LeaveTransitionRule | undefined {
  return LEAVE_TRANSITIONS.find((t) => t.from === from && t.action === action);
}

/** The statuses `action` may start from — what a compare-and-set update filters on. */
export function leaveFromStatuses(action: LeaveAction): LeaveStatus[] {
  return LEAVE_TRANSITIONS.filter((t) => t.action === action && t.from !== null).map(
    (t) => t.from as LeaveStatus,
  );
}

function refusal(from: LeaveStatus | null, action: LeaveAction): string {
  if (from === null) {
    return action === 'withdraw' ? 'No leave request found for that day.' : 'That request no longer exists.';
  }
  switch (action) {
    case 'request':
      return 'That day is already approved. Ask your manager if it needs to change.';
    case 'withdraw':
      return from === 'approved'
        ? 'That day is already approved — ask your manager to change it.'
        : `That day is ${from}, so there is nothing to withdraw.`;
    case 'approve':
    case 'decline':
      return from === 'withdrawn'
        ? 'That request was withdrawn or no longer exists.'
        : `That request is already ${from}.`;
  }
}

export function canLeaveTransition(
  from: LeaveStatus | null,
  action: LeaveAction,
  opts: { note?: string } = {},
): LeaveTransitionCheck {
  const rule = findLeaveTransition(from, action);
  if (!rule) {
    return { ok: false, code: from === null ? 'not_found' : 'not_allowed', message: refusal(from, action) };
  }
  if (rule.requiresNote && opts.note !== undefined && opts.note.trim().length === 0) {
    return {
      ok: false,
      code: 'note_required',
      message: 'Please say why you are declining — the staffer sees this.',
      rule,
    };
  }
  return { ok: true, rule };
}

// ---- UI helpers, in terms of the table ----

export function canRequestLeave(status: LeaveStatus | null | undefined): boolean {
  return canLeaveTransition(status ?? null, 'request').ok;
}

export function canWithdrawLeave(status: LeaveStatus | null | undefined): boolean {
  return canLeaveTransition(status ?? null, 'withdraw').ok;
}

export function canApproveLeave(status: LeaveStatus): boolean {
  return canLeaveTransition(status, 'approve').ok;
}

export function canDeclineLeave(status: LeaveStatus): boolean {
  return canLeaveTransition(status, 'decline').ok;
}
