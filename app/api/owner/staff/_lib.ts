// Shared helpers for app/api/owner/staff/** (docs/PHASE-5-STAFF-ACCOUNTS.md).
// Every route in this tree is owner-gated by its own handler (getOwnerUser())
// before any of this runs — nothing here re-checks auth, these are plain
// data-access + workflow helpers shared to keep create/patch/deactivate/
// reactivate/delete from drifting on the same rules.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  HISTORY_CHECKS,
  normalizeLoginId,
  type AccountStatus,
  type TeamMember,
} from '@/lib/staff/accounts';
import { staffDisplayName } from '@/lib/staff/displayName';

type PgError = { code?: string; message?: string } | null | undefined;

/**
 * True when `error` means "the relation doesn't exist" — the staff-accounts
 * migration (supabase/2026-09-staff-accounts.sql) hasn't been applied yet.
 * PostgREST usually reports this as PGRST205 (schema-cache miss); the raw
 * Postgres code 42P01 shows up on some paths too.
 */
export function isMissingTable(error: PgError): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('schema cache') || msg.includes('does not exist');
}

/**
 * True when the account has a row in any HISTORY_CHECKS table — attendance,
 * employment, payroll, leave, orders entered, cash days opened/closed
 * (SA-D2). Only an account with NO history may be hard-deleted; everyone
 * else can only be deactivated. Each table is checked in parallel (head:true
 * count — no rows fetched). Fails safe: a lookup error counts as "has
 * history" so a real account never becomes deletable because a check broke.
 */
export async function hasHistory(admin: SupabaseClient, id: string): Promise<boolean> {
  const flags = await Promise.all(
    HISTORY_CHECKS.map(async ({ table, column }) => {
      const { count, error } = await admin
        .from(table)
        .select('*', { count: 'exact', head: true })
        .eq(column, id);
      if (error) {
        console.error(`hasHistory: ${table}.${column} check failed`, error);
        return true;
      }
      return (count ?? 0) > 0;
    }),
  );
  return flags.some(Boolean);
}

export interface AuthUserInfo {
  email: string;
  lastSignInAt: string | null;
}

/**
 * Pages through every auth user (a single cafe's user base is small — this
 * mirrors the same page-through-1000 pattern used elsewhere, e.g.
 * lib/staff/displayName.ts) and returns an id → {email, lastSignInAt} map.
 */
export async function loadAuthUserMap(admin: SupabaseClient): Promise<Map<string, AuthUserInfo>> {
  const byId = new Map<string, AuthUserInfo>();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data) break;
    for (const u of data.users) {
      byId.set(u.id, { email: u.email ?? '', lastSignInAt: u.last_sign_in_at ?? null });
    }
    if (data.users.length < 1000) break;
  }
  return byId;
}

/** Finds an existing auth user id by email (case-insensitive), or null. */
export async function findUserIdByEmail(admin: SupabaseClient, email: string): Promise<string | null> {
  const target = email.trim().toLowerCase();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data) break;
    const match = data.users.find((u) => (u.email ?? '').toLowerCase() === target);
    if (match) return match.id;
    if (data.users.length < 1000) break;
  }
  return null;
}

/** The profiles.role for `id`, or null when there's no profile row. */
export async function loadRole(admin: SupabaseClient, id: string): Promise<string | null> {
  const { data } = await admin.from('profiles').select('role').eq('id', id).maybeSingle();
  return (data as { role?: string } | null)?.role ?? null;
}

type StaffAccountRow = {
  login_id: string;
  personal_email: string | null;
  phone: string | null;
  status: AccountStatus;
  role_before_deactivation?: string | null;
  handles_cash?: boolean;
};

const STAFF_ACCOUNT_BASE_COLUMNS = 'login_id, personal_email, phone, status, role_before_deactivation';

/**
 * Reads one staff_accounts row, including handles_cash
 * (supabase/2026-09-cash-counts.sql) when that column exists. Falls back to
 * the pre-cash-counts column set if the migration hasn't been applied yet —
 * without this, an unknown-column error on the COMBINED select would fail
 * the whole row and wipe out loginId/personalEmail/phone/status (which have
 * nothing to do with cash counts) back to their empty defaults. Only
 * handles_cash itself degrades (to true, via buildMember below) when the
 * migration is missing.
 */
async function selectStaffAccountRow(
  admin: SupabaseClient,
  id: string,
): Promise<{ data: StaffAccountRow | null; error: PgError }> {
  const withCash = await admin
    .from('staff_accounts')
    .select(`${STAFF_ACCOUNT_BASE_COLUMNS}, handles_cash`)
    .eq('user_id', id)
    .maybeSingle();
  if (!withCash.error || !isMissingTable(withCash.error)) {
    return { data: withCash.data as StaffAccountRow | null, error: withCash.error };
  }
  const base = await admin.from('staff_accounts').select(STAFF_ACCOUNT_BASE_COLUMNS).eq('user_id', id).maybeSingle();
  return { data: base.data as StaffAccountRow | null, error: base.error };
}

/**
 * Rebuilds one TeamMember row from scratch — profiles + staff_accounts + the
 * auth user — for a mutation response, so every handler answers with the
 * post-write truth rather than hand-assembling a partial object. Returns
 * null only when the profile itself is gone (shouldn't happen right after a
 * create/update, but degrading beats throwing from a response builder).
 */
export async function buildMember(admin: SupabaseClient, id: string): Promise<TeamMember | null> {
  const { data: profile, error: profileError } = await admin
    .from('profiles')
    .select('id, role, name')
    .eq('id', id)
    .maybeSingle();
  if (profileError) console.error('buildMember: profiles lookup failed', profileError);
  if (!profile) return null;
  const p = profile as { id: string; role: string; name: string | null };

  const { data: authUser, error: authError } = await admin.auth.admin.getUserById(id);
  if (authError) console.error('buildMember: auth user lookup failed', authError);
  const email = authUser?.user?.email ?? '';
  const lastSignInAt = authUser?.user?.last_sign_in_at ?? null;

  let loginId: string | null = null;
  let personalEmail: string | null = null;
  let phone = '';
  let status: AccountStatus = 'active';
  let roleBeforeDeactivation: string | null | undefined = null;
  let handlesCash = true; // default: everyone counts cash unless the owner exempts them

  const { data: account, error: accountError } = await selectStaffAccountRow(admin, id);
  if (accountError && !isMissingTable(accountError)) {
    console.error('buildMember: staff_accounts lookup failed', accountError);
  }
  if (account) {
    const row = account as StaffAccountRow;
    loginId = row.login_id;
    personalEmail = row.personal_email;
    phone = row.phone ?? '';
    status = row.status;
    roleBeforeDeactivation = row.role_before_deactivation;
    handlesCash = row.handles_cash ?? true;
  }

  const deletable = !(await hasHistory(admin, id));

  // profiles.role is 'customer' for a deactivated account — that's an
  // implementation detail of how login is blocked, not what the owner sees
  // as this person's role. `status: 'deactivated'` already conveys the
  // state, so report the role they'll be restored to instead: showing
  // 'customer' here would make the team screen's edit form pre-fill role as
  // customer and silently demote a manager on save.
  const role = status === 'deactivated' ? (roleBeforeDeactivation || 'staff') : p.role;

  return {
    id,
    name: staffDisplayName(p.name, email),
    role: role as TeamMember['role'],
    email,
    loginId,
    personalEmail,
    phone,
    status,
    lastSignInAt,
    deletable,
    handlesCash,
  };
}

export type ActionResult = { status: number; body: Record<string, unknown> };

function fail(status: number, error: string): ActionResult {
  return { status, body: { error } };
}

function succeed(member: TeamMember | null): ActionResult {
  return { status: 200, body: { ok: true, member } };
}

/**
 * Deactivate an account (SA-D2 "delete = deactivate"): block login
 * immediately (far-future ban), demote profiles.role to 'customer' (the
 * server-side gates that actually matter read this, so access stops on the
 * next request rather than in an hour), and record status/role_before_
 * deactivation on staff_accounts so reactivate can restore it. Idempotent —
 * calling it again on an already-deactivated account just returns the
 * current member. Shared by POST .../[id]/deactivate and the legacy
 * DELETE /api/owner/staff (route.ts), which now deactivates instead of
 * demoting-without-banning for safety.
 */
export async function performDeactivate(
  admin: SupabaseClient,
  ownerId: string,
  id: string,
): Promise<ActionResult> {
  if (id === ownerId) return fail(403, "You can't deactivate your own account");

  const { data: profile } = await admin.from('profiles').select('role').eq('id', id).maybeSingle();
  const role = (profile as { role?: string } | null)?.role ?? null;
  if (!role) return fail(404, 'Not found');
  if (role === 'owner') return fail(403, 'Owner accounts can only be changed via SQL');

  const { data: accountRow, error: accountError } = await admin
    .from('staff_accounts')
    .select('status, role_before_deactivation')
    .eq('user_id', id)
    .maybeSingle();
  const accountsAvailable = !(accountError && isMissingTable(accountError));
  if (accountError && accountsAvailable) {
    console.error('performDeactivate: staff_accounts lookup failed', accountError);
  }
  const account = accountRow as { status?: string; role_before_deactivation?: string } | null;

  if (role === 'customer' && account?.status !== 'deactivated') {
    // Not a currently-active team member, and not already deactivated via
    // this flow either — nothing this endpoint is meant to act on.
    return fail(404, 'Not a staff account');
  }

  if (account?.status === 'deactivated') {
    return succeed(await buildMember(admin, id));
  }

  const { error: banError } = await admin.auth.admin.updateUserById(id, { ban_duration: '876000h' });
  if (banError) return fail(500, banError.message);

  const { error: roleError } = await admin.from('profiles').update({ role: 'customer' }).eq('id', id);
  if (roleError) return fail(500, roleError.message);

  if (accountsAvailable) {
    const patch = {
      status: 'deactivated' as const,
      role_before_deactivation: role,
      deactivated_at: new Date().toISOString(),
      deactivated_by: ownerId,
    };
    if (account) {
      const { error } = await admin.from('staff_accounts').update(patch).eq('user_id', id);
      if (error) console.error('performDeactivate: staff_accounts update failed', error);
    } else {
      // Backfill-skipped account (its email's local part didn't satisfy the
      // login_id shape, or collided at backfill time). Best-effort row so
      // the team screen still shows it deactivated — a login_id we can't
      // derive here must never block the deactivation itself, since the ban
      // + role change above already took effect.
      const { data: authUser } = await admin.auth.admin.getUserById(id);
      const derivedLoginId = normalizeLoginId(authUser?.user?.email ?? null);
      if (derivedLoginId) {
        const { error } = await admin
          .from('staff_accounts')
          .insert({ user_id: id, login_id: derivedLoginId, created_by: ownerId, ...patch });
        if (error) console.error('performDeactivate: staff_accounts insert failed', error);
      }
    }
  }

  return succeed(await buildMember(admin, id));
}

/**
 * Reactivate: unban, restore profiles.role from role_before_deactivation
 * (defaulting to 'staff' if that was somehow never set), and flip
 * staff_accounts back to active. Idempotent on an already-active account.
 */
export async function performReactivate(admin: SupabaseClient, id: string): Promise<ActionResult> {
  const { data: accountRow, error: accountError } = await admin
    .from('staff_accounts')
    .select('status, role_before_deactivation')
    .eq('user_id', id)
    .maybeSingle();
  if (accountError && isMissingTable(accountError)) {
    return fail(409, 'Staff accounts migration not applied yet — run supabase/2026-09-staff-accounts.sql');
  }
  if (accountError) return fail(500, accountError.message);
  const account = accountRow as { status?: string; role_before_deactivation?: string } | null;
  if (!account) return fail(404, 'Not found');

  if (account.status !== 'deactivated') {
    return succeed(await buildMember(admin, id));
  }

  const restoredRole = account.role_before_deactivation || 'staff';

  const { error: unbanError } = await admin.auth.admin.updateUserById(id, { ban_duration: 'none' });
  if (unbanError) return fail(500, unbanError.message);

  const { error: roleError } = await admin.from('profiles').update({ role: restoredRole }).eq('id', id);
  if (roleError) return fail(500, roleError.message);

  const { error: acctError } = await admin
    .from('staff_accounts')
    .update({ status: 'active', role_before_deactivation: null, deactivated_at: null, deactivated_by: null })
    .eq('user_id', id);
  if (acctError) console.error('performReactivate: staff_accounts update failed', acctError);

  return succeed(await buildMember(admin, id));
}

/**
 * True delete — only legal when the account has no HISTORY_CHECKS rows
 * (SA-D2). Deleting the auth user cascades staff_accounts (and profiles) via
 * their `on delete cascade` FKs, so nothing else needs cleaning up here.
 */
export async function performDelete(admin: SupabaseClient, ownerId: string, id: string): Promise<ActionResult> {
  if (id === ownerId) return fail(403, "You can't remove your own account");

  const role = await loadRole(admin, id);
  if (!role) return fail(404, 'Not found');
  if (role === 'owner') return fail(403, 'Owner accounts can only be changed via SQL');

  if (await hasHistory(admin, id)) {
    return fail(409, 'This account has history — deactivate it instead.');
  }

  const { error } = await admin.auth.admin.deleteUser(id);
  if (error) return fail(500, error.message);
  return { status: 200, body: { ok: true } };
}
