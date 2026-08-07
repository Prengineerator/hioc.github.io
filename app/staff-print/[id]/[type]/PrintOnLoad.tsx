'use client';

// PRT-1 — the print page's half of the hidden-iframe pipeline.
//
// With `?auto=1` this page is not something a human is looking at: it is mounted
// off-screen inside the POS, prints itself, and reports back. That is the whole
// difference from the AutoPrint toolbar, which exists for a tab a staffer opened
// on purpose and therefore offers Print/Close buttons — buttons nobody can reach
// inside an iframe, and a window.print() that would fight this one.
//
// The report is what makes the watchdog possible (PRT-3): the POS starts a 10s
// clock per job and only a message from here stops it, so a printer that is off
// produces a visible chip instead of a kitchen that never gets its ticket.

import { useEffect } from 'react';
import { PRINT_MESSAGE_CHANNEL, type PrintFrameMessage } from '@/lib/pos/printQueue';

export function PrintOnLoad({ orderId, type }: { orderId: string; type: string }) {
  useEffect(() => {
    const post = (event: PrintFrameMessage['event']) => {
      const message: PrintFrameMessage = { channel: PRINT_MESSAGE_CHANNEL, event, orderId, type };
      try {
        // Same-origin by construction (the POS mounts this page itself), and
        // pinned to that origin so the message can't leak to an embedder.
        window.parent?.postMessage(message, window.location.origin);
      } catch {
        /* the POS's own timeout covers a browser that won't let us answer */
      }
    };

    // 'beforeprint' means the browser has put its dialog up (or, under
    // --kiosk-printing, is about to render). It is NOT an outcome — it tells the
    // POS to stop its 10s watchdog, because from here the thing being timed is a
    // human at a dialog, not a printer answering.
    const onBeforePrint = () => post('dialog');
    window.addEventListener('beforeprint', onBeforePrint);

    // 'afterprint' fires when the dialog closes AND when a kiosk-printing
    // browser finishes silently.
    //
    // READ THIS BEFORE TRUSTING IT: afterprint fires when the browser has handed
    // the job to the OS spooler. It fires whether or not the thermal printer is
    // powered, connected, or has paper — no browser API reports any of that. So
    // 'printed' here means "the job left the browser", which is the strongest
    // claim this side of the pipeline can honestly make, and the POS must not
    // render it as "paper came out". That is why the queue keeps a handed-off
    // job visible for a few seconds with a "Didn't print" escape hatch: the one
    // sensor that CAN see the paper is the staffer.
    const onAfterPrint = () => post('printed');
    window.addEventListener('afterprint', onAfterPrint);

    // Same reason AutoPrint waits: let fonts and layout settle, or the printed
    // ticket can snapshot mid-reflow.
    const t = setTimeout(() => {
      try {
        window.print();
      } catch {
        post('failed');
      }
    }, 300);

    return () => {
      clearTimeout(t);
      window.removeEventListener('beforeprint', onBeforePrint);
      window.removeEventListener('afterprint', onAfterPrint);
    };
  }, [orderId, type]);

  return null;
}
