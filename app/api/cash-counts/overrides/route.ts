import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { OVERRIDE_TTL_MINUTES, overrideReasonProblem, type PunchType } from '@/lib/cash/counts';
import { getStaffDisplayNames } from '@/lib/staff/displayName';

export const dynamic = 'force-dynamic';

// CC-2 — manager/owner override for one upcoming cash count
// (docs/PHASE-5-CASH-COUNTS.md CC-D5). Lets a manager excuse a single
// clock-in or clock-out from the count requirement, with a mandatory reason;
// the grant expires after OVERRIDE_TTL_MINUTES and is consumed by the next
// matching punch (lib/cash/checkpoints.ts recordOverride).

function isPunchType(value: unknown): value is PunchType {
  return value === 'in' || value === 'out';
}

// POST /api/cash-counts/overrides — manager/owner only.
// Body: { userId, punchType: 'in' | 'out', reason }.
export async function POST(request: Request) {
  const manager = await getManagerUser();
  if (!manager) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const { userId, punchType, reason } = body;
  if (typeof userId !== 'string' || !isUuid(userId)) {
    return errorResponse(400, 'userId must be a valid id');
  }
  if (!isPunchType(punchType)) {
    return errorResponse(400, "punchType must be 'in' or 'out'");
  }
  const reasonProblem = overrideReasonProblem(reason);
  if (reasonProblem) return errorResponse(400, reasonProblem);

  if (userId === manager.id) {
    return errorResponse(400, 'You cannot grant yourself a cash-count override.');
  }

  const admin = createAdminSupabaseClient();

  const { data: target, error: targetError } = await admin
    .from('staff_accounts')
    .select('user_id, status')
    .eq('user_id', userId)
    .maybeSingle();
  if (targetError) {
    return errorResponse(
      500,
      'Could not verify the staff account — is supabase/2026-09-staff-accounts.sql applied?',
    );
  }
  if (!target || (target as { status: string }).status !== 'active') {
    return errorResponse(400, 'The override can only be granted to an active staff account.');
  }

  const expiresAt = new Date(Date.now() + OVERRIDE_TTL_MINUTES * 60_000).toISOString();

  const { data: inserted, error: insertError } = await admin
    .from('cash_count_overrides')
    .insert({
      user_id: userId,
      punch_type: punchType,
      reason: (reason as string).trim(),
      granted_by: manager.id,
      expires_at: expiresAt,
    })
    .select('*')
    .single();
  if (insertError || !inserted) {
    return errorResponse(
      500,
      'Could not grant the override — is supabase/2026-09-cash-counts.sql applied?',
    );
  }

  return NextResponse.json({ override: inserted });
}

// GET /api/cash-counts/overrides — manager/owner only. Currently usable
// (unused, unexpired) overrides, with staffer + granter names resolved.
export async function GET() {
  const manager = await getManagerUser();
  if (!manager) return unauthorized();

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('cash_count_overrides')
    .select('*')
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });
  if (error) {
    return errorResponse(
      500,
      'Could not load overrides — is supabase/2026-09-cash-counts.sql applied?',
    );
  }

  const rows = (data ?? []) as {
    id: string;
    user_id: string;
    punch_type: PunchType;
    reason: string;
    granted_by: string;
    expires_at: string;
    created_at: string;
  }[];
  const names = await getStaffDisplayNames(admin, [
    ...rows.map((r) => r.user_id),
    ...rows.map((r) => r.granted_by),
  ]);

  const overrides = rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    userName: names.get(r.user_id) ?? 'Unknown staff',
    punchType: r.punch_type,
    reason: r.reason,
    grantedBy: r.granted_by,
    grantedByName: names.get(r.granted_by) ?? 'Unknown manager',
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }));

  return NextResponse.json({ overrides });
}
