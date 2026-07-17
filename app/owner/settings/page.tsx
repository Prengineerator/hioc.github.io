'use client';

// Store settings editor (O5). Reads and PATCHes the singleton settings row via
// /api/store-settings — changes take effect on the customer/staff flows with no
// redeploy. Opening hours is edited as JSON (usable, not fancy, per plan).

import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
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

      <div className="mt-6 flex items-center gap-3">
        <button onClick={save} disabled={saving} className="rounded-md bg-tan px-6 py-2.5 font-bold text-cream hover:bg-tan-dark disabled:opacity-50">
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        {msg ? <span className="text-sm text-muted">{msg}</span> : null}
      </div>
    </div>
  );
}
