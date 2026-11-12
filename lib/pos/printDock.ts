// PRT-1/PRT-3 — the print dock's engine: ONE queue, ONE print frame and the
// failure chip's state, for the whole staff shell (components/staff/PrintDock).
//
// It used to live inside a React hook that every printing screen called for
// itself (New order, the order board, Settle, HIOC Ritual), so each screen had
// its own queue and its own hidden frame. Leaving a screen while a ticket was
// queued or printing unmounted all of it: the queued KOT never printed, the
// frame went with the print in it, and the failure chip that was meant to
// catch exactly that went too — the silent missed ticket PRT-3 exists to
// prevent. Now the shell owns one engine and every screen hands it jobs.
//
// This module knows nothing about React or the DOM, so its lifecycle is a test
// rather than a hope:
//   - the frame belongs to ONE attempt of one job (`frame.key`), and only that
//     frame may settle it — a late "printed" from a frame that was torn down
//     (its job timed out, or the dock was disposed) can't settle the next job;
//   - dispose() clears every timer the queue armed, aborts the running attempt
//     and settles the frame's waiter, so nothing outlives the shell.

import {
  printFrameSrc,
  PrintQueue,
  type PrintAttemptContext,
  type PrintFrameMessage,
  type PrintJob,
  type PrintJobSpec,
  type PrintQueueOptions,
  type PrintQueueSnapshot,
  type PrintRetryOptions,
  type PrintRetryResult,
} from '@/lib/pos/printQueue';
import { NoPrintersConfiguredError } from '@/lib/desktop/printExecutor';
import { localPrintOrder, ticketOrderFor } from '@/lib/print/localTicket';
import type { StaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';
import type { PrintType } from '@/lib/staff/autoPrint';

/**
 * The one print frame: the /staff-print page (`src`), or the same ticket drawn
 * on the counter from the order the job carries (`local`,
 * components/staff/LocalPrintFrame). `key` names the attempt it was mounted
 * for — `<job id>#<attempt>` — and is what it must quote to settle anything.
 */
export type PrintFrame = {
  key: string;
  jobId: string;
  orderId: string;
  type: PrintType;
} & ({ src: string } | { local: { order: StaffPrintOrder; type: PrintType } });

export interface PrintDockSnapshot extends PrintQueueSnapshot {
  frame: PrintFrame | null;
}

export const EMPTY_PRINT_DOCK_SNAPSHOT: PrintDockSnapshot = {
  jobs: [],
  failed: [],
  handedOff: [],
  failureCount: 0,
  escalate: false,
  phase: 'idle',
  frame: null,
};

export type DesktopPrintExecutor = (job: PrintJob, ctx: PrintAttemptContext) => Promise<{ confirmed: boolean }>;

export interface PrintDockEngineOptions
  extends Pick<PrintQueueOptions, 'timeoutMs' | 'dialogTimeoutMs' | 'handoffMs' | 'setTimer' | 'clearTimer' | 'newId'> {
  /** PRN-4/PRN-5 — present only inside the desktop app (lib/desktop/printExecutor). */
  desktopExecutor?: DesktopPrintExecutor | null;
}

const FRAME_EVENTS: readonly PrintFrameMessage['event'][] = ['printed', 'failed', 'dialog'];

export class PrintDockEngine {
  readonly #queue: PrintQueue;
  readonly #desktop: DesktopPrintExecutor | null;
  #frame: PrintFrame | null = null;
  #waiter: { key: string; resolve: () => void; reject: (err: Error) => void } | null = null;
  #snapshot: PrintDockSnapshot = EMPTY_PRINT_DOCK_SNAPSHOT;
  #listeners = new Set<() => void>();
  #disposed = false;

  constructor(opts: PrintDockEngineOptions = {}) {
    const { desktopExecutor = null, ...queueOpts } = opts;
    this.#desktop = desktopExecutor;
    this.#queue = new PrintQueue({
      ...queueOpts,
      execute: (job, ctx) => this.#execute(job, ctx),
      // The job timed out or failed: its frame must go, or a late
      // window.print() in it would race the next job.
      abort: (job) => this.#closeFrameOf(job.id),
      onChange: () => this.#publish(),
    });
  }

  /** Inside the desktop app — the chip's escalation copy points at Printers. */
  get desktop(): boolean {
    return this.#desktop !== null;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** For useSyncExternalStore: a stable function, a stable snapshot between changes. */
  subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => {};
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): PrintDockSnapshot => this.#snapshot;

  /** Queue jobs in order (a KOT before a receipt). Returns the queued jobs; none once disposed. */
  enqueue(specs: PrintJobSpec[]): PrintJob[] {
    return this.#queue.enqueue(specs);
  }

  retry(jobId: string, opts?: PrintRetryOptions): PrintRetryResult {
    return this.#queue.retry(jobId, opts);
  }

  dismissAll(): void {
    this.#queue.dismissAll();
  }

  reportNotPrinted(jobId: string): void {
    this.#queue.reportNotPrinted(jobId);
  }

  /**
   * An event from the frame mounted for attempt `key` (the local frame calls
   * this directly, bound to its own key). Anything from a frame that isn't the
   * current one is about a job this dock has stopped waiting for, and is
   * dropped — it must not settle, or pause the watchdog of, the job that owns
   * the printer now.
   */
  frameEvent(key: string, event: PrintFrameMessage['event']): void {
    const frame = this.#frame;
    if (this.#disposed || !frame || frame.key !== key || !FRAME_EVENTS.includes(event)) return;

    // The native print dialog is open and a human is standing in front of it.
    // The job hasn't finished, so it must not settle — but the 10s watchdog
    // has to stop counting, or it fires while they're choosing a printer.
    if (event === 'dialog') {
      this.#queue.noteDialogOpen();
      return;
    }

    const waiter = this.#waiter?.key === key ? this.#waiter : null;
    this.#waiter = null;
    this.#frame = null;
    this.#publish();
    if (event === 'printed') waiter?.resolve();
    else waiter?.reject(new Error('The print page could not print.'));
  }

  /**
   * A message posted by the /staff-print page. `fromCurrentFrame` is the
   * caller's check that it came from the frame element mounted right now
   * (MessageEvent.source); the page also names its order and ticket type, and
   * both must match the job the frame was mounted for.
   */
  frameMessage(message: Partial<PrintFrameMessage>, fromCurrentFrame: boolean): void {
    const frame = this.#frame;
    if (!fromCurrentFrame || !frame || !('src' in frame) || !message.event) return;
    if (message.orderId !== frame.orderId || message.type !== frame.type) return;
    this.frameEvent(frame.key, message.event);
  }

  /**
   * The shell is going away. Terminal: the queue's timers are cleared and its
   * running attempt aborted, the frame is dropped and its waiter settled (the
   * disposed queue ignores the answer), and nobody is notified again.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#queue.dispose();
    const waiter = this.#waiter;
    this.#waiter = null;
    this.#frame = null;
    waiter?.reject(new Error('The print dock closed.'));
    this.#snapshot = { ...this.#queue.snapshot(), frame: null };
    this.#listeners.clear();
  }

  #execute(job: PrintJob, ctx: PrintAttemptContext): Promise<void | { confirmed: boolean }> {
    const desktop = this.#desktop;
    if (!desktop) return this.#runInFrame(job, ctx);
    return desktop(job, ctx).catch((err) => {
      // No printers configured AT ALL (as opposed to none set for this job's
      // role) — this machine hasn't been set up yet, so behave exactly like a
      // browser until the owner visits Printers.
      if (err instanceof NoPrintersConfiguredError) return this.#runInFrame(job, ctx);
      throw err;
    });
  }

  /**
   * The browser path: mount the frame for this attempt and wait for it to
   * report. A placement's first attempt draws the ticket from the order the
   * job carries instead of loading the page: no server call
   * (lib/print/localTicket.ts). A retry, or a print with no order attached,
   * loads the page as before.
   */
  #runInFrame(job: PrintJob, ctx: PrintAttemptContext): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.#disposed || ctx.signal.aborted) {
        reject(new Error('The print was stopped before it started.'));
        return;
      }
      const carried = localPrintOrder(job);
      let local: { order: StaffPrintOrder; type: PrintType } | null = null;
      if (carried) {
        try {
          local = { order: ticketOrderFor(carried, job.type, job.itemIds), type: job.type };
        } catch (err) {
          reject(err);
          return;
        }
      }
      // One frame at a time (the queue is sequential); a waiter still here
      // belongs to an attempt the queue has already given up on.
      this.#waiter?.reject(new Error('Superseded by the next print.'));
      const key = `${job.id}#${job.attempts}`;
      this.#waiter = { key, resolve, reject };
      const base = { key, jobId: job.id, orderId: job.orderId, type: job.type };
      this.#frame = local ? { ...base, local } : { ...base, src: printFrameSrc(job.orderId, job.type, job.itemIds) };
      this.#publish();
    });
  }

  #closeFrameOf(jobId: string): void {
    if (this.#frame?.jobId !== jobId) return;
    this.#frame = null;
    this.#waiter = null;
    this.#publish();
  }

  #publish(): void {
    if (this.#disposed) return;
    this.#snapshot = { ...this.#queue.snapshot(), frame: this.#frame };
    for (const listener of [...this.#listeners]) listener();
  }
}
