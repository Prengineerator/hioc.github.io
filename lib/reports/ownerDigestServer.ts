// Owner report emails — loading the settings, building a report email and
// sending it (supabase/2026-10-owner-report-emails.sql). The rules — which
// reports are due, which dates they cover, what the email says — are pure, in
// lib/reports/ownerDigest.ts.
//
// Nothing here throws on a send: every attempt, sent or not, is logged in
// owner_report_sends so "why didn't I get my report?" has an answer on
// Owner → Reports. A scheduled report goes to each address once per period
// (owner_report_sends_cron_once), however many times the cron runs.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { emailAdapter } from '@/lib/notifications/adapters';
import { absoluteUrl } from '@/lib/url';
import { loadReport, fetchAll, type PageResult } from '@/lib/reports/reconcileServer';
import { rangeBounds } from '@/lib/reports/reconcile';
import {
  isEmptyReport,
  previousPeriod,
  readReportSettings,
  renderOwnerDigest,
  topItems,
  type DigestEmail,
  type ItemLineRow,
  type OwnerReportSettings,
  type ReportPeriod,
} from '@/lib/reports/ownerDigest';

export const MIGRATION_NOT_APPLIED = 'Owner report emails migration not applied — run supabase/2026-10-owner-report-emails.sql';

const IN_CHUNK = 200;

export function isMissingRelation(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === '42P01' || error.code === 'PGRST205') return true;
  return /relation .* does not exist|could not find the table/i.test(error.message ?? '');
}

/** The saved settings, or the defaults with `migrated: false` when the table isn't there yet. */
export async function loadReportSettings(
  admin: SupabaseClient,
): Promise<{ settings: OwnerReportSettings; migrated: boolean }> {
  const { data, error } = await admin.from('owner_report_settings').select('*').eq('is_singleton', true).maybeSingle();
  if (isMissingRelation(error)) return { settings: readReportSettings(null), migrated: false };
  if (error) throw new Error(`owner_report_settings read failed: ${error.message}`);
  return { settings: readReportSettings(data), migrated: true };
}

export async function saveReportSettings(
  admin: SupabaseClient,
  patch: Partial<OwnerReportSettings>,
  userId: string,
): Promise<OwnerReportSettings> {
  // Upsert, not update: a database where the migration's seed insert was
  // skipped still ends up with its one row.
  const { data, error } = await admin
    .from('owner_report_settings')
    .upsert({ is_singleton: true, ...patch, updated_by: userId, updated_at: new Date().toISOString() }, { onConflict: 'is_singleton' })
    .select('*')
    .maybeSingle();
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return readReportSettings(data);
}

/** The login email of every owner account — where the reports go by default. */
export async function ownerLoginEmails(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin.from('profiles').select('id').eq('role', 'owner');
  if (error) {
    console.error('ownerLoginEmails: profiles lookup failed', error);
    return [];
  }
  const emails: string[] = [];
  for (const { id } of (data ?? []) as { id: string }[]) {
    const { data: u, error: uErr } = await admin.auth.admin.getUserById(id);
    if (uErr) console.error('ownerLoginEmails: auth lookup failed', id, uErr);
    const email = u?.user?.email;
    if (email) emails.push(email);
  }
  return emails;
}

/** Order lines from valid orders PLACED in the period (the report's sales clock). */
async function loadItemLines(admin: SupabaseClient, from: string, to: string): Promise<ItemLineRow[]> {
  const { startIso, endIso } = rangeBounds(from, to);
  const orders = await fetchAll<{ id: string }>((a, b) =>
    admin
      .from('orders')
      .select('id')
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .not('status', 'in', '(cancelled,rejected)')
      .order('created_at')
      .range(a, b) as unknown as PromiseLike<PageResult<{ id: string }>>,
  );
  const ids = orders.map((o) => o.id);
  const lines: ItemLineRow[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const rows = await fetchAll<ItemLineRow>((a, b) =>
      admin
        .from('order_items')
        .select('name_snapshot, quantity, line_total_inr')
        .in('order_id', chunk)
        .order('id')
        .range(a, b) as unknown as PromiseLike<PageResult<ItemLineRow>>,
    );
    lines.push(...rows);
  }
  return lines;
}

export interface BuiltDigest {
  email: DigestEmail;
  empty: boolean;
}

/**
 * The email for one period. Only the report itself is required: a failed
 * comparison or top-sellers lookup drops that section rather than the email.
 */
export async function buildDigest(admin: SupabaseClient, period: ReportPeriod): Promise<BuiltDigest> {
  const prev = previousPeriod(period);
  const [report, previous, lines] = await Promise.all([
    loadReport(admin, period.from, period.to),
    loadReport(admin, prev.from, prev.to).catch((err) => {
      console.error('owner digest: previous period failed', period.kind, err);
      return null;
    }),
    loadItemLines(admin, period.from, period.to).catch((err) => {
      console.error('owner digest: top items failed', period.kind, err);
      return [] as ItemLineRow[];
    }),
  ]);
  const email = renderOwnerDigest({
    period,
    report,
    previous,
    items: topItems(lines),
    reportUrl: absoluteUrl(`/owner/reports?from=${period.from}&to=${period.to}`),
  });
  return { email, empty: isEmptyReport(report) };
}

export interface SendOutcome {
  to: string;
  status: 'sent' | 'failed' | 'skipped';
  detail: string;
}

function reportsFrom(): string | undefined {
  return process.env.RESEND_FROM_REPORTS || undefined; // adapter falls back to RESEND_FROM
}

/**
 * Send one period's email to every recipient and log each attempt. A 'cron'
 * send skips an address that already has this period's report.
 */
export async function sendDigest(
  admin: SupabaseClient,
  period: ReportPeriod,
  email: DigestEmail,
  recipients: string[],
  trigger: 'cron' | 'manual',
): Promise<SendOutcome[]> {
  let alreadySent = new Set<string>();
  if (trigger === 'cron' && recipients.length) {
    const { data, error } = await admin
      .from('owner_report_sends')
      .select('to_email')
      .eq('kind', period.kind)
      .eq('period_start', period.from)
      .eq('trigger', 'cron')
      .eq('status', 'sent');
    if (error) console.error('owner digest: sent check failed', error);
    alreadySent = new Set(((data ?? []) as { to_email: string }[]).map((r) => r.to_email));
  }

  const outcomes: SendOutcome[] = [];
  for (const to of recipients) {
    if (alreadySent.has(to)) {
      outcomes.push({ to, status: 'skipped', detail: 'already sent' });
      continue;
    }
    const res = await emailAdapter.send({
      to,
      channel: 'email',
      body: email.text,
      subject: email.subject,
      html: email.html,
      from: reportsFrom(),
    });
    const outcome: SendOutcome = res.ok
      ? { to, status: 'sent', detail: '' }
      : { to, status: 'failed', detail: res.error || 'send failed' };
    outcomes.push(outcome);
    await logSend(admin, period, trigger, { ...outcome, providerRef: res.providerRef });
  }
  return outcomes;
}

export async function logSend(
  admin: SupabaseClient,
  period: ReportPeriod,
  trigger: 'cron' | 'manual',
  o: SendOutcome & { providerRef?: string },
): Promise<void> {
  const { error } = await admin.from('owner_report_sends').insert({
    kind: period.kind,
    period_start: period.from,
    period_end: period.to,
    trigger,
    to_email: o.to,
    status: o.status,
    provider_ref: o.providerRef ?? '',
    error: o.detail,
  });
  // 23505: a concurrent run already logged this period's send — the unique
  // index doing its job, not an error.
  if (error && error.code !== '23505') console.error('owner_report_sends log insert failed', error);
}

export interface SendLogRow {
  id: string;
  kind: string;
  period_start: string;
  period_end: string;
  trigger: string;
  to_email: string;
  status: string;
  error: string;
  created_at: string;
}

export async function recentSends(admin: SupabaseClient, limit = 20): Promise<SendLogRow[]> {
  const { data, error } = await admin
    .from('owner_report_sends')
    .select('id, kind, period_start, period_end, trigger, to_email, status, error, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    if (!isMissingRelation(error)) console.error('owner_report_sends read failed', error);
    return [];
  }
  return (data ?? []) as SendLogRow[];
}
