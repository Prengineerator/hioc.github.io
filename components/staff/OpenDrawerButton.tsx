'use client';

// DRW-2 — "Open drawer", in the POS title bar just left of the store status
// pill (StaffHeader): change for a note, a float top-up, anything with no sale
// behind it. Every tap that actually opens the drawer is logged as `manual`
// (lib/desktop/drawer.ts), so the owner sees how often, when and by whom
// (/owner/cash).
//
// POS only: StaffHeader renders it on the POS surface alone, and it renders
// itself only inside the HIOC POS app — a plain browser has no drawer to open,
// and a button that can only fail is worse than none. Checked after mount —
// SSR has no `window`, same pattern as StaffPinOverlay.

import { useEffect, useRef, useState } from 'react';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { openDrawerManually } from '@/lib/desktop/drawer';

const STATUS_MS = 4000;

export function OpenDrawerButton() {
  const [inApp, setInApp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const clearTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    setInApp(getDesktopBridge() !== null);
    return () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    };
  }, []);

  if (!inApp) return null;

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    const err = await openDrawerManually();
    setBusy(false);
    setStatus(err ? { ok: false, text: err } : { ok: true, text: 'Drawer opened' });
    if (clearTimer.current) clearTimeout(clearTimer.current);
    clearTimer.current = setTimeout(() => setStatus(null), STATUS_MS);
  }

  // Sized and coloured like the header's other controls (dark bar); the
  // result floats just below the button so the bar's height never changes.
  return (
    <div className="relative flex shrink-0">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        title="Open the cash drawer (logged)"
        className="flex h-10 items-center gap-1.5 whitespace-nowrap rounded-md border border-cream/30 px-2.5 text-sm font-bold text-cream transition-colors hover:bg-cream/10 disabled:opacity-50"
      >
        <span aria-hidden>💵</span>
        {busy ? 'Opening…' : 'Drawer'}
      </button>
      {status ? (
        <p
          role="status"
          className={
            'absolute right-0 top-full z-50 mt-1 whitespace-nowrap rounded-md px-2 py-1 text-xs font-bold shadow-lg ' +
            (status.ok ? 'bg-green-700 text-white' : 'bg-red-700 text-white')
          }
        >
          {status.text}
        </p>
      ) : null}
    </div>
  );
}
