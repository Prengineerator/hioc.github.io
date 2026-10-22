import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { deductionKey, type ReportRow, type SettlementStore } from './ingest';
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
