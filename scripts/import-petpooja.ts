#!/usr/bin/env -S npx tsx
// ===========================================================================
// import-petpooja — bring Petpooja's bill/customer history into the
// read-only `legacy_orders` / `legacy_order_items` / `legacy_customers`
// tables (supabase/2026-09-petpooja-history.sql). Never touches `orders`.
//
// Default is a DRY RUN: parse the xlsx/csv exports, dedupe, match items
// against the menu, and write a markdown report (aggregates only — never
// customer names, phones or addresses; item names are menu data, not PII,
// so those are fine to show). Pass --commit to actually write to Supabase.
//
// Usage:
//   npx tsx scripts/import-petpooja.ts \
//     --orders a.xlsx --orders b.xlsx ... --customers customers.csv \
//     [--menu menu.json] [--report out.md] [--commit]
//
// Menu resolution:
//   --menu <file.json>   a MenuSnapshotItem[] JSON file (ids optional — item
//                        names still match and count toward the report's
//                        match-rate stats even without ids; only the ids let
//                        an insert point legacy_order_items.menu_item_id at a
//                        real row).
//   (omitted)             fetched live over PostgREST from menu_items +
//                        menu_item_variants. In --commit mode this is not
//                        optional: real ids are required to write the item
//                        links, so commit mode ALWAYS fetches live and
//                        ignores --menu even if one was given.
//
// --commit needs NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, read
// from .env.local (or the environment) the same way scripts/verify-db.mjs
// does: by hand, with plain `fetch` against PostgREST — no dotenv, no
// @supabase/supabase-js (that pulls in a realtime client that needs a
// browser WebSocket global Node doesn't have).
//
// The whole import is idempotent: legacy_orders upserts on
// (source, bill_no, ordered_at), legacy_order_items are deleted and
// re-inserted per order, legacy_customers upserts on phone. Re-running after
// a partial failure (network blip, a bad HTTP response mid-batch) is safe —
// earlier batches are not undone, and the same command just continues them.
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

import {
  parseOrderSheet,
  dedupeOrders,
  parseCustomerCsv,
  parsePetpoojaDateTime,
  legacyOrderKey,
} from '../lib/petpooja';
import type {
  MenuSnapshotItem,
  ParsedLegacyOrder,
  ParsedLegacyCustomer,
  SkipCount,
} from '../lib/petpooja';

// fileURLToPath, not url.pathname — the latter stays percent-encoded, so a
// repo checked out under a path with a space would look for '%20'.
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

function die(msg: string): never {
  console.error(`import-petpooja: ${msg}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Environment — copied from scripts/verify-db.mjs's loadEnv, unchanged in
// approach: hand-rolled .env.local parsing, plain fetch for PostgREST.
// ---------------------------------------------------------------------------
function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    // The Supabase values in this repo are written DOUBLE-QUOTED. Left in,
    // the quotes end up inside the URL and every request 404s against a
    // hostname that contains a literal '"'. Strip a matched pair only.
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return out;
}

function resolveEnvVar(fileEnv: Record<string, string>, key: string): string | undefined {
  return process.env[key] || fileEnv[key];
}

function requireCommitEnv(): { base: string; key: string } {
  const fileEnv = loadEnv(path.join(ROOT, '.env.local'));
  const url = resolveEnvVar(fileEnv, 'NEXT_PUBLIC_SUPABASE_URL');
  const key = resolveEnvVar(fileEnv, 'SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !key) {
    die(
      '--commit needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, in .env.local or the environment.',
    );
  }
  return { base: `${url.replace(/\/+$/, '')}/rest/v1`, key };
}

interface RestResult { status: number; ok: boolean; body: unknown }

async function rest(
  base: string,
  key: string,
  pathAndQuery: string,
  opts: { method?: string; body?: unknown; prefer?: string } = {},
): Promise<RestResult> {
  const headers: Record<string, string> = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (opts.prefer) headers.Prefer = opts.prefer;
  let res: Response;
  try {
    res = await fetch(`${base}${pathAndQuery}`, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    return { status: 0, ok: false, body: { message: String((err as Error)?.message ?? err) } };
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, ok: res.ok, body: parsed };
}

function bodyText(body: unknown): string {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function failHttp(label: string, res: RestResult): never {
  console.error(`\nHTTP error during ${label}`);
  console.error(`  status: ${res.status}`);
  console.error(`  body: ${bodyText(res.body)}`);
  console.error(
    '\nEarlier batches already written are fine to keep — this import is idempotent ' +
      '(legacy_orders upserts on source+bill_no+ordered_at, legacy_order_items are ' +
      'deleted and re-inserted per order, legacy_customers upserts on phone). ' +
      'Fix the problem and re-run the same command to pick up where it left off.',
  );
  process.exit(1);
}

class HttpError extends Error {
  constructor(public label: string, public status: number, public body: unknown) {
    super(`${label}: HTTP ${status}`);
  }
}

async function fetchLiveMenu(base: string, key: string): Promise<MenuSnapshotItem[]> {
  const itemsRes = await rest(base, key, '/menu_items?select=id,name&order=name.asc');
  if (!itemsRes.ok) throw new HttpError('GET /menu_items', itemsRes.status, itemsRes.body);
  const variantsRes = await rest(base, key, '/menu_item_variants?select=id,label,menu_item_id&order=label.asc');
  if (!variantsRes.ok) throw new HttpError('GET /menu_item_variants', variantsRes.status, variantsRes.body);

  const items = (itemsRes.body as { id: string; name: string }[] | null) ?? [];
  const variants = (variantsRes.body as { id: string; label: string; menu_item_id: string }[] | null) ?? [];
  const byItem = new Map<string, { id: string; label: string }[]>();
  for (const v of variants) {
    const list = byItem.get(v.menu_item_id) ?? [];
    list.push({ id: v.id, label: v.label });
    byItem.set(v.menu_item_id, list);
  }
  return items.map((it) => ({ id: it.id, name: it.name, variants: byItem.get(it.id) ?? [] }));
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
interface CliArgs {
  orderFiles: string[];
  customersFile: string;
  menuFile: string | null;
  reportPath: string;
  commit: boolean;
}

function requireValue(argv: string[], i: number, flag: string): string {
  const v = argv[i];
  if (v === undefined) die(`${flag} needs a value`);
  return v;
}

function printHelp(): void {
  console.log(
    [
      'Usage: npx tsx scripts/import-petpooja.ts --orders a.xlsx [--orders b.xlsx ...]',
      '         --customers customers.csv [--menu menu.json] [--report out.md] [--commit]',
      '',
      'Default is a dry run: parses, dedupes, matches items against the menu, and',
      'writes an aggregates-only markdown report (default ./petpooja-dry-run.md).',
      'Pass --commit to write to Supabase (needs NEXT_PUBLIC_SUPABASE_URL and',
      'SUPABASE_SERVICE_ROLE_KEY in .env.local or the environment).',
    ].join('\n'),
  );
}

function parseArgs(argv: string[]): CliArgs {
  const orderFiles: string[] = [];
  let customersFile: string | null = null;
  let menuFile: string | null = null;
  let reportPath = path.join(ROOT, 'petpooja-dry-run.md');
  let commit = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--orders':
        orderFiles.push(requireValue(argv, ++i, '--orders'));
        break;
      case '--customers':
        customersFile = requireValue(argv, ++i, '--customers');
        break;
      case '--menu':
        menuFile = requireValue(argv, ++i, '--menu');
        break;
      case '--report':
        reportPath = path.resolve(requireValue(argv, ++i, '--report'));
        break;
      case '--commit':
        commit = true;
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        die(`unknown argument: ${arg} (--help for usage)`);
    }
  }
  if (orderFiles.length === 0) die('at least one --orders <file.xlsx> is required');
  if (!customersFile) die('--customers <file.csv> is required');
  return { orderFiles, customersFile, menuFile, reportPath, commit };
}

// ---------------------------------------------------------------------------
// xlsx reading — exceljs into unknown[][], numbers stay numbers, text stays
// text. Sheet1's title block (rows 0-3) and the header row are left in; the
// shared parser (lib/petpooja) finds the header itself.
// ---------------------------------------------------------------------------
const ORDER_SHEET_COLUMNS = 23; // spec's fixed column count — pad ragged rows out to this width

function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const anyV = v as unknown as Record<string, unknown>;
    if (Array.isArray(anyV.richText)) {
      return (anyV.richText as { text?: string }[]).map((t) => String(t.text ?? '')).join('');
    }
    if ('result' in anyV) return anyV.result ?? '';
    if ('text' in anyV) return anyV.text;
    if ('hyperlink' in anyV) return anyV.text ?? anyV.hyperlink;
    return v;
  }
  return v; // number, string or boolean — unchanged
}

async function readSheetRows(filePath: string): Promise<unknown[][]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets.find((s) => s.name === 'Sheet1') ?? workbook.worksheets[0];
  if (!sheet) throw new Error(`${filePath}: workbook has no worksheet`);
  const maxCol = Math.max(sheet.columnCount, ORDER_SHEET_COLUMNS);
  const rows: unknown[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    const cells: unknown[] = [];
    for (let c = 1; c <= maxCol; c++) cells.push(cellValue(row.getCell(c).value));
    rows.push(cells);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Report data — every function below is pure (no I/O), built from already-
// parsed data, so it is easy to eyeball / unit-test independent of file I/O
// and network calls.
// ---------------------------------------------------------------------------
interface FileStat {
  file: string;
  bills: number;
  continuation: number;
  minDate: string | null;
  maxDate: string | null;
}

const CREATED_COL = 21; // 0-based index of 'Created' among the 23 order-sheet columns

function computeFileStats(file: string, rows: unknown[][]): FileStat {
  const headerIdx = rows.findIndex((r) => String(r[0] ?? '') === 'Order No.');
  const dataRows = headerIdx === -1 ? [] : rows.slice(headerIdx + 1);
  let bills = 0;
  let continuation = 0;
  let minDate: string | null = null;
  let maxDate: string | null = null;
  for (const row of dataRows) {
    const orderNo = String(row[0] ?? '').trim();
    const created = String(row[CREATED_COL] ?? '').trim();
    if (!orderNo && !created) continue; // fully blank row
    if (created) {
      bills++;
      try {
        const iso = parsePetpoojaDateTime(created);
        if (minDate === null || iso < minDate) minDate = iso;
        if (maxDate === null || iso > maxDate) maxDate = iso;
      } catch {
        // unparsable Created value — skip its contribution to the date range,
        // the row itself is still counted as a bill row above.
      }
    } else if (orderNo) {
      continuation++;
    }
  }
  return { file, bills, continuation, minDate, maxDate };
}

interface FyStat {
  fiscalYear: string;
  bills: number;
  completed: number;
  cancelled: number;
  completedTotalInr: number;
  minBillNo: number | null;
  maxBillNo: number | null;
  nonNumericBillNos: number;
  missingBillNos: number[];
  missingCount: number;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function computeFyStats(orders: ParsedLegacyOrder[]): FyStat[] {
  const byFy = new Map<string, ParsedLegacyOrder[]>();
  for (const o of orders) {
    const list = byFy.get(o.fiscal_year) ?? [];
    list.push(o);
    byFy.set(o.fiscal_year, list);
  }
  const result: FyStat[] = [];
  for (const [fy, list] of [...byFy.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let completed = 0;
    let cancelled = 0;
    let completedTotal = 0;
    let nonNumeric = 0;
    const numeric = new Set<number>();
    for (const o of list) {
      if (o.status === 'completed') {
        completed++;
        completedTotal += o.total_inr;
      } else if (o.status === 'cancelled') {
        cancelled++;
      }
      if (/^\d+$/.test(o.bill_no)) numeric.add(Number(o.bill_no));
      else nonNumeric++;
    }
    let minBillNo: number | null = null;
    let maxBillNo: number | null = null;
    const missing: number[] = [];
    if (numeric.size) {
      minBillNo = Math.min(...numeric);
      maxBillNo = Math.max(...numeric);
      for (let n = minBillNo; n <= maxBillNo; n++) if (!numeric.has(n)) missing.push(n);
    }
    result.push({
      fiscalYear: fy,
      bills: list.length,
      completed,
      cancelled,
      completedTotalInr: round2(completedTotal),
      minBillNo,
      maxBillNo,
      nonNumericBillNos: nonNumeric,
      missingBillNos: missing.slice(0, 20),
      missingCount: missing.length,
    });
  }
  return result;
}

function tally(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of items) out[v] = (out[v] ?? 0) + 1;
  return out;
}

interface PhoneBuckets { valid: number; placeholder: number; landline: number; missing: number; other: number }

function computePhoneBuckets(orders: ParsedLegacyOrder[]): PhoneBuckets {
  let valid = 0;
  let placeholder = 0;
  let landline = 0;
  let missing = 0;
  let other = 0;
  for (const o of orders) {
    if (o.customer_phone) {
      valid++;
      continue;
    }
    const raw = o.customer_phone_raw.trim();
    if (!raw) {
      missing++;
      continue;
    }
    const digits = raw.replace(/\D/g, '');
    if (digits === '9999999999' || /^(\d)\1{9}$/.test(digits)) {
      placeholder++;
      continue;
    }
    if (digits.length === 11) {
      landline++;
      continue;
    }
    other++;
  }
  return { valid, placeholder, landline, missing, other };
}

interface ItemStats {
  total: number;
  distinct: number;
  matched: number;
  matchRate: number;
  topUnmatched: { name: string; count: number }[];
}

function computeItemStats(orders: ParsedLegacyOrder[]): ItemStats {
  let total = 0;
  let matched = 0;
  const distinctNames = new Set<string>();
  const unmatchedCounts = new Map<string, number>();
  for (const o of orders) {
    for (const it of o.items) {
      total++;
      distinctNames.add(it.item_name);
      if (it.matched_menu_name) matched++;
      else unmatchedCounts.set(it.item_name, (unmatchedCounts.get(it.item_name) ?? 0) + 1);
    }
  }
  const topUnmatched = [...unmatchedCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 60)
    .map(([name, count]) => ({ name, count }));
  return { total, distinct: distinctNames.size, matched, matchRate: total ? matched / total : 1, topUnmatched };
}

interface CustomerStats { parsed: number; withBills: number; withoutBills: number; skipped: SkipCount[] }

function computeCustomerStats(
  customers: ParsedLegacyCustomer[],
  skipped: SkipCount[],
  orders: ParsedLegacyOrder[],
): CustomerStats {
  const phonesWithBills = new Set(orders.map((o) => o.customer_phone).filter((p): p is string => !!p));
  let withBills = 0;
  for (const c of customers) if (phonesWithBills.has(c.phone)) withBills++;
  return { parsed: customers.length, withBills, withoutBills: customers.length - withBills, skipped };
}

function overallDateRange(orders: ParsedLegacyOrder[]): [string | null, string | null] {
  let min: string | null = null;
  let max: string | null = null;
  for (const o of orders) {
    if (min === null || o.ordered_at < min) min = o.ordered_at;
    if (max === null || o.ordered_at > max) max = o.ordered_at;
  }
  return [min, max];
}

interface ReportData {
  generatedAt: string;
  commit: boolean;
  menuSource: string;
  fileStats: FileStat[];
  totalBeforeDedupe: number;
  duplicates: number;
  totalAfterDedupe: number;
  overallMinDate: string | null;
  overallMaxDate: string | null;
  ordersSkipped: SkipCount[];
  fyStats: FyStat[];
  channelCounts: Record<string, number>;
  paymentTypeCounts: Record<string, number>;
  phones: PhoneBuckets;
  customers: CustomerStats;
  items: ItemStats;
}

// Pure: takes already-computed data, returns markdown text. Nothing here
// reads a file or the network, and nothing here ever sees a name, phone or
// address — only the aggregates built above.
function renderReport(d: ReportData): string {
  const lines: string[] = [];
  lines.push('# Petpooja import — dry run report');
  lines.push('');
  lines.push(`Generated: ${d.generatedAt}`);
  lines.push('');
  lines.push(
    'This report contains aggregate counts only — never customer names, phone numbers ' +
      'or addresses. Item names are menu data, not PII, so those are shown.',
  );
  lines.push('');
  lines.push(`Menu used for item matching: ${d.menuSource}`);
  lines.push('');
  lines.push(
    d.commit
      ? 'Mode: COMMIT — a write to the database was attempted after this report was built (see the ' +
          'console output for the outcome; the live menu was re-fetched with ids before writing).'
      : 'Mode: DRY RUN — nothing was written to the database.',
  );
  lines.push('');

  lines.push('## Files');
  lines.push('');
  lines.push('| file | bill rows | continuation rows | date range (IST) |');
  lines.push('| --- | ---: | ---: | --- |');
  for (const f of d.fileStats) {
    const range = f.minDate && f.maxDate ? `${f.minDate} .. ${f.maxDate}` : 'n/a';
    lines.push(`| ${f.file} | ${f.bills} | ${f.continuation} | ${range} |`);
  }
  lines.push('');

  lines.push('## Totals after dedupe');
  lines.push('');
  lines.push(`- Bills parsed across all files (before dedupe): ${d.totalBeforeDedupe}`);
  lines.push(`- Duplicates skipped (same bill_no + Created string, first file wins): ${d.duplicates}`);
  lines.push(`- Bills after dedupe: ${d.totalAfterDedupe}`);
  lines.push(`- Date range: ${d.overallMinDate ?? 'n/a'} .. ${d.overallMaxDate ?? 'n/a'}`);
  if (d.ordersSkipped.length) {
    lines.push('- Rows skipped while parsing the order sheets:');
    for (const s of d.ordersSkipped) lines.push(`  - ${s.reason}: ${s.count}`);
  }
  lines.push('');

  lines.push('## Per fiscal year');
  lines.push('');
  lines.push(
    '| fiscal year | bills | completed | cancelled | sum total_inr (completed) | bill_no range | ' +
      'non-numeric bill_nos | missing bill_nos in range |',
  );
  lines.push('| --- | ---: | ---: | ---: | ---: | --- | ---: | --- |');
  for (const fy of d.fyStats) {
    const range = fy.minBillNo !== null ? `${fy.minBillNo}–${fy.maxBillNo}` : 'n/a';
    const missing =
      fy.missingCount === 0
        ? 'none'
        : `${fy.missingBillNos.join(', ')}${
            fy.missingCount > fy.missingBillNos.length ? ` … (+${fy.missingCount - fy.missingBillNos.length} more)` : ''
          }`;
    lines.push(
      `| ${fy.fiscalYear} | ${fy.bills} | ${fy.completed} | ${fy.cancelled} | ${fy.completedTotalInr.toFixed(2)} | ` +
        `${range} | ${fy.nonNumericBillNos} | ${missing} |`,
    );
  }
  lines.push('');

  lines.push('## Channel counts');
  lines.push('');
  for (const [k, v] of Object.entries(d.channelCounts).sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${v}`);
  lines.push('');

  lines.push('## Payment type counts');
  lines.push('');
  for (const [k, v] of Object.entries(d.paymentTypeCounts).sort((a, b) => b[1] - a[1])) {
    lines.push(`- ${k || '(blank)'}: ${v}`);
  }
  lines.push('');

  lines.push('## Phones');
  lines.push('');
  lines.push(`- Valid (normalized to +91…): ${d.phones.valid}`);
  lines.push(`- Placeholder (9999999999 / all-same-digit): ${d.phones.placeholder}`);
  lines.push(`- Landline / 11-digit: ${d.phones.landline}`);
  lines.push(`- Missing: ${d.phones.missing}`);
  if (d.phones.other) lines.push(`- Other / unrecognised: ${d.phones.other}`);
  lines.push('');

  lines.push('## Customers');
  lines.push('');
  lines.push(`- Parsed from customer report: ${d.customers.parsed}`);
  if (d.customers.skipped.length) {
    lines.push('- Skipped while parsing:');
    for (const s of d.customers.skipped) lines.push(`  - ${s.reason}: ${s.count}`);
  }
  lines.push(`- With ≥1 bill in the supplied order files: ${d.customers.withBills}`);
  lines.push(
    `- Without bills in the supplied order files (bills predate the files, or predate 19 Jul 2024): ${d.customers.withoutBills}`,
  );
  lines.push('');

  lines.push('## Items');
  lines.push('');
  lines.push(`- Total item entries: ${d.items.total}`);
  lines.push(`- Distinct item names: ${d.items.distinct}`);
  lines.push(
    `- Matched to the menu (by occurrence): ${d.items.matched} / ${d.items.total} (${(d.items.matchRate * 100).toFixed(1)}%)`,
  );
  if (d.items.topUnmatched.length) {
    lines.push('');
    lines.push(`### Top ${d.items.topUnmatched.length} unmatched item names`);
    lines.push('');
    lines.push('| item name | occurrences |');
    lines.push('| --- | ---: |');
    for (const u of d.items.topUnmatched) lines.push(`| ${u.name} | ${u.count} |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commit phase — writes to Supabase over PostgREST. Kept strictly separate
// from parsing/report-building above: this is the only part of the script
// that performs a write.
// ---------------------------------------------------------------------------
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface CommitResult { ordersWritten: number; itemsWritten: number; customersWritten: number }

async function runCommit(
  orders: ParsedLegacyOrder[],
  customers: ParsedLegacyCustomer[],
  base: string,
  key: string,
): Promise<CommitResult> {
  const idMap = new Map<string, string>(); // legacyOrderKey(bill_no, ordered_at) -> legacy_order_id
  let ordersWritten = 0;
  let itemsWritten = 0;

  const orderBatches = chunk(orders, 500);
  for (let i = 0; i < orderBatches.length; i++) {
    const batch = orderBatches[i];
    const rows = batch.map((o) => ({
      source: o.source,
      bill_no: o.bill_no,
      fiscal_year: o.fiscal_year,
      ordered_at: o.ordered_at,
      client_order_id: o.client_order_id,
      order_type: o.order_type,
      sub_order_type: o.sub_order_type,
      channel: o.channel,
      table_label: o.table_label,
      customer_name: o.customer_name,
      customer_phone: o.customer_phone,
      customer_phone_raw: o.customer_phone_raw,
      customer_address: o.customer_address,
      customer_gstin: o.customer_gstin,
      items_text: o.items_text,
      subtotal_inr: o.subtotal_inr,
      discount_inr: o.discount_inr,
      delivery_charge_inr: o.delivery_charge_inr,
      container_charge_inr: o.container_charge_inr,
      tax_inr: o.tax_inr,
      round_off_inr: o.round_off_inr,
      total_inr: o.total_inr,
      payment_type: o.payment_type,
      payments: o.payments,
      status: o.status,
      raw: o.raw,
    }));
    const res = await rest(base, key, '/legacy_orders?on_conflict=source,bill_no,ordered_at&select=id,bill_no,ordered_at', {
      method: 'POST',
      body: rows,
      prefer: 'resolution=merge-duplicates,return=representation',
    });
    if (!res.ok) failHttp(`POST /legacy_orders (batch ${i + 1}/${orderBatches.length})`, res);
    const returned = (res.body as { id: string; bill_no: string; ordered_at: string }[] | null) ?? [];
    if (returned.length !== batch.length) {
      die(
        `POST /legacy_orders (batch ${i + 1}/${orderBatches.length}) returned ${returned.length} row(s) ` +
          `but the batch had ${batch.length} — an upsert must return one row per input row (Prefer: ` +
          'return=representation). Refusing to continue: legacy_order_items would be written for an ' +
          'incomplete/uncertain set of orders. Nothing after this batch was written; earlier batches are ' +
          'safe to keep (the import is idempotent) — fix the problem and re-run the same command.',
      );
    }
    for (const r of returned) idMap.set(legacyOrderKey(r.bill_no, r.ordered_at), r.id);
    ordersWritten += returned.length;

    const batchIds = returned.map((r) => r.id);
    for (const idChunk of chunk(batchIds, 200)) {
      const del = await rest(base, key, `/legacy_order_items?legacy_order_id=in.(${idChunk.join(',')})`, {
        method: 'DELETE',
      });
      if (!del.ok) failHttp(`DELETE /legacy_order_items (batch ${i + 1})`, del);
    }

    const itemRows: Record<string, unknown>[] = [];
    const unmapped: ParsedLegacyOrder[] = [];
    for (const o of batch) {
      const orderId = idMap.get(legacyOrderKey(o.bill_no, o.ordered_at));
      if (!orderId) {
        unmapped.push(o);
        continue;
      }
      for (const item of o.items) {
        itemRows.push({
          legacy_order_id: orderId,
          position: item.position,
          raw_name: item.raw_name,
          item_name: item.item_name,
          variant_label: item.variant_label,
          menu_item_id: item.menu_item_id,
          variant_id: item.variant_id,
          quantity: null, // Petpooja's export never carries quantities
        });
      }
    }
    if (unmapped.length) {
      const first = unmapped[0];
      die(
        `${unmapped.length} order(s) in batch ${i + 1}/${orderBatches.length} had no matching legacy_order_id ` +
          `after the upsert — legacy_order_items would silently be dropped for them. First: ` +
          `${JSON.stringify(legacyOrderKey(first.bill_no, first.ordered_at))} (bill_no ${JSON.stringify(first.bill_no)}, ` +
          `ordered_at ${JSON.stringify(first.ordered_at)}). Nothing after this point in the batch was written; ` +
          'earlier batches are safe to keep (the import is idempotent) — fix the problem and re-run the same command.',
      );
    }
    for (const itemChunk of chunk(itemRows, 1000)) {
      const ins = await rest(base, key, '/legacy_order_items', {
        method: 'POST',
        body: itemChunk,
        prefer: 'return=minimal',
      });
      if (!ins.ok) failHttp(`POST /legacy_order_items (batch ${i + 1})`, ins);
      itemsWritten += itemChunk.length;
    }

    console.log(
      `  orders batch ${i + 1}/${orderBatches.length}: ${returned.length} upserted, ${itemRows.length} items written`,
    );
  }

  let customersWritten = 0;
  const customerBatches = chunk(customers, 1000);
  for (let i = 0; i < customerBatches.length; i++) {
    const batch = customerBatches[i];
    const rows = batch.map((c) => ({
      phone: c.phone,
      name: c.name,
      email: c.email,
      date_of_birth: c.date_of_birth,
      date_of_anniversary: c.date_of_anniversary,
      address: c.address,
      locality: c.locality,
      gstin: c.gstin,
      is_favourite: c.is_favourite,
      petpooja_created_on: c.petpooja_created_on,
      marketing_consent: false, // DPDP: consent was never collected via Petpooja — informational only
      source: 'petpooja',
      raw: c.raw,
    }));
    const res = await rest(base, key, '/legacy_customers?on_conflict=phone', {
      method: 'POST',
      body: rows,
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
    if (!res.ok) failHttp(`POST /legacy_customers (batch ${i + 1}/${customerBatches.length})`, res);
    customersWritten += rows.length;
    console.log(`  customers batch ${i + 1}/${customerBatches.length}: ${rows.length} upserted`);
  }

  const refreshed = await rest(base, key, '/rpc/refresh_legacy_customer_stats', { method: 'POST', body: {} });
  if (!refreshed.ok) failHttp('POST /rpc/refresh_legacy_customer_stats', refreshed);
  console.log(`  refresh_legacy_customer_stats: ${refreshed.body} row(s) updated`);

  const synced = await rest(base, key, '/rpc/sync_order_number_after_legacy', { method: 'POST', body: {} });
  if (!synced.ok) failHttp('POST /rpc/sync_order_number_after_legacy', synced);
  console.log(`  sync_order_number_after_legacy: next order number will be ${synced.body}`);

  return { ordersWritten, itemsWritten, customersWritten };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  let commitCreds: { base: string; key: string } | null = null;
  if (args.commit) {
    console.log('Validating environment for --commit ...');
    commitCreds = requireCommitEnv();
    console.log('  ok.');
  }

  // Resolve the menu used for matching. Commit mode always re-fetches live
  // (ids required for the FK) and ignores --menu even if one was given.
  let menu: MenuSnapshotItem[] = [];
  let menuSource: string;
  if (args.commit) {
    console.log('Fetching the live menu (ids required for --commit) ...');
    try {
      menu = await fetchLiveMenu(commitCreds!.base, commitCreds!.key);
    } catch (err) {
      if (err instanceof HttpError) failHttp(err.label, { status: err.status, ok: false, body: err.body });
      throw err;
    }
    menuSource = `live PostgREST, ${menu.length} item(s) with ids (commit mode always re-fetches; any --menu file was ignored)`;
    console.log(`  ${menu.length} menu item(s).`);
  } else if (args.menuFile) {
    menu = JSON.parse(fs.readFileSync(args.menuFile, 'utf8')) as MenuSnapshotItem[];
    menuSource = `file: ${args.menuFile} (${menu.length} item(s))`;
  } else {
    const fileEnv = loadEnv(path.join(ROOT, '.env.local'));
    const url = resolveEnvVar(fileEnv, 'NEXT_PUBLIC_SUPABASE_URL');
    const key =
      resolveEnvVar(fileEnv, 'SUPABASE_SERVICE_ROLE_KEY') || resolveEnvVar(fileEnv, 'NEXT_PUBLIC_SUPABASE_ANON_KEY');
    if (url && key) {
      try {
        menu = await fetchLiveMenu(`${url.replace(/\/+$/, '')}/rest/v1`, key);
        menuSource = `live PostgREST, ${menu.length} item(s)`;
        console.log(`Fetched the live menu: ${menu.length} item(s).`);
      } catch (err) {
        const detail = err instanceof HttpError ? `HTTP ${err.status}: ${bodyText(err.body)}` : String((err as Error)?.message ?? err);
        console.warn(`warning: could not fetch the live menu (${detail}); continuing with no menu — every item will be reported unmatched.`);
        menuSource = 'none — live fetch failed and no --menu was given';
      }
    } else {
      console.warn(
        'warning: no --menu file and no Supabase credentials in .env.local; continuing with no menu — every item will be reported unmatched.',
      );
      menuSource = 'none — no --menu and no credentials to fetch one live';
    }
  }

  // Read + parse order sheets.
  const fileStats: FileStat[] = [];
  let allOrders: ParsedLegacyOrder[] = [];
  const skippedTally = new Map<string, number>();
  for (const file of args.orderFiles) {
    console.log(`Reading ${file} ...`);
    const rows = await readSheetRows(file);
    fileStats.push(computeFileStats(file, rows));
    const { orders, skipped } = parseOrderSheet(rows, menu);
    for (const s of skipped) skippedTally.set(s.reason, (skippedTally.get(s.reason) ?? 0) + s.count);
    allOrders = allOrders.concat(orders);
  }
  const totalBeforeDedupe = allOrders.length;
  const { orders: dedupedOrders, duplicates } = dedupeOrders(allOrders);

  // Read + parse the customers report. Strip a BOM if present — Excel-saved
  // CSVs commonly have one and it would otherwise land inside the first
  // header cell.
  console.log(`Reading ${args.customersFile} ...`);
  const customersText = fs.readFileSync(args.customersFile, 'utf8').replace(/^﻿/, '');
  const { customers, skipped: customersSkipped } = parseCustomerCsv(customersText);

  // Build + write the report (pure function over everything parsed above).
  const [overallMin, overallMax] = overallDateRange(dedupedOrders);
  const reportData: ReportData = {
    generatedAt: new Date().toISOString(),
    commit: args.commit,
    menuSource,
    fileStats,
    totalBeforeDedupe,
    duplicates,
    totalAfterDedupe: dedupedOrders.length,
    overallMinDate: overallMin,
    overallMaxDate: overallMax,
    ordersSkipped: [...skippedTally.entries()].map(([reason, count]) => ({ reason, count })),
    fyStats: computeFyStats(dedupedOrders),
    channelCounts: tally(dedupedOrders.map((o) => o.channel)),
    paymentTypeCounts: tally(dedupedOrders.map((o) => o.payment_type)),
    phones: computePhoneBuckets(dedupedOrders),
    customers: computeCustomerStats(customers, customersSkipped, dedupedOrders),
    items: computeItemStats(dedupedOrders),
  };
  const report = renderReport(reportData);
  fs.mkdirSync(path.dirname(args.reportPath), { recursive: true });
  fs.writeFileSync(args.reportPath, report, 'utf8');
  console.log(`\nReport written to ${args.reportPath}`);
  console.log(
    `  ${dedupedOrders.length} bills, ${customers.length} customers, ${reportData.items.total} item entries ` +
      `(${(reportData.items.matchRate * 100).toFixed(1)}% matched).`,
  );

  if (!args.commit) {
    console.log('\nDry run only — nothing was written to the database. Re-run with --commit to import.');
    return;
  }

  console.log('\nCommitting to the database ...');
  const result = await runCommit(dedupedOrders, customers, commitCreds!.base, commitCreds!.key);
  console.log('\nDone.');
  console.log(`  legacy_orders upserted: ${result.ordersWritten}`);
  console.log(`  legacy_order_items written: ${result.itemsWritten}`);
  console.log(`  legacy_customers upserted: ${result.customersWritten}`);
  console.log(
    '\nThis import is idempotent — safe to re-run at any point (upserts key on ' +
      'source+bill_no+ordered_at for orders, and on phone for customers).',
  );
}

main().catch((err) => {
  console.error(`\nimport-petpooja: crashed: ${err?.stack || err}`);
  process.exit(1);
});
