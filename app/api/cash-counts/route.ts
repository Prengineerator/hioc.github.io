import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getManagerUser, getStaffUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { recordCount, type CashCountRow } from '@/lib/cash/checkpoints';
import { getStaffDisplayNames } from '@/lib/staff/displayName';

export const dynamic = 'force-dynamic';

// CC-2 — manual cash checkpoints (docs/PHASE-5-CASH-COUNTS.md). A staffer can
// count the drawer outside of a punch (e.g. mid-shift, or asked to by a
// manager); the owner/manager view lists recent checkpoints across the whole
// chain — clock-in/out, day-open/close and manual counts alike.

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// POST /api/cash-counts — any staff session. Body: { denoms }.
export async function POST(request: Request) {
  const user = await getStaffUser();
  if (!user) return unauthorized();

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  try {
    const cashCount = await recordCount(createAdminSupabaseClient(), {
      kind: 'manual',
      userId: user.id,
      denoms: body.denoms,
    });
    return NextResponse.json({ cashCount });
  } catch (err) {
    console.error('POST /api/cash-counts: recordCount failed', err);
    return errorResponse(
      500,
      'Could not save the count — is supabase/2026-09-cash-counts.sql applied?',
    );
  }
}

// GET /api/cash-counts?limit= — manager/owner only. Recent checkpoints of
// every kind, newest first, with display names resolved.
export async function GET(request: Request) {
  const user = await getManagerUser();
  if (!user) return unauthorized();

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_LIMIT) : DEFAULT_LIMIT;

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('cash_counts')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    return errorResponse(
      500,
      'Could not load cash counts — is supabase/2026-09-cash-counts.sql applied?',
    );
  }

  const rows = (data ?? []) as CashCountRow[];
  const ids = rows.flatMap((r) => [r.user_id, r.override_by].filter((v): v is string => !!v));
  const names = await getStaffDisplayNames(admin, ids);

  const counts = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    businessDate: r.business_date,
    userId: r.user_id,
    userName: names.get(r.user_id) ?? 'Unknown staff',
    attendanceSessionId: r.attendance_session_id,
    cashDayId: r.cash_day_id,
    countedTotalInr: r.counted_total_inr,
    expectedTotalInr: r.expected_total_inr,
    varianceInr: r.variance_inr,
    overrideBy: r.override_by,
    overrideByName: r.override_by ? (names.get(r.override_by) ?? 'Unknown manager') : null,
    overrideReason: r.override_reason,
    createdAt: r.created_at,
  }));

  return NextResponse.json({ counts });
}
