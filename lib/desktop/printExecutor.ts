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
//
// A job is tracked per TARGET — one copy on one printer — on the job itself
// (PrintJob.targets, lib/pos/printQueue.ts). The bar printer failing no longer
// fails the kitchen's copy with it, and a retry sends only what didn't print:
// a second KOT on the kitchen rail reads as a second order. When the queue
// stops waiting (its timeout) the attempt's signal aborts and no further copy
// is STARTED; a copy already with the bridge can't be recalled (bridge.ts has
// no cancel), so the queue marks it unknown and Retry asks before resending it.

import type { HiocDesktopBridge, PrinterConfig, PrintResult } from '@/lib/desktop/bridge';
import { routeJob } from '@/lib/desktop/routing';
import { renderEscPos } from '@/lib/print/escpos';
import { getBrandHeaderRaster } from '@/lib/print/brandHeaderRaster';
import type { TicketBlock, TicketDoc } from '@/lib/print/ticketDoc';
import {
  describePrintJob,
  targetNeedsPrint,
  type PrintAttemptContext,
  type PrintJob,
} from '@/lib/pos/printQueue';
import { kotItemsQuery } from '@/lib/print/kotAddition';
import { localPrintOrder, localTicketDoc } from '@/lib/print/localTicket';
import { printUrl } from '@/lib/staff/autoPrint';

/**
 * Replaces a `{ kind: 'brandHeader' }` placeholder block in `doc` (receipts
 * and token slips — see lib/print/ticketModel.ts) with the rasterized HIOC
 * wordmark for this printer's paper width. `getBrandHeaderRaster` returns
 * `null` on any failure (no canvas, a blocked logo/font load, …), in which
 * case the placeholder is left exactly as-is and `renderEscPos`'s centered
 * double-size "HIOC." text fallback prints instead — a bad rasterization can
 * never block or break the print job. A doc with no `brandHeader` block
 * (the KOT) is returned unchanged with no rasterization work done at all.
 * Exported so PrinterSettings' "Test print" path (lib/print/testTicket.ts)
 * resolves the header the same way.
 */
export async function resolveBrandHeader(doc: TicketDoc, paperWidthMm: 58 | 80): Promise<TicketDoc> {
  if (!doc.blocks.some((b) => b.kind === 'brandHeader')) return doc;

  const raster = await getBrandHeaderRaster(paperWidthMm);
  if (!raster) return doc;

  const blocks: TicketBlock[] = doc.blocks.map((b) => (b.kind === 'brandHeader' ? raster : b));
  return { ...doc, blocks };
}

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

async function fetchTicketDoc(orderId: string, type: PrintJob['type'], itemIds?: string[]): Promise<TicketDoc> {
  const query = type === 'kot' ? kotItemsQuery(itemIds) : '';
  const res = await fetch(`/api/print/ticket/${orderId}/${type}${query ? `?${query}` : ''}`, { cache: 'no-store' });
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
 * One copy of a job on one printer — the key PrintJob.targets is indexed by.
 * Stable across attempts as long as the routing is unchanged; a routing edit
 * between attempts simply produces keys the job hasn't seen, which print.
 */
export function printTargetKey(printerId: string, copy: number): string {
  return `${printerId}#${copy}`;
}

const NO_REPORT: PrintAttemptContext['report'] = () => {};

/**
 * Builds the executor PrintQueue calls for one job. `bridge` is captured once
 * (PrintDock creates the executor when the bridge first appears); the printer
 * LIST is re-fetched every call so a config change in Printers takes effect on
 * the very next print with no reload — "cache per call" just means a job that
 * routes to three printers makes one `list()` call, not three.
 */
export function createDesktopExecutor(
  bridge: HiocDesktopBridge,
): (job: PrintJob, ctx?: PrintAttemptContext) => Promise<{ confirmed: boolean }> {
  return async (job, ctx) => {
    const signal = ctx?.signal;
    const report = ctx?.report ?? NO_REPORT;
    const printers = await bridge.printers.list();
    if (printers.length === 0) throw new NoPrintersConfiguredError();

    const routed = routeJob(printers, job.type);
    if (routed.length === 0) {
      throw new Error(
        `No printer is set for ${describePrintJob({ type: job.type })} — open Printers to assign one.`,
      );
    }

    // The whole plan, announced before anything is sent, so the job knows
    // every copy it owes — a retry after the staffer says "Kitchen printed it"
    // must still send the bar's copy that never started.
    const plan = routed.map(({ printer, copies }) => ({
      printer,
      targets: Array.from({ length: copies }, (_, i) => printTargetKey(printer.id, i + 1)),
    }));
    for (const { printer, targets } of plan) {
      for (const key of targets) {
        if (!job.targets?.[key]) report(key, { printer: printer.name, state: 'pending' });
      }
    }

    // Fetched at most once and shared across every printer/copy this job
    // routes to — a KOT going to kitchen AND bar prints the SAME snapshot of
    // the order, not two independently-fetched ones taken moments apart. A
    // placement's first attempt needs no fetch at all: the job carries the
    // order the create answer returned, and the doc is built here with the
    // same code the ticket route runs (lib/print/localTicket.ts).
    const carried = localPrintOrder(job);
    let ticketDocPromise: Promise<TicketDoc> | null = null;
    const getTicketDoc = () => {
      if (!ticketDocPromise) {
        ticketDocPromise = carried
          ? Promise.resolve().then(() => localTicketDoc(carried, job.type, job.itemIds))
          : fetchTicketDoc(job.orderId, job.type, job.itemIds);
      }
      return ticketDocPromise;
    };

    // What each copy sent THIS attempt answered: confirmed or not.
    const sent = new Map<string, boolean>();

    // allSettled, not all: the bar's printer throwing must not abandon the
    // kitchen's copies mid-way (Promise.all would reject at once and leave
    // them printing with nobody recording it). Every printer finishes, every
    // copy's outcome is reported, and only then does the job fail.
    const outcomes = await Promise.allSettled(
      plan.map(async ({ printer, targets }) => {
        const owed = targets.filter((key) => targetNeedsPrint(job.targets?.[key]?.state));
        if (owed.length === 0) return;
        try {
          let send: () => Promise<PrintResult>;
          if (isRawCapable(printer)) {
            const doc = await getTicketDoc();
            const resolved = await resolveBrandHeader(doc, printer.paperWidthMm);
            const bytes = renderEscPos(resolved, {
              paperWidthMm: printer.paperWidthMm,
              cut: printer.cut,
              cutMode: printer.cutMode,
            });
            send = () => bridge.printRaw(printer.id, bytes);
          } else {
            // system + driver — the shell prints the existing staff-gated HTML
            // ticket page off-screen, silently, with no Chrome print dialog. It
            // still loads that page from the server: the shell can only print a
            // URL, and taking HTML from the page needs a desktop app release.
            const path = printUrl(job.orderId, job.type, job.itemIds);
            const url = `${window.location.origin}${path}${path.includes('?') ? '&' : '?'}silent=1`;
            send = () => bridge.printUrl(printer.id, url);
          }

          for (const key of owed) {
            // The queue has stopped waiting for this attempt: start nothing
            // more. Copies not started stay owed, so a retry sends them.
            if (signal?.aborted) throw new Error('stopped — the print timed out');
            report(key, { printer: printer.name, state: 'printing' });
            let result: PrintResult;
            try {
              result = await send();
            } catch (err) {
              report(key, { printer: printer.name, state: 'failed' });
              throw err;
            }
            report(key, { printer: printer.name, state: 'printed', confirmed: result.confirmed });
            sent.set(key, result.confirmed);
          }
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err);
          // PRN-4: error messages must name the printer — "Kitchen: offline"
          // tells a staffer which physical machine to go check.
          throw new Error(`${printer.name}: ${detail}`);
        }
      }),
    );

    // Several printers for one role all have to succeed — a KOT that reached
    // the kitchen but not the bar is a half-failure, not a success. The
    // kitchen's copy is recorded as printed, so the retry is the bar's alone.
    const failures = outcomes.flatMap((o) =>
      o.status === 'rejected' ? [o.reason instanceof Error ? o.reason.message : String(o.reason)] : [],
    );
    if (failures.length > 0) throw new Error(failures.join('; '));

    // Confirmed only when every copy the job owes is vouched for: by the
    // printer this attempt, by the printer on an earlier attempt, or by the
    // staffer ("Kitchen printed it").
    const confirmed = plan.every(({ targets }) =>
      targets.every((key) => {
        if (sent.has(key)) return sent.get(key) === true;
        const earlier = job.targets?.[key];
        return earlier?.state === 'skipped' || (earlier?.state === 'printed' && earlier.confirmed === true);
      }),
    );
    return { confirmed };
  };
}
