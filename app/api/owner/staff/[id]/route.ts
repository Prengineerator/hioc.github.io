import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, notFound, parseJsonBody } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { MANAGEABLE_ROLES, loginEmailFor, normalizeLoginId, normalizePersonalEmail } from '@/lib/staff/accounts';
import { buildMember, findUserIdByEmail, isMissingTable, performDelete } from '../_lib';

export const dynamic = 'force-dynamic';

type RouteParams = { params: { id: string } };
type ManageableRole = (typeof MANAGEABLE_ROLES)[number];

type StaffAccountRow = {
  login_id: string;
  personal_email: string | null;
  phone: string | null;
  status: string;
  role_before_deactivation: string | null;
};

// PATCH /api/owner/staff/[id] — UpdateStaffBody, every field optional. Cannot
// target an owner, cannot change the caller's own role. A loginId change
// renames the Supabase auth email; other fields land on profiles or
// staff_accounts as appropriate. Creates the staff_accounts row on the fly
// for a backfill-skipped account (docs/PHASE-5-STAFF-ACCOUNTS.md backfill
// note) when a loginId is supplied or derivable from the current auth email.
export async function PATCH(request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  const { id } = params;
  if (!isUuid(id)) return notFound();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const admin = createAdminSupabaseClient();

  const { data: profile } = await admin.from('profiles').select('role').eq('id', id).maybeSingle();
  const currentRole = (profile as { role?: string } | null)?.role ?? null;
  if (!currentRole) return notFound();
  if (currentRole === 'owner') return errorResponse(403, 'Owner accounts can only be changed via SQL');

  const patchHasRole = typeof body.role === 'string';

  const { data: accountRow, error: accountError } = await admin
    .from('staff_accounts')
    .select('login_id, personal_email, phone, status, role_before_deactivation')
    .eq('user_id', id)
    .maybeSingle();
  if (accountError && isMissingTable(accountError)) {
    return errorResponse(409, 'Staff accounts migration not applied yet — run supabase/2026-09-staff-accounts.sql');
  }
  if (accountError) return errorResponse(500, accountError.message);
  const account = accountRow as StaffAccountRow | null;

  const profilePatch: Record<string, unknown> = {};
  const accountPatch: Record<string, unknown> = {};
  let newLoginEmail: string | null = null;

  if (typeof body.name === 'string') {
    const name = body.name.trim();
    if (!name || name.length > 80) return errorResponse(400, 'Name must be 1-80 characters');
    profilePatch.name = name;
  }

  if (typeof body.loginId === 'string') {
    const loginId = normalizeLoginId(body.loginId);
    if (!loginId) return errorResponse(400, 'Enter a valid login ID');
    if (!account || account.login_id !== loginId) {
      const loginEmail = loginEmailFor(loginId);
      const existingUserId = await findUserIdByEmail(admin, loginEmail);
      if (existingUserId && existingUserId !== id) return errorResponse(409, 'That login ID is already in use');

      const { data: existingAccount, error: existingAccountErr } = await admin
        .from('staff_accounts')
        .select('user_id')
        .eq('login_id', loginId)
        .maybeSingle();
      if (existingAccountErr && !isMissingTable(existingAccountErr)) return errorResponse(500, existingAccountErr.message);
      if (existingAccount && (existingAccount as { user_id: string }).user_id !== id) {
        return errorResponse(409, 'That login ID is already in use');
      }

      newLoginEmail = loginEmail;
      accountPatch.login_id = loginId;
    }
  }

  if (typeof body.personalEmail === 'string') {
    if (body.personalEmail.trim() === '') {
      accountPatch.personal_email = null;
    } else {
      const personalEmail = normalizePersonalEmail(body.personalEmail);
      if (!personalEmail) return errorResponse(400, 'Enter a valid personal email');
      accountPatch.personal_email = personalEmail;
    }
  }

  if (typeof body.phone === 'string') {
    accountPatch.phone = body.phone.trim();
  }

  const isDeactivated = currentRole === 'customer' && account?.status === 'deactivated';
  // profiles.role is 'customer' while deactivated — that's not the role the
  // owner sees or means to compare against, so "effective" role for a
  // deactivated account is what it'll be restored to.
  const effectiveRole = isDeactivated ? account?.role_before_deactivation || 'staff' : currentRole;

  if (patchHasRole) {
    const role = body.role as string;
    if (!MANAGEABLE_ROLES.includes(role as ManageableRole)) return errorResponse(400, 'Role must be staff or manager');
    if (role === effectiveRole) {
      // No-op — same role as today, nothing to change or guard against.
    } else if (id === owner.id) {
      return errorResponse(403, "You can't change your own role");
    } else if (isDeactivated) {
      // The account is deactivated — its real role is parked on
      // staff_accounts, not profiles (profiles.role stays 'customer' until
      // reactivate). Changing "role" here means changing what it will be
      // restored to.
      accountPatch.role_before_deactivation = role;
    } else {
      profilePatch.role = role;
    }
  }

  if (Object.keys(profilePatch).length === 0 && Object.keys(accountPatch).length === 0) {
    return errorResponse(400, 'Nothing to update');
  }

  if (newLoginEmail) {
    const { error: emailErr } = await admin.auth.admin.updateUserById(id, { email: newLoginEmail, email_confirm: true });
    if (emailErr) return errorResponse(500, `Could not update login email: ${emailErr.message}`);
  }

  if (Object.keys(profilePatch).length > 0) {
    const { error } = await admin.from('profiles').update(profilePatch).eq('id', id);
    if (error) return errorResponse(500, error.message);
  }

  if (Object.keys(accountPatch).length > 0) {
    if (account) {
      const { error } = await admin.from('staff_accounts').update(accountPatch).eq('user_id', id);
      if (error) return errorResponse(500, error.message);
    } else {
      let loginId = (accountPatch.login_id as string | undefined) ?? null;
      if (!loginId) {
        const { data: authUser } = await admin.auth.admin.getUserById(id);
        loginId = normalizeLoginId(authUser?.user?.email ?? null);
      }
      if (!loginId) return errorResponse(400, 'A login ID is required to create the account record');

      const insertPatch: Record<string, unknown> = {
        user_id: id,
        login_id: loginId,
        personal_email: (accountPatch.personal_email as string | null | undefined) ?? null,
        phone: (accountPatch.phone as string | undefined) ?? '',
        created_by: owner.id,
      };
      if ('role_before_deactivation' in accountPatch) {
        insertPatch.role_before_deactivation = accountPatch.role_before_deactivation;
      }
      const { error } = await admin.from('staff_accounts').insert(insertPatch);
      if (error) return errorResponse(500, error.message);
    }
  }

  const member = await buildMember(admin, id);
  return NextResponse.json({ ok: true, member });
}

// DELETE /api/owner/staff/[id] — true delete, only legal when the account has
// no history (SA-D2). Blocked with 409 otherwise; deactivate instead.
export async function DELETE(_request: Request, { params }: RouteParams) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');
  const { id } = params;
  if (!isUuid(id)) return notFound();

  const admin = createAdminSupabaseClient();
  const result = await performDelete(admin, owner.id, id);
  return NextResponse.json(result.body, { status: result.status });
}
