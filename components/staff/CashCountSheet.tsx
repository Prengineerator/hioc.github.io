'use client';

// CC-3 — the count sheet a staffer fills before a clock-in/clock-out that
// requires a cash count, and that a manager/staffer can also open for a manual
// count (CashDayManager's "Count now"). A bottom sheet on phone, a centered
// modal from sm up — built bespoke rather than reusing components/ui/Modal so
// it can hit the exact spec here: max-h-[90dvh], a confirm step, and a footer
// that respects the home-indicator safe area.
//
// Two steps: count (the denom grid) → confirm ("You counted ₹X — confirm?").
// The caller owns submission — onConfirm hands back the raw denoms and the
// caller POSTs them, passing `busy`/`error` back in while that's in flight.
// Nothing here computes or trusts a total beyond what it displays; the server
// is the only authority on money (denomsTotalInr is a live mirror only).

import { useEffect, useId, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { CashDayDenomGrid } from '@/components/staff/CashDayDenomGrid';
import { denomsTotalInr } from '@/lib/cash/denoms';
import type { CashDenoms } from '@/lib/types';

const EMPTY_DENOMS: CashDenoms = {};

export function CashCountSheet({
  open,
  title = 'Count the cash drawer',
  subtitle,
  busy = false,
  error = '',
  onClose,
  onConfirm,
}: {
  open: boolean;
  title?: string;
  subtitle?: string;
  busy?: boolean;
  error?: string;
  onClose: () => void;
  onConfirm: (denoms: CashDenoms) => void;
}) {
  const titleId = useId();
  const [denoms, setDenoms] = useState<CashDenoms>(EMPTY_DENOMS);
  const [step, setStep] = useState<'count' | 'confirm'>('count');

  // Fresh sheet every time it opens — a leftover count from a cancelled punch
  // must never silently carry into the next one.
  useEffect(() => {
    if (open) {
      setDenoms(EMPTY_DENOMS);
      setStep('count');
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, busy, onClose]);

  const total = useMemo(() => denomsTotalInr(denoms), [denoms]);

  if (!open || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:px-4 sm:py-8">
      <button
        type="button"
        aria-label="Close"
        onClick={() => {
          if (!busy) onClose();
        }}
        className="fixed inset-0 bg-charcoal/50"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative flex max-h-[90dvh] w-full flex-col overflow-hidden rounded-t-2xl bg-cream shadow-elevated sm:max-w-md sm:rounded-md"
      >
        <div className="flex items-start justify-between gap-3 border-b border-[#e5e5e5] px-5 py-4">
          <div>
            <h2 id={titleId} className="text-lg font-bold text-charcoal">
              {title}
            </h2>
            {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-2xl leading-none text-charcoal transition-colors hover:bg-white disabled:opacity-40"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === 'count' ? (
            <>
              <p className="text-sm text-muted">Count every note and coin in the drawer right now.</p>
              <div className="mt-3">
                <CashDayDenomGrid denoms={denoms} onChange={setDenoms} disabled={busy} />
              </div>
            </>
          ) : (
            <div className="py-8 text-center">
              <p className="text-sm text-muted">You counted</p>
              <p className="mt-1 text-4xl font-bold tabular-nums text-charcoal">₹{total}</p>
              <p className="mt-4 text-base font-bold text-charcoal">Confirm?</p>
            </div>
          )}
          {error ? (
            <p className="mt-3 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>
          ) : null}
        </div>

        <div
          className="flex gap-3 border-t border-[#e5e5e5] px-5 py-4"
          style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom, 0px))' }}
        >
          {step === 'count' ? (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="min-h-[44px] flex-1 rounded-md border border-[#ddd] px-4 py-3 text-sm font-bold text-charcoal transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => setStep('confirm')}
                disabled={busy}
                className="min-h-[44px] flex-1 rounded-md bg-tan px-4 py-3 text-sm font-bold text-cream transition-colors hover:bg-tan-dark disabled:opacity-50"
              >
                Review total — ₹{total}
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => setStep('count')}
                disabled={busy}
                className="min-h-[44px] flex-1 rounded-md border border-[#ddd] px-4 py-3 text-sm font-bold text-charcoal transition-colors disabled:opacity-50"
              >
                Edit count
              </button>
              <button
                type="button"
                onClick={() => onConfirm(denoms)}
                disabled={busy}
                className="min-h-[44px] flex-1 rounded-md bg-charcoal px-4 py-3 text-sm font-bold text-cream transition-colors hover:bg-black disabled:opacity-50"
              >
                {busy ? 'Submitting…' : `Confirm — ₹${total}`}
              </button>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
