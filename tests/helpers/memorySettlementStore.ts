import { deductionKey, type ReportRow, type SettlementStore } from '@/lib/online-settlements/ingest';
import type { Platform } from '@/lib/online-settlements/types';

// An in-memory SettlementStore for the online-settlement tests: report rows,
// orders, deductions and the raw files in plain collections the test can read
// (and seed) directly. `reads` lists the paths readFile was asked for. Like
// Postgres, an upsert whose batch repeats a key is refused as a whole.
function refuseRepeatedKeys(keys: string[]) {
  if (new Set(keys).size < keys.length) throw new Error('ON CONFLICT DO UPDATE command cannot affect row a second time');
}

export function memoryStore() {
  const reports: (ReportRow & { id: string })[] = [];
  const orders = new Map<string, Record<string, unknown>>();
  const deductions = new Map<string, Record<string, unknown>>();
  const files = new Map<string, Uint8Array>();
  const reads: string[] = [];
  const store: SettlementStore = {
    async findReportByHash(sha) {
      const r = reports.find((x) => x.file_sha256 === sha);
      return r ? { id: r.id, status: r.status } : null;
    },
    async saveFile(path, bytes) {
      files.set(path, bytes);
      return true;
    },
    async readFile(path) {
      reads.push(path);
      return files.get(path) ?? null;
    },
    async insertReport(row) {
      const id = `report-${reports.length + 1}`;
      reports.push({ ...row, id });
      return id;
    },
    async updateReport(id, patch) {
      Object.assign(reports.find((r) => r.id === id) as object, patch);
    },
    async orderPeriods(platform: Platform, ids) {
      const out = new Map<string, string>();
      for (const id of ids) {
        const o = orders.get(`${platform}|${id}`);
        if (o) out.set(id, (o.report_period_end as string | null) ?? '');
      }
      return out;
    },
    async upsertOrders(rows) {
      refuseRepeatedKeys(rows.map((r) => `${r.platform}|${r.order_id}`));
      for (const r of rows) orders.set(`${r.platform}|${r.order_id}`, r);
    },
    async deductionPeriods(platform: Platform) {
      const out = new Map<string, string>();
      for (const d of deductions.values()) {
        if (d.platform === platform) out.set(deductionKey(d as never), (d.report_period_end as string | null) ?? '');
      }
      return out;
    },
    async upsertDeductions(rows) {
      refuseRepeatedKeys(rows.map((r) => `${r.platform}|${deductionKey(r as never)}`));
      for (const r of rows) deductions.set(`${r.platform}|${deductionKey(r as never)}`, r);
    },
  };
  return { store, reports, orders, deductions, files, reads };
}
