'use client';

// SET-1 — the "App" card on /staff/settings/counter: shows the desktop
// shell's own version/platform when running inside it, or the plain browser
// fallback copy otherwise. Same bridge-check-after-mount pattern as
// PrinterSettings/DeviceEnrollment (SSR has no `window`), so this renders
// nothing until the check has run once, avoiding a hydration mismatch.

import { useEffect, useState } from 'react';
import { getDesktopBridge } from '@/lib/desktop/bridge';
import { summarizeDesktopApp } from '@/lib/staff/settingsOverview';

export function DesktopAppCard() {
  const [checked, setChecked] = useState(false);
  const [info, setInfo] = useState<{ version: string; platform: string } | null>(null);

  useEffect(() => {
    const bridge = getDesktopBridge();
    setInfo(bridge ? { version: bridge.version, platform: bridge.platform } : null);
    setChecked(true);
  }, []);

  if (!checked) return null;

  return (
    <section aria-labelledby="settings-app-heading" className="rounded-md border border-line bg-cream p-5">
      <h2 id="settings-app-heading" className="text-sm font-bold uppercase tracking-[0.15em] text-muted">
        App
      </h2>
      <p className="mt-2 text-sm text-charcoal">{summarizeDesktopApp(info)}</p>
    </section>
  );
}
