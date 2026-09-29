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
