import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deductionKey, type ReportRow, type SettlementStore } from './ingest';
import type { SavedReport } from './reprocess';
import type { Platform } from './types';

// The Supabase side of SettlementStore (ingest.ts): the four tables from
// supabase/2026-10-online-settlements.sql through the service-role client, and
// the private 'online-settlements' Storage bucket for the raw files.

export const SETTLEMENT_BUCKET = 'online-settlements';

const IN_CHUNK = 200; // ids per .in() — keeps the request URL well under limits
const PAGE = 1000; // PostgREST's default max rows per response

export function supabaseSettlementStore(admin: SupabaseClient): SettlementStore {
  return {
    async findReportByHash(sha256) {
      const { data, error } = await admin
        .from('online_settlement_reports')
        .select('id, status')
        .eq('file_sha256', sha256)
        .maybeSingle();
      if (error) throw new Error(`online_settlement_reports lookup failed: ${error.message}`);
      return (data as { id: string; status: string } | null) ?? null;
    },

    async saveFile(path, bytes, contentType) {
      const body = Buffer.from(bytes);
      let { error } = await admin.storage.from(SETTLEMENT_BUCKET).upload(path, body, { contentType, upsert: true });
      // First run before the migration's bucket insert: create it PRIVATE and retry once.
      if (error && /bucket not found/i.test(error.message)) {
        await admin.storage.createBucket(SETTLEMENT_BUCKET, { public: false });
        ({ error } = await admin.storage.from(SETTLEMENT_BUCKET).upload(path, body, { contentType, upsert: true }));
      }
      if (error) {
        // Not fatal: the report is still read; only re-reading it later needs the file.
        console.error('online-settlements: raw file upload failed', error.message);
        return false;
      }
      return true;
    },

    async readFile(path) {
      try {
        const { data, error } = await admin.storage.from(SETTLEMENT_BUCKET).download(path);
        if (error || !data) {
          console.error('online-settlements: raw file download failed', path, error?.message ?? 'no data');
          return null;
        }
        return new Uint8Array(await data.arrayBuffer());
      } catch (err) {
        console.error('online-settlements: raw file download failed', path, err);
        return null;
      }
    },

    async insertReport(row: ReportRow) {
      const { data, error } = await admin.from('online_settlement_reports').insert(row).select('id').single();
      if (error || !data) throw new Error(`online_settlement_reports insert failed: ${error?.message ?? 'no row'}`);
      return (data as { id: string }).id;
    },

    async updateReport(id, patch) {
      const { error } = await admin.from('online_settlement_reports').update(patch).eq('id', id);
      if (error) throw new Error(`online_settlement_reports update failed: ${error.message}`);
    },

    async orderPeriods(platform: Platform, orderIds: string[]) {
      const out = new Map<string, string>();
      for (let i = 0; i < orderIds.length; i += IN_CHUNK) {
        const { data, error } = await admin
          .from('online_settlement_orders')
          .select('order_id, report_period_end')
          .eq('platform', platform)
          .in('order_id', orderIds.slice(i, i + IN_CHUNK));
        if (error) throw new Error(`online_settlement_orders lookup failed: ${error.message}`);
        for (const r of (data ?? []) as { order_id: string; report_period_end: string | null }[]) {
          out.set(r.order_id, r.report_period_end ?? '');
        }
      }
      return out;
    },

    async upsertOrders(rows) {
      const { error } = await admin.from('online_settlement_orders').upsert(rows, { onConflict: 'platform,order_id' });
      if (error) throw new Error(`online_settlement_orders upsert failed: ${error.message}`);
    },

    async deductionPeriods(platform: Platform) {
      const out = new Map<string, string>();
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await admin
          .from('online_settlement_deductions')
          .select('kind, label, ref, period_text, report_period_end')
          .eq('platform', platform)
          .order('id', { ascending: true }) // a total order, or a page can repeat or skip rows
          .range(from, from + PAGE - 1);
        if (error) throw new Error(`online_settlement_deductions lookup failed: ${error.message}`);
        const rows = (data ?? []) as { kind: string; label: string; ref: string; period_text: string; report_period_end: string | null }[];
        for (const r of rows) out.set(deductionKey(r), r.report_period_end ?? '');
        if (rows.length < PAGE) break;
      }
      return out;
    },

    async upsertDeductions(rows) {
      const { error } = await admin
        .from('online_settlement_deductions')
        .upsert(rows, { onConflict: 'platform,kind,label,ref,period_text' });
      if (error) throw new Error(`online_settlement_deductions upsert failed: ${error.message}`);
    },
  };
}

const REREAD_COLUMNS =
  'id, platform, source, file_name, storage_path, status, email_message_id, email_from, email_subject, email_received_at';

/**
 * The reports "Re-read saved reports" works on: status 'unsupported' or
 * 'failed', in id order, `limit` at a time starting after `afterId`. `left` is
 * how many more match beyond this batch; the caller passes the last id it
 * handled back as `afterId`, so files that stay unreadable don't block the
 * ones behind them. `error` narrows it to reports with exactly that error
 * (the mail check uses it for the ones a run left INTERRUPTED).
 */
export async function loadRereadableReports(
  admin: SupabaseClient,
  opts: { platform?: Platform | null; afterId?: string | null; error?: string; limit: number },
): Promise<{ rows: SavedReport[]; left: number }> {
  let q = admin
    .from('online_settlement_reports')
    .select(REREAD_COLUMNS, { count: 'exact' })
    .in('status', ['unsupported', 'failed']);
  if (opts.platform) q = q.eq('platform', opts.platform);
  if (opts.error) q = q.eq('error', opts.error);
  if (opts.afterId) q = q.gt('id', opts.afterId);
  const { data, error, count } = await q.order('id', { ascending: true }).limit(opts.limit);
  if (error) throw new Error(`online_settlement_reports lookup failed: ${error.message}`);
  const rows = (data ?? []) as unknown as SavedReport[];
  return { rows, left: Math.max((count ?? rows.length) - rows.length, 0) };
}
