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

/**
 * A job that hasn't settled yet, one that failed and is waiting on a human, or
 * one the browser has accepted but nobody has yet seen paper for.
 */
export type PrintJobState = 'queued' | 'printing' | 'handed-off' | 'failed';

export interface PrintJob {
  id: string;
  orderId: string;
  type: PrintType;
  state: PrintJobState;
  /** How many times execute() has been started for this job. */
  attempts: number;
}

export interface PrintJobSpec {
  orderId: string;
  type: PrintType;
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
  /** Failures since this queue was created — one shift, one POS screen. */
  failureCount: number;
  /** Three failures in a shift is a printer/profile problem, not bad luck. */
  escalate: boolean;
}

export interface PrintQueueOptions {
  /**
   * Start one print and resolve when the page reports `afterprint`. Rejecting
   * (or never settling — see `timeoutMs`) marks the job failed.
   */
  execute: (job: PrintJob) => Promise<void>;
  /**
   * Called when a job stops being this queue's concern while `execute` may still
   * be in flight — i.e. it timed out. The caller must tear the frame down here,
   * or a late window.print() would race the next job.
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
export function printFrameSrc(orderId: string, type: PrintType): string {
  return `${printUrl(orderId, type)}?auto=1`;
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

export function describePrintJob(job: Pick<PrintJob, 'type'>): string {
  return TYPE_LABELS[job.type];
}

/**
 * The chip's line. Names what didn't print, because "a print failed" leaves the
 * staffer guessing whether the kitchen has its ticket.
 */
export function printFailureMessage(failed: Pick<PrintJob, 'type'>[]): string {
  if (failed.length === 0) return '';
  const names = failed.map(describePrintJob);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `${list} didn’t print`;
}

let seq = 0;
function defaultId(): string {
  seq += 1;
  return `print-${seq}`;
}

export class PrintQueue {
  #jobs: PrintJob[] = [];
  #failureCount = 0;
  /**
   * Identifies the attempt currently allowed to settle. A job that timed out and
   * was retried has two `execute` promises alive; only the newest may report.
   */
  #activeToken = 0;
  #running = false;
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
    const jobs = this.#jobs.map((j) => ({ ...j }));
    const failed = jobs.filter((j) => j.state === 'failed');
    return {
      jobs,
      failed,
      handedOff: this.#handedOff.map((j) => ({ ...j })),
      failureCount: this.#failureCount,
      escalate: this.#failureCount >= ESCALATE_AFTER_FAILURES,
    };
  }

  /** Adds jobs in the order given — a KOT queued before a receipt prints first. */
  enqueue(specs: PrintJobSpec[]): PrintJob[] {
    const added = specs.map((spec) => ({
      id: this.#opts.newId(),
      orderId: spec.orderId,
      type: spec.type,
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
   * second order.
   */
  retry(jobId: string): void {
    const job = this.#jobs.find((j) => j.id === jobId);
    if (!job || job.state !== 'failed') return;
    job.state = 'queued';
    this.#emit();
    this.#pump();
  }

  /** The staffer has dealt with it (printed from the order, or wrote it out). */
  dismiss(jobId: string): void {
    const before = this.#jobs.length;
    this.#jobs = this.#jobs.filter((j) => j.id !== jobId || j.state !== 'failed');
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
    if (!this.#running) return;
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
    this.#jobs = this.#jobs.filter((j) => j.state !== 'failed');
    this.#emit();
  }

  #pump(): void {
    if (this.#running) return;
    const job = this.#jobs.find((j) => j.state === 'queued');
    if (!job) return;

    this.#running = true;
    job.state = 'printing';
    job.attempts += 1;
    const token = ++this.#activeToken;
    this.#emit();

    this.#timer = this.#opts.setTimer(() => this.#settle(token, false), this.#opts.timeoutMs);

    // The snapshot copy keeps the executor from mutating queue state.
    this.#opts.execute({ ...job }).then(
      () => this.#settle(token, true),
      () => this.#settle(token, false),
    );
  }

  #settle(token: number, ok: boolean): void {
    // A resolve that arrives after its own timeout lost the race — the job has
    // already been reported failed and may even be printing again.
    if (token !== this.#activeToken || !this.#running) return;
    this.#running = false;
    if (this.#timer !== null) {
      this.#opts.clearTimer(this.#timer);
      this.#timer = null;
    }

    const job = this.#jobs.find((j) => j.state === 'printing');
    if (job) {
      if (ok) {
        // NOT "printed" — "the browser accepted it". It leaves the work queue
        // and waits briefly in #handedOff where a human can contradict it; see
        // PrintQueueSnapshot.handedOff for why that is the strongest claim
        // available.
        this.#jobs = this.#jobs.filter((j) => j.id !== job.id);
        const done: PrintJob = { ...job, state: 'handed-off' };
        this.#handedOff = [...this.#handedOff, done];
        this.#handoffTimers.set(
          done.id,
          this.#opts.setTimer(() => this.#dropHandoff(done.id), this.#opts.handoffMs),
        );
      } else {
        job.state = 'failed';
        this.#failureCount += 1;
        this.#opts.abort?.({ ...job });
      }
    }
    this.#emit();
    this.#pump();
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
   * button picks it up.
   */
  reportNotPrinted(jobId: string): void {
    const job = this.#handedOff.find((j) => j.id === jobId);
    if (!job) return;
    this.#dropHandoff(jobId);
    this.#jobs = [...this.#jobs, { ...job, state: 'failed' }];
    this.#failureCount += 1;
    this.#emit();
  }

  #emit(): void {
    this.#opts.onChange?.(this.snapshot());
  }
}
