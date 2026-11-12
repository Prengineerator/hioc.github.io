// The two lifecycles behind Owner → Online orders (docs/ONLINE-SETTLEMENTS.md):
// a settlement REPORT (online_settlement_reports) and a mail-check RUN
// (online_settlement_sync_runs). Pure: no server-only import.
//
// A report
//
//   (new) ──rows to write──▶ writing ──every row saved──▶ read
//     │                         │
//     │                         └─(killed part-way: stays writing; the next
//     │                            mail check reads it again)
//     └──nothing to write──▶ unsupported | failed
//   writing / unsupported / failed ──the same bytes again (re-read, re-upload,
//                                     a better parser)──▶ writing | unsupported | failed
//   read: the end. The same bytes again are a duplicate.
//
// 'writing' is not one of the stored statuses (the CHECK allows read /
// unsupported / failed, and is left alone). It is STORED as status 'failed'
// with error INTERRUPTED — so a run killed mid-write leaves a report that
// reads as not-read (re-readable), never a 'read' one with half its rows —
// and READ back by reportState(). Nothing else should test for the pair.
//
// A run
//
//   (start) ──▶ running ──finished_at written──▶ finished | failed (error set)
//                  └──finished_at still empty after SYNC_RUN_STALE_MS──▶ abandoned
//
// 'abandoned' is derived, never written: a run the platform killed (both
// routes have a 60 s limit) can't write anything. It no longer counts as in
// flight, so it doesn't block the next check, and the reports it left
// 'writing' are read again by that check.

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

/** online_settlement_reports.status as the CHECK allows it. */
export const REPORT_STATUSES = ['read', 'unsupported', 'failed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export const REPORT_STATES = ['writing', 'read', 'unsupported', 'failed'] as const;
export type ReportState = (typeof REPORT_STATES)[number];

/** A report's error while its rows are still being written: the mail check reads such a report again. */
export const INTERRUPTED = 'Reading stopped before every order was saved: it will be read again';

/** How 'writing' is stored. */
export const WRITING_REPORT = { status: 'failed', error: INTERRUPTED } as const satisfies { status: ReportStatus; error: string };

export function reportState(row: { status: string; error: string | null | undefined }): ReportState {
  if (row.status === WRITING_REPORT.status && row.error === WRITING_REPORT.error) return 'writing';
  return (REPORT_STATUSES as readonly string[]).includes(row.status) ? (row.status as ReportStatus) : 'failed';
}

/** Whether the same bytes arriving again are read again (anything but 'read', which makes them a duplicate). */
export function isReReadable(state: ReportState): boolean {
  return state !== 'read';
}

export const REPORT_TRANSITIONS: readonly { from: ReportState | null; to: ReportState }[] = [
  { from: null, to: 'writing' },
  { from: null, to: 'unsupported' },
  { from: null, to: 'failed' },
  { from: 'writing', to: 'read' },
  ...(['writing', 'unsupported', 'failed'] as const).flatMap((from) =>
    (['writing', 'unsupported', 'failed'] as const).map((to) => ({ from, to })),
  ),
];

export function canReportTransition(from: ReportState | null, to: ReportState): boolean {
  return REPORT_TRANSITIONS.some((t) => t.from === from && t.to === to);
}

/** The owner's words for each state. */
export const REPORT_STATE_LABEL: Record<ReportState, string> = {
  writing: 'Being read',
  read: 'Read',
  unsupported: 'Saved, not read',
  failed: 'Could not read',
};

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export const SYNC_RUN_STATES = ['running', 'finished', 'failed', 'abandoned'] as const;
export type SyncRunState = (typeof SYNC_RUN_STATES)[number];

/**
 * An unfinished run older than this was killed. Both routes that run a check
 * have maxDuration 60 s and stop starting work after 45 s, so five minutes is
 * well past any run that is still alive.
 */
export const SYNC_RUN_STALE_MS = 5 * 60 * 1000;

export interface SyncRunFacts {
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export function syncRunState(run: SyncRunFacts, nowMs: number): SyncRunState {
  if (run.finished_at) return run.error ? 'failed' : 'finished';
  const started = Date.parse(run.started_at ?? '');
  if (Number.isNaN(started) || nowMs - started >= SYNC_RUN_STALE_MS) return 'abandoned';
  return 'running';
}

/** The owner's words for each state. */
export const SYNC_RUN_STATE_LABEL: Record<SyncRunState, string> = {
  running: 'Checking now',
  finished: 'Checked',
  failed: 'Check failed',
  abandoned: 'Stopped before it finished',
};

/**
 * Of the runs in flight, the one that goes ahead: the earliest started, ties
 * broken by id. Every run that asks gets the same answer, so a later one
 * stands down instead of reading the same mailbox at the same time.
 */
export function runThatGoesAhead<T extends SyncRunFacts & { id: string }>(runs: readonly T[], nowMs: number): T | null {
  let best: T | null = null;
  for (const r of runs) {
    if (syncRunState(r, nowMs) !== 'running') continue;
    if (!best) {
      best = r;
      continue;
    }
    // As instants: the database and this process write the time differently.
    const a = Date.parse(r.started_at ?? '');
    const b = Date.parse(best.started_at ?? '');
    if (a < b || (a === b && r.id < best.id)) best = r;
  }
  return best;
}
