// Staff accounts (docs/PHASE-5-STAFF-ACCOUNTS.md) — the shared contract.
//
// A staffer signs in as <login_id>@hioc.in. That is a login ID, NOT a mailbox:
// anything meant for the person goes to staff_accounts.personal_email. Pure
// rules + API shapes live here so the owner APIs, the team screen, the
// password-email flow and payslips can't drift on them.

import { normalizeEmail } from '@/lib/email';

export const LOGIN_DOMAIN = 'hioc.in';
export const MIN_PASSWORD_LENGTH = 8;

export const MANAGEABLE_ROLES = ['staff', 'manager'] as const;
export type ManageableRole = (typeof MANAGEABLE_ROLES)[number];
export const TEAM_ROLES = ['staff', 'manager', 'owner'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export type AccountStatus = 'active' | 'deactivated';
export type StaffEmailKind = 'invite' | 'password_reset' | 'password_changed' | 'payslip' | 'stock_assigned';

// Mirrors the CHECK on staff_accounts.login_id.
const LOGIN_ID_RE = /^[a-z][a-z0-9._-]{1,29}$/;

/**
 * Normalise what the owner or a staffer typed into a login ID. Accepts either
 * "ayush" or "ayush@hioc.in" (any case, surrounding spaces). Returns null when
 * it isn't a valid ID, or when it names a different domain.
 */
export function normalizeLoginId(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  let v = input.trim().toLowerCase();
  if (v.includes('@')) {
    const [local, domain] = v.split('@');
    if (domain !== LOGIN_DOMAIN) return null;
    v = local;
  }
  return LOGIN_ID_RE.test(v) ? v : null;
}

/** The Supabase auth email for a login ID. */
export function loginEmailFor(loginId: string): string {
  return `${loginId}@${LOGIN_DOMAIN}`;
}

/** A personal email must be real and must not be a hioc.in login ID. */
export function normalizePersonalEmail(input: string | null | undefined): string | null {
  const e = normalizeEmail(typeof input === 'string' ? input : '');
  if (!e) return null;
  if (e.toLowerCase().endsWith(`@${LOGIN_DOMAIN}`)) return null;
  return e.toLowerCase();
}

/** Returns an error message, or null when acceptable. */
export function passwordProblem(pw: unknown): string | null {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (pw.length > 72) return 'Password must be at most 72 characters.';
  return null;
}

/**
 * Tables whose rows are history for a staffer. An account with a row in any of
 * these can only be deactivated, never deleted — most cascade from auth.users,
 * so a delete would erase pay/attendance history (SA-D2).
 */
export const HISTORY_CHECKS: { table: string; column: string }[] = [
  { table: 'attendance_sessions', column: 'user_id' },
  { table: 'staff_employment', column: 'user_id' },
  { table: 'payroll_run_lines', column: 'user_id' },
  { table: 'leave_requests', column: 'user_id' },
  { table: 'orders', column: 'created_by' },
  { table: 'cash_days', column: 'opened_by' },
  { table: 'cash_days', column: 'closed_by' },
];

// ── Activation: one state across three stores ───────────────────────────────
//
// Whether someone may work is held in THREE places, which deactivate and
// reactivate change one at a time (no transaction spans Supabase Auth and
// Postgres):
//   1. the auth ban (auth.users.banned_until) — blocks new sign-ins/refreshes;
//   2. profiles.role — 'customer' while deactivated, so every server gate that
//      reads the role refuses on the very next request;
//   3. staff_accounts.status — the owner's record, and where the real role is
//      parked while deactivated (role_before_deactivation).
//
// staff_accounts.status is the COMMIT POINT: an account IS deactivated exactly
// when its row says so (isDeactivatedAccount) — the one predicate the team
// list, the edit form, the password route and both actions share. A step that
// failed half-way leaves the other two stores out of line with it; the
// actions read all three, classify them (classifyActivation) and run only the
// steps still missing (deactivationSteps / reactivationPlan), so either one
// can be re-run to completion from any partial state instead of answering
// "already deactivated" or 404.
//
// Deactivate runs ban → record → demote: login is blocked first, and the role
// is parked on the row BEFORE profiles.role is overwritten, so a failure part
// way can never lose it. Reactivate runs unban → restore role → record.

export const ACTIVATION_STATES = [
  'active',
  'deactivated',
  /** Recorded active, but banned: a deactivate that stopped before its record. */
  'inconsistent_active',
  /** Recorded deactivated, but unbanned and/or still holding a team role: either action stopped part-way. */
  'inconsistent_deactivated',
  /** A plain customer: no team role, not banned, no deactivation on record. Neither action applies. */
  'not_staff',
] as const;
export type ActivationState = (typeof ACTIVATION_STATES)[number];

export type DeactivateStep = 'ban' | 'record' | 'demote';
export type ReactivateStep = 'unban' | 'restore_role' | 'record';

/** What the three stores say right now. */
export interface ActivationStores {
  banned: boolean;
  /** profiles.role, or null when there is no profile. */
  profileRole: string | null;
  /** The staff_accounts row, or null when there is none (or the table isn't there yet). */
  account: { status?: string | null; role_before_deactivation?: string | null } | null;
}

/** THE "is deactivated" predicate (the commit point — see above). */
export function isDeactivatedAccount(account: { status?: string | null } | null | undefined): boolean {
  return account?.status === 'deactivated';
}

/** True for the roles an account works under (and keeps across a deactivation). */
export function isTeamRole(role: string | null | undefined): role is TeamRole {
  return (TEAM_ROLES as readonly string[]).includes(role ?? '');
}

/**
 * The role the owner sees and edits: while deactivated, the parked one (what
 * reactivate restores — profiles.role reads 'customer' then, and showing that
 * would make the edit form demote a manager on save); otherwise profiles.role.
 */
export function effectiveTeamRole(
  profileRole: string | null,
  account: ActivationStores['account'],
): string | null {
  return isDeactivatedAccount(account) ? account?.role_before_deactivation || 'staff' : profileRole;
}

/** Whether an auth user's banned_until is still in force. */
export function isBannedUntil(bannedUntil: string | null | undefined, nowMs: number): boolean {
  if (!bannedUntil) return false;
  const until = Date.parse(bannedUntil);
  return Number.isFinite(until) && until > nowMs;
}

export function classifyActivation(s: ActivationStores): ActivationState {
  const recorded = isDeactivatedAccount(s.account);
  const demoted = s.profileRole === 'customer';
  if (recorded) return s.banned && demoted ? 'deactivated' : 'inconsistent_deactivated';
  if (s.banned) return 'inconsistent_active';
  return demoted ? 'not_staff' : 'active';
}

/**
 * The deactivation steps still to run, in order, and the role to park. A role
 * already parked is never overwritten — in particular never with 'customer'
 * from a profile a half-finished run already demoted.
 */
export function deactivationSteps(s: ActivationStores): { steps: DeactivateStep[]; parkRole: string | null } {
  const steps: DeactivateStep[] = [];
  if (!s.banned) steps.push('ban');
  if (!isDeactivatedAccount(s.account)) steps.push('record');
  if (s.profileRole !== 'customer') steps.push('demote');
  const parkRole = isTeamRole(s.profileRole) ? s.profileRole : (s.account?.role_before_deactivation ?? null);
  return { steps, parkRole };
}

/**
 * The reactivation steps still to run, in order, and the role to restore:
 * the parked role while the row says deactivated (it is authoritative then —
 * the owner may have edited it), else the profile's own team role, else
 * 'staff' (a deactivation that never got to park one).
 */
export function reactivationPlan(s: ActivationStores): { steps: ReactivateStep[]; restoreRole: string } {
  const restoreRole = isDeactivatedAccount(s.account)
    ? s.account?.role_before_deactivation || 'staff'
    : isTeamRole(s.profileRole)
      ? s.profileRole
      : s.account?.role_before_deactivation || 'staff';
  const steps: ReactivateStep[] = [];
  if (s.banned) steps.push('unban');
  // Never "restore" an owner: owners are not deactivated from the app.
  if (s.profileRole !== restoreRole && s.profileRole !== 'owner') steps.push('restore_role');
  if (isDeactivatedAccount(s.account)) steps.push('record');
  return { steps, restoreRole };
}

// ── API contract: /api/owner/staff ──────────────────────────────────────────

/** One row of GET /api/owner/staff → { members: TeamMember[] }. */
export interface TeamMember {
  id: string;
  /** Resolved display name (lib/staff/displayName). */
  name: string;
  role: TeamRole | 'customer';
  /** Auth email (= loginEmailFor(loginId) for accounts created here). Kept for back-compat. */
  email: string;
  loginId: string | null;
  personalEmail: string | null;
  phone: string;
  status: AccountStatus;
  lastSignInAt: string | null;
  /** False when the account has history (SA-D2) — only then may it be deleted. */
  deletable: boolean;
  /**
   * staff_accounts.handles_cash (docs/PHASE-5-CASH-COUNTS.md) — false exempts
   * this person from the clock-in/out drawer count (e.g. kitchen staff who
   * never touch the register). Optional (rather than always-present) so any
   * code building a TeamMember without knowing about this field still
   * compiles; MISSING MEANS TRUE, same as buildMember's own fallback and the
   * DB column's default — everyone counts unless the owner says otherwise, or
   * the cash-counts migration (supabase/2026-09-cash-counts.sql) hasn't been
   * applied yet.
   */
  handlesCash?: boolean;
  /**
   * staff_accounts.warehouse_access (docs/WAREHOUSE-SPEC.md, WH-D16) — true
   * lets a staffer do the warehouse run: record what left the warehouse and
   * send stock back to it. Managers have it by role. MISSING MEANS FALSE (the
   * column's default, and before supabase/2026-11-warehouse-access.sql).
   */
  warehouseAccess?: boolean;
}

/** POST /api/owner/staff */
export interface CreateStaffBody {
  name: string;
  loginId: string;
  personalEmail: string;
  phone?: string;
  role: ManageableRole;
  /** 'link' → email a set-password link; 'set' → use `password`. */
  passwordMode: 'link' | 'set';
  password?: string;
}

/** PATCH /api/owner/staff/[id] — every field optional. */
export interface UpdateStaffBody {
  name?: string;
  loginId?: string;
  personalEmail?: string;
  phone?: string;
  role?: ManageableRole;
  /** staff_accounts.handles_cash — see TeamMember.handlesCash. */
  handlesCash?: boolean;
  /** staff_accounts.warehouse_access — see TeamMember.warehouseAccess. */
  warehouseAccess?: boolean;
}

/** POST /api/owner/staff/[id]/password */
export type PasswordBody = { mode: 'link' } | { mode: 'set'; password: string };

/**
 * Every mutating owner route answers { ok: true, member: TeamMember, email?: EmailOutcome }
 * or an error { error: string } with a 4xx/5xx status.
 */
export interface EmailOutcome {
  kind: StaffEmailKind;
  status: 'sent' | 'failed' | 'skipped';
  /** e.g. 'no personal email', provider error text. */
  detail: string;
}
