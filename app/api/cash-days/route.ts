import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { hasPermission } from '@/lib/permissions';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import {
  denomsTotalInr,
  sanitizeDenoms,
  expectedCashInr,
  overShortInr,
} from '@/lib/cash/denoms';
import { istBusinessDate, istDayRange } from '@/lib/cash/date';
import type { CashDay } from '@/lib/types';

export const dynamic = 'force-dynamic';

// Cash management: day-open / day-close by denomination (OPS-2, STF-045).
//
// MONEY IS SERVER-AUTHORITATIVE (§5.2): every total (opening float, counted
// drawer, expected cash, over/short) is recomputed here from the raw
// denomination counts and the day's cash orders/refunds — a client-sent total
// is never persisted. Sensitive gates go through hasPermission() (the
// owner-tunable matrix), and only one cash day may be open at a time (enforced
// at the DB by idx_cash_days_one_open and re-checked here for a friendly error).

const CASH_DAY_COLUMNS =
  'id, business_date, status, opened_by, opened_at, opening_denoms, opening_total_inr, closed_by, closed_at, closing_denoms, counted_total_inr, expected_cash_inr, over_short_inr, notes';

const HISTORY_LIMIT = 30;

type Admin = SupabaseClient;

// The two DB-derived cash flows for a business date. Cash SETTLES = orders
// collected in cash that day (paid or partially refunded); cash REFUNDS =
// processed refunds against those same cash orders (drawer cash paid back out).
// Online/UPI-gateway money never enters this math (OPS-2).
async function computeCashFlows(admin: Admin, businessDate: string) {
  const { startIso, endIso } = istDayRange(businessDate);

  // POS4-1: a split settlement stores each part in order_payments, so the cash
  // that actually entered the drawer is the sum of the CASH PARTS — not the
  // order total. Summing totals for payment_method='cash' would count the UPI
  // half of a split as cash and read every drawer short.
  //
  // So we load every settled order for the day (any method, because a split's
  // dominant method may not be cash while a cash part still exists), then prefer
  // its parts. Orders with no parts are pre-POS4-1 and fall back to the old
  // rule: the whole total counts iff the order was settled in cash.
  const { data: settledOrders } = await admin
    .from('orders')
    .select('id, total_inr, payment_method')
    .in('payment_status', ['paid', 'partially_refunded'])
    .gte('created_at', startIso)
    .lt('created_at', endIso);

  const settled = (settledOrders ?? []) as {
    id: string;
    total_inr: number | null;
    payment_method: string | null;
  }[];

  const partsByOrder = new Map<string, number>();
  if (settled.length > 0) {
    const { data: partRows } = await admin
      .from('order_payments')
      .select('order_id, amount_inr, method')
      .in(
        'order_id',
        settled.map((o) => o.id),
      );
    for (const p of (partRows ?? []) as { order_id: string; amount_inr: number; method: string }[]) {
      if (p.method !== 'cash') {
        // Mark the order as "has parts" with no cash, so it isn't double-counted
        // by the legacy fallback below.
        if (!partsByOrder.has(p.order_id)) partsByOrder.set(p.order_id, 0);
        continue;
      }
      partsByOrder.set(p.order_id, (partsByOrder.get(p.order_id) ?? 0) + p.amount_inr);
    }
  }

  // An order counts toward the drawer only if it actually contributed cash:
  // either its parts include a cash amount, or (legacy, no parts) it was settled
  // in cash outright. A split paid entirely by card and UPI has a parts row but
  // no cash, and must not inflate the settle count.
  const orders = settled.filter((o) => {
    const fromParts = partsByOrder.get(o.id);
    if (fromParts !== undefined) return fromParts > 0;
    return o.payment_method === 'cash';
  });
  const cashSettlesInr = orders.reduce(
    (sum, o) => sum + (partsByOrder.get(o.id) ?? o.total_inr ?? 0),
    0,
  );

  // REF-1: only refunds actually paid back IN CASH leave the drawer. A UPI
  // reversal on a split order must not be counted here or the till reads short.
  // Legacy rows (written before REF-1) carry no method; those orders only reach
  // this list because they were cash-settled, so treating them as cash matches
  // the old behaviour exactly.
  let cashRefundsInr = 0;
  const orderIds = orders.map((o) => o.id);
  if (orderIds.length > 0) {
    const { data: refunds } = await admin
      .from('refunds')
      .select('amount_inr, method')
      .eq('status', 'processed')
      .in('order_id', orderIds);
    cashRefundsInr = ((refunds ?? []) as { amount_inr: number | null; method?: string | null }[])
      .filter((r) => !r.method || r.method === 'cash')
      .reduce(
      (sum, r) => sum + (r.amount_inr ?? 0),
      0,
    );
  }

  return { cashSettlesInr, cashRefundsInr, cashSettleCount: orders.length };
}

// GET — the currently OPEN cash day (with its live expected-cash summary) plus
// recent CLOSED history for the summary/over-short trend. Any staff session.
export async function GET() {
  const user = await getStaffUser();
  if (!user) return unauthorized();

  const admin = createAdminSupabaseClient();

  const { data: openRow, error: openError } = await admin
    .from('cash_days')
    .select(CASH_DAY_COLUMNS)
    .eq('status', 'open')
    .maybeSingle();
  if (openError) return errorResponse(500, openError.message);

  const openDay = (openRow as CashDay | null) ?? null;

  // Live summary for the open day so the close form can show expected vs counted
  // before anything is written (the same figures the close recomputes).
  let openSummary: {
    opening_total_inr: number;
    cash_settles_inr: number;
    cash_refunds_inr: number;
    cash_settle_count: number;
    expected_cash_inr: number;
  } | null = null;
  if (openDay) {
    const flows = await computeCashFlows(admin, openDay.business_date);
    openSummary = {
      opening_total_inr: openDay.opening_total_inr,
      cash_settles_inr: flows.cashSettlesInr,
      cash_refunds_inr: flows.cashRefundsInr,
      cash_settle_count: flows.cashSettleCount,
      expected_cash_inr: expectedCashInr(
        openDay.opening_total_inr,
        flows.cashSettlesInr,
        flows.cashRefundsInr,
      ),
    };
  }

  const { data: history, error: historyError } = await admin
    .from('cash_days')
    .select(CASH_DAY_COLUMNS)
    .eq('status', 'closed')
    .order('business_date', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (historyError) return errorResponse(500, historyError.message);

  return NextResponse.json({
    open_day: openDay,
    open_summary: openSummary,
    history: (history as CashDay[] | null) ?? [],
  });
}

// POST — day-open. Enter the opening float as a denomination grid; the total is
// COMPUTED here, never typed. Permission-gated (cash_day_open, default staff).
// Body: { opening_denoms }.
export async function POST(request: Request) {
  const user = await getStaffUser();
  if (!user) return unauthorized();
  if (!(await hasPermission(user, 'cash_day_open'))) {
    return errorResponse(403, 'You do not have permission to open the cash day');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const openingDenoms = sanitizeDenoms(body.opening_denoms);
  const openingTotalInr = denomsTotalInr(openingDenoms); // server-authoritative

  const admin = createAdminSupabaseClient();
  const businessDate = istBusinessDate();

  // Friendly pre-checks (the DB's idx_cash_days_one_open / business_date unique
  // are the real backstop, mapped from 23505 below in case of a race).
  const { data: alreadyOpen } = await admin
    .from('cash_days')
    .select('id')
    .eq('status', 'open')
    .maybeSingle();
  if (alreadyOpen) return errorResponse(409, 'A cash day is already open');

  const { data: todayRow } = await admin
    .from('cash_days')
    .select('id, status')
    .eq('business_date', businessDate)
    .maybeSingle();
  if (todayRow) {
    return errorResponse(409, "Today's cash day has already been recorded");
  }

  const { data, error } = await admin
    .from('cash_days')
    .insert({
      business_date: businessDate,
      status: 'open',
      opened_by: user.id,
      opened_at: new Date().toISOString(),
      opening_denoms: openingDenoms,
      opening_total_inr: openingTotalInr,
    })
    .select(CASH_DAY_COLUMNS)
    .single();

  if (error) {
    // 23505 = unique_violation — either the one-open partial index or the
    // business_date unique. Both mean a day is already open/recorded.
    if (error.code === '23505') return errorResponse(409, 'A cash day is already open');
    return errorResponse(500, error.message);
  }

  return NextResponse.json({ cash_day: data as CashDay });
}

// PATCH — day-close. Count the drawer into the same grid; counted total,
// expected cash, and over/short are all COMPUTED here. Notes are REQUIRED on any
// variance. Permission-gated (cash_day_close, default manager sign-off).
// Body: { closing_denoms, notes }.
//
// A signed (closed) day is IMMUTABLE: this route only ever transitions THE open
// day → closed under a status='open' guard, so a closed day can never be edited
// here. Corrections are a next-day audited adjustment entry (out of v1 scope).
export async function PATCH(request: Request) {
  const user = await getStaffUser();
  if (!user) return unauthorized();
  if (!(await hasPermission(user, 'cash_day_close'))) {
    return errorResponse(403, 'You do not have permission to close the cash day');
  }

  const body = await parseJsonBody(request);
  if (!body) return errorResponse(400, 'Request body must be a JSON object');

  const closingDenoms = sanitizeDenoms(body.closing_denoms);
  const notes = typeof body.notes === 'string' ? body.notes.trim() : '';

  const admin = createAdminSupabaseClient();

  const { data: openRow, error: openError } = await admin
    .from('cash_days')
    .select(CASH_DAY_COLUMNS)
    .eq('status', 'open')
    .maybeSingle();
  if (openError) return errorResponse(500, openError.message);
  const openDay = openRow as CashDay | null;
  if (!openDay) return errorResponse(404, 'No cash day is open to close');

  const countedTotalInr = denomsTotalInr(closingDenoms); // server-authoritative
  const flows = await computeCashFlows(admin, openDay.business_date);
  const expected = expectedCashInr(
    openDay.opening_total_inr,
    flows.cashSettlesInr,
    flows.cashRefundsInr,
  );
  const overShort = overShortInr(countedTotalInr, expected);

  // A variance must be explained before sign-off (OPS-2 AC).
  if (overShort !== 0 && !notes) {
    return errorResponse(
      400,
      'Notes are required to explain a cash over/short before closing',
    );
  }

  // Transition the OPEN day → closed under the status guard. If a concurrent
  // close won the race, zero rows match → 409 (the day is already closed).
  const { data: closed, error: closeError } = await admin
    .from('cash_days')
    .update({
      status: 'closed',
      closed_by: user.id,
      closed_at: new Date().toISOString(),
      closing_denoms: closingDenoms,
      counted_total_inr: countedTotalInr,
      expected_cash_inr: expected,
      over_short_inr: overShort,
      notes,
    })
    .eq('id', openDay.id)
    .eq('status', 'open')
    .select(CASH_DAY_COLUMNS)
    .maybeSingle();

  if (closeError) return errorResponse(500, closeError.message);
  if (!closed) {
    return errorResponse(409, 'This cash day has already been closed');
  }

  return NextResponse.json({
    cash_day: closed as CashDay,
    summary: {
      opening_total_inr: openDay.opening_total_inr,
      cash_settles_inr: flows.cashSettlesInr,
      cash_refunds_inr: flows.cashRefundsInr,
      cash_settle_count: flows.cashSettleCount,
      expected_cash_inr: expected,
      counted_total_inr: countedTotalInr,
      over_short_inr: overShort,
    },
  });
}
