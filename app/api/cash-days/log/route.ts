import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { errorResponse } from '@/lib/api/http';
import { requireCashManager } from '@/lib/cash/gate';
import { CASH_DAY_COLUMNS, MIGRATION_HINT, dayActivity, dayAppTotalsFor, dayExpensesFor, isMissingColumn } from '@/lib/cash/dayServer';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import type { CashDay } from '@/lib/types';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 45;
const MAX_LIMIT = 120;

// GET /api/cash-days/log?limit= — manager/owner only. Every cash day, newest
// first, for the owner's Cash page: who opened/closed, the float (and the open
// difference + reason), the day's flows, expected vs counted (+ reason), the
// handover, and the reopen events, with staff names resolved.
//
// A CLOSED day carries the figures frozen at its close. The OPEN day has none
// yet, so its flows are computed live here (same windowing as the day itself)
// and marked `live: true`.
export async function GET(request: Request) {
  const gate = await requireCashManager('Only a manager or the owner can view the cash day log.');
  if (gate.denied) return gate.denied;

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get('limit'));
  const limit =
    Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAX_LIMIT) : DEFAULT_LIMIT;

  const admin = createAdminSupabaseClient();
  const { data, error } = await admin
    .from('cash_days')
    .select(CASH_DAY_COLUMNS)
    .order('opened_at', { ascending: false })
    .limit(limit);
  if (error) return errorResponse(500, isMissingColumn(error) ? MIGRATION_HINT : error.message);

  const rows = (data ?? []) as CashDay[];
  const ids = rows.flatMap((d) => [
    d.opened_by,
    d.closed_by,
    d.reopened_by,
    ...(Array.isArray(d.reopen_log) ? d.reopen_log.map((e) => e.by) : []),
  ]).filter((v): v is string => !!v);
  const names = await getStaffDisplayNames(admin, ids);
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? 'Unknown staff') : null);

  const appTotals = await dayAppTotalsFor(
    admin,
    rows.filter((d) => d.status === 'closed').map((d) => d.id),
  );

  // Frozen expense totals of the closed days (null when unknown / column missing).
  const expenses = await dayExpensesFor(
    admin,
    rows.filter((d) => d.status === 'closed').map((d) => d.id),
  );

  const days = await Promise.all(
    rows.map(async (d) => {
      let live: {
        cash_sales_inr: number;
        cash_sales_count: number;
        cash_refunds_inr: number;
        cash_in_inr: number;
        cash_out_inr: number;
        expenses_inr: number;
        upi_inr: number;
        card_inr: number;
        swiggy_dineout_inr: number;
        zomato_district_inr: number;
        expected_cash_inr: number;
      } | null = null;
      if (d.status === 'open') {
        try {
          const a = await dayActivity(admin, d.opening_total_inr, d.opened_at, new Date().toISOString());
          live = {
            cash_sales_inr: a.flows.cashSalesInr,
            cash_sales_count: a.cashSales.length,
            cash_refunds_inr: a.flows.cashRefundsInr,
            cash_in_inr: a.flows.cashInInr,
            cash_out_inr: a.flows.cashOutInr,
            expenses_inr: a.expensesInr,
            upi_inr: a.upiInr,
            card_inr: a.cardInr,
            swiggy_dineout_inr: a.swiggyDineoutInr,
            zomato_district_inr: a.zomatoDistrictInr,
            expected_cash_inr: a.expectedInr,
          };
        } catch (err) {
          console.error('GET /api/cash-days/log: live figures failed for the open day', err);
        }
      }
      return {
        ...d,
        ...(appTotals.get(d.id) ?? {}),
        expenses_inr: expenses.get(d.id) ?? null,
        ...(live ?? {}),
        live: live !== null,
        opened_by_name: nameOf(d.opened_by),
        closed_by_name: nameOf(d.closed_by),
        reopened_by_name: nameOf(d.reopened_by),
        reopen_log: (Array.isArray(d.reopen_log) ? d.reopen_log : []).map((e) => ({
          ...e,
          by_name: nameOf(e.by),
        })),
      };
    }),
  );

  return NextResponse.json({ days });
}
