'use client';

// S7: staff-facing quick store controls — pause new orders, force
// open/closed, and a busy-mode toggle. GET/PATCHes the singleton settings
// row via /api/store-settings. Full settings editing (hours, GST, capacity,
// …) stays in the owner dashboard (app/owner/settings) — this is the
// fast day-to-day panel staff reach for during a shift.

import { useEffect, useState } from 'react';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { Spinner } from '@/components/ui/Spinner';
import type { StoreOpenState } from '@/lib/store/hours';
import type { StoreOpenOverride, StoreSettings } from '@/lib/types';

// Extra ETA minutes applied to quoted prep times while busy mode is on
// (busy_buffer_min > 0 — STF-043). Off = 0.
const BUSY_BUFFER_MIN = 15;

const OVERRIDE_OPTIONS: { value: StoreOpenOverride; label: string }[] = [
  { value: 'auto', label: 'Auto (by hours)' },
  { value: 'force_open', label: 'Force open' },
  { value: 'force_closed', label: 'Force closed' },
];

export function StoreControls() {
  const [settings, setSettings] = useState<StoreSettings | null>(null);
  const [openState, setOpenState] = useState<StoreOpenState | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings();
  }, []);

  async function fetchSettings() {
    const res = await fetch('/api/store-settings', { cache: 'no-store' });
    const data = await res.json().catch(() => null);
    setSettings(data?.settings ?? null);
    setOpenState(data?.openState ?? null);
  }

  async function patch(body: Partial<StoreSettings>) {
    const prevSettings = settings;
    const prevOpenState = openState;
    setSaving(true);
    setSettings((prev) => (prev ? { ...prev, ...body } : prev)); // optimistic
    try {
      const res = await fetch('/api/store-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (res.ok && data) {
        setSettings(data.settings ?? null);
        setOpenState(data.openState ?? null);
      } else {
        setSettings(prevSettings);
        setOpenState(prevOpenState);
      }
    } catch {
      setSettings(prevSettings);
      setOpenState(prevOpenState);
    } finally {
      setSaving(false);
    }
  }

  if (!settings || !openState) {
    return (
      <div className="rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
        <Spinner label="Loading store controls…" />
      </div>
    );
  }

  const busy = settings.busy_buffer_min > 0;

  return (
    <div className="rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold text-charcoal">Store</h2>
        <span
          className={
            'rounded-md px-2 py-1 text-xs font-bold ' +
            (openState.acceptingOrders
              ? 'bg-[#e8f3ea] text-[#2f6b38]'
              : 'bg-[#f6efe9] text-tan-dark')
          }
        >
          {openState.acceptingOrders
            ? 'Accepting orders'
            : `Not accepting orders (${openState.reason.replace(/_/g, ' ')})`}
        </span>
      </div>

      <div className="flex flex-col divide-y divide-[#e5e5e5]">
        <div className="flex items-center justify-between gap-4 py-3 first:pt-0">
          <div>
            <p className="text-sm font-bold text-charcoal">Pause new orders</p>
            <p className="text-xs text-muted">Stops new orders even during open hours.</p>
          </div>
          <ToggleSwitch
            checked={!settings.accepting_orders}
            onChange={(next) => patch({ accepting_orders: !next })}
            label="Pause new orders"
          />
        </div>

        <div className="flex items-center justify-between gap-4 py-3">
          <div>
            <p className="text-sm font-bold text-charcoal">Store state</p>
            <p className="text-xs text-muted">Override the scheduled hours.</p>
          </div>
          <select
            value={settings.store_open_override}
            onChange={(e) => patch({ store_open_override: e.target.value as StoreOpenOverride })}
            className="rounded-md border border-[#e5e5e5] px-3 py-2 text-sm text-charcoal outline-none focus:border-tan"
          >
            {OVERRIDE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between gap-4 py-3 last:pb-0">
          <div>
            <p className="text-sm font-bold text-charcoal">Busy mode</p>
            <p className="text-xs text-muted">
              Adds {BUSY_BUFFER_MIN} min to every quoted prep time when the kitchen is slammed.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {busy ? (
              <span className="rounded-md bg-[#f6efe9] px-2 py-1 text-xs font-bold text-tan-dark">
                Busy
              </span>
            ) : null}
            <ToggleSwitch
              checked={busy}
              onChange={(next) => patch({ busy_buffer_min: next ? BUSY_BUFFER_MIN : 0 })}
              label="Busy mode"
            />
          </div>
        </div>
      </div>

      {saving ? <p className="mt-3 text-xs text-muted">Saving…</p> : null}
    </div>
  );
}
