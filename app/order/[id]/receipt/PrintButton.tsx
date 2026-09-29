'use client';

// Print / Save-as-PDF trigger for the receipt page. A tiny client island so the
// otherwise-static server-rendered receipt needs no client JS of its own.
// Hidden in the printout itself (print:hidden on the wrapper).
export function PrintButton() {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="rounded-md bg-tan-dark px-4 py-2 text-sm font-bold text-cream transition-colors hover:bg-tan-darker"
    >
      Print / Save as PDF
    </button>
  );
}
