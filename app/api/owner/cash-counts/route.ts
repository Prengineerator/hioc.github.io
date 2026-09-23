import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import type { CashCountKind } from '@/lib/cash/counts';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 300;

type PgError = { code?: string; message?: string } | null | undefined;

/**
 * True when `error` means "the relation/column doesn't exist" — the
 * cash-counts migration (supabase/2026-09-cash-counts.sql) hasn't been
 * applied yet. Duplicated rather than imported from ../cash-shortages/_lib —
 * same call app/api/owner/devices/route.ts makes against staff/_lib.ts's
 * copy: a six-line predicate isn't worth coupling two route trees over.
 */
function isMissingTable(error: PgError): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === '42703' || error.code === 'PGRST204' || error.code === 'PGRST205') {
    return true;
  }
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('schema cache') || msg.includes('does not exist');
}

interface CountRow {
  id: string;
  kind: CashCountKind;
  user_id: string;
  business_date: string;
  counted_total_inr: number | null;
  expected_total_inr: number | null;
  variance_inr: number | null;
  override_by: string | null;
  override_reason: string | null;
  created_at: string;
}

interface MovementRow {
  id: string;
  direction: 'out' | 'in';
  amount_inr: number;
  reason: string;
  recorded_by: string;
  created_at: string;
}

// GET /api/owner/cash-counts?limit= — read-only log for the owner: recent
// checkpoints (kind, who, counted, expected, variance, override reason) and
// cash movements (in/out, amount, reason, who) — docs/PHASE-5-CASH-COUNTS.md.
// No writes happen through this route; counts and movements are produced by
// the punch flow and the manager/owner override + cash-movement endpoints
// elsewhere (app/api/cash-counts/**, app/api/cash-movements/**).
export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT);
  const limit = Number.isFinite(limitParam) ? Math.min(MAX_LIMIT, Math.max(1, Math.floor(limitParam))) : DEFAULT_LIMIT;

  const admin = createAdminSupabaseClient();

  const { data: countData, error: countError } = await admin
    .from('cash_counts')
    .select(
      'id, kind, user_id, business_date, counted_total_inr, expected_total_inr, variance_inr, override_by, override_reason, created_at',
    )
    .order('created_at', { ascending: false })
    .limit(limit);
  if (countError && isMissingTable(countError)) {
    return errorResponse(409, 'Cash-counts migration not applied yet — run supabase/2026-09-cash-counts.sql');
  }
  if (countError) return errorResponse(500, countError.message);

  const { data: movementData, error: movementError } = await admin
    .from('cash_movements')
    .select('id, direction, amount_inr, reason, recorded_by, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (movementError && !isMissingTable(movementError)) {
    return errorResponse(500, movementError.message);
  }

  const counts = (countData ?? []) as CountRow[];
  const movements = (movementData ?? []) as MovementRow[];

  const ids = new Set<string>();
  for (const c of counts) {
    ids.add(c.user_id);
    if (c.override_by) ids.add(c.override_by);
  }
  for (const m of movements) ids.add(m.recorded_by);
  const names = await getStaffDisplayNames(admin, [...ids]);

  return NextResponse.json({
    counts: counts.map((c) => ({
      id: c.id,
      kind: c.kind,
      userId: c.user_id,
      userName: names.get(c.user_id) ?? 'Unknown staff',
      businessDate: c.business_date,
      countedTotalInr: c.counted_total_inr,
      expectedTotalInr: c.expected_total_inr,
      varianceInr: c.variance_inr,
      overrideByName: c.override_by ? (names.get(c.override_by) ?? 'Unknown staff') : null,
      overrideReason: c.override_reason,
      createdAt: c.created_at,
    })),
    movements: movements.map((m) => ({
      id: m.id,
      direction: m.direction,
      amountInr: m.amount_inr,
      reason: m.reason,
      recordedByName: names.get(m.recorded_by) ?? 'Unknown staff',
      createdAt: m.created_at,
    })),
  });
}
