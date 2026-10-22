import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ingestSettlementFile, INTERRUPTED, type IngestOutcome, type SettlementStore } from './ingest';
import {
  friendlyMailboxError,
  mailboxConfigFromEnv,
  scanMailbox,
  type ScannedMessage,
  type SkippedMessage,
} from './mailbox';
import { REREAD_MAX_FILES, reprocessSavedReports } from './reprocess';
import { loadRereadableReports, supabaseSettlementStore } from './store';

// One mailbox check: find the platforms' recent emails, read every report
// attachment (one email at a time), and log the run (online_settlement_sync_
// runs) so Owner → Online orders can show when mail was last checked and what
// came of it. Run by the daily cron and by the owner's "Check email now".
//
// Both routes have a 60 s limit, so no new email or file is started after
// SYNC_TIME_BUDGET_MS; what is left is counted in messagesLeft and taken by the
// next run. An email handled in full is remembered in online_settlement_seen_
// messages (whatever came of it) so it is never downloaded again; one cut
// short by the time limit is not, so it is retried.

export interface SyncResult {
  configured: boolean;
  ok: boolean;
  runId: string | null;
  lookbackDays: number;
  messagesFound: number;
  /** Report emails (and interrupted reports) left for another run: each run downloads at most 60 and starts nothing new after 45 s. */
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

/** Stop starting new emails and files after this long, so the response still fits the routes' 60 s. */
export const SYNC_TIME_BUDGET_MS = 45_000;

/** One column of ids, paged in `orderBy` order (which must be unique, or a page can repeat or skip rows). */
async function idColumn(admin: SupabaseClient, table: string, column: string, orderBy: string): Promise<string[]> {
  const out: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await admin
      .from(table)
      .select(column)
      .not(column, 'is', null)
      .order(orderBy, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as unknown as Record<string, string>[];
    for (const r of rows) out.push(r[column]);
    if (rows.length < PAGE) break;
  }
  return out;
}

/**
 * Message-IDs already handled: those a report row carries, and those in the
 * seen-messages table (emails with nothing to read, or already read in full).
 * The mailbox scan skips them without downloading.
 */
async function knownMessageIds(admin: SupabaseClient): Promise<Set<string>> {
  const [fromReports, fromSeen] = await Promise.all([
    idColumn(admin, 'online_settlement_reports', 'email_message_id', 'id'),
    idColumn(admin, 'online_settlement_seen_messages', 'message_id', 'message_id'),
  ]);
  return new Set([...fromReports, ...fromSeen]);
}

/** What the loop that reads one downloaded email needs, so it runs in tests without IMAP or Supabase. */
export interface MessageHandling {
  store: SettlementStore;
  /** Note that this email was handled, so the next check doesn't download it again. */
  remember(message: ScannedMessage, outcome: string): Promise<void>;
  now?: () => number;
}

/** The email's outcome in one word: the best thing that came of its files, or 'skipped' when none was read. */
function messageOutcome(statuses: string[]): string {
  for (const s of ['read', 'failed', 'unsupported', 'duplicate']) if (statuses.includes(s)) return s;
  return 'skipped';
}

/**
 * Reads the report files of one downloaded email into `result`, then remembers
 * the email. Returns false, remembering nothing, when `deadline` passes before
 * every file is started: the next run takes the email again (files already
 * read come back as duplicates). An email whose file threw is not remembered
 * either (the database or Storage may have been down; it has no report row to
 * re-read), so it is retried.
 */
export async function handleScannedMessage(
  deps: MessageHandling,
  message: ScannedMessage,
  result: SyncResult,
  deadline: number,
): Promise<boolean> {
  const now = deps.now ?? Date.now;
  result.skippedMessages.push(...message.skipped);
  const statuses: string[] = [];
  let threw = false;
  for (const a of message.attachments) {
    if (now() > deadline) return false;
    result.filesFound++;
    let outcome: IngestOutcome;
    try {
      outcome = await ingestSettlementFile(deps.store, {
        bytes: a.bytes,
        fileName: a.fileName,
        source: 'email',
        platformHint: a.platform,
        email: a.email,
      });
    } catch (err) {
      console.error('online-settlements: ingest failed', a.fileName, err);
      threw = true;
      outcome = { status: 'failed', fileName: a.fileName, platform: a.platform, message: err instanceof Error ? err.message : String(err) };
    }
    statuses.push(outcome.status);
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
  if (!threw) await deps.remember(message, messageOutcome(statuses));
  return true;
}

/**
 * Reads again the reports a run left INTERRUPTED (rows being written when it
 * stopped). The mail scan can't: it skips an email that already has a report
 * row. Their saved files are read back from Storage, within the time budget.
 */
async function rereadInterrupted(admin: SupabaseClient, store: SettlementStore, result: SyncResult, deadline: number) {
  const { rows, left } = await loadRereadableReports(admin, { error: INTERRUPTED, limit: REREAD_MAX_FILES });
  if (!rows.length) return;
  const reread = await reprocessSavedReports(store, rows, { deadline });
  for (const f of reread.files) {
    result.filesFound++;
    if (f.status === 'read') result.filesRead++;
    else result.filesFailed++;
    result.files.push({
      fileName: f.fileName,
      platform: f.platform,
      status: f.status === 'read' ? 'read' : 'failed',
      periodStart: f.periodStart,
      periodEnd: f.periodEnd,
      orders: f.orders,
      message: f.message,
    });
  }
  result.messagesLeft += left + reread.notReached;
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

  const deadline = Date.now() + SYNC_TIME_BUDGET_MS;
  const store = supabaseSettlementStore(admin);
  const deps: MessageHandling = {
    store,
    remember: async (m, outcome) => {
      if (!m.messageId) return;
      const { error } = await admin
        .from('online_settlement_seen_messages')
        .upsert({ message_id: m.messageId, platform: m.platform, outcome }, { onConflict: 'message_id' });
      // Not fatal: the email is downloaded again next time and its files come back as duplicates.
      if (error) console.error('online-settlements: could not remember a handled email', error.message);
    },
  };
  try {
    const scan = await scanMailbox(cfg, (m) => handleScannedMessage(deps, m, result, deadline), {
      lookbackDays,
      known: await knownMessageIds(admin),
      deadline,
    });
    result.messagesFound = scan.messagesFound;
    result.messagesLeft = scan.messagesLeft;
    result.skippedMessages.push(...scan.skipped);
    result.ok = true;
  } catch (err) {
    console.error('online-settlements: mailbox scan failed', err);
    result.error = friendlyMailboxError(err);
  }
  // Whether or not the mailbox could be reached.
  try {
    await rereadInterrupted(admin, store, result, deadline);
  } catch (err) {
    console.error('online-settlements: re-reading interrupted reports failed', err);
    result.error = result.error ?? `Could not read again the reports an earlier check left unfinished: ${err instanceof Error ? err.message : String(err)}`;
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
