'use client';

// Owner → Reports → "Report emails": the daily / weekly / monthly summaries
// emailed to the owner (lib/reports/ownerDigest.ts). Which ones go out, when a
// week and a month start, and who gets them. Every report can be previewed or
// sent right now, so the owner sees what they're signing up for.

import { useEffect, useState } from 'react';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import type { OwnerReportSettings, ReportKind } from '@/lib/reports/ownerDigest';

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

interface SendRow {
  id: string;
  kind: string;
  period_start: string;
  period_end: string;
  trigger: string;
  to_email: string;
  status: string;
  error: string;
  created_at: string;
}

interface LoadResponse {
  settings: OwnerReportSettings;
  migrated: boolean;
  ownerEmails: string[];
  recipients: string[];
  emailConfigured: boolean;
  sends: SendRow[];
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

function weekDescription(dow: number): string {
  const start = WEEKDAYS[dow - 1];
  const end = WEEKDAYS[(dow + 5) % 7];
  return `Every ${start} morning, covering ${start} to ${end}.`;
}

function monthDescription(day: number): string {
  if (day === 1) return 'On the 1st, covering the whole of last month.';
  return `On the ${ordinal(day)}, covering the ${ordinal(day)} of last month to the ${ordinal(day - 1)} of this one.`;
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

export function ReportEmailSettingsPanel() {
  const [data, setData] = useState<LoadResponse | null>(null);
  const [settings, setSettings] = useState<OwnerReportSettings | null>(null);
  const [extra, setExtra] = useState('');
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [sending, setSending] = useState<ReportKind | null>(null);

  const load = () =>
    fetch('/api/owner/report-emails')
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? 'Failed to load');
        return d as LoadResponse;
      })
      .then((d) => {
        setData(d);
        setSettings(d.settings);
        setExtra(d.settings.recipients.join(', '));
      })
      .catch((e: Error) => setLoadError(e.message || 'Failed to load report email settings'));

  useEffect(() => {
    load();
  }, []);

  if (loadError) return <p className="text-sm text-red-700">{loadError}</p>;
  if (!data || !settings) return <p className="text-sm text-muted">Loading report emails…</p>;

  const set = (patch: Partial<OwnerReportSettings>) => setSettings({ ...settings, ...patch });

  const save = async () => {
    setSaving(true);
    setMsg('');
    try {
      const res = await fetch('/api/owner/report-emails', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, recipients: extra.split(/[\s,;]+/).filter(Boolean) }),
      });
      const d = await res.json();
      if (!res.ok) {
        setMsg(d.error ?? 'Save failed.');
        return;
      }
      setSettings(d.settings);
      setExtra(d.settings.recipients.join(', '));
      setData({ ...data, settings: d.settings, recipients: d.recipients });
      setMsg('Saved.');
    } catch {
      setMsg('Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const sendNow = async (kind: ReportKind) => {
    setSending(kind);
    setMsg('');
    try {
      const res = await fetch('/api/owner/report-emails/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind }),
      });
      const d = await res.json();
      if (!res.ok) {
        setMsg(d.error ?? 'Send failed.');
        return;
      }
      const outcomes = d.outcomes as { to: string; status: string; detail: string }[];
      const sent = outcomes.filter((o) => o.status === 'sent').length;
      const failed = outcomes.filter((o) => o.status === 'failed');
      setMsg(
        failed.length
          ? `Sent to ${sent} of ${outcomes.length}. Failed: ${failed.map((f) => `${f.to} (${f.detail})`).join(', ')}`
          : `The ${kind} report was sent to ${sent} address${sent === 1 ? '' : 'es'}.`,
      );
      load();
    } catch {
      setMsg('Send failed.');
    } finally {
      setSending(null);
    }
  };

  const actions = (kind: ReportKind) => (
    <div className="mt-2 flex flex-wrap gap-2">
      <a
        href={`/api/owner/report-emails/preview?kind=${kind}`}
        target="_blank"
        rel="noreferrer"
        className="rounded-md border border-line bg-white px-3 py-1.5 text-xs font-bold text-charcoal hover:border-charcoal"
      >
        Preview
      </a>
      <button
        type="button"
        onClick={() => sendNow(kind)}
        disabled={sending !== null || !data.migrated || data.recipients.length === 0}
        className="rounded-md border border-line bg-white px-3 py-1.5 text-xs font-bold text-charcoal hover:border-charcoal disabled:opacity-50"
      >
        {sending === kind ? 'Sending…' : 'Send now'}
      </button>
    </div>
  );

  const rowClass = 'flex items-start justify-between gap-4 border-b border-[#f2efe9] py-4 last:border-b-0';

  return (
    <div className="flex flex-col gap-4">
      {!data.migrated ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Report emails need a database update first — run <code>supabase/2026-10-owner-report-emails.sql</code>. Nothing
          is sent until then.
        </p>
      ) : null}
      {!data.emailConfigured ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          Email sending isn&apos;t set up on the server (RESEND_API_KEY and RESEND_FROM), so reports can&apos;t be
          delivered yet. Attempts will show below as failed.
        </p>
      ) : null}

      <div className="flex flex-col">
        <div className={rowClass}>
          <div>
            <p className="text-sm font-bold text-charcoal">Daily report</p>
            <p className="text-xs text-muted">Every morning at about 8:00 AM, covering yesterday.</p>
            <label className="mt-2 flex items-center gap-2 text-xs text-charcoal">
              <input
                type="checkbox"
                checked={settings.daily_skip_empty}
                onChange={(e) => set({ daily_skip_empty: e.target.checked })}
              />
              Skip days with no orders (e.g. holidays)
            </label>
            {actions('daily')}
          </div>
          <ToggleSwitch checked={settings.daily_enabled} onChange={(v) => set({ daily_enabled: v })} label="Daily report" />
        </div>

        <div className={rowClass}>
          <div>
            <p className="text-sm font-bold text-charcoal">Weekly report</p>
            <label className="mt-1 flex items-center gap-2 text-xs text-charcoal">
              Week starts on
              <select
                value={settings.weekly_send_dow}
                onChange={(e) => set({ weekly_send_dow: Number(e.target.value) })}
                className="rounded-md border border-line p-1"
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i + 1}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1 text-xs text-muted">{weekDescription(settings.weekly_send_dow)}</p>
            {actions('weekly')}
          </div>
          <ToggleSwitch checked={settings.weekly_enabled} onChange={(v) => set({ weekly_enabled: v })} label="Weekly report" />
        </div>

        <div className={rowClass}>
          <div>
            <p className="text-sm font-bold text-charcoal">Monthly report</p>
            <label className="mt-1 flex items-center gap-2 text-xs text-charcoal">
              Month starts on the
              <select
                value={settings.monthly_send_day}
                onChange={(e) => set({ monthly_send_day: Number(e.target.value) })}
                className="rounded-md border border-line p-1"
              >
                {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {ordinal(d)}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1 text-xs text-muted">{monthDescription(settings.monthly_send_day)}</p>
            {actions('monthly')}
          </div>
          <ToggleSwitch checked={settings.monthly_enabled} onChange={(v) => set({ monthly_enabled: v })} label="Monthly report" />
        </div>
      </div>

      <div className="border-t border-line pt-4">
        <p className="text-sm font-bold text-charcoal">Who gets them</p>
        <label className="mt-2 flex items-center gap-2 text-sm text-charcoal">
          <input
            type="checkbox"
            checked={settings.send_to_owner_login}
            onChange={(e) => set({ send_to_owner_login: e.target.checked })}
          />
          The owner&apos;s login email{data.ownerEmails.length ? ` (${data.ownerEmails.join(', ')})` : ''}
        </label>
        <label className="mt-3 block text-sm">
          <span className="text-charcoal">Also send to (comma-separated, up to 10)</span>
          <input
            value={extra}
            onChange={(e) => setExtra(e.target.value)}
            placeholder="partner@example.com, accounts@example.com"
            className="mt-1 w-full rounded-md border border-line p-2"
          />
        </label>
        <p className="mt-2 text-xs text-muted">
          {data.recipients.length
            ? `Currently going to: ${data.recipients.join(', ')}`
            : 'No one will get the reports until an address is added.'}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !data.migrated}
          className="rounded-md bg-tan-dark px-5 py-2 text-sm font-bold text-cream hover:bg-tan-darker disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save report emails'}
        </button>
        {msg ? <span className="text-sm text-muted">{msg}</span> : null}
      </div>

      {data.sends.length ? (
        <div className="border-t border-line pt-4">
          <p className="mb-2 text-sm font-bold text-charcoal">Recently sent</p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-xs">
              <thead>
                <tr className="text-left font-semibold uppercase tracking-wide text-muted">
                  <th className="py-1 pr-3">When</th>
                  <th className="py-1 pr-3">Report</th>
                  <th className="py-1 pr-3">To</th>
                  <th className="py-1 pr-3">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.sends.map((s) => (
                  <tr key={s.id} className="border-t border-[#f2efe9]">
                    <td className="py-1 pr-3 text-charcoal">
                      {new Date(s.created_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' })}
                    </td>
                    <td className="py-1 pr-3 text-charcoal">
                      {s.kind} · {s.period_start === s.period_end ? shortDate(s.period_start) : `${shortDate(s.period_start)} – ${shortDate(s.period_end)}`}
                      {s.trigger === 'manual' ? ' · sent by hand' : ''}
                    </td>
                    <td className="py-1 pr-3 text-charcoal">{s.to_email || '—'}</td>
                    <td className={`py-1 pr-3 ${s.status === 'failed' ? 'text-red-700' : s.status === 'sent' ? 'text-green-700' : 'text-muted'}`}>
                      {s.status}
                      {s.error ? ` — ${s.error}` : ''}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
