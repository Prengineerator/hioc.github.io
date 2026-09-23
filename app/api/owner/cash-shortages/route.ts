import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import type { ShortageStatus } from '@/lib/cash/counts';
import { SHORTAGE_COLUMNS, buildShortageRows, isMissingTable, monthBounds, type ShortageRow } from './_lib';

export const dynamic = 'force-dynamic';

const STATUSES: ShortageStatus[] = ['pending', 'approved', 'waived'];
const MAX_ROWS = 300;

// GET /api/owner/cash-shortages?status=&month= — the owner's shortage review
// queue (docs/PHASE-5-CASH-COUNTS.md). `status` narrows to one status
// (typically 'pending' for the review queue at the top of /owner/cash);
// `month` (YYYY-MM) narrows to shortages whose business_date falls in that
// month (for the per-staffer monthly totals). Both are optional and compose
// with AND; omitting both returns the most recent shortages of any status.
export async function GET(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return errorResponse(403, 'Owner access required');

  const url = new URL(request.url);
  const statusParam = url.searchParams.get('status');
  if (statusParam && !STATUSES.includes(statusParam as ShortageStatus)) {
    return errorResponse(400, 'status must be pending, approved or waived');
  }
  const monthParam = url.searchParams.get('month');
  let bounds: { from: string; to: string } | null = null;
  if (monthParam) {
    bounds = monthBounds(monthParam);
    if (!bounds) return errorResponse(400, 'month must look like 2026-09');
  }

  const admin = createAdminSupabaseClient();
  let query = admin.from('cash_shortages').select(SHORTAGE_COLUMNS).order('created_at', { ascending: false }).limit(MAX_ROWS);
  if (statusParam) query = query.eq('status', statusParam);
  if (bounds) query = query.gte('business_date', bounds.from).lte('business_date', bounds.to);

  const { data, error } = await query;
  if (error && isMissingTable(error)) {
    return errorResponse(409, 'Cash-counts migration not applied yet — run supabase/2026-09-cash-counts.sql');
  }
  if (error) return errorResponse(500, error.message);

  const shortages = await buildShortageRows(admin, (data ?? []) as ShortageRow[]);
  return NextResponse.json({ shortages });
}
