// PRN-4/PRN-5 — the desktop `PrintQueue` executor.
//
// The browser executor (components/staff/PrintDock) mounts a hidden iframe and
// waits for `afterprint`, which can't see paper and can't route to more than
// one printer. This one talks to `window.hiocDesktop` instead: it routes the
// job to every printer configured for its role (lib/desktop/routing), renders
// real ESC/POS bytes for anything raw-capable (network / USB / system+raw) and
// falls back to a silent driver print of the existing HTML ticket page for
// system+driver printers. Confirmed printers skip PrintQueue's hand-off window
// entirely (see lib/pos/printQueue.ts) — the printer itself vouched for the
// paper, which the iframe path could never do.

import type { HiocDesktopBridge, PrinterConfig } from '@/lib/desktop/bridge';
import { routeJob } from '@/lib/desktop/routing';
import { renderEscPos } from '@/lib/print/escpos';
import type { TicketDoc } from '@/lib/print/ticketDoc';
import { describePrintJob, type PrintJob } from '@/lib/pos/printQueue';

/**
 * This machine has NO printers configured at all — as opposed to printers
 * existing but none assigned to this job's role (that's a plain `Error`
 * instead, below). PrintDock catches this one specifically and falls back to
 * the existing iframe path, so a freshly-installed shell (or one mid-setup)
 * keeps printing exactly like the browser until the owner visits Printers.
 */
export class NoPrintersConfiguredError extends Error {
  constructor() {
    super('No printers are configured on this machine yet.');
    this.name = 'NoPrintersConfiguredError';
  }
}

async function fetchTicketDoc(orderId: string, type: PrintJob['type']): Promise<TicketDoc> {
  const res = await fetch(`/api/print/ticket/${orderId}/${type}`, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Could not load the ${describePrintJob({ type })} ticket to print (${res.status}).`);
  }
  const data = (await res.json()) as { doc: TicketDoc };
  return data.doc;
}

/** network and usb are always raw ESC/POS; system is raw only in 'raw' mode. */
function isRawCapable(printer: PrinterConfig): boolean {
  return printer.connection.kind !== 'system' || printer.connection.mode === 'raw';
}

/**
 * Builds the executor PrintQueue calls for one job. `bridge` is captured once
 * (PrintDock creates the executor when the bridge first appears); the printer
 * LIST is re-fetched every call so a config change in Printers takes effect on
 * the very next print with no reload — "cache per call" just means a job that
 * routes to three printers makes one `list()` call, not three.
 */
export function createDesktopExecutor(
  bridge: HiocDesktopBridge,
): (job: PrintJob) => Promise<{ confirmed: boolean }> {
  return async (job) => {
    const printers = await bridge.printers.list();
    if (printers.length === 0) throw new NoPrintersConfiguredError();

    const routed = routeJob(printers, job.type);
    if (routed.length === 0) {
      throw new Error(
        `No printer is set for ${describePrintJob({ type: job.type })} — open Printers to assign one.`,
      );
    }

    // Fetched at most once and shared across every printer/copy this job
    // routes to — a KOT going to kitchen AND bar prints the SAME snapshot of
    // the order, not two independently-fetched ones taken moments apart.
    let ticketDocPromise: Promise<TicketDoc> | null = null;
    const getTicketDoc = () => {
      if (!ticketDocPromise) ticketDocPromise = fetchTicketDoc(job.orderId, job.type);
      return ticketDocPromise;
    };

    const perPrinterConfirmed = await Promise.all(
      routed.map(async ({ printer, copies }) => {
        try {
          if (isRawCapable(printer)) {
            const doc = await getTicketDoc();
            const bytes = renderEscPos(doc, {
              paperWidthMm: printer.paperWidthMm,
              cut: printer.cut,
              cutMode: printer.cutMode,
            });
            let confirmed = true;
            for (let i = 0; i < copies; i++) {
              const result = await bridge.printRaw(printer.id, bytes);
              confirmed = confirmed && result.confirmed;
            }
            return confirmed;
          }

          // system + driver — the shell prints the existing staff-gated HTML
          // ticket page off-screen, silently, with no Chrome print dialog.
          const url = `${window.location.origin}/staff-print/${job.orderId}/${job.type}?silent=1`;
          let confirmed = true;
          for (let i = 0; i < copies; i++) {
            const result = await bridge.printUrl(printer.id, url);
            confirmed = confirmed && result.confirmed;
          }
          return confirmed;
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          // PRN-4: error messages must name the printer — "Kitchen: offline"
          // tells a staffer which physical machine to go check.
          throw new Error(`${printer.name}: ${detail}`);
        }
      }),
    );

    // Several printers for one role all have to succeed — a KOT that reached
    // the kitchen but not the bar is a silent half-failure, not a success.
    return { confirmed: perPrinterConfirmed.every(Boolean) };
  };
}
