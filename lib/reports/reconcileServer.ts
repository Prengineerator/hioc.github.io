// Fetches the rows for a reconciliation report (lib/reports/reconcile.ts) —
// the same tables and rules the cash day uses (lib/cash/checkpoints.ts
// cashActivityBetween), over a whole range at once and paged past PostgREST's
// 1,000-row cap.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isMissingColumnError } from '@/lib/api/postgrest';
import {
  buildReport,
  rangeBounds,
  type CashDayRow,
  type CashMovementRow,
  type PaidOrderRow,
  type PassLineRow,
  type PaymentPartRow,
  type RefundRow,
  type Report,
  type SaleOrderRow,
} from '@/lib/reports/reconcile';

const PAGE = 1000;
const IN_CHUNK = 200;

export type PageResult<T> = { data: T[] | null; error: { code?: string; message?: string } | null };

/** Runs `page(from, to)` until a short page comes back. */
export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<PageResult<T>>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw Object.assign(new Error(error.message ?? 'query failed'), { code: error.code });
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

function isMissingRelation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '42P01' || e?.code === 'PGRST205' || /does not exist|could not find the table/i.test(e?.message ?? '');
}

const SALE_COLUMNS = 'id, created_at, status, payment_status, total_inr, subtotal_inr, tax_inr, discount_inr';
// HIOC Ritual (2026-10-coffee-pass.sql): what kind of order it is and what pass
// cups covered on it. Read only where the migration has been applied.
const SALE_PASS_COLUMNS = 'order_kind, pass_discount_inr';
const PAID_COLUMNS = 'id, payment_method, total_inr, subtotal_inr, paid_at';
// Everything a close freezes onto its cash day (2026-09-cash-day-handover.sql),
// including the closing count by denomination and the handover.
const CASH_DAY_COLUMNS =
  'id, business_date, status, opened_at, closed_at, opening_total_inr, cash_sales_inr, cash_sales_count, cash_refunds_inr, cash_in_inr, cash_out_inr, expected_cash_inr, counted_total_inr, over_short_inr, closing_denoms, handover_inr, float_left_total_inr, float_left_denoms, close_reason, notes';

export async function loadReport(admin: SupabaseClient, from: string, to: string): Promise<Report> {
  const { startIso, endIso } = rangeBounds(from, to);

  // Settle discounts and tips arrived with a later migration; read without
  // them on a database that doesn't have them yet.
  const withOptional = async <T>(base: string, extra: string, run: (cols: string) => Promise<T[]>): Promise<T[]> =>
    withColumnTiers([`${base}, ${extra}`, base], run);

  const [orders, parts, paidOrders, refunds, movements, cashDays] = await Promise.all([
    // Newest columns first, falling back a migration at a time: with the pass
    // columns, then with just the settle discount, then the base.
    withColumnTiers<SaleOrderRow>(
      [
        `${SALE_COLUMNS}, settle_discount_inr, ${SALE_PASS_COLUMNS}`,
        `${SALE_COLUMNS}, settle_discount_inr`,
        SALE_COLUMNS,
      ],
      (cols) =>
        fetchAll<SaleOrderRow>((a, b) =>
          admin.from('orders').select(cols).gte('created_at', startIso).lt('created_at', endIso).order('created_at').range(a, b) as unknown as PromiseLike<PageResult<SaleOrderRow>>,
        ),
    ),
    fetchAll<PaymentPartRow>((a, b) =>
      admin
        .from('order_payments')
        .select('order_id, method, amount_inr, created_at')
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .order('created_at')
        .range(a, b) as unknown as PromiseLike<PageResult<PaymentPartRow>>,
    ),
    withOptional<PaidOrderRow>(PAID_COLUMNS, 'tip_inr', (cols) =>
      fetchAll<PaidOrderRow>((a, b) =>
        admin
          .from('orders')
          .select(cols)
          .in('payment_status', ['paid', 'partially_refunded', 'refunded'])
          .gte('paid_at', startIso)
          .lt('paid_at', endIso)
          .order('paid_at')
          .range(a, b) as unknown as PromiseLike<PageResult<PaidOrderRow>>,
      ),
    ),
    fetchAll<RefundRow>((a, b) =>
      admin
        .from('refunds')
        .select('amount_inr, method, processed_at')
        .eq('status', 'processed')
        .gte('processed_at', startIso)
        .lt('processed_at', endIso)
        .order('processed_at')
        .range(a, b) as unknown as PromiseLike<PageResult<RefundRow>>,
    ),
    // `category` and `voided_at` arrived with the cash-expenses migration; read without them before that.
    withOptional<CashMovementRow>('direction, amount_inr, created_at', 'category, voided_at', (cols) =>
      fetchAll<CashMovementRow>((a, b) =>
        admin
          .from('cash_movements')
          .select(cols)
          .gte('created_at', startIso)
          .lt('created_at', endIso)
          .order('created_at')
          .range(a, b) as unknown as PromiseLike<PageResult<CashMovementRow>>,
      ),
    ).catch((err) => {
      if (isMissingRelation(err)) return [] as CashMovementRow[];
      throw err;
    }),
    // The day's expenses (cash_days.expenses_inr) arrived with the cash-expenses
    // migration, and when a day ended on its own (auto_ended_at) with the
    // auto-end one; read what the database has.
    withColumnTiers<CashDayRow>(
      [`${CASH_DAY_COLUMNS}, expenses_inr, auto_ended_at`, `${CASH_DAY_COLUMNS}, expenses_inr`, CASH_DAY_COLUMNS],
      (cols) =>
        fetchAll<CashDayRow>((a, b) =>
          admin
            .from('cash_days')
            .select(cols)
            .gte('business_date', from)
            .lte('business_date', to)
            .order('opened_at')
            .range(a, b) as unknown as PromiseLike<PageResult<CashDayRow>>,
        ),
    ),
  ]);

  // Single-tender bills that also have split parts are counted via the parts.
  const ordersWithParts = new Set<string>();
  const ids = paidOrders.map((o) => o.id);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await admin.from('order_payments').select('order_id').in('order_id', ids.slice(i, i + IN_CHUNK));
    if (error) throw new Error(`loadReport: order_payments check failed: ${error.message}`);
    for (const r of (data ?? []) as { order_id: string }[]) ordersWithParts.add(r.order_id);
  }

  const passLines = await loadPassLines(admin, orders);

  return buildReport({ from, to, orders, parts, paidOrders, ordersWithParts, refunds, movements, cashDays, passLines });
}

/**
 * Tries each column list in turn (newest migration first) and returns the first
 * the database accepts: a select naming a column that is not there is refused
 * outright, so a deploy ahead of its migration reads what it can.
 */
async function withColumnTiers<T>(tiers: string[], run: (cols: string) => Promise<T[]>): Promise<T[]> {
  for (let i = 0; i < tiers.length; i++) {
    try {
      return await run(tiers[i]);
    } catch (err) {
      if (i < tiers.length - 1 && isMissingColumnError(err as { code?: string; message?: string })) continue;
      throw err;
    }
  }
  return [];
}

/**
 * The cups each order that used a pass spent, from its lines that were not
 * voided. Asked only about orders whose pass_discount_inr says they used one, so
 * a database without the migration (where no order does) makes no query at all.
 */
async function loadPassLines(admin: SupabaseClient, orders: SaleOrderRow[]): Promise<PassLineRow[]> {
  const ids = orders.filter((o) => (o.pass_discount_inr ?? 0) > 0).map((o) => o.id);
  const out: PassLineRow[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await admin
      .from('order_items')
      .select('order_id, pass_drinks')
      .in('order_id', ids.slice(i, i + IN_CHUNK))
      .eq('voided', false)
      .gt('pass_drinks', 0);
    if (error) throw new Error(`loadReport: pass lines check failed: ${error.message}`);
    out.push(...((data ?? []) as PassLineRow[]));
  }
  return out;
}
