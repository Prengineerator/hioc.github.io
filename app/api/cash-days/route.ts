import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getCounterActor } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { denomsTotalInr, sanitizeDenoms } from '@/lib/cash/denoms';
import { istBusinessDate } from '@/lib/cash/date';
import { evaluateClose, evaluateOpen } from '@/lib/cash/day';
import { recordCount } from '@/lib/cash/checkpoints';
import {
  CASH_DAY_COLUMNS,
  MIGRATION_HINT,
  dayActivity,
  floatLeftOf,
  getLatestDay,
  getOpenDay,
  isMissingColumn,
  unpaidOrdersSince,
  writeDayAppTotals,
  writeDayExpenses,
} from '@/lib/cash/dayServer';
import type { CashDay } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Cash day: Open → Close → Handover (OPS-2, STF-045; reworked 2026-09-29).
//
// MONEY IS SERVER-AUTHORITATIVE (§5.2): every total (opening float, counted
// drawer, expected cash, over/short, cash taken out, float left) is recomputed
// here from the raw denomination counts and the day's payments — a client-sent
// total is never persisted. Sensitive gates go through hasPermission() (the
// owner-tunable matrix), and only one cash day may be open at a time (enforced
// at the DB by idx_cash_days_one_open and re-checked here for a friendly error).
//
// THE DAY IS A TIME WINDOW, not a calendar date: cash sales, refunds and
// cash in/out are everything taken in [opened_at, closing time] by the time
// the money moved (lib/cash/checkpoints.ts cashFlowsBetween). The café opens
// mid-afternoon and runs past midnight, so windowing by the IST date orders
// were created on split one trading day across two and matched neither.

const HISTORY_LIMIT = 30;

const isManagerRole = (role: string) => role === 'manager' || role === 'owner';

// GET — the currently OPEN cash day (with its live figures), what the last
// close left in the drawer (for the open form's Match column), whether a
// mistaken close can be reopened, plus recent CLOSED history. Any staff session.
//
// PIN-3: gated by getCounterActor() — classic session first, unchanged; an
// enrolled-device PIN operator only when there is no session at all.
export async function GET() {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();

  const admin = createAdminSupabaseClient();

  const { day: openDay, error: openError } = await getOpenDay(admin);
  if (openError) {
    return errorResponse(500, isMissingColumn(openError) ? MIGRATION_HINT : openError.message);
  }

  let openSummary: Record<string, unknown> | null = null;
  let cashSales: { order_id: string; order_number: number | null; at: string; amount_inr: number }[] = [];
  let unpaid: { count: number; orders: { id: string; order_number: number; total_inr: number; created_at: string }[] } = {
    count: 0,
    orders: [],
  };
  if (openDay) {
    try {
      const nowIso = new Date().toISOString();
      const activity = await dayActivity(admin, openDay.opening_total_inr, openDay.opened_at, nowIso);
      openSummary = {
        opening_total_inr: openDay.opening_total_inr,
        cash_sales_inr: activity.flows.cashSalesInr,
        cash_sales_count: activity.cashSales.length,
        cash_refunds_inr: activity.flows.cashRefundsInr,
        cash_in_inr: activity.flows.cashInInr,
        cash_out_inr: activity.flows.cashOutInr,
        // Of cash_out_inr, what staff punched as categorised expenses.
        expenses_inr: activity.expensesInr,
        upi_inr: activity.upiInr,
        card_inr: activity.cardInr,
        online_inr: activity.onlineInr,
        swiggy_dineout_inr: activity.swiggyDineoutInr,
        zomato_district_inr: activity.zomatoDistrictInr,
        expected_cash_inr: activity.expectedInr,
        as_of: nowIso,
      };
      cashSales = activity.cashSales.map((s) => ({
        order_id: s.orderId,
        order_number: s.orderNumber,
        at: s.at,
        amount_inr: s.amountInr,
      }));
      const unpaidOrders = await unpaidOrdersSince(admin, openDay.opened_at);
      unpaid = { count: unpaidOrders.length, orders: unpaidOrders.slice(0, 20) };
    } catch (err) {
      console.error('GET /api/cash-days: could not build the open-day summary', err);
      return errorResponse(500, 'Could not load the day’s cash figures.');
    }
  }

  const { day: latest } = await getLatestDay(admin);
  const manager = isManagerRole(actor.role);
  const lastClosed = latest && latest.status === 'closed' ? latest : null;
  const floatLeft = floatLeftOf(lastClosed);

  const { data: history, error: historyError } = await admin
    .from('cash_days')
    .select(CASH_DAY_COLUMNS)
    .eq('status', 'closed')
    .order('opened_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (historyError) return errorResponse(500, historyError.message);

  return NextResponse.json({
    open_day: openDay,
    open_summary: openSummary,
    cash_sales: cashSales,
    unpaid,
    // What the last close left in the drawer — the open form compares against it.
    float_left: floatLeft
      ? {
          denoms: floatLeft.denoms,
          total_inr: floatLeft.totalInr,
          business_date: lastClosed?.business_date ?? null,
          closed_at: lastClosed?.closed_at ?? null,
        }
      : null,
    // A mistaken close can be undone only for the most recent day, only when no
    // day is open (so no newer day exists), and only by a manager/owner.
    reopenable_day:
      !openDay && manager && lastClosed
        ? { id: lastClosed.id, business_date: lastClosed.business_date, closed_at: lastClosed.closed_at }
        : null,
    can_override_unpaid: manager,
    history: (history as CashDay[] | null) ?? [],
  });
}

// POST — day-open. Count the float into the denomination grid; the total is
// COMPUTED here, never typed, and compared with the float left at the last
// close: any difference needs a reason (stored). Permission-gated
// (cash_day_open, default staff).
// Body: { opening_denoms, open_reason? }.
//
// PIN-3: gated by getCounterActor(); roleHint = actor.role so hasPermission()
// doesn't try to re-derive the role via a session a device operator has none
// of (see lib/permissions.ts's own note).
export async function POST(request: Request) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  const user = actor.user;
  if (!(await hasPermission(user, 'cash_day_open', actor.role))) {
    return errorResponse(403, 'You do not have permission to open the cash day');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const openingDenoms = sanitizeDenoms(body.opening_denoms);
  const openingTotalInr = denomsTotalInr(openingDenoms); // server-authoritative
  const openReason = typeof body.open_reason === 'string' ? body.open_reason.trim() : '';

  const admin = createAdminSupabaseClient();

  // Friendly pre-check (the DB's idx_cash_days_one_open is the real backstop,
  // mapped from 23505 below in case of a race).
  const { day: alreadyOpen, error: openError } = await getOpenDay(admin);
  if (openError) return errorResponse(500, isMissingColumn(openError) ? MIGRATION_HINT : openError.message);
  if (alreadyOpen) return errorResponse(409, 'A cash day is already open');

  // Tomorrow's open compares against the float the last close left. A day
  // closed before the handover feature (or none at all) left nothing to
  // compare with, and then no reason is needed.
  const { day: latest } = await getLatestDay(admin);
  const previousFloat = floatLeftOf(latest);
  const evaluation = evaluateOpen({
    countedInr: openingTotalInr,
    floatLeftInr: previousFloat?.totalInr ?? null,
    reason: openReason,
  });
  if (evaluation.problem) return errorResponse(400, evaluation.problem);

  // opened_at is left to the column default (DB time): the day's window starts
  // on the same clock that stamps paid_at / order_payments.created_at.
  const { data, error } = await admin
    .from('cash_days')
    .insert({
      business_date: istBusinessDate(),
      status: 'open',
      opened_by: user.id,
      opening_denoms: openingDenoms,
      opening_total_inr: openingTotalInr,
      open_expected_total_inr: evaluation.expectedFloatInr,
      open_variance_inr: evaluation.differenceInr,
      open_reason: evaluation.differenceInr ? openReason : '',
    })
    .select(CASH_DAY_COLUMNS)
    .single();

  if (error) {
    // 23505 = unique_violation — the one-open partial index: a day is already open.
    if (error.code === '23505') return errorResponse(409, 'A cash day is already open');
    return errorResponse(500, isMissingColumn(error) ? MIGRATION_HINT : error.message);
  }

  // CC-2: also record this as a checkpoint on the drawer's continuous chain, so
  // clock-in/out counts have something to compare against. Additive and
  // best-effort — a failure here must never change this route's response.
  try {
    await recordCount(admin, {
      kind: 'day_open',
      userId: user.id,
      denoms: openingDenoms,
      cashDayId: (data as CashDay).id,
    });
  } catch (err) {
    console.error('cash-days: failed to record the day_open checkpoint (CC-2)', err);
  }

  return NextResponse.json({ cash_day: data as CashDay });
}

// PATCH — day-close + handover. Count the drawer into the grid, then split it
// into "float left for tomorrow" (by denomination) and "cash taken out"
// (COMPUTED as counted − float left). Counted total, expected cash, over/short
// and the handover are all computed here. Rules (lib/cash/day.ts evaluateClose):
//  - a variance needs a reason;
//  - counted ₹0 while cash is expected needs an explicit confirm_zero_count;
//  - unpaid orders created since opening block the close, unless a
//    manager/owner overrides with a reason;
//  - float left can't exceed the count, per denomination.
// Permission-gated (cash_day_close, default manager sign-off).
// Body: { closing_denoms, float_left_denoms, close_reason?, notes?,
//         confirm_zero_count?, unpaid_override_reason? }.
//
// A signed (closed) day only changes through the audited reopen route
// (POST /api/cash-days/reopen); this route only ever transitions THE open day
// → closed under a status='open' guard.
export async function PATCH(request: Request) {
  const actor = await getCounterActor();
  if (!actor) return unauthorized();
  const user = actor.user;
  if (!(await hasPermission(user, 'cash_day_close', actor.role))) {
    return errorResponse(403, 'You do not have permission to close the cash day');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  if (!body.float_left_denoms || typeof body.float_left_denoms !== 'object') {
    return errorResponse(400, 'Enter the float left for tomorrow by denomination (all zeros if none).');
  }
  const closingDenoms = sanitizeDenoms(body.closing_denoms);
  const floatLeftDenoms = sanitizeDenoms(body.float_left_denoms);
  const closeReason = typeof body.close_reason === 'string' ? body.close_reason.trim() : '';
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';
  const unpaidOverrideReason =
    typeof body.unpaid_override_reason === 'string' ? body.unpaid_override_reason.trim() : '';

  const admin = createAdminSupabaseClient();

  const { day: openDay, error: openError } = await getOpenDay(admin);
  if (openError) return errorResponse(500, isMissingColumn(openError) ? MIGRATION_HINT : openError.message);
  if (!openDay) return errorResponse(404, 'No cash day is open to close');

  // The window ends now: everything taken up to this instant is in the day, and
  // the handover cash-out written below lands AFTER it, so it never counts
  // against this day's own expected cash.
  const closedAtIso = new Date().toISOString();
  let activity;
  let unpaidCount: number;
  try {
    activity = await dayActivity(admin, openDay.opening_total_inr, openDay.opened_at, closedAtIso);
    unpaidCount = (await unpaidOrdersSince(admin, openDay.opened_at)).length;
  } catch (err) {
    console.error('PATCH /api/cash-days: could not compute the day’s figures', err);
    return errorResponse(500, 'Could not compute the day’s cash figures — nothing was closed.');
  }

  const evaluation = evaluateClose({
    openingTotalInr: openDay.opening_total_inr,
    flows: activity.flows,
    closingDenoms,
    floatLeftDenoms,
    closeReason,
    confirmZeroCount: body.confirm_zero_count === true,
    unpaidCount,
    isManager: isManagerRole(actor.role),
    unpaidOverrideReason,
  });
  const problem = evaluation.problems[0];
  if (problem) {
    const status =
      problem.code === 'UNPAID_OVERRIDE_FORBIDDEN' ? 403 : problem.code === 'UNPAID_ORDERS' ? 409 : 400;
    return NextResponse.json(
      {
        error: problem.message,
        code: problem.code,
        problems: evaluation.problems,
        unpaid_count: unpaidCount,
      },
      { status },
    );
  }

  const { data: closed, error: closeError } = await admin
    .from('cash_days')
    .update({
      status: 'closed',
      closed_by: user.id,
      closed_at: closedAtIso,
      closing_denoms: closingDenoms,
      counted_total_inr: evaluation.countedInr,
      expected_cash_inr: evaluation.expectedInr,
      over_short_inr: evaluation.varianceInr,
      notes,
      close_reason: closeReason,
      cash_sales_inr: activity.flows.cashSalesInr,
      cash_sales_count: activity.cashSales.length,
      cash_refunds_inr: activity.flows.cashRefundsInr,
      cash_in_inr: activity.flows.cashInInr,
      cash_out_inr: activity.flows.cashOutInr,
      upi_inr: activity.upiInr,
      card_inr: activity.cardInr,
      handover_inr: evaluation.takenOutInr,
      float_left_denoms: floatLeftDenoms,
      float_left_total_inr: evaluation.floatLeftInr,
      unpaid_count_at_close: unpaidCount,
      unpaid_override_reason: evaluation.overridden ? unpaidOverrideReason : null,
    })
    .eq('id', openDay.id)
    .eq('status', 'open')
    .select(CASH_DAY_COLUMNS)
    .maybeSingle();

  if (closeError) return errorResponse(500, isMissingColumn(closeError) ? MIGRATION_HINT : closeError.message);
  if (!closed) {
    // A concurrent close won the race: zero rows matched the status guard.
    return errorResponse(409, 'This cash day has already been closed');
  }
  const closedDay = closed as CashDay;

  // Dining-app takings sit next to UPI/card in the day's record. Best-effort
  // and separate — see writeDayAppTotals.
  await writeDayAppTotals(admin, closedDay.id, activity);
  // Same for the expense total (cash_days.expenses_inr, 2026-10-cash-expenses.sql).
  await writeDayExpenses(admin, closedDay.id, activity.expensesInr);

  // CC-2: same continuity as day-open — the FULL counted drawer (before the
  // handover) is a checkpoint on the chain. Additive/best-effort.
  try {
    await recordCount(admin, {
      kind: 'day_close',
      userId: user.id,
      denoms: closingDenoms,
      cashDayId: closedDay.id,
    });
  } catch (err) {
    console.error('cash-days: failed to record the day_close checkpoint (CC-2)', err);
  }

  // CHAIN CONSISTENCY ACROSS THE HANDOVER. The checkpoint above says "the drawer
  // held ₹counted at this instant"; the next count (a clock-in, a manual count,
  // tomorrow's day-open) chains off it: expected = that count + cash settled −
  // refunded − cash out + cash in since. The cash taken to the owner/bank is
  // physically gone by then, so without a record of it the next count would read
  // it as a shortage and charge it to whoever counted next — the ₹10,829-vs-₹920
  // drift seen in production. So the handover is written as an ordinary cash
  // movement 'out' AFTER the checkpoint (created_at strictly later, so it falls
  // in the NEXT window and never in this day's own — this day's cash_out was
  // frozen above at the close instant). The chain then needs no special case:
  // tomorrow's open expects exactly counted − handover = the float left.
  let handoverWarning: string | null = null;
  if (evaluation.takenOutInr > 0) {
    const { error: moveError } = await admin.from('cash_movements').insert({
      direction: 'out',
      amount_inr: evaluation.takenOutInr,
      reason: `Day close handover (${closedDay.business_date}): cash taken out to owner/bank`,
      recorded_by: user.id,
    });
    if (moveError) {
      console.error('cash-days: failed to record the handover cash-out', moveError);
      handoverWarning = `The day is closed, but the ₹${evaluation.takenOutInr} handover could not be recorded as a cash-out. A manager should record it under Cash out, or the next count will read short.`;
    }
  }

  return NextResponse.json({
    cash_day: closedDay,
    summary: {
      opening_total_inr: openDay.opening_total_inr,
      cash_sales_inr: activity.flows.cashSalesInr,
      cash_sales_count: activity.cashSales.length,
      cash_refunds_inr: activity.flows.cashRefundsInr,
      cash_in_inr: activity.flows.cashInInr,
      cash_out_inr: activity.flows.cashOutInr,
      expenses_inr: activity.expensesInr,
      expected_cash_inr: evaluation.expectedInr,
      counted_total_inr: evaluation.countedInr,
      over_short_inr: evaluation.varianceInr,
      handover_inr: evaluation.takenOutInr,
      float_left_total_inr: evaluation.floatLeftInr,
    },
    handover_warning: handoverWarning,
  });
}
