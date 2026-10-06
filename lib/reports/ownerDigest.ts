// Owner report emails — a daily, weekly and monthly summary of how the cafe
// did, emailed to the owner (supabase/2026-10-owner-report-emails.sql).
//
// Pure: which reports are due on a given day, which dates each one covers,
// validating the owner's settings, and rendering the email. The numbers come
// from the reconciliation report (lib/reports/reconcile.ts), so an email and
// Owner → Reports for the same dates always agree. Fetching and sending live
// in lib/reports/ownerDigestServer.ts.
//
// Periods are whole IST days and always end YESTERDAY: the cron runs in the
// morning, so the day it runs on is never complete.
//   • daily   — yesterday.
//   • weekly  — the 7 days ending yesterday, sent on the owner's chosen
//               weekday (Monday → a Monday–Sunday week).
//   • monthly — from the chosen day of last month to yesterday, sent on that
//               day (1 → the calendar month; 5 → the 5th to the 4th).

import { CAFE_NAME } from '@/lib/constants';
import { escapeHtml, staffEmailShell } from '@/lib/staff/emails';
import { normalizeEmail } from '@/lib/email';
import {
  REPORT_METHODS,
  closingCountRows,
  closingDayOf,
  istDateOf,
  type CashDayRow,
  type ClosingCountRow,
  type Report,
} from '@/lib/reports/reconcile';

export type ReportKind = 'daily' | 'weekly' | 'monthly';
export const REPORT_KINDS: readonly ReportKind[] = ['daily', 'weekly', 'monthly'];

export function isReportKind(v: unknown): v is ReportKind {
  return v === 'daily' || v === 'weekly' || v === 'monthly';
}

export interface OwnerReportSettings {
  daily_enabled: boolean;
  daily_skip_empty: boolean;
  weekly_enabled: boolean;
  /** ISO weekday the weekly email goes out: 1 = Monday … 7 = Sunday. */
  weekly_send_dow: number;
  monthly_enabled: boolean;
  /** Day of the month (1–28) the monthly email goes out. */
  monthly_send_day: number;
  send_to_owner_login: boolean;
  recipients: string[];
}

export const DEFAULT_REPORT_SETTINGS: OwnerReportSettings = {
  daily_enabled: true,
  daily_skip_empty: true,
  weekly_enabled: true,
  weekly_send_dow: 1,
  monthly_enabled: true,
  monthly_send_day: 1,
  send_to_owner_login: true,
  recipients: [],
};

export const MAX_RECIPIENTS = 10;

// ── Dates (all 'YYYY-MM-DD' IST calendar dates) ─────────────────────────────

function toUtc(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(iso: string, n: number): string {
  const d = toUtc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Same day-of-month `n` months away. Only called with days ≤ 28, so it never overflows. */
function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, d)).toISOString().slice(0, 10);
}

/** ISO weekday: 1 = Monday … 7 = Sunday. */
export function isoWeekday(iso: string): number {
  return ((toUtc(iso).getUTCDay() + 6) % 7) + 1;
}

export interface ReportPeriod {
  kind: ReportKind;
  from: string;
  to: string;
}

/** The period a report sent on `sendDate` covers. */
function periodSentOn(kind: ReportKind, sendDate: string): ReportPeriod {
  const to = addDays(sendDate, -1);
  if (kind === 'daily') return { kind, from: to, to };
  if (kind === 'weekly') return { kind, from: addDays(sendDate, -7), to };
  return { kind, from: addMonths(sendDate, -1), to };
}

/** The reports the cron should send on IST date `today`, per the settings. */
export function dueReports(today: string, s: OwnerReportSettings): ReportPeriod[] {
  const due: ReportPeriod[] = [];
  if (s.daily_enabled) due.push(periodSentOn('daily', today));
  if (s.weekly_enabled && isoWeekday(today) === s.weekly_send_dow) due.push(periodSentOn('weekly', today));
  if (s.monthly_enabled && Number(today.slice(8, 10)) === s.monthly_send_day) due.push(periodSentOn('monthly', today));
  return due;
}

/**
 * The most recent COMPLETE period of a kind as of `today` — what "Send now"
 * and the preview show, whether or not that kind is switched on.
 */
export function latestPeriod(kind: ReportKind, today: string, s: OwnerReportSettings): ReportPeriod {
  if (kind === 'daily') return periodSentOn('daily', today);
  if (kind === 'weekly') {
    const back = (isoWeekday(today) - s.weekly_send_dow + 7) % 7;
    return periodSentOn('weekly', addDays(today, -back));
  }
  const day = Number(today.slice(8, 10));
  const sendDate =
    day >= s.monthly_send_day
      ? `${today.slice(0, 8)}${String(s.monthly_send_day).padStart(2, '0')}`
      : addMonths(`${today.slice(0, 8)}${String(s.monthly_send_day).padStart(2, '0')}`, -1);
  return periodSentOn('monthly', sendDate);
}

/** The period just before `p`, of the same kind — the comparison baseline. */
export function previousPeriod(p: ReportPeriod): ReportPeriod {
  if (p.kind === 'daily') return { kind: p.kind, from: addDays(p.from, -1), to: addDays(p.to, -1) };
  if (p.kind === 'weekly') return { kind: p.kind, from: addDays(p.from, -7), to: addDays(p.to, -7) };
  return { kind: p.kind, from: addMonths(p.from, -1), to: addDays(p.from, -1) };
}

// ── Settings validation ─────────────────────────────────────────────────────

const BOOLEAN_FIELDS = [
  'daily_enabled',
  'daily_skip_empty',
  'weekly_enabled',
  'monthly_enabled',
  'send_to_owner_login',
] as const;

/**
 * Validates a PATCH body into a settings patch. Unknown keys are ignored (an
 * old client can't write a future column); a bad value is rejected with a
 * message the owner can act on.
 */
export function parseSettingsPatch(
  body: Record<string, unknown>,
): { ok: true; patch: Partial<OwnerReportSettings> } | { ok: false; message: string } {
  const patch: Partial<OwnerReportSettings> = {};
  for (const key of BOOLEAN_FIELDS) {
    if (!(key in body)) continue;
    if (typeof body[key] !== 'boolean') return { ok: false, message: `${key} must be true or false.` };
    patch[key] = body[key] as boolean;
  }
  if ('weekly_send_dow' in body) {
    const v = body.weekly_send_dow;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 7) {
      return { ok: false, message: 'The weekly report day must be a weekday (1 = Monday … 7 = Sunday).' };
    }
    patch.weekly_send_dow = v;
  }
  if ('monthly_send_day' in body) {
    const v = body.monthly_send_day;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 28) {
      return { ok: false, message: 'The monthly report day must be between 1 and 28.' };
    }
    patch.monthly_send_day = v;
  }
  if ('recipients' in body) {
    const raw = body.recipients;
    if (!Array.isArray(raw) || raw.some((e) => typeof e !== 'string')) {
      return { ok: false, message: 'recipients must be a list of email addresses.' };
    }
    const out: string[] = [];
    for (const entry of raw as string[]) {
      if (!entry.trim()) continue;
      const email = normalizeEmail(entry);
      if (!email) return { ok: false, message: `"${entry.trim()}" is not a valid email address.` };
      if (!out.includes(email)) out.push(email);
    }
    if (out.length > MAX_RECIPIENTS) return { ok: false, message: `At most ${MAX_RECIPIENTS} extra addresses.` };
    patch.recipients = out;
  }
  if (Object.keys(patch).length === 0) return { ok: false, message: 'Nothing to update' };
  return { ok: true, patch };
}

/** A settings row as stored, with anything missing or malformed at its default. */
export function readReportSettings(row: Partial<Record<keyof OwnerReportSettings, unknown>> | null | undefined): OwnerReportSettings {
  const s = { ...DEFAULT_REPORT_SETTINGS };
  if (!row) return s;
  for (const key of BOOLEAN_FIELDS) if (typeof row[key] === 'boolean') s[key] = row[key] as boolean;
  if (typeof row.weekly_send_dow === 'number') s.weekly_send_dow = row.weekly_send_dow;
  if (typeof row.monthly_send_day === 'number') s.monthly_send_day = row.monthly_send_day;
  if (Array.isArray(row.recipients)) s.recipients = row.recipients.filter((e): e is string => typeof e === 'string');
  return s;
}

/** Every address a report goes to: owner logins (if on) plus the extras, de-duplicated. */
export function resolveRecipients(s: OwnerReportSettings, ownerLoginEmails: string[]): string[] {
  const all = [...(s.send_to_owner_login ? ownerLoginEmails : []), ...s.recipients];
  const out: string[] = [];
  for (const e of all) {
    const email = normalizeEmail(e);
    if (email && !out.includes(email)) out.push(email);
  }
  return out;
}

// ── Top sellers ─────────────────────────────────────────────────────────────

export interface ItemLineRow {
  name_snapshot: string | null;
  quantity: number | null;
  line_total_inr: number | null;
}

export interface TopItem {
  name: string;
  units: number;
  revenueInr: number;
}

/** Aggregates order lines by item name, top `limit` by revenue. */
export function topItems(rows: ItemLineRow[], limit = 5): TopItem[] {
  const byName = new Map<string, TopItem>();
  for (const r of rows) {
    const name = (r.name_snapshot ?? '').trim() || 'Unnamed item';
    const item = byName.get(name) ?? { name, units: 0, revenueInr: 0 };
    item.units += r.quantity ?? 0;
    item.revenueInr += r.line_total_inr ?? 0;
    byName.set(name, item);
  }
  return [...byName.values()]
    .sort((a, b) => b.revenueInr - a.revenueInr || b.units - a.units || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// ── Rendering ───────────────────────────────────────────────────────────────

/** True when nothing happened in the period — no orders and no money moved. */
export function isEmptyReport(r: Report): boolean {
  const t = r.totals;
  return t.orders === 0 && t.cancelled === 0 && t.receivedTotalInr === 0 && t.refundsTotalInr === 0;
}

function rupees(n: number): string {
  const sign = n < 0 ? '−' : '';
  return `${sign}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
}

function shortDate(iso: string): string {
  return toUtc(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function longDate(iso: string): string {
  return toUtc(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Human label for a period: 'Mon, 28 Sept 2026' / '21 Sept – 27 Sept' / 'September 2026'. */
export function periodLabel(p: ReportPeriod): string {
  if (p.kind === 'daily') return longDate(p.from);
  const calendarMonth = p.kind === 'monthly' && p.from.endsWith('-01') && addDays(p.to, 1).endsWith('-01');
  if (calendarMonth) {
    return toUtc(p.from).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  return `${shortDate(p.from)} – ${shortDate(p.to)}`;
}

const KIND_TITLE: Record<ReportKind, string> = { daily: 'Daily report', weekly: 'Weekly report', monthly: 'Monthly report' };
const VS_LABEL: Record<ReportKind, string> = { daily: 'the day before', weekly: 'the week before', monthly: 'the month before' };
const METHOD_LABEL = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  online: 'Online',
  swiggy_dineout: 'Swiggy Dineout',
  zomato_district: 'Zomato District',
} as const;

/** % change from `prev` to `cur`, or null with no baseline. */
export function pctChange(cur: number, prev: number): number | null {
  if (prev <= 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

function aov(r: Report): number {
  return r.totals.orders > 0 ? r.totals.netSalesInr / r.totals.orders : 0;
}

// ── The cash drawer ─────────────────────────────────────────────────────────

interface DrawerLine {
  k: string;
  v: string;
  style?: string;
}

interface DrawerSection {
  heading: string;
  lines: DrawerLine[];
  /** A closed day's count by denomination. */
  count?: { rows: ClosingCountRow[]; countedInr: number; floatLeftInr: number | null };
  note?: string;
}

const signed = (n: number) => `${n >= 0 ? '+' : '−'}${rupees(Math.abs(n))}`;
const varianceStyle = (n: number) => (n < 0 ? 'color:#b42318;font-weight:bold;' : 'font-weight:bold;');

/** 'Mon, 5 Oct, 3:02 pm' in IST. */
function istTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** One cash day, the way it was closed: float in, the day's cash, expected vs counted, what left the drawer. */
function cashDayLines(c: CashDayRow): DrawerLine[] {
  const lines: DrawerLine[] = [{ k: 'Opened', v: istTime(c.opened_at) }];
  if (c.status !== 'closed') {
    lines.push({ k: 'Opening float', v: rupees(c.opening_total_inr ?? 0) });
    lines.push({ k: 'Closing count', v: 'not counted — the day is still open', style: 'color:#b42318;font-weight:bold;' });
    return lines;
  }
  const os = c.over_short_inr ?? 0;
  const reason = (c.close_reason || c.notes || '').trim();
  lines.push({ k: 'Closed', v: istTime(c.closed_at) });
  lines.push({ k: 'Opening float', v: rupees(c.opening_total_inr ?? 0) });
  if (c.cash_sales_inr !== null && c.cash_sales_inr !== undefined) {
    const n = c.cash_sales_count;
    lines.push({ k: `Cash sales${n ? ` (${n})` : ''}`, v: `+${rupees(c.cash_sales_inr)}` });
  }
  if (c.cash_refunds_inr) lines.push({ k: 'Cash refunds', v: `−${rupees(c.cash_refunds_inr)}` });
  if (c.cash_in_inr) lines.push({ k: 'Cash in', v: `+${rupees(c.cash_in_inr)}` });
  if (c.cash_out_inr) lines.push({ k: 'Cash out', v: `−${rupees(c.cash_out_inr)}` });
  if (c.expenses_inr) lines.push({ k: 'of which expenses', v: `−${rupees(c.expenses_inr)}` });
  lines.push({ k: 'Expected in drawer', v: rupees(c.expected_cash_inr ?? 0) });
  lines.push({ k: 'Counted at close', v: rupees(c.counted_total_inr ?? 0), style: 'font-weight:bold;' });
  lines.push({ k: 'Over / short', v: signed(os), style: varianceStyle(os) });
  if (os !== 0 && reason) lines.push({ k: 'Reason', v: reason });
  if (c.handover_inr !== null && c.handover_inr !== undefined) {
    lines.push({ k: 'Handed over to owner/bank', v: rupees(c.handover_inr) });
    lines.push({ k: 'Float left in drawer', v: rupees(c.float_left_total_inr ?? 0) });
  }
  return lines;
}

/** The cash-drawer sections of an email: per cash day for a daily report, totals for a range. */
export function drawerSections(period: ReportPeriod, report: Report): DrawerSection[] {
  if (period.kind === 'daily') {
    const day = report.days[0];
    const cashDays = day?.cashDays ?? [];
    if (cashDays.length === 0) return [{ heading: 'Cash drawer', lines: [{ k: 'Cash day', v: 'not opened' }] }];
    return cashDays.map((c, i) => {
      const sec: DrawerSection = {
        heading: cashDays.length > 1 ? `Cash drawer — cash day ${i + 1} of ${cashDays.length}` : 'Cash drawer',
        lines: cashDayLines(c),
      };
      if (c.status === 'closed') {
        sec.count = { rows: closingCountRows(c), countedInr: c.counted_total_inr ?? 0, floatLeftInr: c.float_left_total_inr ?? null };
        if (c.closed_at && istDateOf(c.closed_at) > c.business_date) {
          sec.note = `Closed after midnight: cash taken after 12 am is in this drawer, but Money in counts it on ${shortDate(istDateOf(c.closed_at))}.`;
        }
      }
      return sec;
    });
  }

  const d = report.drawer;
  const daysClosed = report.days.filter((x) => x.cashDays.some((c) => c.status === 'closed')).length;
  const lines: DrawerLine[] = [
    { k: 'Days closed', v: `${daysClosed} of ${report.days.length}${d.open ? ` · ${d.open} still open` : ''}` },
  ];
  if (d.closed) {
    lines.push({ k: `Cash sales${d.cashSalesCount ? ` (${d.cashSalesCount})` : ''}`, v: rupees(d.cashSalesInr) });
    if (d.cashRefundsInr) lines.push({ k: 'Cash refunds', v: `−${rupees(d.cashRefundsInr)}` });
    if (d.cashInInr || d.cashOutInr) lines.push({ k: 'Cash in / out', v: `${rupees(d.cashInInr)} / −${rupees(d.cashOutInr)}` });
    if (d.expensesInr) lines.push({ k: 'Expenses from the drawer', v: `−${rupees(d.expensesInr)}` });
    lines.push({ k: 'Over / short', v: signed(d.overShortInr), style: varianceStyle(d.overShortInr) });
    lines.push({ k: 'Handed over to owner/bank', v: rupees(d.handoverInr), style: 'font-weight:bold;' });
    if (d.floatLeftInr !== null) lines.push({ k: 'Float left in drawer', v: rupees(d.floatLeftInr) });
  } else {
    lines.push({ k: 'Over / short', v: '—' });
  }
  const sections: DrawerSection[] = [{ heading: 'Cash drawer', lines }];

  // A week fits a line per day: what each close counted and how it tied out.
  if (period.kind === 'weekly' && d.closed) {
    sections.push({
      heading: 'Closing count by day',
      lines: report.days.flatMap((x) => {
        const c = closingDayOf(x);
        if (!c) return [];
        const label = toUtc(x.date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
        const os = x.cashDays.reduce((s, cd) => s + (cd.status === 'closed' ? cd.over_short_inr ?? 0 : 0), 0);
        return [{ k: `${label} · ${signed(os)}`, v: rupees(c.counted_total_inr ?? 0), style: os < 0 ? 'color:#b42318;' : '' }];
      }),
    });
  }
  return sections;
}

function countTableHtml(count: NonNullable<DrawerSection['count']>): string {
  if (count.rows.length === 0) {
    return `<tr><td colspan="2" style="padding:6px 0 0;font-size:12px;color:#6b6b6b;">Nothing counted by denomination.</td></tr>`;
  }
  const th = 'padding:8px 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#6b6b6b;font-weight:normal;';
  const td = 'padding:3px 0;font-size:13px;';
  const body = count.rows
    .map(
      (r) =>
        `<tr><td style="${td}">${escapeHtml(r.label)}</td><td style="${td}text-align:right;">${r.count}</td><td style="${td}text-align:right;">${escapeHtml(rupees(r.amountInr))}</td><td style="${td}text-align:right;color:#6b6b6b;">${r.floatLeft}</td></tr>`,
    )
    .join('');
  const total = `<tr><td style="${td}font-weight:bold;border-top:1px solid #e5e0d8;">Total</td><td style="${td}border-top:1px solid #e5e0d8;"></td><td style="${td}text-align:right;font-weight:bold;border-top:1px solid #e5e0d8;">${escapeHtml(rupees(count.countedInr))}</td><td style="${td}text-align:right;color:#6b6b6b;border-top:1px solid #e5e0d8;">${count.floatLeftInr === null ? '' : escapeHtml(rupees(count.floatLeftInr))}</td></tr>`;
  return `<tr><td colspan="2">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:6px;">
      <tr><th align="left" style="${th}">Closing count</th><th align="right" style="${th}">Count</th><th align="right" style="${th}">Amount</th><th align="right" style="${th}">Left as float</th></tr>
      ${body}${total}
    </table>
  </td></tr>`;
}

function countTableText(count: NonNullable<DrawerSection['count']>): string[] {
  if (count.rows.length === 0) return ['  Closing count: nothing counted by denomination'];
  return [
    '  Closing count by denomination:',
    ...count.rows.map((r) => `    ${r.label} × ${r.count} = ${rupees(r.amountInr)}${r.floatLeft ? ` (${r.floatLeft} left as float)` : ''}`),
    `    Total: ${rupees(count.countedInr)}`,
  ];
}

export interface DigestInput {
  period: ReportPeriod;
  report: Report;
  /** The period before, for "vs the week before". Null when it couldn't be loaded. */
  previous: Report | null;
  items: TopItem[];
  /** Absolute link to the full report on Owner → Reports. */
  reportUrl: string;
}

export interface DigestEmail {
  subject: string;
  html: string;
  text: string;
}

export function renderOwnerDigest({ period, report, previous, items, reportUrl }: DigestInput): DigestEmail {
  const t = report.totals;
  const label = periodLabel(period);
  const title = `${KIND_TITLE[period.kind]} — ${label}`;
  const vs = VS_LABEL[period.kind];

  const headline: { label: string; value: string; cur: number; prev: number | null }[] = [
    { label: 'Net sales', value: rupees(t.netSalesInr), cur: t.netSalesInr, prev: previous?.totals.netSalesInr ?? null },
    { label: 'Orders', value: String(t.orders), cur: t.orders, prev: previous?.totals.orders ?? null },
    { label: 'Average order', value: rupees(aov(report)), cur: aov(report), prev: previous ? aov(previous) : null },
    { label: 'Net received', value: rupees(t.netReceivedInr), cur: t.netReceivedInr, prev: previous?.totals.netReceivedInr ?? null },
  ];

  const deltaText = (cur: number, prev: number | null): string => {
    if (prev === null) return '';
    const pct = pctChange(cur, prev);
    if (pct === null) return '';
    return `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct)}%`;
  };

  const cell = 'padding:4px 0;font-size:13px;';
  const row = (k: string, v: string, style = '') =>
    `<tr><td style="${cell}color:#6b6b6b;">${escapeHtml(k)}</td><td style="${cell}text-align:right;${style}">${escapeHtml(v)}</td></tr>`;
  const section = (heading: string, rows: string) =>
    `<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:0.04em;color:#6b6b6b;margin:20px 0 6px;">${escapeHtml(heading)}</h2>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>`;

  const headlineHtml = headline
    .map((h) => {
      const d = deltaText(h.cur, h.prev);
      const color = d.startsWith('▲') ? '#067647' : '#b42318';
      return `<tr>
        <td style="padding:6px 0;font-size:13px;color:#6b6b6b;">${escapeHtml(h.label)}</td>
        <td style="padding:6px 0;text-align:right;font-size:17px;font-weight:bold;">${escapeHtml(h.value)}</td>
        <td style="padding:6px 0 6px 8px;text-align:right;font-size:12px;white-space:nowrap;color:${color};width:56px;">${escapeHtml(d)}</td>
      </tr>`;
    })
    .join('');

  const moneyRows =
    REPORT_METHODS.map((m) => row(METHOD_LABEL[m], rupees(t.received[m]))).join('') +
    (t.refundsTotalInr ? row('Refunds', `−${rupees(t.refundsTotalInr)}`, 'color:#b42318;') : '') +
    row('Net received', rupees(t.netReceivedInr), 'font-weight:bold;') +
    (t.tipsInr ? row('of which tips', rupees(t.tipsInr)) : '');

  const salesRows =
    row('Gross sales', rupees(t.grossSalesInr)) +
    row('GST included', rupees(t.taxInr)) +
    row('Discounts', rupees(t.discountInr)) +
    (t.settleDiscountInr ? row('Settle discounts', `−${rupees(t.settleDiscountInr)}`) : '') +
    row('Net sales', rupees(t.netSalesInr), 'font-weight:bold;') +
    row('Cancelled / rejected', String(t.cancelled));

  const itemsHtml = items.length
    ? section(
        'Top sellers',
        items.map((i) => row(`${i.name} × ${i.units}`, rupees(i.revenueInr))).join(''),
      )
    : '';

  // The drawer, by cash day (lib/reports/reconcile.ts): a single day shows
  // each close in full with its count by denomination; a range adds them up.
  const drawerHtml = drawerSections(period, report)
    .map((sec) =>
      section(
        sec.heading,
        sec.lines.map((l) => row(l.k, l.v, l.style)).join('') +
          (sec.count ? countTableHtml(sec.count) : '') +
          (sec.note ? `<tr><td colspan="2" style="padding:6px 0 0;font-size:12px;color:#6b6b6b;line-height:1.5;">${escapeHtml(sec.note)}</td></tr>` : ''),
      ),
    )
    .join('');

  // Weekly: every day. Monthly: the best and the slowest trading day.
  const daysHtml = (() => {
    if (period.kind === 'weekly') {
      return section(
        'Day by day',
        report.days
          .map((d) => row(`${toUtc(d.date).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', timeZone: 'UTC' })} · ${d.orders} orders`, rupees(d.netSalesInr)))
          .join(''),
      );
    }
    if (period.kind === 'monthly') {
      const trading = report.days.filter((d) => d.orders > 0);
      if (trading.length === 0) return '';
      const best = trading.reduce((a, b) => (b.netSalesInr > a.netSalesInr ? b : a));
      const slow = trading.reduce((a, b) => (b.netSalesInr < a.netSalesInr ? b : a));
      return section(
        'Days',
        row('Trading days', String(trading.length)) +
          row('Average per trading day', rupees(t.netSalesInr / trading.length)) +
          row(`Best day (${shortDate(best.date)})`, rupees(best.netSalesInr)) +
          row(`Slowest day (${shortDate(slow.date)})`, rupees(slow.netSalesInr)),
      );
    }
    return '';
  })();

  const unpaidHtml = t.unpaidOrders
    ? `<p style="font-size:13px;line-height:1.5;background:#fffaeb;border:1px solid #fedf89;border-radius:6px;padding:8px 10px;margin:16px 0 0;">${t.unpaidOrders} order${t.unpaidOrders === 1 ? '' : 's'} from these dates ${t.unpaidOrders === 1 ? 'is' : 'are'} still unpaid (${escapeHtml(rupees(t.unpaidInr))}).</p>`
    : '';

  const html = staffEmailShell(
    title,
    `<p style="font-size:14px;line-height:1.5;margin:0 0 8px;">How ${escapeHtml(CAFE_NAME)} did${period.kind === 'daily' ? '' : ` over ${escapeHtml(label)}`}. Changes are vs ${vs}.</p>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${headlineHtml}</table>
     ${unpaidHtml}
     ${itemsHtml}
     ${section('Money in', moneyRows)}
     ${section('Sales', salesRows)}
     ${daysHtml}
     ${drawerHtml}
     <p style="text-align:center;margin:24px 0 8px;"><a href="${escapeHtml(reportUrl)}" style="display:inline-block;background:#b08968;color:#fffdfa;text-decoration:none;font-weight:bold;padding:10px 20px;border-radius:6px;font-size:14px;">Open the full report</a></p>
     <p style="font-size:11px;color:#8a8a8a;line-height:1.5;margin-top:16px;">Sales count on the day an order was placed; money on the day it was received; the cash drawer by cash day, from when it was opened to when it was counted and closed. Change what you get and who gets it on Owner → Reports.</p>`,
  );

  const text = [
    `${CAFE_NAME} — ${title}`,
    '',
    ...headline.map((h) => `${h.label}: ${h.value}${deltaText(h.cur, h.prev) ? ` (${deltaText(h.cur, h.prev)} vs ${vs})` : ''}`),
    ...(t.unpaidOrders ? ['', `Still unpaid: ${t.unpaidOrders} orders, ${rupees(t.unpaidInr)}`] : []),
    ...(items.length ? ['', 'Top sellers:', ...items.map((i) => `  ${i.name} × ${i.units} — ${rupees(i.revenueInr)}`)] : []),
    '',
    'Money in:',
    ...REPORT_METHODS.map((m) => `  ${METHOD_LABEL[m]}: ${rupees(t.received[m])}`),
    ...(t.refundsTotalInr ? [`  Refunds: −${rupees(t.refundsTotalInr)}`] : []),
    ...drawerSections(period, report).flatMap((sec) => [
      '',
      `${sec.heading}:`,
      ...sec.lines.map((l) => `  ${l.k}: ${l.v}`),
      ...(sec.count ? countTableText(sec.count) : []),
      ...(sec.note ? [`  ${sec.note}`] : []),
    ]),
    '',
    `Full report: ${reportUrl}`,
  ].join('\n');

  const subject = `${KIND_TITLE[period.kind]} — ${label} · ${rupees(t.netSalesInr)} from ${t.orders} order${t.orders === 1 ? '' : 's'}`;
  return { subject, html, text };
}
