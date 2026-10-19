import 'server-only';

// Reads the rows behind the cash and expense downloads (Owner → Reports →
// Downloads) and resolves staff names. The sheets are the pure builders in
// cashReports.ts. The payment-mode sheet reuses the reconciliation report's
// loader (reconcileServer.ts), so its money rules are the same ones.

import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError, type PostgrestLikeError } from '@/lib/api/postgrest';
import { APP_PAYMENT_METHODS } from '@/lib/orders/payments';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { ReportDef } from '@/lib/reports/exports/types';
import { rangeBounds, type CashDayRow } from '@/lib/reports/reconcile';
import { fetchAll, IN_CHUNK, loadReport, withColumnTiers, type PageResult } from '@/lib/reports/reconcileServer';
import {
  appPayments,
  cashRegister,
  expenseByCategory,
  expenseRegister,
  paymentModes,
  type AppPaymentRecord,
  type CashDayRecord,
  type ExpenseRecord,
} from '@/lib/reports/exports/cashReports';

// cash_days columns: the base from the handover migration, then each later
// migration's columns. withColumnTiers steps down one tier at a time.
const CASH_DAY_CORE =
  'id, business_date, status, opened_by, opened_at, closed_by, closed_at, opening_total_inr, cash_sales_inr, cash_sales_count, cash_refunds_inr, cash_in_inr, cash_out_inr, expected_cash_inr, counted_total_inr, over_short_inr, handover_inr, float_left_total_inr, close_reason, notes, upi_inr, card_inr';
const CASH_DAY_TIERS = [
  `${CASH_DAY_CORE}, expenses_inr, auto_ended_at, swiggy_dineout_inr, zomato_district_inr`,
  `${CASH_DAY_CORE}, expenses_inr, auto_ended_at`,
  `${CASH_DAY_CORE}, expenses_inr`,
  CASH_DAY_CORE,
];

type CashDayDbRow = Omit<CashDayRecord, 'opened_by_name' | 'closed_by_name'> & {
  opened_by: string | null;
  closed_by: string | null;
};

interface MovementDbRow {
  id: string;
  amount_inr: number;
  reason: string | null;
  category: string;
  recorded_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  voided_at: string | null;
}

interface TenderDbRow {
  order_id: string;
  method: string;
  amount_inr: number;
  reference?: string | null;
  created_by: string | null;
  created_at: string;
}

interface OrderDbRow {
  id: string;
  order_number: number;
  status: string;
  payment_status: string;
  payment_method?: string | null;
  total_inr: number | null;
  subtotal_inr: number | null;
  paid_at?: string | null;
}

function isMissingRelation(err: unknown): boolean {
  const e = err as PostgrestLikeError | undefined;
  return e?.code === '42P01' || e?.code === 'PGRST205' || /does not exist|could not find the table/i.test(e?.message ?? '');
}

/** Maps user ids to display names (blank for no id). */
async function namesFor(
  admin: SupabaseClient,
  ids: (string | null | undefined)[],
): Promise<(id: string | null | undefined) => string> {
  const names = await getStaffDisplayNames(admin, ids.filter((v): v is string => !!v));
  return (id) => (id ? (names.get(id) ?? 'Unknown staff') : '');
}

async function loadCashDays(admin: SupabaseClient, from: string, to: string): Promise<CashDayRecord[]> {
  const rows = await withColumnTiers<CashDayDbRow>(CASH_DAY_TIERS, (cols) =>
    fetchAll<CashDayDbRow>((a, b) =>
      admin
        .from('cash_days')
        .select(cols)
        .gte('business_date', from)
        .lte('business_date', to)
        .order('opened_at')
        .range(a, b) as unknown as PromiseLike<PageResult<CashDayDbRow>>,
    ),
  );
  const nameOf = await namesFor(admin, rows.flatMap((r) => [r.opened_by, r.closed_by]));
  return rows.map((r) => ({ ...r, opened_by_name: nameOf(r.opened_by), closed_by_name: nameOf(r.closed_by) }));
}

/** Expenses in the range: cash outs with a category, voided ones included (the sheets decide what counts). */
async function loadExpenses(admin: SupabaseClient, from: string, to: string): Promise<ExpenseRecord[]> {
  const { startIso, endIso } = rangeBounds(from, to);
  const rows = await fetchAll<MovementDbRow>((a, b) =>
    admin
      .from('cash_movements')
      .select('id, amount_inr, reason, category, recorded_by, created_at, approved_by, approved_at, voided_at')
      .eq('direction', 'out')
      .not('category', 'is', null)
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .order('created_at')
      .range(a, b) as unknown as PromiseLike<PageResult<MovementDbRow>>,
  ).catch((err: unknown) => {
    // Before supabase/2026-10-cash-expenses.sql there are no categories, so no expenses.
    if (isMissingColumnError(err as PostgrestLikeError) || isMissingRelation(err)) return [] as MovementDbRow[];
    throw err;
  });
  const nameOf = await namesFor(admin, rows.flatMap((r) => [r.recorded_by, r.approved_by]));
  return rows.map((r) => ({
    id: r.id,
    created_at: r.created_at,
    category: r.category,
    amount_inr: r.amount_inr,
    reason: r.reason,
    recorded_by_name: nameOf(r.recorded_by),
    approved_by_name: nameOf(r.approved_by),
    approved_at: r.approved_at,
    voided_at: r.voided_at,
  }));
}

async function ordersById(admin: SupabaseClient, ids: string[]): Promise<Map<string, OrderDbRow>> {
  const out = new Map<string, OrderDbRow>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await admin
      .from('orders')
      .select('id, order_number, status, payment_status')
      .in('id', ids.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`cash report: order lookup failed: ${error.message}`);
    for (const o of (data ?? []) as OrderDbRow[]) out.set(o.id, o);
  }
  return out;
}

/** The orders, among these, that have a dining-app tender row. */
async function ordersWithAppTender(admin: SupabaseClient, ids: string[], methods: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await admin
      .from('order_payments')
      .select('order_id')
      .in('method', methods)
      .in('order_id', ids.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`cash report: app tender check failed: ${error.message}`);
    for (const r of (data ?? []) as { order_id: string }[]) out.add(r.order_id);
  }
  return out;
}

/**
 * Every dining-app payment taken in the range. A split part and a single-method
 * settle both leave a tender row in order_payments (what getAppPayments on the
 * Payments page reads). A bill paid through an app with no tender row at all
 * (its insert failed, and was logged) is found by its paid time and listed
 * with the bill's total and no booking ID.
 */
async function loadAppPayments(admin: SupabaseClient, from: string, to: string): Promise<AppPaymentRecord[]> {
  const { startIso, endIso } = rangeBounds(from, to);
  const methods = [...APP_PAYMENT_METHODS];
  try {
    const tenders = await withColumnTiers<TenderDbRow>(
      [
        'order_id, method, amount_inr, reference, created_by, created_at',
        // reference arrived with 2026-10-aggregator-payments.sql.
        'order_id, method, amount_inr, created_by, created_at',
      ],
      (cols) =>
        fetchAll<TenderDbRow>((a, b) =>
          admin
            .from('order_payments')
            .select(cols)
            .in('method', methods)
            .gte('created_at', startIso)
            .lt('created_at', endIso)
            .order('created_at')
            .range(a, b) as unknown as PromiseLike<PageResult<TenderDbRow>>,
        ),
    );
    const tenderOrders = await ordersById(admin, [...new Set(tenders.map((t) => t.order_id))]);

    const paid = await fetchAll<OrderDbRow>((a, b) =>
      admin
        .from('orders')
        .select('id, order_number, status, payment_status, payment_method, total_inr, subtotal_inr, paid_at')
        .in('payment_method', methods)
        .gte('paid_at', startIso)
        .lt('paid_at', endIso)
        .order('paid_at')
        .range(a, b) as unknown as PromiseLike<PageResult<OrderDbRow>>,
    );
    const tendered = await ordersWithAppTender(
      admin,
      paid.map((o) => o.id),
      methods,
    );
    const bills = paid.filter((o) => !tendered.has(o.id));

    const nameOf = await namesFor(admin, tenders.map((t) => t.created_by));
    const fromTenders: AppPaymentRecord[] = tenders.map((t) => {
      const o = tenderOrders.get(t.order_id);
      return {
        method: t.method,
        amount_inr: t.amount_inr,
        reference: t.reference ?? null,
        created_at: t.created_at,
        invoice_no: o ? formatOrderNumber(o.order_number) : '',
        order_status: o?.status ?? null,
        payment_status: o?.payment_status ?? null,
        recorded_by_name: nameOf(t.created_by),
      };
    });
    const fromBills: AppPaymentRecord[] = bills.map((o) => ({
      method: o.payment_method ?? '',
      amount_inr: o.total_inr ?? o.subtotal_inr ?? 0,
      reference: null,
      created_at: o.paid_at ?? '',
      invoice_no: formatOrderNumber(o.order_number),
      order_status: o.status,
      payment_status: o.payment_status,
      recorded_by_name: '',
    }));
    return [...fromTenders, ...fromBills];
  } catch (err) {
    // Before 2026-10-aggregator-payments.sql the app methods do not exist, so
    // there are no app payments to list.
    const code = (err as { code?: string } | undefined)?.code;
    if (isMissingColumnError(err as PostgrestLikeError) || isMissingRelation(err) || code === '22P02') return [];
    throw err;
  }
}

export const CASH_REPORTS: ReportDef[] = [
  {
    key: 'cash-days',
    group: 'cash',
    title: 'Cash drawer register',
    description:
      'One row per cash day: the float, cash sales and refunds, cash in and out, expenses, the handover to the owner, and the count and over/short as frozen when the day closed.',
    load: async (admin, from, to) => cashRegister(await loadCashDays(admin, from, to)),
  },
  {
    key: 'expenses',
    group: 'cash',
    title: 'Expense register',
    description:
      'Every expense paid from the cash drawer in the period, with its category, who recorded it, and whether it was approved or voided.',
    load: async (admin, from, to) => expenseRegister(await loadExpenses(admin, from, to)),
  },
  {
    key: 'expense-categories',
    group: 'cash',
    title: 'Expenses by category',
    description:
      'Expenses added up by category for the period, voided entries left out, with each category’s share of the total.',
    load: async (admin, from, to) => expenseByCategory(await loadExpenses(admin, from, to)),
  },
  {
    key: 'app-payments',
    group: 'cash',
    title: 'Swiggy Dineout / Zomato District payments',
    description:
      'Every Swiggy Dineout and Zomato District payment taken in the period, with its booking ID, to match against each platform’s payout statement.',
    load: async (admin, from, to) => appPayments(await loadAppPayments(admin, from, to)),
  },
  {
    key: 'payment-modes',
    group: 'cash',
    title: 'Collections by payment mode',
    description:
      'Money received each day by payment method, with refunds, net received and tips. Counted on the day the money was received.',
    load: async (admin, from, to) => paymentModes(await loadReport(admin, from, to)),
  },
];
