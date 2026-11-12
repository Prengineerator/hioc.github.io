import 'server-only';

// SA-5 — payslip emails (docs/PHASE-5-STAFF-ACCOUNTS.md "Payslip emails").
//
// A finalized payroll run is a FROZEN snapshot (payroll_runs / payroll_run_lines,
// supabase/2026-08-attendance.sql) — a payslip is rendered from that snapshot's
// columns only, never recomputed, so a later rule change cannot silently
// restate what someone was told they were paid.
//
// Idempotency rides on staff_emails_payslip_once, the partial unique index on
// (user_id, ref) where kind='payslip' and status='sent' (supabase/2026-09-
// staff-accounts.sql). One ref = one successful send. The normal path
// (sendPayslipsForRun, called once per finalize and safe to call again) uses
// ref = runId and simply skips anyone who already has a 'sent' row there. An
// explicit single-person resend (resendPayslip) is allowed to re-send even
// after a 'sent' row exists — inserting a second 'sent' row at the same ref
// would violate the unique index, so a forced resend logs under a distinct
// ref (`${runId}:resend:<timestamp>`) instead. Both refs are treated as the
// same run's payslip history when reading status back (getPayslipStatuses).
// Either way the 'sent' row is written as a CLAIM before the email goes, and
// stepped down to 'failed' if it did not (sendPayslipOnce) — so the index stops
// the second EMAIL, not just the second log row.
//
// Nothing here throws: a finalize, or an owner clicking Resend, must never
// break because an email did. A missing staff_accounts/staff_emails table
// (migration not yet applied) degrades to 'skipped' / 'migration not applied'
// rather than an error.

import type { SupabaseClient } from '@supabase/supabase-js';
import { CAFE_NAME } from '@/lib/constants';
import { emailAdapter } from '@/lib/notifications/adapters';
import { sendStaffEmail, staffEmailShell, escapeHtml } from '@/lib/staff/emails';
import { getStaffDisplayNames } from '@/lib/staff/displayName';
import type { PayrollRun, PayrollRunLine } from '@/lib/types';

export const MIGRATION_NOT_APPLIED = 'migration not applied';

export interface PayslipEmailContent {
  subject: string;
  html: string;
  text: string;
}

export type PayslipEmailStatus = 'sent' | 'failed' | 'skipped';

export interface PayslipSendOutcome {
  userId: string;
  toEmail: string;
  status: PayslipEmailStatus;
  detail: string;
}

export interface PayslipStatus {
  userId: string;
  name: string;
  toEmail: string;
  status: PayslipEmailStatus | 'not_sent';
  detail: string;
  sentAt: string | null;
}

function rupees(n: number): string {
  const sign = n < 0 ? '−' : '';
  return `${sign}₹${Math.round(Math.abs(n)).toLocaleString('en-IN')}`;
}

function hm(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** '2026-08-01' -> 'August 2026'. Falls back to the raw string if unparseable. */
function formatMonth(periodStart: string): string {
  const match = /^(\d{4})-(\d{2})-\d{2}$/.exec(periodStart ?? '');
  if (!match) return periodStart ?? '';
  const [, y, m] = match;
  const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
  return d.toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

interface PayslipRow {
  label: string;
  value: string;
  negative?: boolean;
}

/** One day as frozen into payroll_run_lines.detail.days at finalize. */
interface FrozenDay {
  date: string;
  status: string;
  worked: number;
  /** When the day started counting (after early-clock-in rounding), ISO. */
  in?: string | null;
  /** The last clock-out, ISO. */
  out?: string | null;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Instant (ms) -> IST 'HH:MM', rounded to the nearest minute. */
function istClockMs(ms: number): string {
  return new Date(Math.round((ms + IST_OFFSET_MS) / 60_000) * 60_000).toISOString().slice(11, 16);
}

/** Rounded to the minute, the way the hours are. */
function toMinuteMs(ms: number): number {
  return Math.round(ms / 60_000) * 60_000;
}

/** A clock-out this close to "in + hours" is the same punch, shown so the row adds up. */
const SAME_PUNCH_MS = 2 * 60_000;

/** '2026-10-01' -> 'Thu 1 Oct'. */
function dayLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!match) return date ?? '';
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  const weekday = d.toLocaleDateString('en-IN', { weekday: 'short', timeZone: 'UTC' });
  const month = d.toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });
  return `${weekday} ${d.getUTCDate()} ${month}`;
}

const DAY_OFF_LABEL: Record<string, string> = {
  absent: 'Absent',
  weekly_off: 'Weekly off',
  paid_leave: 'Paid leave',
  unpaid_leave: 'Unpaid leave',
};

interface DayRow {
  day: string;
  in: string;
  out: string;
  hours: string;
}

/**
 * The day-by-day table: every employed day of the month with its counted
 * clock-in, clock-out and hours, so the staffer can check the total
 * themselves. A day with no work shows why (absent, weekly off, leave).
 */
function dayRows(days: FrozenDay[]): DayRow[] {
  return days
    .filter((d) => d.status !== 'not_employed')
    .map((d) => {
      const off = DAY_OFF_LABEL[d.status];
      if (d.worked <= 0) {
        return { day: dayLabel(d.date), in: '—', out: '—', hours: off ?? '0h 0m' };
      }
      const inMs = d.in ? Date.parse(d.in) : NaN;
      const outMs = d.out ? Date.parse(d.out) : NaN;
      // Hours are counted from exact seconds and rounded once, so rounding the
      // in and out times separately can leave a row a minute off (15:02:17 →
      // 00:09:33 is 9h 7m, but rounds to 15:02 → 00:10). When the clock-out is
      // the punch that ends those hours, show it as in + hours so every row
      // adds up. A day with a real break keeps its actual last clock-out.
      let outLabel = Number.isFinite(outMs) ? istClockMs(outMs) : '—';
      if (Number.isFinite(inMs) && Number.isFinite(outMs)) {
        const derived = toMinuteMs(inMs) + d.worked * 60_000;
        if (Math.abs(derived - outMs) <= SAME_PUNCH_MS) outLabel = istClockMs(derived);
      }
      return {
        day: dayLabel(d.date),
        in: Number.isFinite(inMs) ? istClockMs(inMs) : '—',
        out: outLabel,
        hours: off ? `${hm(d.worked)} (${off.toLowerCase()})` : hm(d.worked),
      };
    });
}

/**
 * Pure: render one staffer's payslip email from their FROZEN run line. Reads
 * only payroll_run_lines columns (+ the frozen adjustment reason, day-by-day
 * clock times and pre-deduction total in `detail`) and the run's period —
 * never recomputes anything.
 *
 * Shows hours and pay, a day-by-day table of when each day started and ended,
 * and only the deductions the owner chose to take. Overtime and late marks are
 * deliberately NOT broken out (the owner's choice): overtime is paid at the
 * same rate and is simply part of the hours.
 */
export function renderPayslipEmail(
  line: PayrollRunLine,
  run: Pick<PayrollRun, 'period_start' | 'period_end'>,
  staffName: string,
): PayslipEmailContent {
  const month = formatMonth(run.period_start);
  const name = (staffName || 'Staff').trim() || 'Staff';
  const first = name.split(' ')[0] || 'there';
  const detail = (line.detail ?? {}) as {
    adjustment_reason?: unknown;
    days?: unknown;
    net_before_deductions_inr?: unknown;
  };
  const adjustmentReason =
    typeof detail.adjustment_reason === 'string' ? detail.adjustment_reason.trim() : '';
  const days = Array.isArray(detail.days) ? dayRows(detail.days as FrozenDay[]) : [];
  // Pay for the hours worked, as ONE figure — overtime is paid at the same
  // rate and is not broken out. Taken from the frozen pre-deduction total so
  // the payslip adds up to net pay exactly; older runs without it fall back
  // to base + overtime.
  const earned =
    typeof detail.net_before_deductions_inr === 'number'
      ? detail.net_before_deductions_inr - line.adjustments_inr
      : line.base_pay_inr + line.ot_pay_inr;

  const attendanceRows: PayslipRow[] = [
    { label: 'Days present', value: String(line.days_present) },
    { label: 'Half days', value: String(line.days_half) },
    { label: 'Paid leave', value: String(line.days_paid_leave) },
    { label: 'Absent', value: String(line.days_absent) },
    { label: 'Weekly off', value: String(line.days_off) },
    { label: 'Hours worked', value: hm(line.worked_minutes) },
  ];

  // No separate overtime or late-mark lines — the owner's choice. The hours
  // are explained by the day-by-day table instead.
  const moneyRows: PayslipRow[] = [
    { label: `Pay for hours worked (${hm(line.worked_minutes)})`, value: rupees(earned) },
  ];
  if (line.deductions_inr > 0) {
    moneyRows.push({
      label: 'Deductions (lateness)',
      value: `−${rupees(line.deductions_inr)}`,
      negative: true,
    });
  }
  // CC-5 (docs/PHASE-5-CASH-COUNTS.md): an approved cash-drawer shortage,
  // already frozen into net_pay_inr — shown as its own line so it never reads
  // as unexplained lateness deduction.
  if (line.cash_shortage_inr > 0) {
    moneyRows.push({
      label: 'Cash shortage (approved)',
      value: `−${rupees(line.cash_shortage_inr)}`,
      negative: true,
    });
  }
  if (line.adjustments_inr !== 0) {
    const label = adjustmentReason ? `Adjustment — ${adjustmentReason}` : 'Adjustment';
    moneyRows.push({
      label,
      value: `${line.adjustments_inr < 0 ? '−' : '+'}${rupees(Math.abs(line.adjustments_inr))}`,
      negative: line.adjustments_inr < 0,
    });
  }

  const rowHtml = (r: PayslipRow) =>
    `<tr><td style="padding:4px 0;color:#6b6b6b;font-size:13px;">${escapeHtml(r.label)}</td><td style="padding:4px 0;text-align:right;font-size:13px;${
      r.negative ? 'color:#b42318;' : ''
    }">${escapeHtml(r.value)}</td></tr>`;

  const cell = 'padding:3px 0;font-size:12px;border-bottom:1px solid #f3f0eb;';
  const head = 'padding:4px 0;font-size:11px;color:#8a8a8a;text-align:left;font-weight:normal;';
  const daysHtml =
    days.length === 0
      ? ''
      : `<hr style="border:none;border-top:1px solid #eee;margin:16px 0;" />
     <p style="font-size:13px;font-weight:bold;margin:0 0 6px;">Day by day</p>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
       <tr><th style="${head}">Day</th><th style="${head}">In</th><th style="${head}">Out</th><th style="${head}text-align:right;">Hours</th></tr>
       ${days
         .map(
           (d) =>
             `<tr><td style="${cell}">${escapeHtml(d.day)}</td><td style="${cell}">${escapeHtml(d.in)}</td><td style="${cell}">${escapeHtml(d.out)}</td><td style="${cell}text-align:right;">${escapeHtml(d.hours)}</td></tr>`,
         )
         .join('')}
       <tr><td colspan="3" style="padding:6px 0 0;font-size:12px;font-weight:bold;">Total</td><td style="padding:6px 0 0;font-size:12px;font-weight:bold;text-align:right;">${escapeHtml(hm(line.worked_minutes))}</td></tr>
     </table>`;

  const html = staffEmailShell(
    `Payslip — ${escapeHtml(month)}`,
    `<p style="font-size:14px;line-height:1.5;">Hi ${escapeHtml(first)}, here is your payslip for <strong>${escapeHtml(month)}</strong>.</p>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">${attendanceRows.map(rowHtml).join('')}</table>
     ${daysHtml}
     <hr style="border:none;border-top:1px solid #eee;margin:16px 0;" />
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${moneyRows.map(rowHtml).join('')}
       <tr><td style="padding:10px 0 0;font-weight:bold;font-size:15px;">Net pay</td><td style="padding:10px 0 0;text-align:right;font-weight:bold;font-size:15px;">${rupees(line.net_pay_inr)}</td></tr>
     </table>
     <p style="font-size:12px;color:#8a8a8a;line-height:1.5;margin-top:20px;">Questions about this payslip? Ask ${escapeHtml(CAFE_NAME)}'s owner.</p>`,
  );

  const text = [
    `Payslip for ${name} — ${month}`,
    '',
    ...attendanceRows.map((r) => `${r.label}: ${r.value}`),
    ...(days.length > 0
      ? [
          '',
          'Day by day:',
          ...days.map((d) =>
            d.in === '—' ? `${d.day}: ${d.hours}` : `${d.day}: ${d.in} – ${d.out} = ${d.hours}`,
          ),
          `Total: ${hm(line.worked_minutes)}`,
        ]
      : []),
    '',
    ...moneyRows.map((r) => `${r.label}: ${r.value}`),
    '',
    `Net pay: ${rupees(line.net_pay_inr)}`,
  ].join('\n');

  return { subject: `Your ${CAFE_NAME} payslip — ${month}`, html, text };
}

function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  // PostgREST reports a missing table as PGRST205 (schema-cache miss); raw
  // Postgres 42P01 shows up on some paths.
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /relation .* does not exist|could not find the table/i.test(error.message ?? '');
}

const RESEND_REF_RE = /^resend:\d+$/;

/** The ref a normal (idempotent, per-run) payslip send is logged under. */
function baseRef(runId: string): string {
  return runId;
}

/** The ref a forced single-person resend is logged under — see file header. */
function forcedResendRef(runId: string): string {
  return `${runId}:resend:${Date.now()}`;
}

/** True when `ref` is either the run's base ref or one of its resend refs. */
function refBelongsToRun(ref: string, runId: string): boolean {
  if (ref === runId) return true;
  if (!ref.startsWith(`${runId}:`)) return false;
  return RESEND_REF_RE.test(ref.slice(runId.length + 1));
}

/**
 * What a claim row says while its payslip email is in flight — and keeps saying
 * if the process dies before the outcome is written, so the Payslips section
 * shows an honest "we don't know" rather than a clean 'sent'.
 */
export const PAYSLIP_CLAIM_NOTE = 'claimed — outcome not recorded';

function payslipFrom(): string | undefined {
  return process.env.RESEND_FROM_STAFF || undefined; // same sender as lib/staff/emails.ts; adapter falls back to RESEND_FROM
}

/**
 * One payslip email under `ref`, sent at most once: CLAIM the ref's one 'sent'
 * slot (staff_emails_payslip_once covers kind='payslip' AND status='sent', and
 * the table knows only sent/failed/skipped, so the claim IS a 'sent' row), then
 * send, then step the row down to 'failed' if the provider refused. Reading
 * "already sent?" and inserting the log only after the send (what this
 * replaced) let a finalize and a "send all" racing each other both email the
 * same person; the index only rejected the second log row, after the email.
 *
 * `taken` when the slot is already claimed or sent. No address → logged
 * 'skipped' exactly as sendStaffEmail always did. If the log will not take even
 * the claim (a fault other than the unique index), the email still goes via
 * sendStaffEmail, which logs it afterwards — as before this existed.
 */
async function sendPayslipOnce(
  admin: SupabaseClient,
  args: { userId: string; ref: string; to: string | null; subject: string; html: string; text: string },
): Promise<{ status: PayslipEmailStatus; detail: string; taken: boolean }> {
  const to = (args.to ?? '').trim();
  if (!to) {
    const outcome = await sendStaffEmail(admin, { ...args, kind: 'payslip', to: null });
    return { status: outcome.status, detail: outcome.detail, taken: false };
  }

  const { data: claimRow, error: claimError } = await admin
    .from('staff_emails')
    .insert({
      user_id: args.userId,
      kind: 'payslip',
      ref: args.ref,
      to_email: to,
      status: 'sent',
      provider_ref: '',
      error: PAYSLIP_CLAIM_NOTE,
    })
    .select('id')
    .maybeSingle();
  if (claimError?.code === '23505') return { status: 'skipped', detail: 'already sent', taken: true };
  if (claimError && isMissingRelation(claimError)) return { status: 'skipped', detail: MIGRATION_NOT_APPLIED, taken: false };
  if (claimError || !claimRow) {
    console.error('staff_emails payslip claim failed', args.userId, args.ref, claimError);
    const outcome = await sendStaffEmail(admin, { ...args, kind: 'payslip' });
    return { status: outcome.status, detail: outcome.detail, taken: false };
  }

  const res = await emailAdapter.send({
    to,
    channel: 'email',
    body: args.text,
    subject: args.subject,
    html: args.html,
    from: payslipFrom(),
  });
  const detail = res.ok ? '' : res.error || 'send failed';
  const patch = res.ok
    ? { error: '', provider_ref: res.providerRef }
    : { status: 'failed' as const, error: detail, provider_ref: res.providerRef };
  const { error: settleError } = await admin
    .from('staff_emails')
    .update(patch)
    .eq('id', (claimRow as { id: string }).id);
  if (settleError) console.error('staff_emails payslip outcome update failed', args.userId, args.ref, settleError);
  return { status: res.ok ? 'sent' : 'failed', detail, taken: false };
}

/**
 * Email every staffer on a FINALIZED run their payslip. Idempotent: a
 * staffer who already has a 'sent' payslip row for this run is skipped.
 * Never throws — a bad lookup, a missing migration, or a send failure all
 * come back as a per-user 'skipped'/'failed' outcome instead.
 */
export async function sendPayslipsForRun(
  admin: SupabaseClient,
  runId: string,
): Promise<PayslipSendOutcome[]> {
  try {
    const { data: runRow, error: runErr } = await admin
      .from('payroll_runs')
      .select('*')
      .eq('id', runId)
      .maybeSingle();
    if (runErr || !runRow) return [];
    const run = runRow as PayrollRun;
    if (run.status !== 'finalized') return [];

    const { data: lineRows, error: lineErr } = await admin
      .from('payroll_run_lines')
      .select('*')
      .eq('run_id', runId);
    if (lineErr) return [];
    const lines = (lineRows ?? []) as PayrollRunLine[];
    if (lines.length === 0) return [];

    const userIds = lines.map((l) => l.user_id);

    const { data: acctRows, error: acctErr } = await admin
      .from('staff_accounts')
      .select('user_id, personal_email')
      .in('user_id', userIds);
    if (isMissingRelation(acctErr)) {
      return lines.map((l) => ({
        userId: l.user_id,
        toEmail: '',
        status: 'skipped' as const,
        detail: MIGRATION_NOT_APPLIED,
      }));
    }
    const emailByUser = new Map(
      ((acctRows ?? []) as { user_id: string; personal_email: string | null }[]).map((r) => [
        r.user_id,
        r.personal_email,
      ]),
    );

    const { data: sentRows, error: sentErr } = await admin
      .from('staff_emails')
      .select('user_id')
      .eq('kind', 'payslip')
      .eq('ref', baseRef(runId))
      .eq('status', 'sent')
      .in('user_id', userIds);
    if (isMissingRelation(sentErr)) {
      return lines.map((l) => ({
        userId: l.user_id,
        toEmail: '',
        status: 'skipped' as const,
        detail: MIGRATION_NOT_APPLIED,
      }));
    }
    const alreadySent = new Set(((sentRows ?? []) as { user_id: string }[]).map((r) => r.user_id));

    const names = await getStaffDisplayNames(admin, userIds);

    const outcomes: PayslipSendOutcome[] = [];
    for (const line of lines) {
      const toEmail = emailByUser.get(line.user_id) ?? '';
      if (alreadySent.has(line.user_id)) {
        outcomes.push({ userId: line.user_id, toEmail, status: 'skipped', detail: 'already sent' });
        continue;
      }
      const to = emailByUser.get(line.user_id) ?? null;
      const name = names.get(line.user_id) ?? 'Staff';
      const { subject, html, text } = renderPayslipEmail(line, run, name);
      // The read above is only a fast path; the claim is what makes the send once-only.
      const outcome = await sendPayslipOnce(admin, { userId: line.user_id, ref: baseRef(runId), to, subject, html, text });
      outcomes.push({ userId: line.user_id, toEmail: to ?? '', status: outcome.status, detail: outcome.detail });
    }
    return outcomes;
  } catch (err) {
    console.error('sendPayslipsForRun failed', runId, err);
    return [];
  }
}

/**
 * Force-resend one staffer's payslip for a run, even if one was already sent.
 * See the file header for why a prior 'sent' row makes this log under a
 * distinct ref rather than colliding with staff_emails_payslip_once.
 */
export async function resendPayslip(
  admin: SupabaseClient,
  runId: string,
  userId: string,
): Promise<PayslipSendOutcome> {
  try {
    const { data: runRow } = await admin.from('payroll_runs').select('*').eq('id', runId).maybeSingle();
    const run = runRow as PayrollRun | null;
    if (!run || run.status !== 'finalized') {
      return { userId, toEmail: '', status: 'failed', detail: 'That run is not finalized.' };
    }

    const { data: lineRow, error: lineErr } = await admin
      .from('payroll_run_lines')
      .select('*')
      .eq('run_id', runId)
      .eq('user_id', userId)
      .maybeSingle();
    if (lineErr || !lineRow) {
      return { userId, toEmail: '', status: 'failed', detail: 'No payslip line for this person on this run.' };
    }
    const line = lineRow as PayrollRunLine;

    const { data: acctRow, error: acctErr } = await admin
      .from('staff_accounts')
      .select('personal_email')
      .eq('user_id', userId)
      .maybeSingle();
    if (isMissingRelation(acctErr)) {
      return { userId, toEmail: '', status: 'skipped', detail: MIGRATION_NOT_APPLIED };
    }
    const to = (acctRow as { personal_email: string | null } | null)?.personal_email ?? null;

    const { data: sentRow, error: sentErr } = await admin
      .from('staff_emails')
      .select('id')
      .eq('kind', 'payslip')
      .eq('ref', baseRef(runId))
      .eq('user_id', userId)
      .eq('status', 'sent')
      .maybeSingle();
    if (isMissingRelation(sentErr)) {
      return { userId, toEmail: '', status: 'skipped', detail: MIGRATION_NOT_APPLIED };
    }
    const names = await getStaffDisplayNames(admin, [userId]);
    const name = names.get(userId) ?? 'Staff';
    const { subject, html, text } = renderPayslipEmail(line, run, name);

    // A resend always sends. Under the run's base ref while that slot is free; if it is
    // taken — already sent, or claimed by a concurrent send since the read above — under a
    // distinct resend ref instead, which never collides with the once-only index.
    let outcome = sentRow
      ? null
      : await sendPayslipOnce(admin, { userId, ref: baseRef(runId), to, subject, html, text });
    if (!outcome || outcome.taken) {
      outcome = await sendPayslipOnce(admin, { userId, ref: forcedResendRef(runId), to, subject, html, text });
    }
    return { userId, toEmail: to ?? '', status: outcome.status, detail: outcome.detail };
  } catch (err) {
    console.error('resendPayslip failed', runId, userId, err);
    return {
      userId,
      toEmail: '',
      status: 'failed',
      detail: err instanceof Error ? err.message : 'Resend failed',
    };
  }
}

/**
 * Per-staffer payslip status for a run, for the owner's Payslips section:
 * the latest send attempt (across the base ref and any forced resends), or
 * 'not_sent' when nothing has been attempted yet.
 */
export async function getPayslipStatuses(
  admin: SupabaseClient,
  runId: string,
): Promise<PayslipStatus[]> {
  try {
    const { data: lineRows, error: lineErr } = await admin
      .from('payroll_run_lines')
      .select('user_id')
      .eq('run_id', runId);
    if (lineErr) return [];
    const userIds = [...new Set(((lineRows ?? []) as { user_id: string }[]).map((r) => r.user_id))];
    if (userIds.length === 0) return [];

    const names = await getStaffDisplayNames(admin, userIds);

    const { data: acctRows, error: acctErr } = await admin
      .from('staff_accounts')
      .select('user_id, personal_email')
      .in('user_id', userIds);
    const migrationMissing = isMissingRelation(acctErr);
    const emailByUser = new Map(
      ((acctRows ?? []) as { user_id: string; personal_email: string | null }[]).map((r) => [
        r.user_id,
        r.personal_email,
      ]),
    );

    let logRows: { user_id: string; ref: string; to_email: string; status: string; error: string; created_at: string }[] =
      [];
    if (!migrationMissing) {
      const { data, error } = await admin
        .from('staff_emails')
        .select('user_id, ref, to_email, status, error, created_at')
        .eq('kind', 'payslip')
        .or(`ref.eq.${runId},ref.like.${runId}:resend:%`)
        .in('user_id', userIds)
        .order('created_at', { ascending: false });
      if (!isMissingRelation(error)) {
        logRows = (data ?? []) as typeof logRows;
      }
    }
    // Defensive filter matching refBelongsToRun, in case a future ref shape
    // makes the `.like` above over-match (it can't today, but this function
    // is what the owner trusts, so don't rely on the query alone).
    logRows = logRows.filter((r) => refBelongsToRun(r.ref, runId));

    const latestByUser = new Map<string, (typeof logRows)[number]>();
    for (const row of logRows) {
      if (!latestByUser.has(row.user_id)) latestByUser.set(row.user_id, row);
    }

    return userIds.map((userId) => {
      const name = names.get(userId) ?? 'Staff';
      if (migrationMissing) {
        return { userId, name, toEmail: '', status: 'skipped', detail: MIGRATION_NOT_APPLIED, sentAt: null };
      }
      const latest = latestByUser.get(userId);
      if (latest) {
        return {
          userId,
          name,
          toEmail: latest.to_email,
          status: latest.status as PayslipEmailStatus,
          detail: latest.error ?? '',
          sentAt: latest.created_at,
        };
      }
      return {
        userId,
        name,
        toEmail: emailByUser.get(userId) ?? '',
        status: 'not_sent',
        detail: '',
        sentAt: null,
      };
    });
  } catch (err) {
    console.error('getPayslipStatuses failed', runId, err);
    return [];
  }
}
