import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';

export const dynamic = 'force-dynamic';

// Owner-only team management. Staff/manager roles normally require running SQL
// against `profiles.role`; this endpoint lets the owner do it from the
// dashboard instead. Every method is gated by getOwnerUser() and all writes go
// through the service-role admin client (the profiles table has no
// insert/update policy for `authenticated` — role changes are privileged).

const MANAGEABLE_ROLES = ['staff', 'manager'] as const;
const TEAM_ROLES = ['staff', 'manager', 'owner'];

// supabase-js exposes no email filter on listUsers, so page through the (small,
// for a single cafe) user list to build an id→email map / find one by email.
async function loadEmailMap(admin: SupabaseClient): Promise<Map<string, string>> {
  const emailById = new Map<string, string>();
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error || !data) break;
    for (const u of data.users) emailById.set(u.id, u.email ?? '');
    if (data.users.length < 1000) break;
  }
  return emailById;
}

// GET — list every staff/manager/owner member with their email + role.
export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('profiles')
    .select('id, role, name')
    .in('role', TEAM_ROLES)
    .order('role', { ascending: true });
  if (error) return errorResponse(500, error.message);

  const emailById = await loadEmailMap(admin);
  const members = ((data ?? []) as { id: string; role: string; name: string }[]).map((p) => ({
    id: p.id,
    role: p.role,
    name: p.name ?? '',
    email: emailById.get(p.id) ?? '',
    isSelf: p.id === owner.id,
  }));
  return NextResponse.json({ members });
}

// POST { email, role } — promote an existing account, or create one if none
// exists yet (they can then sign in via the normal email OTP flow).
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const role = typeof body.role === 'string' ? body.role : 'staff';
  if (!email || !email.includes('@')) return errorResponse(400, 'A valid email is required');
  if (!MANAGEABLE_ROLES.includes(role as (typeof MANAGEABLE_ROLES)[number])) {
    return errorResponse(400, 'Role must be staff or manager');
  }

  const admin = createAdminSupabaseClient();

  // Find the existing auth user for this email, else create a confirmed one.
  let userId = '';
  for (let page = 1; page <= 10 && !userId; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) return errorResponse(502, `User lookup failed: ${error.message}`);
    if (!data) break;
    const match = data.users.find((u) => (u.email ?? '').toLowerCase() === email);
    if (match) userId = match.id;
    if (data.users.length < 1000) break;
  }
  if (!userId) {
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      email_confirm: true,
    });
    if (createErr || !created?.user) {
      return errorResponse(502, `Could not create account: ${createErr?.message ?? 'unknown error'}`);
    }
    userId = created.user.id;
  }

  // Upsert the role (the trigger creates a profiles row on user creation, but
  // upsert also covers any pre-existing user missing a row).
  const { error: upErr } = await admin.from('profiles').upsert({ id: userId, role }, { onConflict: 'id' });
  if (upErr) return errorResponse(500, `Could not set role: ${upErr.message}`);

  return NextResponse.json({ success: true, id: userId, email, role });
}

// DELETE { id } — revoke team access by demoting the profile back to customer.
export async function DELETE(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id) return errorResponse(400, 'id is required');
  if (id === owner.id) return errorResponse(400, "You can't remove your own access");

  const admin = createAdminSupabaseClient();
  const { data: prof } = await admin.from('profiles').select('role').eq('id', id).maybeSingle();
  if ((prof as { role?: string } | null)?.role === 'owner') {
    return errorResponse(400, 'Owner accounts can only be changed via SQL');
  }
  const { error } = await admin.from('profiles').update({ role: 'customer' }).eq('id', id);
  if (error) return errorResponse(500, error.message);
  return NextResponse.json({ success: true });
}
