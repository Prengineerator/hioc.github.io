// Shared helpers for app/api/owner/staff/** (docs/PHASE-5-STAFF-ACCOUNTS.md).
// Every route in this tree is owner-gated by its own handler (getOwnerUser())
// before any of this runs — nothing here re-checks auth, these are plain
// data-access + workflow helpers shared to keep create/patch/deactivate/
// reactivate/delete from drifting on the same rules.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  HISTORY_CHECKS,
  classifyActivation,
  deactivationSteps,
  effectiveTeamRole,
  isBannedUntil,
  normalizeLoginId,
  reactivationPlan,
  type AccountStatus,
  type ActivationStores,
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
  warehouse_access?: boolean;
};

const STAFF_ACCOUNT_BASE_COLUMNS = 'login_id, personal_email, phone, status, role_before_deactivation';

/**
 * The optional per-person switches on staff_accounts, newest migration first:
 * warehouse_access (supabase/2026-11-warehouse-access.sql), then handles_cash
 * (supabase/2026-09-cash-counts.sql). A read tries them all, then drops the
 * newest until one works, so a missing migration only costs its own switch.
 */
export const STAFF_ACCOUNT_SWITCH_SETS = ['handles_cash, warehouse_access', 'handles_cash', ''] as const;

/**
 * Reads one staff_accounts row, including handles_cash and warehouse_access
 * when those columns exist. Falls back column set by column set
 * (STAFF_ACCOUNT_SWITCH_SETS) if a migration hasn't been applied yet —
 * without this, an unknown-column error on the COMBINED select would fail
 * the whole row and wipe out loginId/personalEmail/phone/status (which have
 * nothing to do with either switch) back to their empty defaults. Only the
 * missing switch itself degrades (handles_cash to true, warehouse_access to
 * false, via buildMember below).
 */
async function selectStaffAccountRow(
  admin: SupabaseClient,
  id: string,
): Promise<{ data: StaffAccountRow | null; error: PgError }> {
  let last: { data: unknown; error: PgError } = { data: null, error: null };
  for (const extra of STAFF_ACCOUNT_SWITCH_SETS) {
    last = await admin
      .from('staff_accounts')
      .select(extra ? `${STAFF_ACCOUNT_BASE_COLUMNS}, ${extra}` : STAFF_ACCOUNT_BASE_COLUMNS)
      .eq('user_id', id)
      .maybeSingle();
    if (!last.error || !isMissingTable(last.error)) break;
  }
  return { data: last.data as StaffAccountRow | null, error: last.error };
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
  let warehouseAccess = false; // default: the warehouse side is a manager's unless the owner says otherwise

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
    warehouseAccess = row.warehouse_access === true;
  }

  const deletable = !(await hasHistory(admin, id));

  // profiles.role is 'customer' for a deactivated account — that's an
  // implementation detail of how login is blocked, not what the owner sees
  // as this person's role. `status: 'deactivated'` already conveys the
  // state, so report the role they'll be restored to instead: showing
  // 'customer' here would make the team screen's edit form pre-fill role as
  // customer and silently demote a manager on save (lib/staff/accounts.ts).
  const role = effectiveTeamRole(p.role, { status, role_before_deactivation: roleBeforeDeactivation }) ?? p.role;

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
    warehouseAccess,
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
 * The three stores deactivate/reactivate keep in line (lib/staff/accounts.ts),
 * read fresh: the auth ban, profiles.role and the staff_accounts row. An auth
 * lookup that fails is an error, not "not banned": the plan below depends on it.
 */
async function loadActivationStores(
  admin: SupabaseClient,
  id: string,
): Promise<
  | { ok: true; stores: ActivationStores; accountsAvailable: boolean }
  | { ok: false; result: ActionResult }
> {
  const { data: profile } = await admin.from('profiles').select('role').eq('id', id).maybeSingle();
  const profileRole = (profile as { role?: string } | null)?.role ?? null;
  if (!profileRole) return { ok: false, result: fail(404, 'Not found') };

  const { data: accountRow, error: accountError } = await admin
    .from('staff_accounts')
    .select('status, role_before_deactivation')
    .eq('user_id', id)
    .maybeSingle();
  const accountsAvailable = !(accountError && isMissingTable(accountError));
  if (accountError && accountsAvailable) return { ok: false, result: fail(500, accountError.message) };
  const account = accountsAvailable
    ? (accountRow as { status?: string; role_before_deactivation?: string | null } | null)
    : null;

  const { data: authUser, error: authError } = await admin.auth.admin.getUserById(id);
  if (authError) return { ok: false, result: fail(500, `Could not read the login: ${authError.message}`) };
  const banned = isBannedUntil(authUser?.user?.banned_until ?? null, Date.now());

  return { ok: true, stores: { banned, profileRole, account }, accountsAvailable };
}

/** A step failed part-way: say so, and that running the same action again finishes it. */
function partial(action: 'Deactivate' | 'Reactivate', what: string, message: string | undefined): ActionResult {
  return fail(500, `${what} failed (${message ?? 'unknown error'}) — ${action.toLowerCase()} did not finish. Run ${action} again to complete it.`);
}

/**
 * Deactivate an account (SA-D2 "delete = deactivate"): block login
 * immediately (far-future ban), park the role on staff_accounts
 * (status 'deactivated' + role_before_deactivation), then demote
 * profiles.role to 'customer' (the server-side gates that actually matter
 * read this, so access stops on the next request rather than in an hour).
 *
 * Idempotent AND self-healing: it reads all three stores and runs only the
 * steps still missing (lib/staff/accounts.ts deactivationSteps), so a run
 * that failed part-way — banned but not recorded, recorded but not demoted —
 * is finished by running it again, and a fully deactivated account is left
 * alone. Shared by POST .../[id]/deactivate and the legacy
 * DELETE /api/owner/staff (route.ts), which now deactivates instead of
 * demoting-without-banning for safety.
 */
export async function performDeactivate(
  admin: SupabaseClient,
  ownerId: string,
  id: string,
): Promise<ActionResult> {
  if (id === ownerId) return fail(403, "You can't deactivate your own account");

  const loaded = await loadActivationStores(admin, id);
  if (!loaded.ok) return loaded.result;
  const { stores, accountsAvailable } = loaded;
  if (stores.profileRole === 'owner') return fail(403, 'Owner accounts can only be changed via SQL');
  // A plain customer — not on the team, never deactivated through here.
  if (classifyActivation(stores) === 'not_staff') return fail(404, 'Not a staff account');

  const { steps, parkRole } = deactivationSteps(stores);
  for (const step of steps) {
    if (step === 'ban') {
      const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: '876000h' });
      if (error) return partial('Deactivate', 'Blocking the login', error.message);
    } else if (step === 'record') {
      if (!accountsAvailable) continue; // migration not applied: ban + demote are all there is
      const patch = {
        status: 'deactivated' as const,
        role_before_deactivation: parkRole,
        deactivated_at: new Date().toISOString(),
        deactivated_by: ownerId,
      };
      if (stores.account) {
        // The role must be parked before profiles.role is overwritten below:
        // stop here rather than demote and lose it.
        const { error } = await admin.from('staff_accounts').update(patch).eq('user_id', id);
        if (error) return partial('Deactivate', 'Recording the deactivation', error.message);
      } else {
        // Backfill-skipped account (its email's local part didn't satisfy the
        // login_id shape, or collided at backfill time). Best-effort row so
        // the team screen still shows it deactivated — a login_id we can't
        // derive here must never block the deactivation itself, since the ban
        // above already took effect and the demotion below must follow.
        const { data: authUser } = await admin.auth.admin.getUserById(id);
        const derivedLoginId = normalizeLoginId(authUser?.user?.email ?? null);
        if (derivedLoginId) {
          const { error } = await admin
            .from('staff_accounts')
            .insert({ user_id: id, login_id: derivedLoginId, created_by: ownerId, ...patch });
          if (error) console.error('performDeactivate: staff_accounts insert failed', error);
        }
      }
    } else {
      const { error } = await admin.from('profiles').update({ role: 'customer' }).eq('id', id);
      if (error) return partial('Deactivate', 'Removing staff access', error.message);
    }
  }

  return succeed(await buildMember(admin, id));
}

/**
 * Reactivate: unban, restore profiles.role (from role_before_deactivation,
 * defaulting to 'staff' if that was somehow never set), and flip
 * staff_accounts back to active. Idempotent and self-healing like
 * performDeactivate (lib/staff/accounts.ts reactivationPlan): a run that
 * failed part-way is finished by running it again, and so is a deactivate
 * that stopped after banning — reactivate unbans it rather than reporting a
 * success it never achieved.
 */
export async function performReactivate(admin: SupabaseClient, id: string): Promise<ActionResult> {
  const loaded = await loadActivationStores(admin, id);
  if (!loaded.ok) return loaded.result;
  if (!loaded.accountsAvailable) {
    return fail(409, 'Staff accounts migration not applied yet — run supabase/2026-09-staff-accounts.sql');
  }
  const { stores } = loaded;
  if (classifyActivation(stores) === 'not_staff') return fail(404, 'Not found');

  const { steps, restoreRole } = reactivationPlan(stores);
  for (const step of steps) {
    if (step === 'unban') {
      const { error } = await admin.auth.admin.updateUserById(id, { ban_duration: 'none' });
      if (error) return partial('Reactivate', 'Unblocking the login', error.message);
    } else if (step === 'restore_role') {
      const { error } = await admin.from('profiles').update({ role: restoreRole }).eq('id', id);
      if (error) return partial('Reactivate', 'Restoring the role', error.message);
    } else {
      const { error } = await admin
        .from('staff_accounts')
        .update({ status: 'active', role_before_deactivation: null, deactivated_at: null, deactivated_by: null })
        .eq('user_id', id);
      if (error) return partial('Reactivate', 'Recording the reactivation', error.message);
    }
  }

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
