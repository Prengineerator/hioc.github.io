'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import QRCode from 'qrcode';
import { absoluteUrl } from '@/lib/url';
import { flags } from '@/lib/flags';
import { CAFE_NAME } from '@/lib/constants';

// QR-2 — printable QR cards. The owner prints one A6 card per active table; the
// card's QR encodes QR-1's scan-to-order URL (/t/<qr_token>).
//
// SECURITY: qr_token is fetched from the owner-only endpoint
// (/api/owner/tables/qr — getOwnerUser-gated, service-role read) and the QR
// image is generated ENTIRELY in the browser with the `qrcode` library. The
// token is never sent to any external QR-image service — self-contained
// generation only, so the sensitive token never leaves the app.
//
// Regenerating a token ("New QR" in TableManager) invalidates the old printed
// card — the owner just reprints from here. No extra code needed for that.
//
// Flag: gated behind flags.tableQr (NEXT_PUBLIC_FLAG_TABLE_QR, default OFF like
// the rest of the QR-1 scan-to-order flow) — a printed card is only useful once
// scanning /t/<token> actually opens the menu. When the flag is off this whole
// surface is hidden, matching §5.2 (new surfaces mount behind their flag).

interface QrTable {
  id: string;
  label: string;
  zone: string;
  qr_token: string;
}

interface QrCard extends QrTable {
  url: string;
  dataUrl: string;
}

// Build the absolute scan URL. absoluteUrl() prefers NEXT_PUBLIC_SITE_URL; in
// local dev (no site URL configured) it returns a bare path, which a QR can't
// encode usefully — fall back to the current origin so the printed code is
// always scannable.
function scanUrl(token: string): string {
  const abs = absoluteUrl(`/t/${token}`);
  if (abs.startsWith('http')) return abs;
  if (typeof window !== 'undefined') return `${window.location.origin}/t/${token}`;
  return abs;
}

export function QrCards() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cards, setCards] = useState<QrCard[]>([]);
  // null = print every card ("Print all"); an id = print just that one card.
  const [soloId, setSoloId] = useState<string | null>(null);
  // Bumped on each print request so the print effect re-fires even when soloId
  // is unchanged (e.g. two "Print all" clicks in a row).
  const [printSeq, setPrintSeq] = useState(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
  }, []);

  const loadAndRender = useCallback(async () => {
    setLoading(true);
    setError('');
    setCards([]);
    try {
      const res = await fetch('/api/owner/tables/qr', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to load QR codes');
      const tables: QrTable[] = data.tables ?? [];
      const rendered = await Promise.all(
        tables.map(async (t) => {
          const url = scanUrl(t.qr_token);
          const dataUrl = await QRCode.toDataURL(url, {
            width: 480,
            margin: 1,
            errorCorrectionLevel: 'M',
          });
          return { ...t, url, dataUrl } satisfies QrCard;
        }),
      );
      setCards(rendered);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load QR codes');
    } finally {
      setLoading(false);
    }
  }, []);

  function openModal() {
    setOpen(true);
    void loadAndRender();
  }

  function closeModal() {
    setOpen(false);
    setSoloId(null);
  }

  function requestPrint(id: string | null) {
    setSoloId(id);
    setPrintSeq((n) => n + 1);
  }

  // Fire the browser print dialog after the DOM reflects the chosen soloId. The
  // small delay lets the (already-loaded data-URL) images settle before the
  // dialog snapshots the page — same idea as components/print/AutoPrint.
  useEffect(() => {
    if (printSeq === 0) return;
    const t = setTimeout(() => {
      try {
        window.print();
      } catch {
        /* no-op — the manual buttons remain */
      }
    }, 60);
    return () => clearTimeout(t);
  }, [printSeq]);

  // Close on Escape for a modal-like feel.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') closeModal();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Feature-flagged off: render nothing (no button, no surface).
  if (!flags.tableQr) return null;

  const portal =
    open && mountedRef.current
      ? createPortal(
          <div
            data-qr-print-portal=""
            className="fixed inset-0 z-[100] flex flex-col bg-black/40"
          >
            {/* Print rules: hide the whole app + this modal's chrome, lay each
                card out as its own A6 page. Scoped to @media print so the
                on-screen preview is unaffected. */}
            <style>{PRINT_CSS}</style>

            {/* Modal panel (on-screen only) */}
            <div className="mx-auto mt-6 mb-6 flex max-h-[calc(100vh-3rem)] w-full max-w-4xl flex-col overflow-hidden rounded-md bg-cream shadow-xl">
              <div className="qr-cards-toolbar flex items-center justify-between gap-3 border-b border-[#e5e5e5] px-5 py-3">
                <div>
                  <h2 className="text-sm font-bold uppercase tracking-wide text-muted">
                    Print QR cards
                  </h2>
                  <p className="text-xs text-muted">
                    One A6 card per active table. Set your printer to A6 (or “fit to page”).
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => requestPrint(null)}
                    disabled={loading || cards.length === 0}
                    className="rounded-md bg-charcoal px-4 py-2 text-sm font-bold text-cream transition-colors hover:opacity-90 disabled:opacity-50"
                  >
                    Print all
                  </button>
                  <button
                    type="button"
                    onClick={closeModal}
                    className="text-sm font-medium text-muted hover:underline"
                  >
                    Close
                  </button>
                </div>
              </div>

              <div className="qr-cards-scroll flex-1 overflow-y-auto bg-[#f2efe9] p-5">
                {loading ? (
                  <p className="py-10 text-center text-sm text-muted">Generating QR codes…</p>
                ) : error ? (
                  <p className="py-10 text-center text-sm font-medium text-red-700">{error}</p>
                ) : cards.length === 0 ? (
                  <p className="py-10 text-center text-sm text-muted">
                    No active tables to print. Add or reactivate a table first.
                  </p>
                ) : (
                  <div className="flex flex-wrap justify-center gap-5">
                    {cards.map((card) => (
                      <div
                        key={card.id}
                        className={
                          'qr-card ' + (soloId && soloId !== card.id ? 'qr-card--skip' : '')
                        }
                      >
                        <div className="qr-card__inner">
                          <div className="qr-card__head">
                            <p className="qr-card__label">{card.label}</p>
                            {card.zone ? <p className="qr-card__zone">{card.zone}</p> : null}
                          </div>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={card.dataUrl}
                            alt={`QR code for table ${card.label}`}
                            className="qr-card__qr"
                          />
                          <div className="qr-card__foot">
                            <p className="qr-card__scan">Scan to order</p>
                            <p className="qr-card__cafe">{CAFE_NAME}</p>
                          </div>
                        </div>
                        {/* Per-card print (nice-to-have) — screen only. */}
                        <button
                          type="button"
                          onClick={() => requestPrint(card.id)}
                          className="qr-card__print qr-cards-toolbar mt-2 text-xs font-medium text-charcoal hover:underline"
                        >
                          Print this card
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        type="button"
        onClick={openModal}
        className="rounded-md border border-[#d8d2c7] bg-white px-3 py-1.5 text-sm font-medium text-charcoal transition-colors hover:border-tan"
      >
        Print QR cards
      </button>
      {portal}
    </>
  );
}

// A6 = 105mm × 148mm. On screen the cards render at a fixed pixel preview size
// (see .qr-card base below, injected via Tailwind classes on __inner); in print
// each card becomes a full A6 page and page-breaks after itself.
const PRINT_CSS = `
.qr-card__inner {
  box-sizing: border-box;
  width: 264px;
  height: 372px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 20px;
  background: #fff;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  text-align: center;
}
.qr-card__head { display: flex; flex-direction: column; gap: 2px; }
.qr-card__label { font-size: 28px; font-weight: 800; line-height: 1; color: #2b2b2b; }
.qr-card__zone { font-size: 13px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #8a8378; }
.qr-card__qr { width: 200px; height: 200px; image-rendering: pixelated; }
.qr-card__foot { display: flex; flex-direction: column; gap: 2px; }
.qr-card__scan { font-size: 15px; font-weight: 700; color: #2b2b2b; }
.qr-card__cafe { font-size: 12px; letter-spacing: 0.2em; font-weight: 700; color: #8a8378; }

@media print {
  @page { size: A6 portrait; margin: 0; }
  html, body { margin: 0 !important; padding: 0 !important; background: #fff !important; }
  /* Hide the whole app + this modal's own chrome; show only the cards. */
  body > *:not([data-qr-print-portal]) { display: none !important; }
  [data-qr-print-portal] {
    position: static !important;
    display: block !important;
    background: #fff !important;
    inset: auto !important;
  }
  .qr-cards-toolbar { display: none !important; }
  /* Collapse the modal shell so cards flow straight onto pages. */
  [data-qr-print-portal] > div { max-width: none !important; max-height: none !important; margin: 0 !important; box-shadow: none !important; border-radius: 0 !important; background: #fff !important; overflow: visible !important; }
  .qr-cards-scroll { overflow: visible !important; padding: 0 !important; background: #fff !important; }
  .qr-cards-scroll > div { display: block !important; gap: 0 !important; }
  .qr-card--skip { display: none !important; }
  .qr-card {
    display: flex !important;
    align-items: center;
    justify-content: center;
    width: 105mm;
    height: 148mm;
    margin: 0 !important;
    page-break-after: always;
    break-after: page;
  }
  .qr-card:last-of-type { page-break-after: auto; break-after: auto; }
  .qr-card__inner {
    width: 95mm !important;
    height: 138mm !important;
    border: 1px dashed #bbb !important;
    border-radius: 6px;
    padding: 8mm !important;
  }
  .qr-card__qr { width: 55mm !important; height: 55mm !important; }
  .qr-card__label { font-size: 34px; }
}
`;
