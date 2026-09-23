import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getOwnerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { getPermissionMatrix, KNOWN_PERMISSION_KEYS } from '@/lib/permissions';
import type { PermissionKey, PermissionMinRole } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Owner-only permission matrix (FND3-6). Modeled on app/api/owner/staff/route.ts:
// every method opens getOwnerUser() and all writes go through the service-role
// admin client. GET returns the full matrix (every known key, defaults filled);
// PATCH flips one key's min_role between 'staff' and 'manager', audits the change,
// and takes effect immediately (hasPermission reads fresh per request — no cache).

// Only 'staff' and 'manager' are settable — nothing is grantable to customers.
const EDITABLE_MIN_ROLES: PermissionMinRole[] = ['staff', 'manager'];

// GET — the full permission × role matrix for the owner grid.
export async function GET() {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const permissions = await getPermissionMatrix();
  return NextResponse.json({ permissions });
}

// PATCH { permission_key, min_role } — change one key's required role.
export async function PATCH(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const permissionKey = body.permission_key;
  const minRole = body.min_role;

  if (
    typeof permissionKey !== 'string' ||
    !KNOWN_PERMISSION_KEYS.includes(permissionKey as PermissionKey)
  ) {
    return errorResponse(400, 'permission_key must be one of the known permission keys');
  }
  if (
    typeof minRole !== 'string' ||
    !EDITABLE_MIN_ROLES.includes(minRole as PermissionMinRole)
  ) {
    return errorResponse(400, 'min_role must be staff or manager');
  }

  const admin = createAdminSupabaseClient();

  // Read the current value first, for the audit trail (may be missing → null).
  const { data: existing } = await admin
    .from('role_permissions')
    .select('min_role')
    .eq('permission_key', permissionKey)
    .maybeSingle();
  const oldMinRole = (existing as { min_role?: string } | null)?.min_role ?? null;

  const now = new Date().toISOString();
  const { data: updated, error: upsertError } = await admin
    .from('role_permissions')
    .upsert(
      { permission_key: permissionKey, min_role: minRole, updated_by: owner.id, updated_at: now },
      { onConflict: 'permission_key' },
    )
    .select('permission_key, min_role, updated_by, updated_at')
    .single();
  if (upsertError || !updated) {
    return errorResponse(500, 'Failed to update permission');
  }

  // Audit who flipped what, when (FND3-6 AC). The change already succeeded, so a
  // failed audit write is logged, not fatal.
  const { error: auditError } = await admin.from('permission_change_audit').insert({
    permission_key: permissionKey,
    old_min_role: oldMinRole,
    new_min_role: minRole,
    changed_by: owner.id,
    changed_at: now,
  });
  if (auditError) {
    console.error('permission_change_audit insert failed after a successful change', auditError);
  }

  return NextResponse.json({ permission: updated });
}
