'use client';

// SET-1 — the /staff/settings overview: one card per section with a live
// status summary. Everything here is best-effort and non-blocking — the
// bridge check runs after mount (SSR has no `window`, same pattern as
// PrinterSettings/DeviceEnrollment) and the store fetch is a plain
// cache: 'no-store' request that just leaves its card showing "Checking…"
// on failure rather than throwing. `device` is the one piece resolved
// server-side, passed in already-loaded from the page.

import { useEffect, useState } from 'react';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import type { PrinterConfig } from '@/lib/desktop/bridge';
import type { StoreOpenState } from '@/lib/store/hours';
import { summarizeDevice, summarizePrinters, summarizeStore } from '@/lib/staff/settingsOverview';

export function SettingsOverview({ device }: { device: { name: string } | null }) {
  const [inApp, setInApp] = useState(false);
  const [printers, setPrinters] = useState<PrinterConfig[] | null>(null);
  const [openState, setOpenState] = useState<StoreOpenState | null>(null);

  useEffect(() => {
    const bridge = getDesktopBridge();
    setInApp(bridge !== null);
    if (!bridge) return;
    bridge.printers
      .list()
      .then(setPrinters)
      .catch(() => setPrinters([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/store-settings', { cache: 'no-store' })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) setOpenState(data.openState ?? null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const cards: { href: string; title: string; summary: string }[] = [
    {
      href: '/staff/settings/printers',
      title: 'Printers & cash drawer',
      summary: inApp
        ? summarizePrinters(printers)
        : 'Open the HIOC POS app on this counter to configure printers.',
    },
    {
      href: '/staff/settings/kot-counters',
      title: 'KOT counters',
      summary: 'Split each kitchen ticket into one slip per counter, by menu category.',
    },
    { href: '/staff/settings/store', title: 'Store', summary: summarizeStore(openState) },
    { href: '/staff/settings/counter', title: 'This counter', summary: summarizeDevice(device) },
  ];

  return (
    <div>
      <p className="text-sm text-muted">
        Printers, the store&apos;s open state, and this counter&apos;s setup — all in one place.
      </p>
      <ul className="mt-6 flex flex-col gap-3">
        {cards.map((card) => (
          <li key={card.href}>
            <Link
              href={card.href}
              className="block min-h-[44px] rounded-md border border-[#e5e5e5] bg-white p-4 transition-colors hover:border-tan"
            >
              <h2 className="text-base font-bold text-charcoal">{card.title}</h2>
              <p className="mt-1 text-sm text-muted">{card.summary}</p>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
