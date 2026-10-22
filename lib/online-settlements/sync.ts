import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ingestSettlementFile, type IngestOutcome } from './ingest';
import { friendlyMailboxError, mailboxConfigFromEnv, scanMailbox, type SkippedMessage } from './mailbox';
import { supabaseSettlementStore } from './store';

// One mailbox check: find the platforms' recent emails, read every report
// attachment, and log the run (online_settlement_sync_runs) so Owner → Online
// orders can show when mail was last checked and what came of it. Run by the
// daily cron and by the owner's "Check email now".

export interface SyncResult {
  configured: boolean;
  ok: boolean;
  runId: string | null;
  lookbackDays: number;
  messagesFound: number;
  /** Report emails left for another run (each run downloads at most 60). */
  messagesLeft: number;
  filesFound: number;
  filesRead: number;
  filesSkipped: number;
  filesFailed: number;
  error: string | null;
  files: Pick<IngestOutcome, 'fileName' | 'platform' | 'status' | 'periodStart' | 'periodEnd' | 'orders' | 'message'>[];
  skippedMessages: SkippedMessage[];
}

const PAGE = 1000;

/** Message-IDs that already produced a report row: the mailbox scan skips them unread. */
async function knownMessageIds(admin: SupabaseClient): Promise<Set<string>> {
  const out = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from('online_settlement_reports')
      .select('email_message_id')
      .not('email_message_id', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`online_settlement_reports: ${error.message}`);
    const rows = (data ?? []) as { email_message_id: string }[];
    for (const r of rows) out.add(r.email_message_id);
    if (rows.length < PAGE) break;
  }
  return out;
}

export const NOT_CONFIGURED =
  'Email is not set up yet: add ONLINE_REPORTS_IMAP_USER and ONLINE_REPORTS_IMAP_PASSWORD (docs/ONLINE-SETTLEMENTS.md).';

export async function runOnlineReportSync(
  admin: SupabaseClient,
  trigger: 'cron' | 'owner',
  opts: { lookbackDays?: number } = {},
): Promise<SyncResult> {
  const cfg = mailboxConfigFromEnv();
  const lookbackDays = Math.min(Math.max(Math.round(opts.lookbackDays ?? cfg?.lookbackDays ?? 14), 1), 400);
  const result: SyncResult = {
    configured: !!cfg,
    ok: false,
    runId: null,
    lookbackDays,
    messagesFound: 0,
    messagesLeft: 0,
    filesFound: 0,
    filesRead: 0,
    filesSkipped: 0,
    filesFailed: 0,
    error: null,
    files: [],
    skippedMessages: [],
  };
  if (!cfg) {
    result.error = NOT_CONFIGURED;
    return result;
  }

  const { data: run, error: runErr } = await admin
    .from('online_settlement_sync_runs')
    .insert({ trigger, lookback_days: lookbackDays })
    .select('id')
    .single();
  if (runErr || !run) {
    result.error = /online_settlement_sync_runs/.test(runErr?.message ?? '')
      ? 'Apply supabase/2026-10-online-settlements.sql first'
      : `Could not start the mail check: ${runErr?.message ?? 'no row'}`;
    return result;
  }
  result.runId = (run as { id: string }).id;

  try {
    const scan = await scanMailbox(cfg, lookbackDays, await knownMessageIds(admin));
    result.messagesFound = scan.messagesFound;
    result.messagesLeft = scan.messagesLeft;
    result.skippedMessages = scan.skipped;
    result.filesFound = scan.attachments.length;
    const store = supabaseSettlementStore(admin);
    for (const a of scan.attachments) {
      let outcome: IngestOutcome;
      try {
        outcome = await ingestSettlementFile(store, {
          bytes: a.bytes,
          fileName: a.fileName,
          source: 'email',
          platformHint: a.platform,
          email: a.email,
        });
      } catch (err) {
        console.error('online-settlements: ingest failed', a.fileName, err);
        outcome = { status: 'failed', fileName: a.fileName, platform: a.platform, message: err instanceof Error ? err.message : String(err) };
      }
      if (outcome.status === 'read') result.filesRead++;
      else if (outcome.status === 'duplicate') result.filesSkipped++;
      else if (outcome.status === 'failed') result.filesFailed++;
      result.files.push({
        fileName: outcome.fileName,
        platform: outcome.platform,
        status: outcome.status,
        periodStart: outcome.periodStart,
        periodEnd: outcome.periodEnd,
        orders: outcome.orders,
        message: outcome.message,
      });
    }
    result.ok = true;
  } catch (err) {
    console.error('online-settlements: mailbox scan failed', err);
    result.error = friendlyMailboxError(err);
  }

  const { error: finishErr } = await admin
    .from('online_settlement_sync_runs')
    .update({
      finished_at: new Date().toISOString(),
      messages_found: result.messagesFound,
      files_found: result.filesFound,
      files_read: result.filesRead,
      files_skipped: result.filesSkipped,
      files_failed: result.filesFailed,
      error: result.error,
      details: [...result.files, ...result.skippedMessages.map((s) => ({ ...s, status: 'skipped_message' }))].slice(0, 100),
    })
    .eq('id', result.runId);
  if (finishErr) console.error('online-settlements: run log update failed', finishErr.message);
  return result;
}
