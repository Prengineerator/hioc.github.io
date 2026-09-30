'use client';

// The master "Sending ON / OFF" switch (marketing_settings.enabled), shared by the
// Overview banner and the Settings tab.
//
// It is the one control that decides whether ANY customer is messaged, so it
// never flips on a bare tap: both directions ask first, in words that say what
// changes. It also saves by itself (PATCH {enabled} alone) instead of riding on
// the Settings "Save" button — turning sending off in a hurry must not depend on
// every other box on that form being valid, and turning it on must not be
// bundled silently with an unrelated edit.

import { useCallback, useState, type ReactNode } from 'react';
import { API, requestJson } from './api';
import { ConfirmDialog } from './ui';
import { inr } from './format';
import type { SettingsResponse } from '@/lib/marketing/types';

export function useKillSwitch({
  monthlyBudgetInr,
  onChanged,
}: {
  monthlyBudgetInr: number;
  /** Called with the saved value after the server accepted it. */
  onChanged: (enabled: boolean) => void;
}): { ask: (next: boolean) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ask = useCallback((next: boolean) => {
    setError(null);
    setPending(next);
  }, []);

  const confirm = async () => {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    const r = await requestJson<SettingsResponse>(API.settings, { method: 'PATCH', body: { enabled: pending } });
    setBusy(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    setPending(null);
    onChanged(r.data.settings.enabled);
  };

  const turningOn = pending === true;
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={turningOn ? 'Turn sending on?' : 'Turn sending off?'}
      confirmLabel={turningOn ? 'Yes, turn sending on' : 'Yes, stop all sending'}
      danger={!turningOn}
      busy={busy}
      error={error}
      onConfirm={confirm}
      onCancel={() => setPending(null)}
    >
      {turningOn ? (
        <>
          <p>
            Campaigns you have approved, and Auto playbooks that pass every safety check, will start sending WhatsApp messages to customers who opted in.
          </p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Messages only go out inside your send window and stop when this month&apos;s budget ({inr(monthlyBudgetInr)}) is used up.</li>
            <li>Nobody who has not said yes to offers is ever messaged, and anyone who has opted out is skipped even after you approve.</li>
            <li>You can switch this off again at any time.</li>
          </ul>
        </>
      ) : (
        <>
          <p>Nothing will be sent to anyone until you turn it back on.</p>
          <ul className="list-disc space-y-1 pl-5">
            <li>Campaigns you already approved stay in the queue and wait.</li>
            <li>Messages that have already gone out cannot be recalled.</li>
          </ul>
        </>
      )}
    </ConfirmDialog>
  );

  return { ask, dialog };
}
