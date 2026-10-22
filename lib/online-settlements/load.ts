import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DeductionRow, OrderRow } from './summary';

// Reads what Owner → Online orders needs. Orders are fetched for the chosen
// IST date range (paged: PostgREST returns at most 1,000 rows a request);
// deductions, reports and runs are small, so they come whole.

const PAGE = 1000;

const ORDER_COLUMNS =
  'platform, order_id, ordered_at, status, offer, cancel_reason, cancel_stage, menu_sales_inr, discount_inr, ' +
  'commission_inr, payment_fee_inr, gst_on_fees_inr, tcs_inr, tds_inr, payout_inr, unsettled_inr, ' +
  'settlement_status, settlement_date, utr, customer_ref';

export interface ReportListRow {
  id: string;
  platform: string;
  source: string;
  file_name: string;
  period_start: string | null;
  period_end: string | null;
  status: string;
  error: string | null;
  orders_count: number;
  email_received_at: string | null;
  created_at: string;
}

export interface SyncRunRow {
  id: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  messages_found: number;
  files_found: number;
  files_read: number;
  files_skipped: number;
  files_failed: number;
  error: string | null;
}

export interface OnlineData {
  migrated: boolean;
  orders: OrderRow[];
  deductions: DeductionRow[];
  reports: ReportListRow[];
  /** Reports saved but not read ('unsupported' or 'failed'), across all of them, not just the list above. */
  rereadable: number;
  runs: SyncRunRow[];
  /** Earliest and latest order day stored, for the "data from … to …" line. */
  coverage: { first: string | null; last: string | null };
}

const MISSING_TABLE = /online_settlement_|PGRST205|does not exist|could not find the table/i;

export async function loadOnlineData(admin: SupabaseClient, from: string, to: string): Promise<OnlineData> {
  // IST day bounds as instants: from 00:00 IST to the end of `to` in IST.
  const startIso = new Date(Date.parse(`${from}T00:00:00+05:30`)).toISOString();
  const endIso = new Date(Date.parse(`${to}T00:00:00+05:30`) + 24 * 60 * 60 * 1000).toISOString();

  const orders: OrderRow[] = [];
  for (let page = 0; ; page += PAGE) {
    const { data, error } = await admin
      .from('online_settlement_orders')
      .select(ORDER_COLUMNS)
      .gte('ordered_at', startIso)
      .lt('ordered_at', endIso)
      .order('ordered_at', { ascending: true })
      .order('platform', { ascending: true }) // with order_id: the primary key, so pages never repeat or skip a row
      .order('order_id', { ascending: true })
      .range(page, page + PAGE - 1);
    if (error) {
      if (MISSING_TABLE.test(`${error.code ?? ''} ${error.message}`)) {
        return { migrated: false, orders: [], deductions: [], reports: [], rereadable: 0, runs: [], coverage: { first: null, last: null } };
      }
      throw new Error(`online_settlement_orders: ${error.message}`);
    }
    const rows = (data ?? []) as unknown as OrderRow[];
    orders.push(...rows);
    if (rows.length < PAGE) break;
  }

  const [ded, reports, waiting, runs, first, last] = await Promise.all([
    admin
      .from('online_settlement_deductions')
      .select('platform, kind, amount_inr, period_start, period_end, report_period_end')
      .eq('kind', 'ads'),
    admin
      .from('online_settlement_reports')
      .select('id, platform, source, file_name, period_start, period_end, status, error, orders_count, email_received_at, created_at')
      .order('created_at', { ascending: false })
      .limit(30),
    admin.from('online_settlement_reports').select('id', { count: 'exact', head: true }).in('status', ['unsupported', 'failed']),
    admin
      .from('online_settlement_sync_runs')
      .select('id, trigger, started_at, finished_at, messages_found, files_found, files_read, files_skipped, files_failed, error')
      .order('started_at', { ascending: false })
      .limit(5),
    admin.from('online_settlement_orders').select('ordered_at').order('ordered_at', { ascending: true }).limit(1),
    admin.from('online_settlement_orders').select('ordered_at').order('ordered_at', { ascending: false }).limit(1),
  ]);
  for (const r of [ded, reports, waiting, runs, first, last]) {
    if (r.error) throw new Error(`online settlements: ${r.error.message}`);
  }
  const at = (r: { data: unknown }) => ((r.data as { ordered_at: string }[] | null)?.[0]?.ordered_at ?? null);
  return {
    migrated: true,
    orders,
    deductions: (ded.data ?? []) as unknown as DeductionRow[],
    reports: (reports.data ?? []) as unknown as ReportListRow[],
    rereadable: waiting.count ?? 0,
    runs: (runs.data ?? []) as unknown as SyncRunRow[],
    coverage: { first: at(first), last: at(last) },
  };
}
