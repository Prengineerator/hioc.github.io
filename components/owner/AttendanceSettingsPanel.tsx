'use client';

// OPS5-1a — the owner's geofence configuration.
//
// The "use my current location" button is the whole point of this screen. The
// alternative is asking an owner to find their cafe's latitude and longitude to
// six decimal places, which they will get wrong, and a wrong store point means
// either nobody can clock in or everybody can from anywhere.
//
// The measured-accuracy readout matters just as much: Gate 5A-i is about
// discovering what a phone actually reports inside THIS building, and this is
// where that number becomes visible.

import { useCallback, useEffect, useState } from 'react';
import type { AttendanceSettings } from '@/lib/types';

export function AttendanceSettingsPanel() {
  const [settings, setSettings] = useState<AttendanceSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [measured, setMeasured] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/owner/attendance-settings', { cache: 'no-store' });
      if (!res.ok) {
        setError(res.status === 403 ? 'Owner access required.' : 'Could not load attendance settings.');
        return;
      }
      const data = await res.json();
      setSettings(data.settings as AttendanceSettings);
    } catch {
      setError('Could not load attendance settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Record<string, number | null>) {
    setSaving(true);
    setError('');
    setNotice('');
    try {
      const res = await fetch('/api/owner/attendance-settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError((data.error as string) ?? 'Could not save.');
        return;
      }
      setSettings(data.settings as AttendanceSettings);
      setNotice('Saved.');
    } catch {
      setError('Network problem — try again.');
    } finally {
      setSaving(false);
    }
  }

  function useCurrentLocation() {
    setError('');
    setNotice('');
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMeasured({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
        });
        setLocating(false);
      },
      () => {
        setError('Could not read your location. Allow location access and try again.');
        setLocating(false);
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20_000 },
    );
  }

  if (loading) return <p className="text-sm text-muted">Loading attendance settings…</p>;
  if (!settings) return <p className="text-sm text-red-700">{error || 'Unavailable.'}</p>;

  const configured = settings.store_lat !== null && settings.store_lng !== null;

  return (
    <section className="rounded-md border border-[#e5e5e5] bg-white p-5">
      <h2 className="text-lg font-bold text-charcoal">Attendance &amp; geofence</h2>
      <p className="mt-1 text-sm text-muted">
        Staff can only clock in when their phone reports them inside this circle. Nothing here
        is ever shown to staff.
      </p>

      {!configured ? (
        <p className="mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          The cafe&apos;s location isn&apos;t set, so <strong>nobody can clock in</strong>. Stand
          at the counter and tap &ldquo;Use my current location&rdquo;.
        </p>
      ) : (
        <p className="mt-4 text-sm text-charcoal">
          Cafe location set to{' '}
          <span className="font-mono">
            {Number(settings.store_lat).toFixed(6)}, {Number(settings.store_lng).toFixed(6)}
          </span>{' '}
          ·{' '}
          <a
            className="text-tan underline"
            href={`https://www.google.com/maps?q=${settings.store_lat},${settings.store_lng}`}
            target="_blank"
            rel="noreferrer"
          >
            view on map
          </a>
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={useCurrentLocation}
          disabled={locating}
          className="rounded-md border border-charcoal px-4 py-2 text-sm font-bold text-charcoal disabled:opacity-50"
        >
          {locating ? 'Reading location…' : 'Use my current location'}
        </button>
        {measured ? (
          <button
            type="button"
            disabled={saving}
            onClick={() => save({ store_lat: measured.lat, store_lng: measured.lng })}
            className="rounded-md bg-tan px-4 py-2 text-sm font-bold text-cream disabled:opacity-50"
          >
            Set as cafe location
          </button>
        ) : null}
      </div>

      {measured ? (
        <div className="mt-3 rounded-md border border-[#e5e5e5] bg-[#faf7f4] p-3 text-sm">
          <p className="font-mono text-charcoal">
            {measured.lat.toFixed(6)}, {measured.lng.toFixed(6)}
          </p>
          <p className="mt-1 text-muted">
            Accuracy here: <strong>±{Math.round(measured.accuracy)} m</strong>.{' '}
            {measured.accuracy > settings.max_accuracy_m
              ? `That is worse than the ±${settings.max_accuracy_m} m limit below — a staffer standing here would be refused. Raise the limit, or take the reading nearer a window.`
              : 'That is within the limit below, so a punch from here would be accepted.'}
          </p>
        </div>
      ) : null}

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <NumberField
          label="Radius (m)"
          hint="How far from the point above a punch still counts. 150 m is a sensible start."
          value={settings.geofence_radius_m}
          min={10}
          max={5000}
          disabled={saving}
          onCommit={(v) => save({ geofence_radius_m: v })}
        />
        <NumberField
          label="Max accuracy (±m)"
          hint="Readings vaguer than this are refused — a ±2 km fix proves nothing."
          value={settings.max_accuracy_m}
          min={5}
          max={2000}
          disabled={saving}
          onCommit={(v) => save({ max_accuracy_m: v })}
        />
        <NumberField
          label="Max fix age (s)"
          hint="Rejects a stale cached position."
          value={settings.max_fix_age_sec}
          min={5}
          max={900}
          disabled={saving}
          onCommit={(v) => save({ max_fix_age_sec: v })}
        />
      </div>

      {/* OPS5-1b — the payroll rules. Separated by a rule from the geofence
          because the two get tuned at completely different moments: the fence
          on site with a phone, these once, at a desk. */}
      <div className="mt-8 border-t border-[#e5e5e5] pt-6">
        <h3 className="text-base font-bold text-charcoal">Pay rules</h3>
        <p className="mt-1 text-sm text-muted">
          How hours turn into pay. Defaults are sensible — change them only where your cafe
          actually differs.
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-3">
          <NumberField
            label="Late grace (min)"
            hint="Arriving within this of the shift start isn't late."
            value={settings.grace_period_min}
            min={0}
            max={240}
            disabled={saving}
            onCommit={(v) => save({ grace_period_min: v })}
          />
          <NumberField
            label="Late marks = half day"
            hint="This many late arrivals deducts half a day's pay."
            value={settings.late_marks_per_halfday}
            min={1}
            max={30}
            disabled={saving}
            onCommit={(v) => save({ late_marks_per_halfday: v })}
          />
          <NumberField
            label="OT starts after (min)"
            hint="Extra minutes beyond the contracted day before overtime begins."
            value={settings.ot_threshold_min}
            min={0}
            max={480}
            disabled={saving}
            onCommit={(v) => save({ ot_threshold_min: v })}
          />
          <NumberField
            label="OT rate (×)"
            hint="0 = overtime unpaid, 1 = normal rate, 1.5 = time and a half."
            value={Number(settings.ot_multiplier)}
            min={0}
            max={5}
            step={0.25}
            disabled={saving}
            onCommit={(v) => save({ ot_multiplier: v })}
          />
          <NumberField
            label="Unpaid break (min)"
            hint="Deducted automatically — but only on a day with a single unbroken session."
            value={settings.auto_break_min}
            min={0}
            max={240}
            disabled={saving}
            onCommit={(v) => save({ auto_break_min: v })}
          />
          <NumberField
            label="Break applies after (min)"
            hint="Only shifts longer than this get the break deducted."
            value={settings.auto_break_after_min}
            min={30}
            max={1440}
            disabled={saving}
            onCommit={(v) => save({ auto_break_after_min: v })}
          />
          <NumberField
            label="Half day below (min)"
            hint="Work under this counts as half a day."
            value={settings.half_day_min_minutes}
            min={0}
            max={1440}
            disabled={saving}
            onCommit={(v) => save({ half_day_min_minutes: v })}
          />
          <NumberField
            label="Absent below (min)"
            hint="Work under this counts as absent. Must be lower than the half-day figure."
            value={settings.absent_below_minutes}
            min={0}
            max={1440}
            disabled={saving}
            onCommit={(v) => save({ absent_below_minutes: v })}
          />
          <NumberField
            label="Auto-close grace (min)"
            hint="How long after a shift ends before a forgotten clock-out is closed for review."
            value={settings.auto_close_grace_min}
            min={0}
            max={720}
            disabled={saving}
            onCommit={(v) => save({ auto_close_grace_min: v })}
          />
        </div>

        <p className="mt-4 text-xs text-muted">
          An automatically closed shift is never paid on trust — it waits for you on the
          attendance sheet until you approve or correct it.
        </p>
      </div>

      {error ? <p className="mt-4 text-sm text-red-700">{error}</p> : null}
      {notice ? <p className="mt-4 text-sm text-green-700">{notice}</p> : null}
    </section>
  );
}

function NumberField({
  label,
  hint,
  value,
  min,
  max,
  step,
  disabled,
  onCommit,
}: {
  label: string;
  hint: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  disabled: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  return (
    <label className="block text-sm">
      <span className="font-bold text-charcoal">{label}</span>
      <input
        type="number"
        inputMode={step && step < 1 ? 'decimal' : 'numeric'}
        min={min}
        max={max}
        step={step ?? 1}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft);
          if (!Number.isFinite(n) || n === value) {
            setDraft(String(value));
            return;
          }
          onCommit(n);
        }}
        className="mt-1 w-full rounded-md border border-[#ddd] px-3 py-2"
      />
      <span className="mt-1 block text-xs text-muted">{hint}</span>
    </label>
  );
}
