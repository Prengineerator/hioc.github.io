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
  type PaymentPartRow,
  type RefundRow,
  type Report,
  type SaleOrderRow,
} from '@/lib/reports/reconcile';

const PAGE = 1000;
const IN_CHUNK = 200;

type PageResult<T> = { data: T[] | null; error: { code?: string; message?: string } | null };

/** Runs `page(from, to)` until a short page comes back. */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<PageResult<T>>): Promise<T[]> {
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
const PAID_COLUMNS = 'id, payment_method, total_inr, subtotal_inr, paid_at';

export async function loadReport(admin: SupabaseClient, from: string, to: string): Promise<Report> {
  const { startIso, endIso } = rangeBounds(from, to);

  // Settle discounts and tips arrived with a later migration; read without
  // them on a database that doesn't have them yet.
  const withOptional = async <T>(base: string, extra: string, run: (cols: string) => Promise<T[]>): Promise<T[]> => {
    try {
      return await run(`${base}, ${extra}`);
    } catch (err) {
      if (isMissingColumnError(err as { code?: string; message?: string })) return run(base);
      throw err;
    }
  };

  const [orders, parts, paidOrders, refunds, movements, cashDays] = await Promise.all([
    withOptional<SaleOrderRow>(SALE_COLUMNS, 'settle_discount_inr', (cols) =>
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
    fetchAll<CashMovementRow>((a, b) =>
      admin
        .from('cash_movements')
        .select('direction, amount_inr, created_at')
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .order('created_at')
        .range(a, b) as unknown as PromiseLike<PageResult<CashMovementRow>>,
    ).catch((err) => {
      if (isMissingRelation(err)) return [] as CashMovementRow[];
      throw err;
    }),
    fetchAll<CashDayRow>((a, b) =>
      admin
        .from('cash_days')
        .select('business_date, status, opening_total_inr, cash_sales_inr, expected_cash_inr, counted_total_inr, over_short_inr')
        .gte('business_date', from)
        .lte('business_date', to)
        .order('business_date')
        .range(a, b) as unknown as PromiseLike<PageResult<CashDayRow>>,
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

  return buildReport({ from, to, orders, parts, paidOrders, ordersWithParts, refunds, movements, cashDays });
}
