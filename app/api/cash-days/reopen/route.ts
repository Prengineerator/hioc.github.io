import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse, parseJsonBody } from '@/lib/api/http';
import { requireCashManager } from '@/lib/cash/gate';
import { cashReasonProblem } from '@/lib/cash/day';
import { CASH_DAY_COLUMNS, MIGRATION_HINT, getLatestDay, isMissingColumn, writeDayAppTotals } from '@/lib/cash/dayServer';
import type { CashDay, CashDayReopenEntry } from '@/lib/types';

export const dynamic = 'force-dynamic';

// POST /api/cash-days/reopen — a manager/owner undoes a MISTAKEN close (the
// production accident: a day closed with ₹0 counted before the first sale).
// Body: { reason, id? }.
//
// Only the most recent cash day can be reopened, and only while no newer day
// exists (nothing is open, so nothing was opened after it): reopening an older
// day would put two overlapping windows on the same drawer. The close it undoes
// is kept in reopen_log (who, when, why, what it had counted), and the day's
// closing fields are cleared so the re-close starts clean.
//
// The chain is untouched: the day_close checkpoint and the handover cash-out
// written at the first close stay, so at the re-close expected cash correctly
// reflects that the handed-over cash really left the drawer. If it was put back,
// a manager records it as cash in.
//
// PIN-3: requireCashManager() (getCounterManager) — classic session first, an
// enrolled device's PIN operator otherwise; manager or owner only (a plain role
// check, not a permission-matrix key). 401 without an actor, 403 for plain staff.
export async function POST(request: Request) {
  const gate = await requireCashManager('Only a manager or the owner can reopen a cash day.');
  if (gate.denied) return gate.denied;
  const manager = gate.manager;

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const reasonProblem = cashReasonProblem(body.reason, 'reopening the day');
  if (reasonProblem) return errorResponse(400, reasonProblem);
  const reason = (body.reason as string).trim();

  const admin = createAdminSupabaseClient();
  const { day: latest, error: latestError } = await getLatestDay(admin);
  if (latestError) return errorResponse(500, isMissingColumn(latestError) ? MIGRATION_HINT : latestError.message);
  if (!latest) return errorResponse(404, 'There is no cash day to reopen');
  if (latest.status !== 'closed') return errorResponse(409, 'The cash day is already open');
  if (typeof body.id === 'string' && body.id !== latest.id) {
    return errorResponse(409, 'Only the most recent cash day can be reopened');
  }

  const nowIso = new Date().toISOString();
  const entry: CashDayReopenEntry = {
    at: nowIso,
    by: manager.user.id,
    reason,
    prev_closed_at: latest.closed_at,
    prev_counted_inr: latest.counted_total_inr,
    prev_handover_inr: latest.handover_inr,
  };

  const { data, error } = await admin
    .from('cash_days')
    .update({
      status: 'open',
      closed_by: null,
      closed_at: null,
      closing_denoms: {},
      counted_total_inr: 0,
      expected_cash_inr: 0,
      over_short_inr: 0,
      notes: '',
      close_reason: '',
      cash_sales_inr: null,
      cash_sales_count: null,
      cash_refunds_inr: null,
      cash_in_inr: null,
      cash_out_inr: null,
      upi_inr: null,
      card_inr: null,
      handover_inr: null,
      float_left_denoms: null,
      float_left_total_inr: null,
      unpaid_count_at_close: null,
      unpaid_override_reason: null,
      reopened_at: nowIso,
      reopened_by: manager.user.id,
      reopen_reason: reason,
      reopen_log: [...(Array.isArray(latest.reopen_log) ? latest.reopen_log : []), entry],
    })
    .eq('id', latest.id)
    .eq('status', 'closed') // a concurrent reopen/open loses here
    .select(CASH_DAY_COLUMNS)
    .maybeSingle();

  if (error) {
    // 23505: another day was opened in the meantime (idx_cash_days_one_open).
    if (error.code === '23505') return errorResponse(409, 'A newer cash day is already open');
    return errorResponse(500, isMissingColumn(error) ? MIGRATION_HINT : error.message);
  }
  if (!data) return errorResponse(409, 'This cash day is no longer closed');
  // Cleared with the other close-time figures; the next close writes them again.
  await writeDayAppTotals(admin, latest.id, null);

  return NextResponse.json({ cash_day: data as CashDay });
}
