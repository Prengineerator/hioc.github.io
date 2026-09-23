'use client';

// Store settings editor (O5). Reads and PATCHes the singleton settings row via
// /api/store-settings — changes take effect on the customer/staff flows with no
// redeploy. Opening hours is edited as JSON (usable, not fancy, per plan).

import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { ChannelHealthSummary } from '@/components/owner/ChannelHealthSummary';
import { AttendanceSettingsPanel } from '@/components/owner/AttendanceSettingsPanel';
import { flags } from '@/lib/flags';
import { readAutoPrintSettings } from '@/lib/staff/autoPrint';
import type { StoreSettings } from '@/lib/types';

type Num = 'gst_percent' | 'packaging_charge_inr' | 'default_prep_min' | 'busy_buffer_min' | 'pickup_slot_len_min' | 'pickup_slot_capacity' | 'last_order_cutoff_min';

const NUM_FIELDS: { key: Num; label: string }[] = [
  { key: 'gst_percent', label: 'GST %' },
  { key: 'packaging_charge_inr', label: 'Packaging charge (₹)' },
  { key: 'default_prep_min', label: 'Default prep time (min)' },
  { key: 'busy_buffer_min', label: 'Busy buffer (min)' },
  { key: 'pickup_slot_len_min', label: 'Pickup slot length (min)' },
  { key: 'pickup_slot_capacity', label: 'Slot capacity (0 = unlimited)' },
  { key: 'last_order_cutoff_min', label: 'Last-order cutoff (min before close)' },
];

// POS4-3 follow-up — the counter's automatic prints. Described by what comes out
// of the printer and when, because that is how the cafe thinks about it.
const AUTO_PRINT_FIELDS: {
  key: 'auto_print_kot' | 'auto_print_bill';
  flag: 'kot' | 'bill';
  label: string;
  hint: string;
}[] = [
  {
    key: 'auto_print_kot',
    flag: 'kot',
    label: 'Print the kitchen ticket automatically',
    hint: 'The kitchen’s copy of the order (KOT). Prints the moment an order is placed, so the pass gets it without anyone carrying a slip over. Leave this on unless the kitchen works off the screen.',
  },
  {
    key: 'auto_print_bill',
    flag: 'bill',
    label: 'Print the customer’s bill automatically',
    hint: 'The paper receipt. Prints when the order is settled. Most customers get their bill on WhatsApp, which is why this stays off — turn it on if you want paper handed over on every sale.',
  },
];

export default function OwnerSettingsPage() {
  const [settings, setSettings] = useState<StoreSettings | null>(null);
  const [hoursJson, setHoursJson] = useState('');
  const [holidays, setHolidays] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    fetch('/api/store-settings')
      .then((r) => r.json())
      .then((d) => {
        const s = d.settings as StoreSettings;
        setSettings(s);
        setHoursJson(JSON.stringify(s.opening_hours, null, 2));
        setHolidays((s.holidays ?? []).join(', '));
      })
      .catch(() => setMsg('Failed to load settings'));
  }, []);

  if (!settings) {
    return <div className="mx-auto max-w-3xl px-4 py-10"><Spinner label="Loading settings…" /></div>;
  }

  const set = (patch: Partial<StoreSettings>) => setSettings({ ...settings, ...patch });
  const autoPrint = readAutoPrintSettings(settings);

  const save = async () => {
    setSaving(true);
    setMsg('');
    let opening_hours: unknown;
    try {
      opening_hours = JSON.parse(hoursJson);
    } catch {
      setSaving(false);
      setMsg('Opening hours is not valid JSON');
      return;
    }
    const body = {
      ...settings,
      opening_hours,
      holidays: holidays.split(',').map((h) => h.trim()).filter(Boolean),
    };
    try {
      const res = await fetch('/api/store-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setMsg(res.ok ? 'Saved.' : 'Save failed.');
    } catch {
      setMsg('Save failed.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-charcoal">Store settings</h1>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {NUM_FIELDS.map((f) => (
          <label key={f.key} className="text-sm">
            <span className="text-charcoal">{f.label}</span>
            <input
              type="number"
              value={settings[f.key]}
              onChange={(e) => set({ [f.key]: Number(e.target.value) } as Partial<StoreSettings>)}
              className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2"
            />
          </label>
        ))}
      </div>

      <div className="mt-4 flex flex-wrap gap-4">
        <label className="flex items-center gap-2 text-sm text-charcoal">
          <input type="checkbox" checked={settings.gst_inclusive} onChange={(e) => set({ gst_inclusive: e.target.checked })} />
          GST inclusive
        </label>
        <label className="flex items-center gap-2 text-sm text-charcoal">
          <input type="checkbox" checked={settings.accepting_orders} onChange={(e) => set({ accepting_orders: e.target.checked })} />
          Accepting orders
        </label>
        <label className="flex items-center gap-2 text-sm text-charcoal">
          Store state
          <select value={settings.store_open_override} onChange={(e) => set({ store_open_override: e.target.value as StoreSettings['store_open_override'] })} className="rounded-md border border-[#e5e5e5] p-1">
            <option value="auto">Auto (by hours)</option>
            <option value="force_open">Force open</option>
            <option value="force_closed">Force closed</option>
          </select>
        </label>
      </div>

      <label className="mt-4 block text-sm">
        <span className="text-charcoal">Opening hours (JSON: {'{'} &quot;mon&quot;: [{'{'}&quot;open&quot;:&quot;10:00&quot;,&quot;close&quot;:&quot;24:00&quot;{'}'}] {'}'})</span>
        <textarea value={hoursJson} onChange={(e) => setHoursJson(e.target.value)} rows={9} className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2 font-mono text-xs" />
      </label>

      <label className="mt-4 block text-sm">
        <span className="text-charcoal">Holidays (comma-separated ISO dates)</span>
        <input value={holidays} onChange={(e) => setHolidays(e.target.value)} placeholder="2026-08-15, 2026-10-02" className="mt-1 w-full rounded-md border border-[#e5e5e5] p-2" />
      </label>

      {/* Counter printing (POS4-3). Read through readAutoPrintSettings so a row
          written before the auto-print migration shows the same defaults the
          POS is actually using, rather than an unchecked box that lies. */}
      <div className="mt-6 rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
        <h2 className="mb-1 text-sm font-bold uppercase tracking-wide text-muted">Counter printing</h2>
        <p className="mb-2 text-sm text-muted">
          What the counter prints on its own, so nobody has to remember a second click.
        </p>
        <div className="flex flex-col divide-y divide-[#f2efe9]">
          {AUTO_PRINT_FIELDS.map((f) => (
            <div key={f.key} className="flex items-start justify-between gap-4 py-3 last:pb-0">
              <div>
                <p className="text-sm font-bold text-charcoal">{f.label}</p>
                <p className="text-xs text-muted">{f.hint}</p>
              </div>
              <ToggleSwitch
                checked={autoPrint[f.flag]}
                onChange={(next) => set({ [f.key]: next } as Partial<StoreSettings>)}
                label={f.label}
              />
            </div>
          ))}
        </div>
      </div>

      <div className="mt-6 flex items-center gap-3">
        <button onClick={save} disabled={saving} className="rounded-md bg-tan px-6 py-2.5 font-bold text-cream hover:bg-tan-dark disabled:opacity-50">
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {msg ? <span className="text-sm text-muted">{msg}</span> : null}
      </div>

      {/* Below the Save button on purpose: everything above is written by it,
          this is read-only status the owner can't change from a browser. */}
      <div className="mt-8 border-t border-[#e5e5e5] pt-8">
        <ChannelHealthSummary />
      </div>

      {/* OPS5-1a. Saves itself per field rather than through the Save button
          above — the geofence is tuned by trial on site, and a round trip
          through a form-wide save would make that slower than it needs to be. */}
      {flags.attendance ? (
        <div className="mt-8 border-t border-[#e5e5e5] pt-8">
          <AttendanceSettingsPanel />
        </div>
      ) : null}
    </div>
  );
}
