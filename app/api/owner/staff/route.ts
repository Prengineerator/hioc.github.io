import { randomBytes } from 'crypto';
import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { nameFromEmail } from '@/lib/staff/displayName';
import {
  MANAGEABLE_ROLES,
  TEAM_ROLES,
  loginEmailFor,
  normalizeLoginId,
  normalizePersonalEmail,
  passwordProblem,
  type EmailOutcome,
  type TeamMember,
} from '@/lib/staff/accounts';
import { sendPasswordLink } from '@/lib/staff/emails';
import {
  buildMember,
  findUserIdByEmail,
  hasHistory,
  isMissingTable,
  loadAuthUserMap,
  performDeactivate,
} from './_lib';

export const dynamic = 'force-dynamic';

// Owner-only team management (docs/PHASE-5-STAFF-ACCOUNTS.md). Every method
// is gated by getOwnerUser() and every write goes through the service-role
// admin client (profiles/staff_accounts have no client-writable policy).
//
// GET/POST here keep answering the shape older consumers expect (`members`,
// and a bare {email, role} POST body) while adding the full staff_accounts
// create flow. Per-account operations (patch, password, deactivate,
// reactivate, true delete) live under ./[id]/**.

type ManageableRole = (typeof MANAGEABLE_ROLES)[number];

// GET — every team member: active staff/manager/owner profiles, PLUS
// deactivated accounts (profiles.role is 'customer' while deactivated, so
// they wouldn't otherwise show up here). Degrades to the pre-migration shape
// (loginId/personalEmail null, status 'active', deletable false) when
// staff_accounts doesn't exist yet, instead of 500ing the whole team screen.
export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const admin = createAdminSupabaseClient();

  const { data: activeProfilesData, error: profError } = await admin
    .from('profiles')
    .select('id, role, name')
    .in('role', TEAM_ROLES)
    .order('role', { ascending: true });
  if (profError) return errorResponse(500, profError.message);

  const activeProfiles = (activeProfilesData ?? []) as { id: string; role: string; name: string | null }[];
  const authById = await loadAuthUserMap(admin);

  const { data: deactivatedRows, error: deactivatedError } = await admin
    .from('staff_accounts')
    .select('user_id')
    .eq('status', 'deactivated');

  if (deactivatedError && !isMissingTable(deactivatedError)) {
    return errorResponse(500, deactivatedError.message);
  }

  if (deactivatedError && isMissingTable(deactivatedError)) {
    // Migration not applied yet — old shape, so the team screen still loads.
    const members: TeamMember[] = activeProfiles.map((p) => {
      const auth = authById.get(p.id);
      return {
        id: p.id,
        role: p.role as TeamMember['role'],
        name: p.name?.trim() || nameFromEmail(auth?.email) || 'Unknown staff',
        email: auth?.email ?? '',
        loginId: null,
        personalEmail: null,
        phone: '',
        status: 'active',
        lastSignInAt: auth?.lastSignInAt ?? null,
        deletable: false,
      };
    });
    return NextResponse.json({ members });
  }

  const activeIds = new Set(activeProfiles.map((p) => p.id));
  const deactivatedIds = ((deactivatedRows ?? []) as { user_id: string }[])
    .map((r) => r.user_id)
    .filter((id) => !activeIds.has(id));

  let extraProfiles: { id: string; role: string; name: string | null }[] = [];
  if (deactivatedIds.length > 0) {
    const { data, error } = await admin.from('profiles').select('id, role, name').in('id', deactivatedIds);
    if (error) return errorResponse(500, error.message);
    extraProfiles = (data ?? []) as typeof extraProfiles;
  }

  const allProfiles = [...activeProfiles, ...extraProfiles];
  const allIds = allProfiles.map((p) => p.id);
  if (allIds.length === 0) return NextResponse.json({ members: [] });

  const { data: accountRows, error: accountsError } = await admin
    .from('staff_accounts')
    .select('user_id, login_id, personal_email, phone, status, role_before_deactivation')
    .in('user_id', allIds);
  if (accountsError && !isMissingTable(accountsError)) return errorResponse(500, accountsError.message);
  const accountById = new Map(
    (
      (accountRows ?? []) as {
        user_id: string;
        login_id: string;
        personal_email: string | null;
        phone: string | null;
        status: string;
        role_before_deactivation: string | null;
      }[]
    ).map((r) => [r.user_id, r]),
  );

  // Each account's own HISTORY_CHECKS run in parallel inside hasHistory();
  // run every account's check in parallel too.
  const deletableById = new Map<string, boolean>();
  await Promise.all(
    allIds.map(async (id) => {
      deletableById.set(id, !(await hasHistory(admin, id)));
    }),
  );

  const members: TeamMember[] = allProfiles.map((p) => {
    const auth = authById.get(p.id);
    const account = accountById.get(p.id);
    // profiles.role is 'customer' while deactivated (that's what actually
    // blocks staff access) — report the role they'll be restored to
    // instead, so the team screen's edit form doesn't pre-fill 'customer'
    // and silently demote a manager on save. status already says deactivated.
    const role = account?.status === 'deactivated' ? account.role_before_deactivation || 'staff' : p.role;
    return {
      id: p.id,
      role: role as TeamMember['role'],
      name: p.name?.trim() || nameFromEmail(auth?.email) || 'Unknown staff',
      email: auth?.email ?? '',
      loginId: account?.login_id ?? null,
      personalEmail: account?.personal_email ?? null,
      phone: account?.phone ?? '',
      status: (account?.status as TeamMember['status']) ?? 'active',
      lastSignInAt: auth?.lastSignInAt ?? null,
      deletable: deletableById.get(p.id) ?? false,
    };
  });

  return NextResponse.json({ members });
}

// POST — two shapes:
//  - new: CreateStaffBody (name, loginId, personalEmail, role, passwordMode…)
//    creates the auth user + profile + staff_accounts row.
//  - legacy: {email, role} — the old TeamManager body — finds-or-creates an
//    auth user by email and sets the role, no staff_accounts row. Kept
//    working for any consumer still on the old shape.
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const admin = createAdminSupabaseClient();

  const isNewStyle = 'loginId' in body || 'personalEmail' in body || 'passwordMode' in body;
  if (isNewStyle) return createStaffAccount(admin, owner.id, body);
  if (typeof body.email === 'string') return legacyCreateOrPromote(admin, body);
  return errorResponse(400, 'loginId and personalEmail are required');
}

async function createStaffAccount(
  admin: ReturnType<typeof createAdminSupabaseClient>,
  ownerId: string,
  body: Record<string, unknown>,
) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > 80) return errorResponse(400, 'Name is required (max 80 characters)');

  const loginId = normalizeLoginId(typeof body.loginId === 'string' ? body.loginId : null);
  if (!loginId) return errorResponse(400, 'Enter a valid login ID (letters, numbers, ., _, - — starting with a letter)');

  const personalEmail = normalizePersonalEmail(typeof body.personalEmail === 'string' ? body.personalEmail : null);
  if (!personalEmail) return errorResponse(400, 'A personal email is required');

  const role = typeof body.role === 'string' ? body.role : '';
  if (!MANAGEABLE_ROLES.includes(role as ManageableRole)) return errorResponse(400, 'Role must be staff or manager');

  const passwordMode = body.passwordMode === 'set' ? 'set' : body.passwordMode === 'link' ? 'link' : null;
  if (!passwordMode) return errorResponse(400, "passwordMode must be 'link' or 'set'");

  let password: string;
  if (passwordMode === 'set') {
    const problem = passwordProblem(body.password);
    if (problem) return errorResponse(400, problem);
    password = body.password as string;
  } else {
    password = randomBytes(24).toString('base64url').slice(0, 32);
  }

  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  const loginEmail = loginEmailFor(loginId);

  const existingUserId = await findUserIdByEmail(admin, loginEmail);
  if (existingUserId) return errorResponse(409, 'That login ID is already in use');

  const { data: existingAccount, error: existingAccountError } = await admin
    .from('staff_accounts')
    .select('user_id')
    .eq('login_id', loginId)
    .maybeSingle();
  if (existingAccountError && !isMissingTable(existingAccountError)) {
    return errorResponse(500, existingAccountError.message);
  }
  if (existingAccount) return errorResponse(409, 'That login ID is already in use');

  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: loginEmail,
    email_confirm: true,
    password,
    user_metadata: { name },
  });
  if (createErr || !created?.user) {
    return errorResponse(502, `Could not create account: ${createErr?.message ?? 'unknown error'}`);
  }
  const userId = created.user.id;

  const { error: profileErr } = await admin.from('profiles').upsert({ id: userId, role, name }, { onConflict: 'id' });
  if (profileErr) {
    await admin.auth.admin.deleteUser(userId);
    return errorResponse(500, `Could not create profile: ${profileErr.message}`);
  }

  const { error: acctErr } = await admin.from('staff_accounts').insert({
    user_id: userId,
    login_id: loginId,
    personal_email: personalEmail,
    phone,
    created_by: ownerId,
  });
  if (acctErr) {
    await admin.auth.admin.deleteUser(userId);
    return errorResponse(500, `Could not create staff account: ${acctErr.message}`);
  }

  let email: EmailOutcome | undefined;
  if (passwordMode === 'link') {
    email = await sendPasswordLink(admin, {
      userId,
      loginEmail,
      loginId,
      personalEmail,
      name,
      kind: 'invite',
    });
  }

  const member = await buildMember(admin, userId);
  return NextResponse.json({ ok: true, member, email });
}

async function legacyCreateOrPromote(admin: ReturnType<typeof createAdminSupabaseClient>, body: Record<string, unknown>) {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = typeof body.role === 'string' ? body.role : 'staff';
  if (!email || !email.includes('@')) return errorResponse(400, 'A valid email is required');
  if (!MANAGEABLE_ROLES.includes(role as ManageableRole)) return errorResponse(400, 'Role must be staff or manager');

  let userId = await findUserIdByEmail(admin, email);
  if (!userId) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (createErr || !created?.user) {
      return errorResponse(502, `Could not create account: ${createErr?.message ?? 'unknown error'}`);
    }
    userId = created.user.id;
  }

  const { data: existingProfile } = await admin.from('profiles').select('name').eq('id', userId).maybeSingle();
  const hasName = Boolean((existingProfile as { name?: string | null } | null)?.name?.trim());
  const patch: { id: string; role: string; name?: string } = { id: userId, role };
  if (!hasName) {
    const derived = nameFromEmail(email);
    if (derived) patch.name = derived;
  }

  const { error: upErr } = await admin.from('profiles').upsert(patch, { onConflict: 'id' });
  if (upErr) return errorResponse(500, `Could not set role: ${upErr.message}`);

  const member = await buildMember(admin, userId);
  return NextResponse.json({ ok: true, member });
}

// DELETE { id } — the pre-SA-2 body shape. Used to demote straight to
// customer with no ban; now routes through the same deactivate flow as
// POST .../[id]/deactivate so a "removed" staffer's login is actually
// blocked, not just hidden from the team list (SA-D2).
export async function DELETE(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return errorResponse(400, 'id is required');

  const admin = createAdminSupabaseClient();
  const result = await performDeactivate(admin, owner.id, id);
  return NextResponse.json(result.body, { status: result.status });
}
