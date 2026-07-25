'use client';

// Print toolbar + auto-open helper for the staff 80mm print pages (KOT-1/KOT-2).
// A tiny client island so the otherwise-static server-rendered ticket needs no
// client JS of its own. On mount it opens the browser's print dialog (decision
// D3 — the thermal printer is USB-connected, so v1 prints through the system
// dialog, no driver code); a manual Print button is the fallback if the auto
// dialog is dismissed or blocked. The whole toolbar is `print:hidden`, so it
// never appears on the ticket itself.
import { useEffect } from 'react';

export function AutoPrint({ label = 'Print' }: { label?: string }) {
  useEffect(() => {
    // A short delay lets fonts/layout settle before the dialog snapshots the page.
    const t = setTimeout(() => {
      try {
        window.print();
      } catch {
        /* no-op — the manual button below is the fallback */
      }
    }, 300);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
      <button
        type="button"
        onClick={() => window.close()}
        className="text-sm text-tan hover:underline"
      >
        Close
      </button>
      <button
        type="button"
        onClick={() => window.print()}
        className="rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-dark"
      >
        {label} / Save as PDF
      </button>
    </div>
  );
}
