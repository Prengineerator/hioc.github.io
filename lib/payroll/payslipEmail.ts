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
//
// Nothing here throws: a finalize, or an owner clicking Resend, must never
// break because an email did. A missing staff_accounts/staff_emails table
// (migration not yet applied) degrades to 'skipped' / 'migration not applied'
// rather than an error.

import type { SupabaseClient } from '@supabase/supabase-js';
import { CAFE_NAME } from '@/lib/constants';
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

/**
 * Pure: render one staffer's payslip email from their FROZEN run line. Reads
 * only payroll_run_lines columns (+ the frozen adjustment reason in `detail`)
 * and the run's period — never recomputes anything.
 */
export function renderPayslipEmail(
  line: PayrollRunLine,
  run: Pick<PayrollRun, 'period_start' | 'period_end'>,
  staffName: string,
): PayslipEmailContent {
  const month = formatMonth(run.period_start);
  const name = (staffName || 'Staff').trim() || 'Staff';
  const first = name.split(' ')[0] || 'there';
  const detail = (line.detail ?? {}) as { adjustment_reason?: unknown };
  const adjustmentReason =
    typeof detail.adjustment_reason === 'string' ? detail.adjustment_reason.trim() : '';

  const attendanceRows: PayslipRow[] = [
    { label: 'Days present', value: String(line.days_present) },
    { label: 'Half days', value: String(line.days_half) },
    { label: 'Paid leave', value: String(line.days_paid_leave) },
    { label: 'Absent', value: String(line.days_absent) },
    { label: 'Weekly off', value: String(line.days_off) },
    { label: 'Hours worked', value: hm(line.worked_minutes) },
  ];
  if (line.ot_minutes > 0) attendanceRows.push({ label: 'Overtime', value: hm(line.ot_minutes) });
  if (line.late_marks > 0) {
    attendanceRows.push({ label: 'Late marks', value: String(line.late_marks) });
  }

  const moneyRows: PayslipRow[] = [{ label: 'Base pay', value: rupees(line.base_pay_inr) }];
  if (line.ot_pay_inr > 0) moneyRows.push({ label: 'Overtime pay', value: rupees(line.ot_pay_inr) });
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

  const html = staffEmailShell(
    `Payslip — ${escapeHtml(month)}`,
    `<p style="font-size:14px;line-height:1.5;">Hi ${escapeHtml(first)}, here is your payslip for <strong>${escapeHtml(month)}</strong>.</p>
     <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">${attendanceRows.map(rowHtml).join('')}</table>
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
      const outcome = await sendStaffEmail(admin, {
        userId: line.user_id,
        kind: 'payslip',
        ref: baseRef(runId),
        to,
        subject,
        html,
        text,
      });
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
    const ref = sentRow ? forcedResendRef(runId) : baseRef(runId);

    const names = await getStaffDisplayNames(admin, [userId]);
    const name = names.get(userId) ?? 'Staff';
    const { subject, html, text } = renderPayslipEmail(line, run, name);

    const outcome = await sendStaffEmail(admin, { userId, kind: 'payslip', ref, to, subject, html, text });
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
