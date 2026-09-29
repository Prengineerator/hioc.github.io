import 'server-only';

// Server-side reads shared by the cash-day routes (GET/POST/PATCH
// /api/cash-days, POST /api/cash-days/reopen, GET /api/cash-days/log). Kept in
// lib/ because a Next route file may only export its HTTP handlers.

import type { SupabaseClient } from '@supabase/supabase-js';
import { cashActivityBetween, type CashSaleEntry } from '@/lib/cash/checkpoints';
import { expectedCashInr } from '@/lib/cash/denoms';
import type { CashDayFlows } from '@/lib/cash/day';
import type { CashDay } from '@/lib/types';

type Admin = SupabaseClient;

export const CASH_DAY_COLUMNS =
  'id, business_date, status, opened_by, opened_at, opening_denoms, opening_total_inr, closed_by, closed_at, closing_denoms, counted_total_inr, expected_cash_inr, over_short_inr, notes, open_expected_total_inr, open_variance_inr, open_reason, close_reason, cash_sales_inr, cash_sales_count, cash_refunds_inr, cash_in_inr, cash_out_inr, upi_inr, card_inr, handover_inr, float_left_denoms, float_left_total_inr, unpaid_count_at_close, unpaid_override_reason, reopened_at, reopened_by, reopen_reason, reopen_log';

// True when the migration (supabase/2026-09-cash-day-handover.sql) hasn't been
// applied: PostgREST reports a missing column as 42703 / PGRST204.
export function isMissingColumn(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42703' || error.code === 'PGRST204') return true;
  const msg = (error.message ?? '').toLowerCase();
  return msg.includes('column') && msg.includes('does not exist');
}

export const MIGRATION_HINT = 'Apply supabase/2026-09-cash-day-handover.sql to use the cash day.';

export interface DayAppTotals {
  swiggy_dineout_inr: number | null;
  zomato_district_inr: number | null;
}

/**
 * Freezes each dining app's takings onto a cash day (null clears them, for a
 * reopen). A separate, best-effort update on purpose: these columns come from
 * 2026-10-aggregator-payments.sql, and a database without it must still be
 * able to close and reopen a day. Always written — zeros included — so a day
 * reopened and closed again never keeps the first close's figures.
 */
export async function writeDayAppTotals(
  admin: Admin,
  dayId: string,
  totals: { swiggyDineoutInr: number; zomatoDistrictInr: number } | null,
): Promise<void> {
  const { error } = await admin
    .from('cash_days')
    .update({
      swiggy_dineout_inr: totals ? totals.swiggyDineoutInr : null,
      zomato_district_inr: totals ? totals.zomatoDistrictInr : null,
    })
    .eq('id', dayId);
  if (error && !isMissingColumn(error)) {
    console.error('cash-days: could not record the dining-app totals', error);
  }
}

/** The frozen dining-app totals for these days; empty when the columns don't exist yet. */
export async function dayAppTotalsFor(admin: Admin, dayIds: string[]): Promise<Map<string, DayAppTotals>> {
  const out = new Map<string, DayAppTotals>();
  if (dayIds.length === 0) return out;
  const { data, error } = await admin
    .from('cash_days')
    .select('id, swiggy_dineout_inr, zomato_district_inr')
    .in('id', dayIds);
  if (error) {
    if (!isMissingColumn(error)) console.error('cash-days: could not read the dining-app totals', error);
    return out;
  }
  for (const r of (data ?? []) as ({ id: string } & DayAppTotals)[]) {
    out.set(r.id, { swiggy_dineout_inr: r.swiggy_dineout_inr, zomato_district_inr: r.zomato_district_inr });
  }
  return out;
}

/**
 * Freezes the day's expense total (categorised cash-outs, already inside
 * cash_out_inr) onto a cash day; null clears it, for a reopen. Separate and
 * best-effort like writeDayAppTotals: cash_days.expenses_inr comes from
 * 2026-10-cash-expenses.sql, and a database without it must still close and
 * reopen a day. Zero is written too, so a re-close never keeps the first one.
 */
export async function writeDayExpenses(admin: Admin, dayId: string, expensesInr: number | null): Promise<void> {
  const { error } = await admin.from('cash_days').update({ expenses_inr: expensesInr }).eq('id', dayId);
  if (error && !isMissingColumn(error)) {
    console.error('cash-days: could not record the day’s expenses', error);
  }
}

/** The frozen expense totals for these days (null = not recorded); empty when the column doesn't exist yet. */
export async function dayExpensesFor(admin: Admin, dayIds: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (dayIds.length === 0) return out;
  const { data, error } = await admin.from('cash_days').select('id, expenses_inr').in('id', dayIds);
  if (error) {
    if (!isMissingColumn(error)) console.error('cash-days: could not read the day expenses', error);
    return out;
  }
  for (const r of (data ?? []) as { id: string; expenses_inr: number | null }[]) {
    out.set(r.id, r.expenses_inr ?? null);
  }
  return out;
}

/** The currently OPEN cash day, or null. */
export async function getOpenDay(admin: Admin): Promise<{ day: CashDay | null; error: { code?: string; message: string } | null }> {
  const { data, error } = await admin.from('cash_days').select(CASH_DAY_COLUMNS).eq('status', 'open').maybeSingle();
  return { day: (data as CashDay | null) ?? null, error };
}

/**
 * The most recent cash day of any status, by when it was opened. business_date
 * is no longer unique (a reopen or a second session can share a date), so
 * "latest" is opened_at, not the date.
 */
export async function getLatestDay(admin: Admin): Promise<{ day: CashDay | null; error: { code?: string; message: string } | null }> {
  const { data, error } = await admin
    .from('cash_days')
    .select(CASH_DAY_COLUMNS)
    .order('opened_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  return { day: (data as CashDay | null) ?? null, error };
}

/** The float a closed day left for the next open, or null when it recorded none (legacy day / never closed). */
export function floatLeftOf(day: CashDay | null): { denoms: NonNullable<CashDay['float_left_denoms']>; totalInr: number } | null {
  if (!day || day.status !== 'closed') return null;
  if (day.float_left_total_inr === null || day.float_left_total_inr === undefined) return null;
  return { denoms: day.float_left_denoms ?? {}, totalInr: day.float_left_total_inr };
}

export interface DayActivity {
  flows: CashDayFlows;
  cashSales: CashSaleEntry[];
  upiInr: number;
  cardInr: number;
  onlineInr: number;
  swiggyDineoutInr: number;
  zomatoDistrictInr: number;
  /** Categorised expenses in the window — already inside flows.cashOutInr. */
  expensesInr: number;
  expectedInr: number;
}

/**
 * Everything that moved through the drawer for a day over [opened_at, toIso]:
 * the SAME windowing as the checkpoint chain (cashFlowsBetween — by when each
 * payment was taken, order_payments.created_at / orders.paid_at / refund
 * processed_at), not by orders.created_at. An order placed at 11 pm and paid at
 * 12:10 am is a sale of the day it was paid in, and the café runs past midnight.
 */
export async function dayActivity(
  admin: Admin,
  openingTotalInr: number,
  openedAtIso: string,
  toIso: string,
): Promise<DayActivity> {
  const activity = await cashActivityBetween(admin, openedAtIso, toIso);
  const flows: CashDayFlows = {
    cashSalesInr: activity.flows.cashSettledInr,
    cashRefundsInr: activity.flows.cashRefundedInr,
    cashInInr: activity.flows.cashInInr,
    cashOutInr: activity.flows.cashOutInr,
  };
  return {
    flows,
    cashSales: activity.cashSales,
    upiInr: activity.upiInr,
    cardInr: activity.cardInr,
    onlineInr: activity.onlineInr,
    swiggyDineoutInr: activity.swiggyDineoutInr,
    zomatoDistrictInr: activity.zomatoDistrictInr,
    expensesInr: activity.expensesInr,
    expectedInr: expectedCashInr(
      openingTotalInr,
      flows.cashSalesInr,
      flows.cashRefundsInr,
      flows.cashInInr,
      flows.cashOutInr,
    ),
  };
}

export interface UnpaidOrder {
  id: string;
  order_number: number;
  total_inr: number;
  created_at: string;
}

// Statuses an order can be in while still live. Cancelled / rejected orders are
// never going to be paid, so they never block a close.
const LIVE_ORDER_STATUSES = ['placed', 'received', 'accepted', 'preparing', 'ready', 'completed'];

/** Unpaid, not cancelled/rejected orders created since the day opened. */
export async function unpaidOrdersSince(admin: Admin, openedAtIso: string): Promise<UnpaidOrder[]> {
  const { data, error } = await admin
    .from('orders')
    .select('id, order_number, total_inr, created_at')
    .eq('payment_status', 'unpaid')
    .in('status', LIVE_ORDER_STATUSES)
    .gte('created_at', openedAtIso)
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) throw new Error(`unpaidOrdersSince: orders query failed: ${error.message}`);
  return (data ?? []) as UnpaidOrder[];
}
