// PRT-3 — the print watchdog: the half of "silent printing" that makes silence
// safe.
//
// PRT-1 moved printing into a hidden iframe, so a ticket now leaves for the
// printer with no tab, no dialog and no focus change. The failure mode of that
// is a kitchen that simply never gets the ticket, and nobody finds out until a
// customer asks where their food is. So: success is silent — there is
// deliberately no "printed!" signal anywhere in this module's surface — and
// failure is loud and sticky until a human acts on it.
//
// This module is pure: it owns the queue, the ordering, the timeout and the
// retry, and knows nothing about iframes, React or the DOM. The caller supplies
// `execute` (mount the frame, resolve on afterprint) and `abort` (tear it down);
// timers are injectable so the arithmetic is testable without waiting 10 real
// seconds.
//
// SEQUENTIAL IS NOT A PREFERENCE. Two window.print() calls in flight at once
// race inside the browser and one of them silently does nothing — which is
// exactly the KOT-then-receipt case. One job at a time, always.

import { printUrl, type PrintType } from '@/lib/staff/autoPrint';
import type { StaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';

// ---------------------------------------------------------------------------
// The machines, as tables. Three of them, nested: the QUEUE (one per dock),
// each JOB in it (one ticket type for one order), and each TARGET of a job (one
// copy on one printer — only a desktop executor has more than one, see
// lib/desktop/printExecutor.ts). Every method of PrintQueue below that moves a
// state checks it against these tables, so the rules live in one place.
// ---------------------------------------------------------------------------

/** The outcome of a transition check — the shape lib/orders/stateMachine.ts uses. */
export interface PrintTransitionCheck {
  ok: boolean;
  code?: 'not_allowed';
  message?: string;
}

function checkTransition<S extends string, T extends string>(
  table: Readonly<Record<S, readonly T[]>>,
  machine: string,
  from: S,
  to: T,
): PrintTransitionCheck {
  return table[from].includes(to)
    ? { ok: true }
    : { ok: false, code: 'not_allowed', message: `Illegal ${machine} transition ${from} → ${to}` };
}

/**
 * A job that hasn't settled yet, one that failed and is waiting on a human, or
 * one the browser has accepted but nobody has yet seen paper for.
 */
export const PRINT_JOB_STATES = ['queued', 'printing', 'handed-off', 'failed'] as const;
export type PrintJobState = (typeof PRINT_JOB_STATES)[number];

/**
 * The two ways a job leaves the queue: `done` (it printed, or a human said the
 * paper is there) and `dismissed` (a human said they dealt with it some other
 * way). Neither leaves anything behind.
 */
export const PRINT_JOB_EXITS = ['done', 'dismissed'] as const;
export type PrintJobExit = (typeof PRINT_JOB_EXITS)[number];

export const PRINT_JOB_TRANSITIONS: Readonly<Record<PrintJobState, readonly (PrintJobState | PrintJobExit)[]>> = {
  // Only the pump starts a job; a queued job has no other way forward.
  queued: ['printing'],
  // The printer vouched (→ done), the browser/spooler accepted it (→ handed-
  // off), or it rejected or never answered (→ failed).
  printing: ['done', 'handed-off', 'failed'],
  // The visible window elapsing or an acknowledge (→ done), or the staffer
  // looked and there is no paper (→ failed).
  'handed-off': ['done', 'failed'],
  // Retry (→ queued), Dismiss (→ dismissed), and the two ways a failed job can
  // turn out to have printed after all: every target a printer still owed has
  // answered late or been confirmed by the staffer — vouched for (→ done), or
  // only a spooler's word (→ handed-off, so "Didn't print" is still there).
  failed: ['queued', 'dismissed', 'done', 'handed-off'],
};

export function canTransitionPrintJob(from: PrintJobState, to: PrintJobState | PrintJobExit): PrintTransitionCheck {
  return checkTransition(PRINT_JOB_TRANSITIONS, 'print job', from, to);
}

/**
 * The queue itself. `running` means one job's execute() is live (never two:
 * see SEQUENTIAL above). `disposed` is the end of the dock that owned it — its
 * timers are cleared, the running attempt is aborted, and nothing it is told
 * afterwards (a late answer, a stray enqueue) does anything.
 */
export const PRINT_QUEUE_PHASES = ['idle', 'running', 'disposed'] as const;
export type PrintQueuePhase = (typeof PRINT_QUEUE_PHASES)[number];

export const PRINT_QUEUE_TRANSITIONS: Readonly<Record<PrintQueuePhase, readonly PrintQueuePhase[]>> = {
  idle: ['running', 'disposed'],
  running: ['idle', 'disposed'],
  disposed: [],
};

export function canTransitionPrintQueue(from: PrintQueuePhase, to: PrintQueuePhase): PrintTransitionCheck {
  return checkTransition(PRINT_QUEUE_TRANSITIONS, 'print queue', from, to);
}

/**
 * One copy of a job on one printer (PRN-2: a KOT can go to the kitchen AND the
 * bar, each with its own copy count). Tracked so a retry sends only what didn't
 * print: re-sending the kitchen's KOT because the bar's failed puts a second
 * ticket on the kitchen rail, which reads as a second order.
 *
 * `unknown` is the honest state for a copy that was already with the printer
 * when the queue stopped waiting (its timeout). The desktop bridge has no way
 * to recall a printRaw/printUrl in flight (lib/desktop/bridge.ts), so the copy
 * may well come out — Retry must ask before sending it again, and a late
 * answer from the bridge settles it either way.
 */
export const PRINT_TARGET_STATES = ['pending', 'printing', 'printed', 'failed', 'unknown', 'skipped'] as const;
export type PrintTargetState = (typeof PRINT_TARGET_STATES)[number];

export const PRINT_TARGET_TRANSITIONS: Readonly<Record<PrintTargetState, readonly PrintTargetState[]>> = {
  pending: ['printing'],
  // Answered (printed / failed), or abandoned by a timeout while in flight.
  printing: ['printed', 'failed', 'unknown'],
  failed: ['printing'],
  // A late answer from the bridge, or the staffer's call: send it again
  // (→ pending) or "it printed" (→ skipped).
  unknown: ['printed', 'failed', 'pending', 'skipped'],
  // Only a copy the printer did NOT vouch for, when the staffer reports
  // "Didn't print" — see PrintQueue.reportNotPrinted.
  printed: ['pending'],
  skipped: [],
};

export function canTransitionPrintTarget(from: PrintTargetState, to: PrintTargetState): PrintTransitionCheck {
  return checkTransition(PRINT_TARGET_TRANSITIONS, 'print target', from, to);
}

export interface PrintTarget {
  /** The printer's name ("Kitchen"), for the chip. */
  printer: string;
  state: PrintTargetState;
  /** The attempt that last moved this copy; an older attempt's late answer is ignored. */
  attempt: number;
  /** Printed AND vouched for by the printer itself (PRN-4). */
  confirmed?: boolean;
}

/** What an executor may report about one target while an attempt runs. */
export interface PrintTargetReport {
  printer: string;
  /** `pending` announces the plan before anything is sent. */
  state: 'pending' | 'printing' | 'printed' | 'failed';
  confirmed?: boolean;
}

/** Whether an executor should send this copy on this attempt. */
export function targetNeedsPrint(state: PrintTargetState | undefined): boolean {
  return state === undefined || state === 'pending' || state === 'failed';
}

/**
 * Applies one executor report to a target, or returns null when the report is
 * not allowed (an illegal move, or a late answer from an attempt that no longer
 * owns the copy).
 */
export function nextPrintTarget(
  current: PrintTarget | undefined,
  report: PrintTargetReport,
  attempt: number,
): PrintTarget | null {
  const { printer } = report;
  if (report.state === 'pending') return current ? null : { printer, state: 'pending', attempt };
  if (report.state === 'printing') {
    return canTransitionPrintTarget(current?.state ?? 'pending', 'printing').ok
      ? { printer, state: 'printing', attempt }
      : null;
  }
  if (!current || current.attempt !== attempt) return null;
  if (!canTransitionPrintTarget(current.state, report.state).ok) return null;
  return report.state === 'printed'
    ? { printer, state: 'printed', attempt, confirmed: report.confirmed === true }
    : { printer, state: 'failed', attempt };
}

/**
 * Handed to `execute` with every attempt. `signal` aborts when the queue stops
 * waiting for the attempt (its timeout, or the dock going away): an executor
 * must not START anything after that. `report` records per-target progress on
 * the job, so the next attempt knows what already printed.
 */
export interface PrintAttemptContext {
  signal: AbortSignal;
  report: (targetKey: string, report: PrintTargetReport) => void;
}

export interface PrintJob {
  id: string;
  orderId: string;
  type: PrintType;
  /** A KOT of only these lines — items added to a running order. */
  itemIds?: string[];
  state: PrintJobState;
  /** How many times execute() has been started for this job. */
  attempts: number;
  /**
   * The ticket data the order's create answer carried. The first attempt
   * prints from it with no server call; a retry asks the server, so a reprint
   * reflects the order as it is now (lib/print/localTicket.ts).
   */
  printOrder?: StaffPrintOrder;
  /**
   * Per printer × copy progress, keyed by the executor's target key. Absent
   * for a job no executor has reported on (the browser's single-frame path),
   * which prints whole on every attempt exactly as before.
   */
  targets?: Record<string, PrintTarget>;
}

export interface PrintJobSpec {
  orderId: string;
  type: PrintType;
  /** A KOT of only these lines — items added to a running order. */
  itemIds?: string[];
  printOrder?: StaffPrintOrder;
}

export interface PrintQueueSnapshot {
  /** Everything unfinished: queued, printing, and failed. A printed job is gone. */
  jobs: PrintJob[];
  /** The subset a staffer must act on. */
  failed: PrintJob[];
  /**
   * Jobs the browser accepted, held briefly so a human can contradict it.
   *
   * THE LIMIT THIS EXISTS FOR: `afterprint` fires when the browser hands the job
   * to the OS spooler. It fires with the thermal printer switched off, unplugged
   * or out of paper — no browser API can see the paper. So the watchdog below
   * only ever catches a frame that failed to LOAD or print (network, auth
   * redirect); the single most likely real failure at a counter, a dead printer,
   * arrives here looking exactly like success.
   *
   * PRT-1 made printing invisible on the promise that PRT-3 makes failure
   * visible, and pure silence cannot keep that promise. So the one sensor that
   * CAN see the paper — the staffer — gets a few seconds and a "Didn't print"
   * button. Still non-blocking, still nothing to dismiss on the happy path.
   */
  handedOff: PrintJob[];
  /** Failures since this queue was created — one shift, one staff window (the shell's dock). */
  failureCount: number;
  /** Three failures in a shift is a printer/profile problem, not bad luck. */
  escalate: boolean;
  phase: PrintQueuePhase;
}

/** A job is still waiting or printing — what "don't leave yet" means. */
export function isPrintQueueBusy(snapshot: Pick<PrintQueueSnapshot, 'jobs'>): boolean {
  return snapshot.jobs.some((j) => j.state === 'queued' || j.state === 'printing');
}

export type PrintJobsOutcome = 'pending' | 'failed' | 'done';

/**
 * Where a particular set of jobs stands — for a screen that queued them and
 * waits on its own prints only, not on whatever else the shared dock holds.
 * A job that has left the work queue (printed, handed off, dismissed) is done.
 */
export function printJobsOutcome(
  snapshot: Pick<PrintQueueSnapshot, 'jobs'>,
  jobIds: readonly string[],
): PrintJobsOutcome {
  const mine = snapshot.jobs.filter((j) => jobIds.includes(j.id));
  if (mine.some((j) => j.state === 'queued' || j.state === 'printing')) return 'pending';
  if (mine.some((j) => j.state === 'failed')) return 'failed';
  return 'done';
}

export interface PrintQueueOptions {
  /**
   * Start one print and resolve when the page reports `afterprint`. Rejecting
   * (or never settling — see `timeoutMs`) marks the job failed.
   *
   * PRN-4 — a desktop executor talks to the printer itself and can VOUCH for
   * the paper in a way `afterprint` never could: resolving `{ confirmed: true }`
   * means the printer reported healthy after the job, so it skips the
   * hand-off/"Didn't print" window entirely and leaves the queue clean, exactly
   * like today's silent success. Resolving with no value, or `{ confirmed:
   * false }` (an OS-driver print, or the existing iframe path), is unchanged:
   * the job still can't be vouched for, so it goes through hand-off as before.
   *
   * `ctx` (PrintAttemptContext) carries the attempt's abort signal and its
   * per-target progress reporter; an executor with one destination may ignore it.
   */
  execute: (job: PrintJob, ctx: PrintAttemptContext) => Promise<void | { confirmed: boolean }>;
  /**
   * Called when a job stops being this queue's concern while `execute` may still
   * be in flight — i.e. it timed out. The caller must tear the frame down here,
   * or a late window.print() would race the next job. (The attempt's
   * `ctx.signal` aborts at the same moment.)
   */
  abort?: (job: PrintJob) => void;
  onChange?: (snapshot: PrintQueueSnapshot) => void;
  timeoutMs?: number;
  /** The budget after the print dialog opens — see PRINT_DIALOG_TIMEOUT_MS. */
  dialogTimeoutMs?: number;
  /** How long a handed-off job stays challengeable — see HANDOFF_VISIBLE_MS. */
  handoffMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  newId?: () => string;
}

/**
 * A thermal printer that is on and idle answers in about a second; 10s is slow
 * enough to cover a spooling driver and fast enough that the staffer learns
 * about a dead printer while the customer is still at the counter. Tuned on the
 * real machine at Gate 6B (spec E9).
 */
export const PRINT_TIMEOUT_MS = 10_000;

/**
 * The budget once the browser's own print dialog is up.
 *
 * The 10s watchdog races the dialog on the same thread it is timing: on a stock
 * browser window.print() halts script execution in the renderer the POS shares
 * with the print frame, so the timer physically cannot fire while the dialog is
 * open — and the instant the staffer dismisses it, an already-overdue timer task
 * and the afterprint task are both queued with no defined ordering between them.
 * If the timer wins, the job is marked failed, the frame is torn down, and a
 * chip appears for a ticket that printed. Retrying it puts a SECOND ticket on
 * the kitchen rail, which reads as a second order.
 *
 * So `beforeprint` stops the clock and restarts it on a budget sized for a human
 * at a dialog rather than for a printer. PRT-2's --kiosk-printing profile fires
 * no dialog at all and never reaches this path.
 */
export const PRINT_DIALOG_TIMEOUT_MS = 120_000;

/** Three misses in a shift stops being "the printer was asleep". */
export const ESCALATE_AFTER_FAILURES = 3;

/**
 * How long a handed-off job stays on screen offering "Didn't print".
 *
 * Long enough that a staffer who glances at the printer can catch a miss; short
 * enough that it is gone before the next order's ticket, so the counter is never
 * asked to dismiss anything on a normal night.
 */
export const HANDOFF_VISIBLE_MS = 15_000;

const TYPE_LABELS: Record<PrintType, string> = {
  kot: 'KOT',
  receipt: 'Receipt',
  token: 'Token',
};

/** The print page, told to print itself on load and report back (PRT-1). */
export function printFrameSrc(orderId: string, type: PrintType, itemIds?: readonly string[] | null): string {
  const url = printUrl(orderId, type, itemIds);
  return `${url}${url.includes('?') ? '&' : '?'}auto=1`;
}

/**
 * The frame → POS message contract, defined here because both ends import it and
 * neither may guess: an unrecognised message is dropped, so a typo on one side
 * would look exactly like a printer that never answered.
 */
export const PRINT_MESSAGE_CHANNEL = 'hioc-print';

export interface PrintFrameMessage {
  channel: typeof PRINT_MESSAGE_CHANNEL;
  /**
   * 'dialog' is not an outcome — it means the browser has put its print dialog
   * on screen and a human now owns the timing. It stops the watchdog without
   * settling the job.
   */
  event: 'printed' | 'failed' | 'dialog';
  orderId: string;
  type: string;
}

export function describePrintJob(job: Pick<PrintJob, 'type'> & { itemIds?: string[] }): string {
  if (job.type === 'kot' && job.itemIds && job.itemIds.length > 0) return 'Added-items KOT';
  return TYPE_LABELS[job.type];
}

/**
 * The chip's line. Names what didn't print, because "a print failed" leaves the
 * staffer guessing whether the kitchen has its ticket.
 */
export function printFailureMessage(failed: Pick<PrintJob, 'type'>[]): string {
  if (failed.length === 0) return '';
  return `${listOf(failed.map(describePrintJob))} didn’t print`;
}

function listOf(names: string[]): string {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The printers holding a copy of this failed job that may or may not have come
 * out — sent, but the queue stopped waiting before the printer answered.
 * Empty when Retry can simply go ahead.
 */
export function unsurePrinters(job: Pick<PrintJob, 'targets'>): string[] {
  const names = Object.values(job.targets ?? {})
    .filter((t) => t.state === 'unknown')
    .map((t) => t.printer);
  return [...new Set(names)];
}

/** The chip's line for a job with unsure copies: the staffer is the only one who can look. */
export function printUnsureMessage(job: Pick<PrintJob, 'type' | 'itemIds' | 'targets'>): string {
  const printers = unsurePrinters(job);
  if (printers.length === 0) return '';
  return `${listOf(printers)} may already have printed this ${describePrintJob(job)} — check before reprinting.`;
}

/** The "it's there" answer to printUnsureMessage. */
export function printUnsureSkipLabel(job: Pick<PrintJob, 'targets'>): string {
  const printers = unsurePrinters(job);
  return printers.length === 0 ? '' : `${listOf(printers)} printed it`;
}

/** A failed job some printer still owes paper for (or one with no per-printer record at all). */
function hasWorkLeft(job: PrintJob): boolean {
  const targets = Object.values(job.targets ?? {});
  return targets.length === 0 || targets.some((t) => targetNeedsPrint(t.state));
}

/** A copy that shares nothing mutable with the queue's own job. */
function copyJob(job: PrintJob): PrintJob {
  if (!job.targets) return { ...job };
  const targets: Record<string, PrintTarget> = {};
  for (const [key, target] of Object.entries(job.targets)) targets[key] = { ...target };
  return { ...job, targets };
}

export type PrintRetryResult =
  /** Back in the queue. */
  | 'queued'
  /** Nothing was left to print once the staffer's answer was applied. */
  | 'done'
  /** Some copy may already have printed: say `unknown: 'reprint' | 'skip'`. */
  | 'needs-decision'
  /** Not a failed job (or the dock is gone). */
  | 'ignored';

export interface PrintRetryOptions {
  /**
   * What to do with copies that may already have printed (`unsurePrinters`):
   * send them again, or take the staffer's word that they came out.
   */
  unknown?: 'reprint' | 'skip';
}

let seq = 0;
function defaultId(): string {
  seq += 1;
  return `print-${seq}`;
}

export class PrintQueue {
  #jobs: PrintJob[] = [];
  #failureCount = 0;
  #phase: PrintQueuePhase = 'idle';
  /**
   * Identifies the attempt currently allowed to settle. A job that timed out and
   * was retried has two `execute` promises alive; only the newest may report.
   */
  #activeToken = 0;
  /** Aborts the running attempt's `ctx.signal`. */
  #controller: AbortController | null = null;
  #timer: unknown = null;
  /** Accepted by the browser, not yet vouched for by a human. */
  #handedOff: PrintJob[] = [];
  #handoffTimers = new Map<string, unknown>();

  readonly #opts: Required<Omit<PrintQueueOptions, 'onChange' | 'abort'>> &
    Pick<PrintQueueOptions, 'onChange' | 'abort'>;

  constructor(opts: PrintQueueOptions) {
    this.#opts = {
      execute: opts.execute,
      abort: opts.abort,
      onChange: opts.onChange,
      timeoutMs: opts.timeoutMs ?? PRINT_TIMEOUT_MS,
      dialogTimeoutMs: opts.dialogTimeoutMs ?? PRINT_DIALOG_TIMEOUT_MS,
      handoffMs: opts.handoffMs ?? HANDOFF_VISIBLE_MS,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
      newId: opts.newId ?? defaultId,
    };
  }

  snapshot(): PrintQueueSnapshot {
    const jobs = this.#jobs.map(copyJob);
    const failed = jobs.filter((j) => j.state === 'failed');
    return {
      jobs,
      failed,
      handedOff: this.#handedOff.map(copyJob),
      failureCount: this.#failureCount,
      escalate: this.#failureCount >= ESCALATE_AFTER_FAILURES,
      phase: this.#phase,
    };
  }

  /** Adds jobs in the order given — a KOT queued before a receipt prints first. */
  enqueue(specs: PrintJobSpec[]): PrintJob[] {
    // A disposed queue has no frame, no timers and nobody watching its chip:
    // taking a job here would be the silent missed ticket this module exists
    // to prevent, so it takes nothing and says so (an empty result).
    if (this.#phase === 'disposed') return [];
    const added = specs.map((spec) => ({
      id: this.#opts.newId(),
      orderId: spec.orderId,
      type: spec.type,
      ...(spec.itemIds && spec.itemIds.length > 0 ? { itemIds: [...spec.itemIds] } : {}),
      ...(spec.printOrder ? { printOrder: spec.printOrder } : {}),
      state: 'queued' as const,
      attempts: 0,
    }));
    if (added.length === 0) return [];
    this.#jobs = [...this.#jobs, ...added];
    this.#emit();
    this.#pump();
    return added.map((j) => ({ ...j }));
  }

  /**
   * Re-runs ONE failed job. Never the whole plan: re-printing a KOT because the
   * receipt failed puts a second ticket on the kitchen rail, which reads as a
   * second order. Within the job, only the copies that didn't print go again
   * (PrintTarget); a copy that may already have printed needs the staffer's
   * answer first (`opts.unknown`), so this never guesses on their behalf.
   */
  retry(jobId: string, opts: PrintRetryOptions = {}): PrintRetryResult {
    if (this.#phase === 'disposed') return 'ignored';
    const job = this.#jobs.find((j) => j.id === jobId);
    if (!job || !canTransitionPrintJob(job.state, 'queued').ok) return 'ignored';

    const unsure = Object.entries(job.targets ?? {}).filter(([, t]) => t.state === 'unknown');
    if (unsure.length > 0) {
      if (!opts.unknown) return 'needs-decision';
      const to: PrintTargetState = opts.unknown === 'reprint' ? 'pending' : 'skipped';
      const targets = { ...job.targets };
      for (const [key, target] of unsure) {
        if (canTransitionPrintTarget(target.state, to).ok) targets[key] = { ...target, state: to };
      }
      job.targets = targets;
    }

    if (!hasWorkLeft(job)) {
      // Every copy is accounted for — printed, or the staffer has it in hand.
      this.#jobs = this.#jobs.filter((j) => j.id !== job.id);
      this.#emit();
      return 'done';
    }

    job.state = 'queued';
    this.#emit();
    this.#pump();
    return 'queued';
  }

  /** The staffer has dealt with it (printed from the order, or wrote it out). */
  dismiss(jobId: string): void {
    const before = this.#jobs.length;
    this.#jobs = this.#jobs.filter((j) => j.id !== jobId || !canTransitionPrintJob(j.state, 'dismissed').ok);
    if (this.#jobs.length !== before) this.#emit();
  }

  /**
   * The browser put its print dialog on screen for the running job.
   *
   * Re-arms the watchdog on the human-sized budget. Not a settle and not a
   * cancel: the job is still running, we have simply learned that the thing we
   * are timing is now a person choosing a printer, not a printer answering.
   * Ignored when nothing is running, so a stray or duplicate message is inert.
   */
  noteDialogOpen(): void {
    if (this.#phase !== 'running') return;
    if (this.#timer !== null) {
      this.#opts.clearTimer(this.#timer);
      this.#timer = null;
    }
    const token = this.#activeToken;
    this.#timer = this.#opts.setTimer(() => this.#settle(token, false), this.#opts.dialogTimeoutMs);
  }

  /** Drops every failed job — the "clear" on the escalation banner. */
  dismissAll(): void {
    if (!this.#jobs.some((j) => j.state === 'failed')) return;
    this.#jobs = this.#jobs.filter((j) => !canTransitionPrintJob(j.state, 'dismissed').ok);
    this.#emit();
  }

  /**
   * The dock that owns this queue is going away (the staff shell unmounting).
   * Clears every timer this queue armed, aborts the running attempt so an
   * executor starts nothing more, and stops listening: a late answer, a stray
   * enqueue or retry after this point does nothing. Terminal.
   */
  dispose(): void {
    if (!canTransitionPrintQueue(this.#phase, 'disposed').ok) return;
    this.#phase = 'disposed';
    this.#activeToken += 1;
    if (this.#timer !== null) {
      this.#opts.clearTimer(this.#timer);
      this.#timer = null;
    }
    for (const handle of this.#handoffTimers.values()) this.#opts.clearTimer(handle);
    this.#handoffTimers.clear();
    const controller = this.#controller;
    this.#controller = null;
    controller?.abort();
  }

  #pump(): void {
    if (!canTransitionPrintQueue(this.#phase, 'running').ok) return;
    const job = this.#jobs.find((j) => j.state === 'queued');
    if (!job) return;

    this.#phase = 'running';
    job.state = 'printing';
    job.attempts += 1;
    const token = ++this.#activeToken;
    const controller = new AbortController();
    this.#controller = controller;
    const jobId = job.id;
    const attempt = job.attempts;
    this.#emit();

    this.#timer = this.#opts.setTimer(() => this.#settle(token, false), this.#opts.timeoutMs);

    const ctx: PrintAttemptContext = {
      signal: controller.signal,
      report: (key, report) => this.#report(jobId, attempt, key, report),
    };
    // The snapshot copy keeps the executor from mutating queue state.
    this.#opts.execute(copyJob(job), ctx).then(
      (result) => this.#settle(token, true, result?.confirmed === true),
      () => this.#settle(token, false),
    );
  }

  #settle(token: number, ok: boolean, confirmed = false): void {
    // A resolve that arrives after its own timeout lost the race — the job has
    // already been reported failed and may even be printing again.
    if (token !== this.#activeToken || this.#phase !== 'running') return;
    this.#phase = 'idle';
    if (this.#timer !== null) {
      this.#opts.clearTimer(this.#timer);
      this.#timer = null;
    }
    const controller = this.#controller;
    this.#controller = null;

    const job = this.#jobs.find((j) => j.state === 'printing');
    if (job) {
      if (ok && confirmed) {
        // The printer itself vouched for this one (PRN-4) — there is nothing
        // for a human to contradict, so it leaves the queue exactly like
        // today's silent success, with no hand-off chip at all.
        this.#jobs = this.#jobs.filter((j) => j.id !== job.id);
      } else if (ok) {
        // NOT "printed" — "the browser accepted it". It leaves the work queue
        // and waits briefly in #handedOff where a human can contradict it; see
        // PrintQueueSnapshot.handedOff for why that is the strongest claim
        // available.
        this.#jobs = this.#jobs.filter((j) => j.id !== job.id);
        this.#handOff(job);
      } else {
        // The queue stops waiting. The signal stops the executor STARTING
        // anything more; what it already handed to a printer can't be
        // recalled, so those copies become `unknown` and Retry asks first.
        controller?.abort();
        if (job.targets) {
          const targets = { ...job.targets };
          for (const [key, target] of Object.entries(targets)) {
            if (canTransitionPrintTarget(target.state, 'unknown').ok) targets[key] = { ...target, state: 'unknown' };
          }
          job.targets = targets;
        }
        job.state = 'failed';
        this.#failureCount += 1;
        this.#opts.abort?.(copyJob(job));
      }
    }
    this.#emit();
    this.#pump();
  }

  /**
   * One executor report. Progress during an attempt is just recorded. A late
   * answer for a job that already failed (a copy that was `unknown`) can show
   * the job printed after all; once nothing is left in doubt or owed, it
   * leaves the failed list the way an on-time answer would have.
   */
  #report(jobId: string, attempt: number, key: string, report: PrintTargetReport): void {
    if (this.#phase === 'disposed') return;
    const job = this.#jobs.find((j) => j.id === jobId);
    if (!job) return;
    const next = nextPrintTarget(job.targets?.[key], report, attempt);
    if (!next) return;
    job.targets = { ...job.targets, [key]: next };
    if (job.state !== 'failed') return;

    const targets = Object.values(job.targets);
    if (targets.every((t) => t.state === 'printed' || t.state === 'skipped')) {
      this.#jobs = this.#jobs.filter((j) => j.id !== job.id);
      const vouched = targets.every((t) => t.state === 'skipped' || t.confirmed === true);
      if (!vouched && canTransitionPrintJob('failed', 'handed-off').ok) this.#handOff(job);
    }
    this.#emit();
  }

  #handOff(job: PrintJob): void {
    const done: PrintJob = { ...copyJob(job), state: 'handed-off' };
    this.#handedOff = [...this.#handedOff, done];
    this.#handoffTimers.set(
      done.id,
      this.#opts.setTimer(() => this.#dropHandoff(done.id), this.#opts.handoffMs),
    );
  }

  #dropHandoff(jobId: string): void {
    const handle = this.#handoffTimers.get(jobId);
    if (handle !== undefined) {
      this.#opts.clearTimer(handle);
      this.#handoffTimers.delete(jobId);
    }
    const before = this.#handedOff.length;
    this.#handedOff = this.#handedOff.filter((j) => j.id !== jobId);
    if (this.#handedOff.length !== before) this.#emit();
  }

  /** "Yes, I have the ticket" — or the visible window simply elapsing. */
  acknowledge(jobId: string): void {
    this.#dropHandoff(jobId);
  }

  /**
   * The staffer looked at the printer and there is no paper.
   *
   * This is the only true printer-failure signal the system has, so it is
   * treated exactly like a watchdog timeout: the job becomes a failed one, it
   * counts toward the shift tally that escalates at three, and the normal Retry
   * button picks it up. The copies a printer DID vouch for stay printed; every
   * other copy is owed again, so the retry sends exactly those.
   */
  reportNotPrinted(jobId: string): void {
    if (this.#phase === 'disposed') return;
    const job = this.#handedOff.find((j) => j.id === jobId);
    if (!job || !canTransitionPrintJob('handed-off', 'failed').ok) return;
    this.#dropHandoff(jobId);
    const failed: PrintJob = { ...copyJob(job), state: 'failed' };
    if (failed.targets) {
      for (const [key, target] of Object.entries(failed.targets)) {
        if (target.state === 'printed' && !target.confirmed && canTransitionPrintTarget('printed', 'pending').ok) {
          failed.targets[key] = { ...target, state: 'pending' };
        }
      }
    }
    this.#jobs = [...this.#jobs, failed];
    this.#failureCount += 1;
    this.#emit();
  }

  #emit(): void {
    this.#opts.onChange?.(this.snapshot());
  }
}
