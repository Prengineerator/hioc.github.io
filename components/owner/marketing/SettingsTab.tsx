'use client';

// Settings (spec §7.7): every marketing_settings field, with a plain-English
// explanation and its allowed range. The master Sending switch is first and saves
// by itself behind a confirm (KillSwitch.tsx); everything else saves together
// with one button, and only what changed is sent.

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { parseSettingsPatch } from '@/lib/marketing/parse';
import type { MarketingSettings, SettingsResponse } from '@/lib/marketing/types';
import { API, requestJson } from './api';
import { describeSendWindow, hourLabel, inr } from './format';
import { useApi } from './hooks';
import { useKillSwitch } from './KillSwitch';
import {
  SETTING_GROUPS,
  allowedRange,
  buildSettingsPatch,
  fieldBounds,
  hasSettingsProblems,
  settingFieldError,
  settingsToDraft,
  type SettingField,
  type SettingsDraft,
} from './settingsForm';
import { Help, Panel, ResourceGate, TabIntro } from './ui';

export function SettingsTab({ onEnabledChanged }: { /** The kill switch flipped: refresh the Overview banner. */ onEnabledChanged: () => void }) {
  const res = useApi<SettingsResponse>(API.settings);
  return (
    <div className="flex flex-col gap-5">
      <TabIntro title="Settings">
        The controls that keep marketing safe and affordable. The defaults are cautious: sending is off until you turn it on.
      </TabIntro>
      <ResourceGate resource={res} label="Loading settings…">
        {(data) => (
          <SettingsBody
            settings={data.settings}
            onSaved={(settings) => res.setData({ settings })}
            onEnabledChanged={onEnabledChanged}
          />
        )}
      </ResourceGate>
    </div>
  );
}

/** Exported for the render smoke test (tests/marketingDashboardRender.test.ts). */
export function SettingsBody({
  settings,
  onSaved,
  onEnabledChanged,
}: {
  settings: MarketingSettings;
  onSaved: (s: MarketingSettings) => void;
  onEnabledChanged: () => void;
}) {
  const [draft, setDraft] = useState<SettingsDraft>(() => settingsToDraft(settings));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const { ask, dialog } = useKillSwitch({
    monthlyBudgetInr: settings.monthly_budget_inr,
    onChanged: (enabled) => {
      onSaved({ ...settings, enabled });
      onEnabledChanged();
    },
  });

  const result = useMemo(() => buildSettingsPatch(settings, draft), [settings, draft]);
  const changedCount = Object.keys(result.patch).length;
  const problems = hasSettingsProblems(result);

  const edit = (key: keyof SettingsDraft, value: string) => {
    setSaved(false);
    setError(null);
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const save = async () => {
    if (problems || changedCount === 0) return;
    // The shared parser one more time on exactly what will be sent (it also normalises the phone number).
    const check = parseSettingsPatch(result.patch);
    if (!check.ok) {
      setError(check.error);
      return;
    }
    setSaving(true);
    setError(null);
    const r = await requestJson<SettingsResponse>(API.settings, { method: 'PATCH', body: result.patch });
    setSaving(false);
    if (!r.ok) {
      setError(r.error.message);
      return;
    }
    onSaved(r.data.settings);
    setDraft(settingsToDraft(r.data.settings));
    setSaved(true);
  };

  return (
    <div className="flex flex-col gap-5">
      <Panel title="Sending">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-base font-bold text-charcoal">{settings.enabled ? 'Sending is ON' : 'Sending is OFF'}</p>
            <p className="mt-1 max-w-xl text-sm text-muted">
              The master switch. While it is off, nothing is sent to anyone, whatever is approved or set to Auto. Turn it on when your templates are approved and you have tested them. You are asked to confirm, and it takes effect straight away (it does not wait for Save).
            </p>
            {settings.enabled ? (
              <p className="mt-1 text-sm text-charcoal">
                Messages go out {describeSendWindow(settings.send_window_start_hour, settings.send_window_end_hour)}, up to {inr(settings.monthly_budget_inr)} a month.
              </p>
            ) : null}
          </div>
          <ToggleSwitch checked={settings.enabled} onChange={(next) => ask(next)} label="Sending on or off" />
        </div>
      </Panel>

      {SETTING_GROUPS.map((group) => (
        <Panel key={group.id} title={group.title} subtitle={group.blurb}>
          <div className="grid gap-x-5 gap-y-5 md:grid-cols-2">
            {group.fields.map((f) => (
              <FieldControl key={f.key} field={f} value={draft[f.key]} onChange={(v) => edit(f.key, v)} formError={f.key === 'send_window_end_hour' ? result.formError : null} />
            ))}
          </div>
        </Panel>
      ))}

      <div className="sticky bottom-0 z-20 flex flex-wrap items-center gap-3 rounded-md border border-line bg-cream p-3 shadow-card">
        <Button onClick={save} loading={saving} disabled={saving || changedCount === 0 || problems}>
          {changedCount === 0 ? 'Save settings' : `Save ${changedCount} change${changedCount === 1 ? '' : 's'}`}
        </Button>
        {changedCount > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(settingsToDraft(settings));
              setError(null);
            }}
          >
            Undo changes
          </Button>
        ) : null}
        {problems ? (
          <span role="alert" className="text-sm font-semibold text-red-700">
            Fix the boxes marked in red first.
          </span>
        ) : saved ? (
          <span role="status" className="text-sm font-semibold text-green-800">
            ✓ Saved
          </span>
        ) : changedCount === 0 ? (
          <span className="text-sm text-muted">No changes yet</span>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">
          {error}
        </p>
      ) : null}

      {dialog}
    </div>
  );
}

function FieldControl({
  field: f,
  value,
  onChange,
  formError,
}: {
  field: SettingField;
  value: string;
  onChange: (v: string) => void;
  /** An error that belongs to the form, shown on this box (the send window's end). */
  formError: string | null;
}) {
  const label = f.unit ? `${f.label} (${f.unit})` : f.label;
  const own = settingFieldError(f.key, value);
  const error = own ?? formError ?? undefined;
  const bounds = fieldBounds(f.key);
  const range = allowedRange(f.key);

  let control: React.ReactNode;
  if (f.kind === 'hour_start' || f.kind === 'hour_end') {
    const from = f.kind === 'hour_start' ? 0 : 1;
    const to = f.kind === 'hour_start' ? 23 : 24;
    control = (
      <Select
        label={label}
        value={value}
        error={error}
        onChange={(e) => onChange(e.target.value)}
        options={Array.from({ length: to - from + 1 }, (_, i) => ({ value: String(from + i), label: hourLabel(from + i) }))}
      />
    );
  } else if (f.kind === 'text') {
    control = (
      <Input
        label={label}
        type="tel"
        inputMode="tel"
        autoComplete="off"
        placeholder="+919876543210"
        value={value}
        error={error}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  } else {
    control = (
      <Input
        label={label}
        type="number"
        inputMode="decimal"
        step={f.kind === 'money' ? 0.001 : 1}
        min={bounds?.min}
        max={bounds?.max}
        value={value}
        error={error}
        onChange={(e) => onChange(e.target.value)}
        hint={range}
      />
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {control}
      <Help>{f.help}</Help>
    </div>
  );
}
