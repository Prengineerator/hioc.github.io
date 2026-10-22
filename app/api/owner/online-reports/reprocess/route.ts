import { NextResponse } from 'next/server';
import { getOwnerUser } from '@/lib/api/auth';
import { isUuid } from '@/lib/api/constants';
import { errorResponse, unauthorized } from '@/lib/api/http';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { REREAD_MAX_FILES, reprocessSavedReports } from '@/lib/online-settlements/reprocess';
import { loadRereadableReports, supabaseSettlementStore } from '@/lib/online-settlements/store';
import type { Platform } from '@/lib/online-settlements/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// Stop starting new files after this long, so the response still fits in maxDuration.
const TIME_BUDGET_MS = 45_000;

// POST /api/owner/online-reports/reprocess  { platform?: 'zomato' | 'swiggy', after?: uuid } — owner only.
// The "Re-read saved reports" button on Owner → Online orders: runs the raw
// files already in Storage whose report is 'unsupported' (Swiggy, no parser
// yet) or 'failed' back through the ingest pipeline, without the email, so a
// new or fixed parser picks them up. Reports already read are never touched.
// A call re-reads at most 100 files and says how many are left; `next` is the
// id to send back as `after` for the following batch.
export async function POST(request: Request) {
  const owner = await getOwnerUser();
  if (!owner) return unauthorized();

  // No body (or not JSON): every platform, from the start.
  const body = ((await request.json().catch(() => null)) ?? {}) as { platform?: unknown; after?: unknown };
  let platform: Platform | null = null;
  if (body.platform === 'zomato' || body.platform === 'swiggy') platform = body.platform;
  else if (body.platform != null && body.platform !== '') return errorResponse(400, "platform must be 'zomato' or 'swiggy'");
  let afterId: string | null = null;
  if (isUuid(body.after)) afterId = body.after;
  else if (body.after != null) return errorResponse(400, 'after must be a report id');

  try {
    const admin = createAdminSupabaseClient();
    const { rows, left } = await loadRereadableReports(admin, { platform, afterId, limit: REREAD_MAX_FILES });
    const result = await reprocessSavedReports(supabaseSettlementStore(admin), rows, {
      platform,
      deadline: Date.now() + TIME_BUDGET_MS,
    });
    const handled = rows.length - result.notReached;
    const more = left + result.notReached;
    return NextResponse.json({ result, left: more, next: more ? (rows[handled - 1]?.id ?? afterId) : null });
  } catch (err) {
    console.error('online-reports reprocess failed', err);
    const msg = err instanceof Error ? err.message : String(err);
    if (/online_settlement_/.test(msg) && /does not exist|PGRST205|could not find the table/i.test(msg)) {
      return errorResponse(500, 'Apply supabase/2026-10-online-settlements.sql first');
    }
    return errorResponse(500, 'Could not re-read the saved reports');
  }
}
