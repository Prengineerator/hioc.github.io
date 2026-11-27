'use client';

// PRT-1, printed from the counter's own data. The hidden-frame print used to
// load /staff-print/<id>/<type> into the frame: a server render per ticket, for
// an order the POS had just been handed by the create answer. This frame draws
// the same ticket (TicketPage + TicketSheet, the page's own components) from
// that order instead, and prints it.
//
// The frame starts as an empty same-origin document. On load it takes the
// POS's stylesheets (the app's CSS, already in the browser's cache) and the
// root element's classes (the font variables), and the ticket is rendered into
// its body through a portal. It then prints the way PrintOnLoad does, and
// reports the same three events, so the queue's watchdog and hand-off behave
// exactly as they do for the page.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { StaffPrintOrder } from '@/lib/orders/getStaffPrintOrder';
import type { PrintType } from '@/lib/staff/autoPrint';
import type { PrintFrameMessage } from '@/lib/pos/printQueue';
import { TicketPage, TicketSheet } from '@/components/print/TicketSheet';

const BLANK = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body></body></html>';
/** Same settle time PrintOnLoad and AutoPrint give layout and fonts. */
const SETTLE_MS = 300;
/** A stylesheet that hasn't loaded by now isn't coming; print with what there is. */
const STYLESHEET_WAIT_MS = 3_000;

type FrameEvent = PrintFrameMessage['event'];

/** The POS's stylesheets, copied into the frame; resolves when each has loaded or given up. */
function adoptStyles(from: Document, into: Document): Promise<void> {
  const loads: Promise<void>[] = [];
  from.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
    const copy = into.importNode(node, true) as HTMLElement;
    if (copy.tagName === 'LINK') {
      loads.push(
        new Promise<void>((resolve) => {
          copy.addEventListener('load', () => resolve(), { once: true });
          copy.addEventListener('error', () => resolve(), { once: true });
          setTimeout(resolve, STYLESHEET_WAIT_MS);
        }),
      );
    }
    into.head.appendChild(copy);
  });
  return Promise.all(loads).then(() => undefined);
}

export function LocalPrintFrame({
  order,
  type,
  onEvent,
}: {
  /** Already narrowed to what this ticket prints (lib/print/localTicket ticketOrderFor). */
  order: StaffPrintOrder;
  type: PrintType;
  onEvent: (event: FrameEvent) => void;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const prepared = useRef(false);
  const stylesReady = useRef<Promise<void>>(Promise.resolve());
  const report = useRef(onEvent);
  report.current = onEvent;

  function prepare() {
    const doc = frameRef.current?.contentDocument;
    // Before srcdoc is parsed the frame holds Chrome's initial about:blank,
    // which also reads 'complete'; only the srcdoc document is ours.
    if (!doc || prepared.current || doc.URL !== 'about:srcdoc' || !doc.body) return;
    prepared.current = true;
    doc.documentElement.className = document.documentElement.className;
    doc.body.className = 'font-sans bg-white text-black';
    stylesReady.current = adoptStyles(document, doc);
    setBody(doc.body);
  }

  // The load event can come before React is listening (a frame that was in the
  // server HTML loads during parsing), so also take a frame that is already
  // loaded.
  useEffect(() => {
    if (frameRef.current?.contentDocument?.readyState === 'complete') prepare();
  }, []);

  // Once the ticket is in the frame: wait for its styles and fonts, then print.
  useEffect(() => {
    const win = frameRef.current?.contentWindow;
    const doc = frameRef.current?.contentDocument;
    if (!body || !win || !doc) return undefined;
    let cancelled = false;

    // 'beforeprint' is not an outcome: the dialog is up (or, under
    // --kiosk-printing, rendering is about to start), so the queue stops its
    // 10 s watchdog. 'afterprint' means the job left the browser for the
    // spooler, the most this side can claim (see PrintOnLoad).
    const onBefore = () => report.current('dialog');
    const onAfter = () => report.current('printed');
    win.addEventListener('beforeprint', onBefore);
    win.addEventListener('afterprint', onAfter);

    void stylesReady.current
      .then(() => doc.fonts?.ready)
      .catch(() => undefined)
      .then(
        () =>
          new Promise<void>((resolve) => {
            setTimeout(resolve, SETTLE_MS);
          }),
      )
      .then(() => {
        if (cancelled) return;
        try {
          win.focus();
          win.print();
        } catch {
          report.current('failed');
        }
      });

    return () => {
      cancelled = true;
      win.removeEventListener('beforeprint', onBefore);
      win.removeEventListener('afterprint', onAfter);
    };
  }, [body]);

  return (
    <>
      <iframe
        ref={frameRef}
        srcDoc={BLANK}
        onLoad={prepare}
        title="Printing"
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none fixed left-[-10000px] top-0 h-[600px] w-[80mm] border-0 opacity-0"
      />
      {body
        ? createPortal(
            <TicketPage>
              <TicketSheet order={order} type={type} />
            </TicketPage>,
            body,
          )
        : null}
    </>
  );
}
