'use client';

import { useEffect } from 'react';

// "Print / save as PDF" for the owner's GST report (app/owner/reports/gst). A
// tiny client island so the report itself stays a server component.
//
// Sections marked `data-print-open` (the glossary and the day-wise register)
// are collapsed on screen to keep the page short, but a printout or PDF should
// have them. Browsers print a closed <details> as just its summary, so they are
// opened for the printout and put back afterwards. That works for Ctrl+P and the
// browser's own Print menu too, not only this button: `beforeprint` /
// `afterprint` where they exist, and the print media query for Safari, which
// fires only the latter.
export function PrintReportButton({ className }: { className?: string }) {
  useEffect(() => {
    let reopened: HTMLDetailsElement[] = [];
    const open = () => {
      const closed = Array.from(document.querySelectorAll<HTMLDetailsElement>('details[data-print-open]')).filter(
        (d) => !d.open,
      );
      closed.forEach((d) => {
        d.open = true;
      });
      reopened.push(...closed);
    };
    const restore = () => {
      reopened.forEach((d) => {
        d.open = false;
      });
      reopened = [];
    };
    const media = window.matchMedia('print');
    const onMedia = (e: MediaQueryListEvent) => (e.matches ? open() : restore());
    window.addEventListener('beforeprint', open);
    window.addEventListener('afterprint', restore);
    media.addEventListener?.('change', onMedia);
    return () => {
      window.removeEventListener('beforeprint', open);
      window.removeEventListener('afterprint', restore);
      media.removeEventListener?.('change', onMedia);
    };
  }, []);

  return (
    <button type="button" onClick={() => window.print()} className={className}>
      Print / save as PDF
    </button>
  );
}
