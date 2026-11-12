'use client';

// PRT-1/PRT-3 — the print pipeline's React half, in ONE place, at SHELL level.
//
// It was previously inlined twice: once in PosOrderEntry and once inside
// OrderDetailModal. Inside the modal it was actively broken. `app/staff/page.tsx`
// mounts <OrderDetailModal> only while an order is selected and useModalDismiss
// closes it on Escape or a backdrop tap, so closing the order:
//   - unmounted an in-flight print iframe, killing the job with no signal at
//     all — a staffer who tapped "Print KOT" and immediately closed the order
//     silently cancelled the print, which the old window.open tab never did;
//   - destroyed the PrintQueue instance held in a per-component ref, taking the
//     failure chip, the Retry buttons and the shift failure tally with it.
//
// Lifting it to page level fixed the modal and left the same hole one level
// up: each screen (New order, the board, Settle, HIOC Ritual) mounted a dock of
// its own, so "Open order" on the confirmation, a header link or Ctrl+T while
// a KOT was queued or printing dropped the KOT, its frame and its chip. So the
// queue, the frame and the chip now live in <PrintDockProvider>, mounted once
// by the staff shell (components/staff/StaffShell.tsx), and outlive every
// screen and modal under /staff. The engine itself is framework-free
// (lib/pos/printDock.ts).
//
// Anything that wants to print calls `usePrintDock().enqueue` and forgets
// about it: success is silent by design, and failure raises the chip below
// wherever the staffer has navigated to since.

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  describePrintJob,
  isPrintQueueBusy,
  printFailureMessage,
  printJobsOutcome,
  printUnsureMessage,
  printUnsureSkipLabel,
  unsurePrinters,
  PRINT_MESSAGE_CHANNEL,
  type PrintFrameMessage,
  type PrintJobSpec,
  type PrintJobsOutcome,
} from '@/lib/pos/printQueue';
import { EMPTY_PRINT_DOCK_SNAPSHOT, PrintDockEngine, type PrintDockSnapshot } from '@/lib/pos/printDock';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { createDesktopExecutor } from '@/lib/desktop/printExecutor';
import { LocalPrintFrame } from '@/components/staff/LocalPrintFrame';

export interface PrintDock {
  /**
   * Queue one or more jobs. Order is preserved: a KOT before a receipt prints
   * first. Returns the queued jobs' ids (for `outcomeOf`).
   */
  enqueue: (specs: PrintJobSpec[]) => string[];
  /**
   * The iframe + failure chip. Inside the staff shell the shell renders them
   * and this is null; rendering it anyway is harmless.
   */
  node: React.ReactNode;
  /** A job is still waiting or printing. */
  busy: boolean;
  /** A job failed and is waiting for Retry/Dismiss. */
  hasFailed: boolean;
  /** Where THESE jobs stand — for a screen waiting on its own prints only. */
  outcomeOf: (jobIds: readonly string[]) => PrintJobsOutcome;
}

const PrintDockContext = createContext<PrintDockEngine | null>(null);

function createEngine(): PrintDockEngine {
  // PRN-4/PRN-5 — computed once, when the engine is made: the bridge either
  // exists for the life of this window or it never will.
  const bridge = getDesktopBridge();
  return new PrintDockEngine({ desktopExecutor: bridge ? createDesktopExecutor(bridge) : null });
}

/**
 * An engine owned by the calling component, disposed when it really unmounts.
 * The dispose waits a tick so React's StrictMode rehearsal (an unmount and
 * remount of every effect, in development) cancels it instead of leaving the
 * component holding a dead dock.
 */
function useOwnedEngine(enabled: boolean): PrintDockEngine | null {
  const [engine] = useState(() => (enabled ? createEngine() : null));
  const pendingDispose = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!engine) return undefined;
    if (pendingDispose.current !== null) {
      clearTimeout(pendingDispose.current);
      pendingDispose.current = null;
    }
    return () => {
      pendingDispose.current = setTimeout(() => engine.dispose(), 0);
    };
  }, [engine]);
  return engine;
}

const noSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_PRINT_DOCK_SNAPSHOT;

function useDockSnapshot(engine: PrintDockEngine | null): PrintDockSnapshot {
  return useSyncExternalStore(
    engine ? engine.subscribe : noSubscribe,
    engine ? engine.getSnapshot : emptySnapshot,
    emptySnapshot,
  );
}

/**
 * The staff shell's one dock. Everything under it that calls usePrintDock()
 * shares this queue, frame and chip.
 */
export function PrintDockProvider({ children }: { children: React.ReactNode }) {
  const engine = useOwnedEngine(true) as PrintDockEngine;
  const snapshot = useDockSnapshot(engine);
  const busy = isPrintQueueBusy(snapshot);

  // Moving between staff screens no longer touches the dock; only a full
  // reload or closing the tab does. While a ticket is still queued or
  // printing, ask first — the browser's own "Leave site?" prompt. (The desktop
  // shell overrides this veto on purpose, desktop/src/main.ts, and its prints
  // already belong to the bridge.)
  useEffect(() => {
    if (!busy) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [busy]);

  return (
    <PrintDockContext.Provider value={engine}>
      {children}
      <PrintDockView engine={engine} snapshot={snapshot} />
    </PrintDockContext.Provider>
  );
}

/**
 * The print dock: the shell's when there is one (every /staff screen), else —
 * outside the shell, e.g. a preview — a dock of this component's own,
 * rendered through `node` exactly as the page-level dock used to be.
 */
export function usePrintDock(): PrintDock {
  const shared = useContext(PrintDockContext);
  const own = useOwnedEngine(shared === null);
  const engine = shared ?? own;
  const snapshot = useDockSnapshot(engine);

  const enqueue = useCallback(
    (specs: PrintJobSpec[]) => (engine ? engine.enqueue(specs).map((job) => job.id) : []),
    [engine],
  );

  return useMemo(
    () => ({
      enqueue,
      node: !shared && engine ? <PrintDockView engine={engine} snapshot={snapshot} /> : null,
      busy: isPrintQueueBusy(snapshot),
      hasFailed: snapshot.failed.length > 0,
      outcomeOf: (jobIds: readonly string[]) => printJobsOutcome(snapshot, jobIds),
    }),
    [enqueue, engine, shared, snapshot],
  );
}

function PrintDockView({ engine, snapshot }: { engine: PrintDockEngine; snapshot: PrintDockSnapshot }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Only same-origin messages on our own channel count, and only from the
  // frame mounted right now: a frame torn down after its job timed out can
  // still have a "printed" in flight, and it must not settle the next job.
  // A frame that never speaks is left to the queue's timeout.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Partial<PrintFrameMessage> | null;
      if (!data || data.channel !== PRINT_MESSAGE_CHANNEL || !data.event) return;
      const fromCurrentFrame = event.source !== null && event.source === iframeRef.current?.contentWindow;
      engine.frameMessage(data, fromCurrentFrame);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [engine]);

  const { frame } = snapshot;

  return (
    <>
      {/* PRT-3 — the loud half. Nothing is ever shown for a print that worked;
          this only exists because a silent pipeline's failure is a kitchen that
          never got its ticket. It outlives every modal, confirmation and screen
          on purpose: it stays until the staffer retries it or says they've dealt
          with it. */}
      {snapshot.failed.length > 0 ? (
        <div
          role="alert"
          className="fixed bottom-4 left-4 z-[60] w-[min(20rem,calc(100vw-2rem))] rounded-md border border-red-300 bg-red-50 p-3 shadow-lg"
        >
          <p className="text-sm font-bold text-red-800">{printFailureMessage(snapshot.failed)}</p>
          {snapshot.escalate ? (
            <p className="mt-1 text-xs text-red-700">
              {engine.desktop
                ? 'Third failure this shift — check the printer in Printers.'
                : "Third failure this shift — check the printer is on and set as this machine’s default (see the counter setup guide)."}
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {snapshot.failed.map((job) =>
              unsurePrinters(job).length === 0 ? (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => engine.retry(job.id)}
                  className="rounded-md bg-red-700 px-3 py-2 text-xs font-bold text-cream hover:bg-red-800"
                >
                  Retry {describePrintJob(job)}
                </button>
              ) : (
                // A copy was already with the printer when the watchdog gave up
                // (desktop app): it may be on the rail. Only the staffer can look,
                // so Retry becomes their two answers instead of a guess.
                <Fragment key={job.id}>
                  <p className="w-full text-xs text-red-700">{printUnsureMessage(job)}</p>
                  <button
                    type="button"
                    onClick={() => engine.retry(job.id, { unknown: 'reprint' })}
                    className="rounded-md bg-red-700 px-3 py-2 text-xs font-bold text-cream hover:bg-red-800"
                  >
                    Reprint {describePrintJob(job)}
                  </button>
                  <button
                    type="button"
                    onClick={() => engine.retry(job.id, { unknown: 'skip' })}
                    className="rounded-md border border-red-300 px-3 py-2 text-xs font-bold text-red-800 hover:bg-red-100"
                  >
                    {printUnsureSkipLabel(job)}
                  </button>
                </Fragment>
              ),
            )}
            <button
              type="button"
              onClick={() => engine.dismissAll()}
              className="rounded-md border border-red-300 px-3 py-2 text-xs font-bold text-red-800 hover:bg-red-100"
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      {/* PRT-3's honest half. `afterprint` means the browser handed the job to
          the OS spooler — it fires with the printer switched off, and no browser
          API can see paper. Rather than call that success and go silent, the
          job is named for a few seconds with one way to contradict it. Sits
          below the failure chip and never blocks anything. */}
      {snapshot.failed.length === 0 && snapshot.handedOff.length > 0 ? (
        <div
          role="status"
          className="fixed bottom-4 left-4 z-[55] w-[min(20rem,calc(100vw-2rem))] rounded-md border border-line bg-cream p-2.5 shadow-md"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-charcoal">
              {snapshot.handedOff.map(describePrintJob).join(', ')} sent to the printer
            </p>
            <button
              type="button"
              onClick={() => snapshot.handedOff.forEach((job) => engine.reportNotPrinted(job.id))}
              className="min-h-[36px] shrink-0 rounded-md border border-[#d8d2c7] px-3 text-xs font-bold text-charcoal hover:border-red-400 hover:text-red-700"
            >
              Didn&rsquo;t print
            </button>
          </div>
        </div>
      ) : null}

      {/* PRT-1 — where printing actually happens. Off-screen rather than
          display:none (a frame with no layout can print blank) and 80 mm wide so
          the ticket lays out exactly as it will on paper. Keyed by attempt so a
          retry reloads the document and fires print() again, and so each frame
          can only ever speak for the attempt it was mounted for. */}
      {frame && 'local' in frame ? (
        <LocalPrintFrame
          key={frame.key}
          order={frame.local.order}
          type={frame.local.type}
          onEvent={(event) => engine.frameEvent(frame.key, event)}
        />
      ) : frame ? (
        <iframe
          key={frame.key}
          ref={iframeRef}
          src={frame.src}
          title="Printing"
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed left-[-10000px] top-0 h-[600px] w-[80mm] border-0 opacity-0"
        />
      ) : null}
    </>
  );
}
