// Attendance session state machine — the single source of truth for what may
// happen to an attendance_sessions row, by whom, and what "needs approval"
// means. The punch route, the auto-close cron, the owner correction route, the
// day roll-up (lib/attendance/day.ts) and the owner sheet all read it from
// here, so the server can no longer accept an action the sheet would never
// offer.
//
// A session carries TWO things that together decide whether it is paid:
//
//   * its stored `status` — open → closed | auto_closed, or void; and
//   * an approval stamp (approved_at / approved_by), which only ever matters
//     for an `auto_closed` session: an auto-close is the cron's GUESS at a
//     forgotten clock-out, and pays nothing until a person approves or
//     corrects it (D5-4).
//
// The bugs this table exists to rule out, all of which the route used to allow
// because it updated by id alone:
//
//   * approving an OPEN session — the cron then auto-closed it with the stamp
//     still on, and the day rolled up as an approved auto-close, paying the
//     cron's guess to shift end without anyone having looked at it;
//   * a time edit on a VOID session, which silently un-voided it (status →
//     closed) and stamped it approved;
//   * voiding an already-void session (a second audit row, nothing else).
//
// Pure and dependency-free so client components can import it.

import type { AttendanceStatus } from '@/lib/types';

export const ATTENDANCE_SESSION_STATUSES = [
  'open',
  'closed',
  'auto_closed',
  'void',
] as const satisfies readonly AttendanceStatus[];
export type SessionStatus = AttendanceStatus;

// The DB CHECK (supabase/2026-08-attendance.sql), lib/types.ts and this list
// must agree: `satisfies` refuses a status the type lacks, and this refuses to
// compile if the type gains one the list (and so the table below) forgot.
type UnlistedStatus = Exclude<AttendanceStatus, (typeof ATTENDANCE_SESSION_STATUSES)[number]>;
export const SESSION_STATUSES_EXHAUSTIVE: UnlistedStatus extends never ? true : never = true;

/** A void session is out of every calculation and can never come back. */
export const TERMINAL_SESSION_STATUSES: readonly SessionStatus[] = ['void'];

export type SessionAction =
  | 'clock_in' // ∅ → open (punch route; the one-open-session index guards it)
  | 'clock_out' // open → closed (attendance_clock_out RPC, status-guarded in SQL)
  | 'auto_close' // open → auto_closed (cron; clears any approval stamp)
  | 'approve' // auto_closed (unapproved) → auto_closed (approved)
  | 'void' // open | closed | auto_closed → void
  | 'edit_times' // open | closed | auto_closed → closed (or stays open with no clock-out)
  | 'manual_entry'; // ∅ → closed, source 'manual'

export type SessionActor = 'self' | 'system' | 'attendance_approve' | 'attendance_edit';

/** The facts a guard may consult. Shapes from both DB rows and DaySession fit. */
export interface SessionFacts {
  status: SessionStatus;
  approvedAt?: string | null;
}

export interface SessionTransitionRule {
  action: SessionAction;
  /** `null` = the row is being created. */
  from: SessionStatus | null;
  to: SessionStatus;
  actor: SessionActor;
  requiresReason?: boolean;
  /** Stamps approved_at/approved_by (true), clears them (false), or leaves them (undefined). */
  approval?: boolean;
  guard?: (s: SessionFacts) => { ok: boolean; code?: SessionCheckCode; message?: string };
}

export type SessionCheckCode = 'not_allowed' | 'already_approved' | 'reason_required';

const notYetApproved: SessionTransitionRule['guard'] = (s) =>
  s.approvedAt
    ? { ok: false, code: 'already_approved', message: 'That session has already been approved.' }
    : { ok: true };

export const SESSION_TRANSITIONS: readonly SessionTransitionRule[] = [
  { action: 'clock_in', from: null, to: 'open', actor: 'self' },
  { action: 'clock_out', from: 'open', to: 'closed', actor: 'self' },
  // The cron never approves its own guess — and it CLEARS a stamp the row may
  // already carry, so an approval made while the session was still open (the
  // old route allowed it) can never turn the guess into paid hours.
  { action: 'auto_close', from: 'open', to: 'auto_closed', actor: 'system', approval: false },
  // Approve-as-is is only meaningful for an unapproved auto-close: an open
  // session has no end to approve, a closed one needs no approval, and a void
  // one is gone. This is exactly where the sheet offers the button.
  {
    action: 'approve',
    from: 'auto_closed',
    to: 'auto_closed',
    actor: 'attendance_approve',
    requiresReason: true,
    approval: true,
    guard: notYetApproved,
  },
  { action: 'void', from: 'open', to: 'void', actor: 'attendance_edit', requiresReason: true },
  { action: 'void', from: 'closed', to: 'void', actor: 'attendance_edit', requiresReason: true },
  { action: 'void', from: 'auto_closed', to: 'void', actor: 'attendance_edit', requiresReason: true },
  // A corrected session is, by definition, resolved — it becomes `closed` and
  // carries the corrector's approval. Correcting only the clock-in of a
  // session still running leaves it open and UNstamped (a stamp on an open
  // session is precisely what used to leak through the cron).
  { action: 'edit_times', from: 'open', to: 'open', actor: 'attendance_edit', requiresReason: true },
  { action: 'edit_times', from: 'open', to: 'closed', actor: 'attendance_edit', requiresReason: true, approval: true },
  { action: 'edit_times', from: 'closed', to: 'closed', actor: 'attendance_edit', requiresReason: true, approval: true },
  { action: 'edit_times', from: 'auto_closed', to: 'closed', actor: 'attendance_edit', requiresReason: true, approval: true },
  { action: 'manual_entry', from: null, to: 'closed', actor: 'attendance_edit', requiresReason: true, approval: true },
];

export interface SessionTransitionCheck {
  ok: boolean;
  code?: SessionCheckCode;
  message?: string;
  rule?: SessionTransitionRule;
}

export function findSessionTransition(
  action: SessionAction,
  from: SessionStatus | null,
  to?: SessionStatus,
): SessionTransitionRule | undefined {
  return SESSION_TRANSITIONS.find(
    (t) => t.action === action && t.from === from && (to === undefined || t.to === to),
  );
}

const ACTION_VERB: Record<SessionAction, string> = {
  clock_in: 'clock in',
  clock_out: 'clock out of',
  auto_close: 'auto-close',
  approve: 'approve',
  void: 'void',
  edit_times: 'correct',
  manual_entry: 'add',
};

/**
 * Is `action` legal from `session` (null = creating a row)? `to` narrows the
 * edit_times rule (stays open vs becomes closed). `reason` is checked when the
 * rule requires one.
 */
export function canSessionTransition(
  session: SessionFacts | null,
  action: SessionAction,
  opts: { to?: SessionStatus; reason?: string } = {},
): SessionTransitionCheck {
  const from = session?.status ?? null;
  const rule = findSessionTransition(action, from, opts.to);
  if (!rule) {
    return {
      ok: false,
      code: 'not_allowed',
      message:
        from === 'void'
          ? 'That session was voided and cannot be changed.'
          : `You cannot ${ACTION_VERB[action]} a session that is ${from === null ? 'not there' : from.replace('_', ' ')}.`,
    };
  }
  if (rule.requiresReason && opts.reason !== undefined && opts.reason.trim().length === 0) {
    return { ok: false, code: 'reason_required', message: 'A reason is required for every attendance change.', rule };
  }
  const g = session && rule.guard ? rule.guard(session) : { ok: true };
  if (!g.ok) return { ok: false, code: g.code, message: g.message, rule };
  return { ok: true, rule };
}

// ---- The "is this paid?" predicates — one definition for day.ts, /me and the sheet ----

/**
 * True for a session waiting on a person: an auto-close nobody has approved or
 * corrected. Such a session contributes ZERO payable minutes (D5-4).
 */
export function sessionNeedsApproval(status: SessionStatus, approvedAt: string | null | undefined): boolean {
  return status === 'auto_closed' && !approvedAt;
}

/**
 * True while a session leaves its day unresolved: still running, or an
 * unapproved auto-close. One such session zeroes the whole day's pay until
 * someone acts.
 */
export function sessionIsUnresolved(status: SessionStatus, approvedAt: string | null | undefined): boolean {
  return status === 'open' || sessionNeedsApproval(status, approvedAt);
}

// ---- UI helpers, implemented IN TERMS OF the table ----

type RowLike = { status: SessionStatus; approved_at: string | null };

const facts = (s: RowLike): SessionFacts => ({ status: s.status, approvedAt: s.approved_at });

export function canApproveSession(s: RowLike): boolean {
  return canSessionTransition(facts(s), 'approve').ok;
}

export function canVoidSession(s: RowLike): boolean {
  return canSessionTransition(facts(s), 'void').ok;
}

export function canEditSessionTimes(s: RowLike): boolean {
  return SESSION_TRANSITIONS.some((t) => t.action === 'edit_times' && t.from === s.status);
}
