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
import { parseCoordinates } from '@/lib/attendance/parseCoordinates';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';

// CC-4 — cash_count_required / cash_count_tolerance_inr
// (supabase/2026-09-cash-counts.sql) are optional here rather than added to
// the shared AttendanceSettings type: the migration may not be applied yet,
// in which case the settings row simply won't carry these keys and the
// section below hides itself with a note instead of showing broken fields.
type CashCountFields = {
  cash_count_required?: boolean;
  cash_count_tolerance_inr?: number;
};
type SettingsWithCashCount = AttendanceSettings & CashCountFields;

export function AttendanceSettingsPanel() {
  const [settings, setSettings] = useState<SettingsWithCashCount | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [measured, setMeasured] = useState<{ lat: number; lng: number; accuracy: number } | null>(null);
  const [pasted, setPasted] = useState('');
  const [pasteError, setPasteError] = useState('');
  // NET-1 — the public IP THIS browser is reaching us from. The setup flow is
  // "open this page on the cafe's WiFi and tap Add".
  const [yourIp, setYourIp] = useState<string | null>(null);
  const [networkInput, setNetworkInput] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/owner/attendance-settings', { cache: 'no-store' });
      if (!res.ok) {
        setError(res.status === 403 ? 'Owner access required.' : 'Could not load attendance settings.');
        return;
      }
      const data = await res.json();
      setSettings(data.settings as SettingsWithCashCount);
      setYourIp(typeof data.yourIp === 'string' ? data.yourIp : null);
    } catch {
      setError('Could not load attendance settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(patch: Record<string, unknown>) {
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
      setSettings(data.settings as SettingsWithCashCount);
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

      {/* Paste-from-Maps. "Use my current location" only works while you are
          standing there; this lets the exact spot be picked from a map at a
          desk, which is how most people will actually do it. An embedded
          interactive map would need a Google API key and billing for no extra
          precision, so we take the coordinates Maps already gives you. */}
      <div className="mt-4 rounded-md border border-[#e5e5e5] p-3">
        <label className="block text-sm">
          <span className="font-bold text-charcoal">…or paste from Google Maps</span>
          <div className="mt-1 flex flex-wrap gap-2">
            <input
              value={pasted}
              onChange={(e) => {
                setPasted(e.target.value);
                setPasteError('');
              }}
              placeholder="28.613939, 77.209023 — or a Google Maps link"
              className="min-w-[16rem] flex-1 rounded-md border border-[#ddd] px-3 py-2 font-mono text-sm"
            />
            <button
              type="button"
              disabled={saving || !pasted.trim()}
              onClick={() => {
                const parsed = parseCoordinates(pasted);
                if (!parsed.ok) {
                  setPasteError(parsed.error);
                  return;
                }
                setPasteError('');
                setMeasured(null); // a pasted point has no accuracy reading to show
                void save({ store_lat: parsed.value.lat, store_lng: parsed.value.lng });
              }}
              className="rounded-md bg-charcoal px-4 py-2 text-sm font-bold text-cream disabled:opacity-50"
            >
              Use this
            </button>
          </div>
        </label>
        <p className="mt-2 text-xs text-muted">
          In Google Maps, right-click the exact spot inside your cafe and click the numbers that
          appear — that copies them. Paste them here. A shortened{' '}
          <span className="font-mono">maps.app.goo.gl</span> link won&apos;t work: it doesn&apos;t
          contain the coordinates.
        </p>
        {pasteError ? <p className="mt-2 text-sm text-red-700">{pasteError}</p> : null}
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

      {/* NET-1 — the cafe's network. Sits with the geofence because the two are
          one question asked twice ("is this person actually here?") and are
          tuned in the same on-site sitting. */}
      <div className="mt-8 border-t border-[#e5e5e5] pt-6">
        <h3 className="text-base font-bold text-charcoal">Cafe network</h3>
        <p className="mt-1 text-sm text-muted">
          Punches made off your cafe&apos;s internet connection get flagged on the attendance
          sheet for you to look at. They are never refused — your connection&apos;s address can
          change on its own, and nobody should lose a shift to that.
        </p>
        <p className="mt-2 text-xs text-muted">
          A phone can&apos;t tell us which WiFi it is on — no browser allows that — so this checks
          the internet connection the punch came through. On your cafe&apos;s WiFi that is this
          cafe; on mobile data it is the phone network, which is what gets flagged. Staff who
          need to be counted as present should join the cafe WiFi before clocking in.
        </p>

        {yourIp ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-md border border-[#e5e5e5] bg-[#faf7f4] p-3 text-sm">
            <span className="text-muted">This device is connecting from</span>
            <span className="font-mono font-bold text-charcoal">{yourIp}</span>
            {(settings.store_networks ?? []).includes(yourIp) ? (
              <span className="rounded-full bg-[#e3efe4] px-2 py-0.5 text-xs font-bold text-[#2f6b38]">
                Already added
              </span>
            ) : (
              <button
                type="button"
                disabled={saving}
                onClick={() =>
                  void save({ store_networks: [...(settings.store_networks ?? []), yourIp] })
                }
                className="rounded-md bg-charcoal px-3 py-2.5 text-xs font-bold text-cream disabled:opacity-50"
              >
                Add this network
              </button>
            )}
          </div>
        ) : null}

        {(settings.store_networks ?? []).length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            No networks added — nothing is being checked or flagged yet.
          </p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {(settings.store_networks ?? []).map((entry) => (
              <li
                key={entry}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-[#e5e5e5] px-3 py-2 text-sm"
              >
                <span className="font-mono text-charcoal">{entry}</span>
                <button
                  type="button"
                  disabled={saving}
                  onClick={() =>
                    void save({
                      store_networks: (settings.store_networks ?? []).filter((e) => e !== entry),
                    })
                  }
                  className="text-sm font-medium text-red-700 hover:underline disabled:opacity-50"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-1 flex-col gap-1 text-sm">
            <span className="font-medium text-charcoal">Add another (address or range)</span>
            <input
              value={networkInput}
              onChange={(e) => setNetworkInput(e.target.value)}
              placeholder="49.36.12.34 or 49.36.12.0/24"
              className="min-w-[14rem] rounded-md border border-[#ddd] px-3 py-2 font-mono text-sm"
            />
          </label>
          <button
            type="button"
            disabled={saving || !networkInput.trim()}
            onClick={async () => {
              const next = [...(settings.store_networks ?? []), networkInput.trim()];
              await save({ store_networks: next });
              setNetworkInput('');
            }}
            className="rounded-md bg-charcoal px-4 py-2 text-sm font-bold text-cream disabled:opacity-50"
          >
            Add
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">
          If your connection&apos;s address changes and punches start getting flagged, come back
          here on the cafe WiFi and tap Add. A static IP from your internet provider removes that
          chore for good.
        </p>
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

      {/* CC-4 — the drawer count required at clock-in/out
          (docs/PHASE-5-CASH-COUNTS.md). Sits after pay rules because a
          shortage this produces eventually shows up as a payroll deduction —
          same "tuned once, at a desk" rhythm as the section above. */}
      <div className="mt-8 border-t border-[#e5e5e5] pt-6">
        <h3 className="text-base font-bold text-charcoal">Cash counts</h3>
        {settings.cash_count_required === undefined || settings.cash_count_tolerance_inr === undefined ? (
          <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
            Cash counts aren&apos;t set up in the database yet — apply{' '}
            <span className="font-mono">supabase/2026-09-cash-counts.sql</span> to turn this on.
          </p>
        ) : (
          <>
            <p className="mt-1 text-sm text-muted">
              Staff count the drawer by denomination (₹500 down to ₹1) at every clock-in and
              clock-out. Counts are recorded either way; a shortfall beyond the tolerance below is
              sent to you to approve, waive, or reassign to someone else — approving deducts it
              from that person&apos;s next payroll run.
            </p>
            <div className="mt-4 flex items-center justify-between gap-3 rounded-md border border-[#e5e5e5] p-3">
              <span>
                <span className="block text-sm font-bold text-charcoal">
                  Require a cash count at clock-in and clock-out
                </span>
                <span className="block text-xs text-muted">
                  Applies only to staff marked &ldquo;Handles cash&rdquo; on the Team screen. The
                  punch is refused without a count while this is on.
                </span>
              </span>
              <ToggleSwitch
                checked={settings.cash_count_required ?? false}
                onChange={(next) => save({ cash_count_required: next })}
                label="Require a cash count at clock-in and clock-out"
              />
            </div>
            <div className="mt-4 max-w-xs">
              <NumberField
                label="Tolerance (₹)"
                hint="A variance up to this is recorded but never charged. Beyond it, the whole shortfall is charged — this isn't an allowance."
                value={settings.cash_count_tolerance_inr ?? 0}
                min={0}
                max={500}
                disabled={saving}
                onCommit={(v) => save({ cash_count_tolerance_inr: v })}
              />
            </div>
          </>
        )}
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
