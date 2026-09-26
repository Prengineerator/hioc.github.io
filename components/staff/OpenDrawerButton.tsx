'use client';

// DRW-2 — "Open drawer", top-right of the new-order screen: change for a note,
// a float top-up, anything with no sale behind it. Every tap that actually
// opens the drawer is logged as `manual` (lib/desktop/drawer.ts), so the owner
// sees how often, when and by whom (/owner/cash).
//
// Rendered only inside the HIOC POS app: a plain browser has no drawer to open,
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

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className="min-h-[44px] rounded-md border border-line bg-cream px-4 py-2 text-sm font-bold text-charcoal transition-colors hover:border-tan disabled:opacity-50"
      >
        {busy ? 'Opening…' : 'Open drawer'}
      </button>
      {status ? (
        <p role="status" className={'text-xs font-bold ' + (status.ok ? 'text-green-700' : 'text-red-700')}>
          {status.text}
        </p>
      ) : null}
    </div>
  );
}
