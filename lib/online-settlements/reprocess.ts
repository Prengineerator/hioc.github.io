import { ingestSettlementFile, type SettlementStore } from './ingest';
import type { Platform } from './types';

// "Re-read saved reports": run the raw files kept in Storage back through the
// ingest pipeline, without the email. Every report file is saved before it is
// parsed, so a file saved as 'unsupported' (a Swiggy file that was not its
// payout annexure) or one that 'failed' (a parser bug since fixed) can be read
// once the parser is better. ingestSettlementFile() finds the row by the
// file's hash and updates that same row, so nothing is duplicated and a 'read'
// report is never touched.
//
// The rows come from loadRereadableReports() in store.ts; this file only needs
// a SettlementStore, so it is tested against an in-memory one
// (tests/onlineSettlementsReprocess.test.ts).

/** Files re-read in one call: the owner button and the route stay inside the request time limit. */
export const REREAD_MAX_FILES = 100;

/** The online_settlement_reports columns a re-read needs. */
export interface SavedReport {
  id: string;
  platform: Platform;
  source: 'email' | 'upload';
  file_name: string;
  storage_path: string | null;
  status: string;
  email_message_id: string | null;
  email_from: string | null;
  email_subject: string | null;
  email_received_at: string | null;
}

export type RereadStatus = 'read' | 'stillUnsupported' | 'failed' | 'missingFile';

export interface RereadFile {
  reportId: string;
  fileName: string;
  platform: Platform;
  status: RereadStatus;
  periodStart?: string | null;
  periodEnd?: string | null;
  orders?: number;
  message?: string;
}

export interface RereadResult {
  /** Reports looked at (status unsupported or failed, platform matching). */
  checked: number;
  /** Now read: orders and deductions are in. */
  read: number;
  /** Swiggy files saved again, still not the payout annexure the parser reads. */
  stillUnsupported: number;
  /** Still not a readable report (the report's error says why). */
  failed: number;
  /** No saved copy to read: never stored, or gone from Storage. */
  missingFile: number;
  /** Eligible reports left unchecked because the time budget ran out. */
  notReached: number;
  files: RereadFile[];
}

export async function reprocessSavedReports(
  store: SettlementStore,
  reports: SavedReport[],
  opts: { platform?: Platform | null; deadline?: number } = {},
): Promise<RereadResult> {
  const result: RereadResult = { checked: 0, read: 0, stillUnsupported: 0, failed: 0, missingFile: 0, notReached: 0, files: [] };
  const todo = reports.filter(
    (r) => (r.status === 'unsupported' || r.status === 'failed') && (!opts.platform || r.platform === opts.platform),
  );

  for (let i = 0; i < todo.length; i++) {
    if (opts.deadline !== undefined && Date.now() > opts.deadline) {
      result.notReached = todo.length - i;
      break;
    }
    const file = await rereadOne(store, todo[i]);
    result.checked++;
    result[file.status]++;
    result.files.push(file);
  }
  return result;
}

async function rereadOne(store: SettlementStore, row: SavedReport): Promise<RereadFile> {
  const base = { reportId: row.id, fileName: row.file_name, platform: row.platform };
  try {
    const bytes = row.storage_path ? await store.readFile(row.storage_path) : null;
    if (!bytes) return { ...base, status: 'missingFile', message: 'The saved copy of this file is not in storage' };

    const outcome = await ingestSettlementFile(store, {
      bytes,
      fileName: row.file_name,
      source: row.source,
      platformHint: row.platform,
      email: {
        messageId: row.email_message_id,
        from: row.email_from,
        subject: row.email_subject,
        receivedAt: row.email_received_at,
      },
    });
    // 'duplicate' = the status came out the same as before, so it is still what the row said it was.
    const status: RereadStatus =
      outcome.status === 'read'
        ? 'read'
        : outcome.status === 'unsupported' || (outcome.status === 'duplicate' && row.status === 'unsupported')
          ? 'stillUnsupported'
          : 'failed';
    return {
      ...base,
      status,
      periodStart: outcome.periodStart,
      periodEnd: outcome.periodEnd,
      orders: outcome.orders,
      message: outcome.message,
    };
  } catch (err) {
    console.error('online-settlements: re-read failed', row.file_name, err);
    return { ...base, status: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}
