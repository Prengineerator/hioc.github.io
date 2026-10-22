import { createHash } from 'node:crypto';
import { isReportAttachment, platformFromFileName, safeFileName } from './detect';
import { looksLikeXlsx, readCsv, readWorkbook, WorkbookRefused } from './sheets';
import { isSwiggySettlement, parseSwiggySettlement } from './swiggy';
import { hasZomatoOrderTable, isZomatoSettlement, parseZomatoSettlement } from './zomato';
import { PLATFORM_LABEL, type ParsedSettlement, type Platform, type SettlementDeduction, type SettlementOrder, type Sheets } from './types';

// One report file in, rows out. Shared by the mailbox sync (sync.ts) and the
// owner's upload route, so a report reads the same however it arrived.
//
//   1. Hash the bytes. A file already READ is a duplicate and stops here — the
//      same attachment arriving twice, or emailed and also uploaded. A file
//      seen before but NOT read (failed, or saved for a parser that didn't
//      exist yet) is read again, so improving a parser and re-reading the
//      saved files (reprocess.ts) picks up the backlog.
//   2. Decide the platform: what the file's contents are, if they are a
//      Zomato or Swiggy settlement report (both name their sheet 'Order Level',
//      so each is told by its payout column); else the caller's hint (the
//      sender's domain, or the owner's choice); else the file's name. The
//      contents win over a hint that disagrees, with a warning on the report.
//   3. Save the raw file to Storage, then parse. Zomato .xlsx → orders and
//      deductions; Zomato .csv → orders only; Swiggy .xlsx annexure → orders
//      and deductions. A Swiggy file that is not that annexure is kept as
//      'unsupported'.
//   4. Write orders and deductions, NEWER REPORT WINS per row: a row from a
//      report whose period ends earlier than the one already stored is
//      dropped, so re-reading an old file never turns a settled order back to
//      pending. A report that lists the same order (or the same deduction)
//      twice is collapsed to one row first, or Postgres would refuse the lot.
//
// While the rows are being written the report is 'failed' with INTERRUPTED as
// its error, and only the last step makes it 'read'. A run killed part-way
// (an upsert that throws, the 60 s limit) therefore leaves a report the next
// ingest of the same bytes reads again, not a 'read' one with no rows that
// every retry would call a duplicate.
//
// Storage and the database sit behind SettlementStore so this file is tested
// against an in-memory store (tests/onlineSettlementsIngest.test.ts) and runs
// against Supabase through store.ts.

export interface ReportRow {
  platform: Platform;
  source: 'email' | 'upload';
  file_name: string;
  file_sha256: string;
  file_bytes: number;
  storage_path: string | null;
  email_message_id: string | null;
  email_from: string | null;
  email_subject: string | null;
  email_received_at: string | null;
  restaurant_ref: string | null;
  period_start: string | null;
  period_end: string | null;
  status: 'read' | 'unsupported' | 'failed';
  error: string | null;
  orders_count: number;
  deductions_count: number;
  warnings: string[];
  read_at: string | null;
}

/** A report's error while its rows are still being written: the mail check reads such a report again. */
export const INTERRUPTED = 'Reading stopped before every order was saved: it will be read again';

export interface SettlementStore {
  findReportByHash(sha256: string): Promise<{ id: string; status: string } | null>;
  saveFile(path: string, bytes: Uint8Array, contentType: string): Promise<boolean>;
  /** A saved raw file back from Storage, or null when it can't be fetched. */
  readFile(path: string): Promise<Uint8Array | null>;
  insertReport(row: ReportRow): Promise<string>;
  updateReport(id: string, patch: Partial<ReportRow>): Promise<void>;
  /** order_id → report_period_end ('' when unknown) for the ids already stored. */
  orderPeriods(platform: Platform, orderIds: string[]): Promise<Map<string, string>>;
  upsertOrders(rows: Record<string, unknown>[]): Promise<void>;
  /** dedupe key (see deductionKey) → report_period_end ('' when unknown). */
  deductionPeriods(platform: Platform): Promise<Map<string, string>>;
  upsertDeductions(rows: Record<string, unknown>[]): Promise<void>;
}

export interface IngestInput {
  bytes: Uint8Array;
  fileName: string;
  source: 'email' | 'upload';
  /** From the sender's domain (email) or the owner's pick (upload). */
  platformHint?: Platform | null;
  email?: { messageId: string | null; from: string | null; subject: string | null; receivedAt: string | null };
  now?: () => Date;
}

export type IngestStatus = 'read' | 'duplicate' | 'unsupported' | 'failed';

export interface IngestOutcome {
  status: IngestStatus;
  fileName: string;
  platform: Platform | null;
  reportId?: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  orders?: number;
  /** Rows dropped because a newer report already holds them. */
  olderRowsSkipped?: number;
  message?: string;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function deductionKey(d: { kind: string; label: string; ref: string; period_text: string }): string {
  return [d.kind, d.label, d.ref, d.period_text].join('\u0000');
}

/**
 * One row per order id, and one per deduction key: a report that repeats one
 * would make Postgres refuse the whole upsert ("ON CONFLICT DO UPDATE command
 * cannot affect row a second time"). An order seen twice keeps its last row;
 * deduction rows sharing a key have their amounts added. Each is noted in the
 * report's warnings.
 */
export function collapseDuplicates(parsed: ParsedSettlement): ParsedSettlement {
  const orders = new Map<string, SettlementOrder>();
  for (const o of parsed.orders) orders.set(o.orderId, o);
  const deductions = new Map<string, SettlementDeduction>();
  for (const d of parsed.deductions) {
    const key = deductionKey({ kind: d.kind, label: d.label, ref: d.ref, period_text: d.periodText });
    const first = deductions.get(key);
    deductions.set(
      key,
      first
        ? { ...first, amount: first.amount + d.amount, settled: first.settled + d.settled, outstanding: first.outstanding + d.outstanding }
        : d,
    );
  }
  const warnings = [...parsed.warnings];
  const repeatedOrders = parsed.orders.length - orders.size;
  if (repeatedOrders) warnings.push(`${repeatedOrders} order row(s) repeated an order id in this report: only the last one is kept`);
  const repeatedDeductions = parsed.deductions.length - deductions.size;
  if (repeatedDeductions) {
    warnings.push(`${repeatedDeductions} deduction row(s) repeated another row's type, reference and period: their amounts were added together`);
  }
  return { ...parsed, orders: [...orders.values()], deductions: [...deductions.values()], warnings };
}

/** Keep an incoming row unless the stored copy came from a report ending later. */
export function isNotOlder(incomingPeriodEnd: string | null, storedPeriodEnd: string | undefined): boolean {
  if (storedPeriodEnd === undefined) return true;
  return (incomingPeriodEnd ?? '') >= storedPeriodEnd;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function orderRow(platform: Platform, reportId: string, parsed: ParsedSettlement, o: SettlementOrder, nowIso: string) {
  return {
    platform,
    order_id: o.orderId,
    report_id: reportId,
    report_period_end: parsed.periodEnd,
    restaurant_ref: parsed.restaurantRef,
    ordered_at: o.orderedAt,
    status: o.status,
    order_type: o.orderType,
    offer: o.offer,
    payment_mode: o.paymentMode,
    cancel_reason: o.cancelReason,
    cancel_stage: o.cancelStage,
    refund_policy: o.refundPolicy,
    menu_sales_inr: r2(o.menuSales),
    packaging_inr: r2(o.packaging),
    discount_inr: r2(o.discount),
    gst_from_customer_inr: r2(o.gstFromCustomer),
    net_order_value_inr: r2(o.netOrderValue),
    commission_pct: o.commissionPct,
    commission_inr: r2(o.commission),
    payment_fee_inr: r2(o.paymentFee),
    gst_on_fees_inr: r2(o.gstOnFees),
    tcs_inr: r2(o.tcs),
    tds_inr: r2(o.tds),
    gst_paid_by_platform_inr: r2(o.gstPaidByPlatform),
    gst_due_by_restaurant_inr: r2(o.gstDueByRestaurant),
    other_deductions_inr: r2(o.otherDeductions),
    additions_inr: r2(o.additions),
    payout_inr: r2(o.payout),
    settlement_status: o.settlementStatus,
    settlement_date: o.settlementDate,
    utr: o.utr,
    unsettled_inr: r2(o.unsettled),
    customer_ref: o.customerRef,
    updated_at: nowIso,
  };
}

export function deductionRow(platform: Platform, reportId: string, parsed: ParsedSettlement, d: SettlementDeduction, nowIso: string) {
  return {
    platform,
    report_id: reportId,
    report_period_end: parsed.periodEnd,
    kind: d.kind,
    label: d.label,
    ref: d.ref,
    period_text: d.periodText,
    period_start: d.periodStart,
    period_end: d.periodEnd,
    settlement_status: d.settlementStatus,
    amount_inr: r2(d.amount),
    settled_inr: r2(d.settled),
    outstanding_inr: r2(d.outstanding),
    updated_at: nowIso,
  };
}

const CONTENT_TYPE: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  csv: 'text/csv',
  zip: 'application/zip',
};

const CHUNK = 500;

const EMAIL_FIELDS = ['email_message_id', 'email_from', 'email_subject', 'email_received_at'] as const;

export async function ingestSettlementFile(store: SettlementStore, input: IngestInput): Promise<IngestOutcome> {
  const now = input.now ?? (() => new Date());
  const { bytes, fileName } = input;
  const base = { fileName, platform: input.platformHint ?? null } as const;

  if (!isReportAttachment(fileName)) {
    return { ...base, status: 'failed', message: 'Not a spreadsheet: send the .xlsx (or .csv/.zip) report' };
  }

  const sha = sha256Hex(bytes);
  const seen = await store.findReportByHash(sha);
  if (seen?.status === 'read') return { ...base, status: 'duplicate', reportId: seen.id, message: 'Already read' };

  // A .csv is its one sheet, 'Order Level'.
  const isCsv = /\.csv$/i.test(fileName);
  let sheets: Sheets | null = null;
  let readError: string | null = null;
  if (isCsv) {
    sheets = { 'Order Level': readCsv(bytes) };
  } else if (/\.xlsx$/i.test(fileName) && looksLikeXlsx(bytes)) {
    try {
      sheets = await readWorkbook(bytes);
    } catch (err) {
      // A refusal (too large, damaged) is already in the owner's words.
      readError = err instanceof WorkbookRefused ? err.message : `Could not open the workbook: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const claimed = input.platformHint ?? platformFromFileName(fileName);
  const inside: Platform | null = sheets ? (isZomatoSettlement(sheets) ? 'zomato' : isSwiggySettlement(sheets) ? 'swiggy' : null) : null;
  const platform = inside ?? claimed;
  if (!platform) {
    return { ...base, status: 'failed', message: 'Not a Zomato or Swiggy settlement report' };
  }

  const ext = (fileName.match(/\.([a-z]+)$/i)?.[1] ?? '').toLowerCase();
  const path = `${platform}/${sha.slice(0, 2)}/${sha}-${safeFileName(fileName)}`;
  const saved = await store.saveFile(path, bytes, CONTENT_TYPE[ext] ?? 'application/octet-stream');

  let parsed: ParsedSettlement | null = null;
  let status: ReportRow['status'];
  let error: string | null = null;
  if (platform === 'zomato') {
    if (!sheets) {
      status = 'failed';
      error = readError ?? 'Zomato reports are read from the .xlsx or .csv file; this file is not one';
    } else if (!hasZomatoOrderTable(sheets)) {
      status = 'failed';
      error = isCsv
        ? 'The CSV has no Order ID and Order Date columns: not a Zomato settlement report we can read yet'
        : 'No "Order Level" sheet with Order ID and Order Date columns: not a Zomato settlement report';
    } else {
      parsed = collapseDuplicates(parseZomatoSettlement(sheets, fileName));
      if (parsed.orders.length === 0 && parsed.deductions.length === 0) {
        status = 'failed';
        error = parsed.warnings[0] ?? 'The report has no orders';
      } else {
        status = 'read';
      }
    }
  } else if (!sheets || !isSwiggySettlement(sheets)) {
    status = 'unsupported';
    error =
      readError ??
      'Not Swiggy\'s weekly payout annexure (an .xlsx with an "Order Level" sheet that has a "Net Payout for Order" column), so it is kept but not read';
  } else {
    parsed = collapseDuplicates(parseSwiggySettlement(sheets, fileName));
    if (parsed.orders.length === 0 && parsed.deductions.length === 0) {
      status = 'failed';
      error = parsed.warnings[0] ?? 'The report has no orders';
    } else {
      status = 'read';
    }
  }
  if (parsed && claimed && platform !== claimed) {
    parsed.warnings.unshift(
      `Arrived as a ${PLATFORM_LABEL[claimed]} report (sender, file name or your choice), but its contents are a ${PLATFORM_LABEL[platform]} settlement report: read as ${PLATFORM_LABEL[platform]}`,
    );
  }

  const nowIso = now().toISOString();
  // A report to be read is saved as 'failed' (INTERRUPTED) until its rows are in.
  const writing = status === 'read';
  const row: ReportRow = {
    platform,
    source: input.source,
    file_name: fileName,
    file_sha256: sha,
    file_bytes: bytes.length,
    storage_path: saved ? path : null,
    email_message_id: input.email?.messageId ?? null,
    email_from: input.email?.from ?? null,
    email_subject: input.email?.subject ?? null,
    email_received_at: input.email?.receivedAt ?? null,
    restaurant_ref: parsed?.restaurantRef ?? null,
    period_start: parsed?.periodStart ?? null,
    period_end: parsed?.periodEnd ?? null,
    status: writing ? 'failed' : status,
    error: writing ? INTERRUPTED : error,
    orders_count: 0,
    deductions_count: 0,
    warnings: parsed?.warnings ?? [],
    read_at: null,
  };

  let reportId: string;
  if (seen) {
    reportId = seen.id;
    // A failed re-save must not wipe the path of the copy already kept, and a
    // re-upload (no email details) must not wipe the email ones already there.
    const { file_sha256: _sha, storage_path, ...rest } = row;
    const patch: Partial<ReportRow> = saved ? { ...rest, storage_path } : rest;
    for (const k of EMAIL_FIELDS) if (patch[k] === null) delete patch[k];
    await store.updateReport(reportId, patch);
  } else {
    reportId = await store.insertReport(row);
  }

  if (status !== 'read' || !parsed) {
    // Seen before and still not readable: not news, so a daily mail check
    // doesn't report the same unreadable file as a fresh failure every day.
    if (seen && seen.status === status) {
      return { status: 'duplicate', fileName, platform, reportId, message: error ?? undefined };
    }
    return { status: status === 'unsupported' ? 'unsupported' : 'failed', fileName, platform, reportId, message: error ?? undefined };
  }

  // Orders, newer report wins.
  const stored = await store.orderPeriods(platform, parsed.orders.map((o) => o.orderId));
  const keep = parsed.orders.filter((o) => isNotOlder(parsed!.periodEnd, stored.get(o.orderId)));
  const orderRows = keep.map((o) => orderRow(platform, reportId, parsed!, o, nowIso));
  for (let i = 0; i < orderRows.length; i += CHUNK) await store.upsertOrders(orderRows.slice(i, i + CHUNK));

  // Deductions, same rule.
  const storedDed = await store.deductionPeriods(platform);
  const dedRows = parsed.deductions
    .map((d) => deductionRow(platform, reportId, parsed!, d, nowIso))
    .filter((d) => isNotOlder(d.report_period_end, storedDed.get(deductionKey(d))));
  if (dedRows.length) await store.upsertDeductions(dedRows);

  const olderRowsSkipped = parsed.orders.length - keep.length + (parsed.deductions.length - dedRows.length);
  await store.updateReport(reportId, {
    status: 'read',
    error: null,
    orders_count: parsed.orders.length,
    deductions_count: parsed.deductions.length,
    read_at: nowIso,
    warnings: olderRowsSkipped
      ? [...parsed.warnings, `${olderRowsSkipped} row(s) left as they were: a newer report already has them`]
      : parsed.warnings,
  });

  return {
    status: 'read',
    fileName,
    platform,
    reportId,
    periodStart: parsed.periodStart,
    periodEnd: parsed.periodEnd,
    orders: parsed.orders.length,
    olderRowsSkipped,
  };
}
