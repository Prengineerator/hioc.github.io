'use client';

// PRT-1/PRT-3 — the print pipeline's React half, in ONE place and at PAGE level.
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
// PRT-3 specifies a chip that is "persistent" and failures that "escalate at 3
// in a shift". Neither is possible from inside something the staffer closes to
// get back to the board. So the queue, the iframe and the chip live here, are
// mounted once per page, and outlive every modal on it.
//
// Anything that wants to print calls `enqueue` and forgets about it: success is
// silent by design, and failure raises the chip below wherever the staffer has
// navigated to since.

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  describePrintJob,
  printFailureMessage,
  printFrameSrc,
  PrintQueue,
  PRINT_MESSAGE_CHANNEL,
  type PrintFrameMessage,
  type PrintJobSpec,
  type PrintQueueSnapshot,
} from '@/lib/pos/printQueue';

const EMPTY_SNAPSHOT: PrintQueueSnapshot = {
  jobs: [],
  failed: [],
  handedOff: [],
  failureCount: 0,
  escalate: false,
};

export interface PrintDock {
  /** Queue one or more jobs. Order is preserved: a KOT before a receipt prints first. */
  enqueue: (specs: PrintJobSpec[]) => void;
  /** The iframe + failure chip. Render it once, at page level. */
  node: React.ReactNode;
}

export function usePrintDock(): PrintDock {
  const [frame, setFrame] = useState<{ jobId: string; src: string } | null>(null);
  const frameRef = useRef<{ jobId: string; src: string } | null>(null);
  frameRef.current = frame;

  const waiters = useRef(new Map<string, { resolve: () => void; reject: () => void }>());
  const [status, setStatus] = useState<PrintQueueSnapshot>(EMPTY_SNAPSHOT);

  const queue = useRef<PrintQueue | null>(null);
  if (queue.current === null) {
    queue.current = new PrintQueue({
      execute: (job) =>
        new Promise<void>((resolve, reject) => {
          waiters.current.set(job.id, { resolve, reject });
          setFrame({ jobId: job.id, src: printFrameSrc(job.orderId, job.type) });
        }),
      abort: (job) => {
        waiters.current.delete(job.id);
        setFrame((cur) => (cur?.jobId === job.id ? null : cur));
      },
      onChange: setStatus,
    });
  }

  // The frame's "I'm done" / "I couldn't" / "the dialog is up". Only same-origin
  // messages on our own channel count; anything else on the window is ignored,
  // and a frame that never speaks is left to the queue's timeout.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as Partial<PrintFrameMessage> | null;
      if (!data || data.channel !== PRINT_MESSAGE_CHANNEL) return;
      const active = frameRef.current;
      if (!active) return;

      // The native print dialog is open and a human is standing in front of it.
      // The job hasn't finished, so it must not settle — but the 10s watchdog
      // has to stop counting, or it fires while they're choosing a printer.
      if (data.event === 'dialog') {
        queue.current?.noteDialogOpen();
        return;
      }

      const waiter = waiters.current.get(active.jobId);
      waiters.current.delete(active.jobId);
      setFrame(null);
      if (data.event === 'printed') waiter?.resolve();
      else waiter?.reject();
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const enqueue = useCallback((specs: PrintJobSpec[]) => {
    queue.current?.enqueue(specs);
  }, []);

  const node = (
    <>
      {/* PRT-3 — the loud half. Nothing is ever shown for a print that worked;
          this only exists because a silent pipeline's failure is a kitchen that
          never got its ticket. It outlives every modal and confirmation on
          purpose: it stays until the staffer retries it or says they've dealt
          with it. */}
      {status.failed.length > 0 ? (
        <div
          role="alert"
          className="fixed bottom-4 left-4 z-[60] w-[min(20rem,calc(100vw-2rem))] rounded-md border border-red-300 bg-red-50 p-3 shadow-lg"
        >
          <p className="text-sm font-bold text-red-800">{printFailureMessage(status.failed)}</p>
          {status.escalate ? (
            <p className="mt-1 text-xs text-red-700">
              Third failure this shift — check the printer is on and set as this machine&rsquo;s
              default (see the counter setup guide).
            </p>
          ) : null}
          <div className="mt-2 flex flex-wrap gap-2">
            {status.failed.map((job) => (
              <button
                key={job.id}
                type="button"
                onClick={() => queue.current?.retry(job.id)}
                className="rounded-md bg-red-700 px-3 py-2 text-xs font-bold text-cream hover:bg-red-800"
              >
                Retry {describePrintJob(job)}
              </button>
            ))}
            <button
              type="button"
              onClick={() => queue.current?.dismissAll()}
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
      {status.failed.length === 0 && status.handedOff.length > 0 ? (
        <div
          role="status"
          className="fixed bottom-4 left-4 z-[55] w-[min(20rem,calc(100vw-2rem))] rounded-md border border-[#e5e5e5] bg-cream p-2.5 shadow-md"
        >
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-bold text-charcoal">
              {status.handedOff.map(describePrintJob).join(', ')} sent to the printer
            </p>
            <button
              type="button"
              onClick={() => status.handedOff.forEach((job) => queue.current?.reportNotPrinted(job.id))}
              className="shrink-0 rounded-md border border-[#d8d2c7] px-2 py-1 text-[11px] font-bold text-charcoal hover:border-red-400 hover:text-red-700"
            >
              Didn&rsquo;t print
            </button>
          </div>
        </div>
      ) : null}

      {/* PRT-1 — where printing actually happens. Off-screen rather than
          display:none (a frame with no layout can print blank) and 80 mm wide so
          the ticket lays out exactly as it will on paper. Keyed by job so a retry
          reloads the document and fires print() again. */}
      {frame ? (
        <iframe
          key={frame.jobId}
          src={frame.src}
          title="Printing"
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed left-[-10000px] top-0 h-[600px] w-[80mm] border-0 opacity-0"
        />
      ) : null}
    </>
  );

  return { enqueue, node };
}
