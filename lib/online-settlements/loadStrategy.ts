import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { StrategyDeductionRow, StrategyOrderRow } from './strategy';
import { istDay } from './summary';

// Reads what Owner → Online orders → Strategy needs, Zomato only: its orders
// from the last 400 days (paged: PostgREST returns at most 1,000 rows a
// request), a light read of the first delivered order of every customer over
// ALL history (so an old regular is never counted as new), and every one of its
// deductions (paged the same way).

const PAGE = 1000;
const DAYS = 400;

const ORDER_COLUMNS =
  'platform, order_id, ordered_at, status, offer, menu_sales_inr, packaging_inr, discount_inr, gst_from_customer_inr, ' +
  'net_order_value_inr, commission_inr, payment_fee_inr, gst_on_fees_inr, tcs_inr, tds_inr, payout_inr, customer_ref';

const DEDUCTION_COLUMNS = 'platform, kind, label, ref, period_text, period_start, period_end, report_period_end, settlement_status, amount_inr';

const FIRST_ORDER_COLUMNS = 'customer_ref, ordered_at, platform, order_id';

export interface StrategyData {
  migrated: boolean;
  orders: StrategyOrderRow[];
  /** customer_ref → IST day of that customer's first delivered order, over all history. */
  firstOrderDay: Map<string, string>;
  deductions: StrategyDeductionRow[];
}

const MISSING_TABLE = /online_settlement_|PGRST205|does not exist|could not find the table/i;

/** Throws on a query error (a missing table is reported as not migrated). `now` is for tests. */
export async function loadStrategyData(admin: SupabaseClient, now: Date = new Date()): Promise<StrategyData> {
  const sinceIso = new Date(now.getTime() - DAYS * 24 * 60 * 60 * 1000).toISOString();

  const orders: StrategyOrderRow[] = [];
  for (let page = 0; ; page += PAGE) {
    const { data, error } = await admin
      .from('online_settlement_orders')
      .select(ORDER_COLUMNS)
      .eq('platform', 'zomato')
      .gte('ordered_at', sinceIso)
      .order('ordered_at', { ascending: true })
      .order('platform', { ascending: true }) // with order_id: the primary key, so pages never repeat or skip a row
      .order('order_id', { ascending: true })
      .range(page, page + PAGE - 1);
    if (error) {
      if (MISSING_TABLE.test(`${error.code ?? ''} ${error.message}`)) return { migrated: false, orders: [], firstOrderDay: new Map(), deductions: [] };
      throw new Error(`online_settlement_orders: ${error.message}`);
    }
    const rows = (data ?? []) as unknown as StrategyOrderRow[];
    orders.push(...rows);
    if (rows.length < PAGE) break;
  }

  const firstOrderDay = new Map<string, string>();
  for (let page = 0; ; page += PAGE) {
    const { data, error } = await admin
      .from('online_settlement_orders')
      .select(FIRST_ORDER_COLUMNS)
      .eq('platform', 'zomato')
      .eq('status', 'delivered')
      .order('ordered_at', { ascending: true })
      .order('platform', { ascending: true })
      .order('order_id', { ascending: true })
      .range(page, page + PAGE - 1);
    if (error) {
      if (MISSING_TABLE.test(`${error.code ?? ''} ${error.message}`)) return { migrated: false, orders: [], firstOrderDay: new Map(), deductions: [] };
      throw new Error(`online_settlement_orders (first orders): ${error.message}`);
    }
    const rows = (data ?? []) as unknown as { customer_ref: string | null; ordered_at: string }[];
    for (const r of rows) {
      if (!r.customer_ref) continue;
      const day = istDay(r.ordered_at);
      const seen = firstOrderDay.get(r.customer_ref);
      if (seen === undefined || day < seen) firstOrderDay.set(r.customer_ref, day);
    }
    if (rows.length < PAGE) break;
  }

  const deductions: StrategyDeductionRow[] = [];
  for (let page = 0; ; page += PAGE) {
    const { data, error } = await admin
      .from('online_settlement_deductions')
      .select(DEDUCTION_COLUMNS)
      .eq('platform', 'zomato')
      .order('kind', { ascending: true }) // the table's unique key, so pages never repeat or skip a row
      .order('label', { ascending: true })
      .order('ref', { ascending: true })
      .order('period_text', { ascending: true })
      .range(page, page + PAGE - 1);
    if (error) {
      if (MISSING_TABLE.test(`${error.code ?? ''} ${error.message}`)) return { migrated: false, orders: [], firstOrderDay: new Map(), deductions: [] };
      throw new Error(`online_settlement_deductions: ${error.message}`);
    }
    const rows = (data ?? []) as unknown as StrategyDeductionRow[];
    deductions.push(...rows);
    if (rows.length < PAGE) break;
  }
  return { migrated: true, orders, firstOrderDay, deductions };
}
