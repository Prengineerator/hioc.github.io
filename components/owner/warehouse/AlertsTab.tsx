'use client';

// Owner → Warehouse → Alerts (docs/WAREHOUSE-SPEC.md, WH-D9..D11): who is told
// when the store asks for stock, sends stock back, or counts a delivery in
// different from what was sent — and the last attempts, so "did I get told?"
// has an answer. Email works as soon as Resend is set up (it already is for
// the reports); WhatsApp needs a Meta-approved template, and says so here
// until it has one.

import { useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { describeSkipReason } from '@/lib/notifications/reasons';
import { api, inputClass, primaryButton, when, type AlertsPayload } from '@/components/owner/warehouse/client';

const EVENT_LABELS: Record<string, string> = {
  request_placed: 'Stock request',
  return_sent: 'Return sent',
  arrived_different: 'Arrived different',
};

const STATUS_TONE: Record<string, string> = {
  sent: 'text-green-800',
  failed: 'text-red-700',
  skipped: 'text-amber-800',
};

export function AlertsTab() {
  const [data, setData] = useState<AlertsPayload | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [ownerLogins, setOwnerLogins] = useState(true);
  const [emails, setEmails] = useState('');
  const [phones, setPhones] = useState('');

  const adopt = (d: AlertsPayload) => {
    setData(d);
    setEnabled(d.settings.enabled);
    setOwnerLogins(d.settings.emailOwnerLogins);
    setEmails(d.settings.emails.join('\n'));
    setPhones(d.settings.whatsappPhones.join('\n'));
  };

  useEffect(() => {
    void api<AlertsPayload>('/api/owner/warehouse/alerts').then((res) => (res.ok ? adopt(res.data) : setError(res.error)));
  }, []);

  async function save() {
    setError('');
    setNotice('');
    setBusy(true);
    const split = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
    const res = await api<AlertsPayload>('/api/owner/warehouse/alerts', 'PATCH', {
      enabled,
      emailOwnerLogins: ownerLogins,
      emails: split(emails),
      whatsappPhones: split(phones),
    });
    setBusy(false);
    if (!res.ok) return setError(res.error);
    adopt(res.data);
    setNotice('Saved.');
  }

  if (!data) return error ? <p className="text-sm text-red-700">{error}</p> : <Spinner label="Loading alerts…" />;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section className="rounded-md border border-line bg-white p-4">
        <h2 className="text-lg font-bold text-charcoal">Who is told</h2>
        <p className="text-sm text-muted">
          When the store asks for stock, when it sends stock back, and when a delivery is counted in different from what was sent.
        </p>
        {!data.migrated ? (
          <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            The warehouse migration isn’t applied yet (supabase/2026-11-warehouse.sql), so these settings can’t be saved.
          </p>
        ) : null}

        <label className="mt-4 flex min-h-[44px] items-center gap-3 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="font-semibold text-charcoal">Send alerts</span>
        </label>
        <label className="flex min-h-[44px] items-center gap-3 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={ownerLogins} onChange={(e) => setOwnerLogins(e.target.checked)} disabled={!enabled} />
          <span>
            Email the owner login{data.ownerEmails.length === 1 ? '' : 's'}
            <span className="block text-xs text-muted">{data.ownerEmails.join(', ') || 'no owner email found'}</span>
          </span>
        </label>
        <label className="mt-3 block text-sm">
          <span className="text-charcoal">Also email (one per line)</span>
          <textarea
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            rows={3}
            className={`${inputClass} mt-1`}
            placeholder="partner@example.com"
            disabled={!enabled}
          />
        </label>
        <label className="mt-3 block text-sm">
          <span className="text-charcoal">WhatsApp numbers (one per line)</span>
          <textarea
            value={phones}
            onChange={(e) => setPhones(e.target.value)}
            rows={2}
            className={`${inputClass} mt-1`}
            placeholder="98765 43210"
            disabled={!enabled}
          />
        </label>
        <div className="mt-4 flex items-center gap-3">
          <button type="button" className={primaryButton} onClick={save} disabled={busy || !data.migrated}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          {notice ? <span className="text-sm text-green-700">{notice}</span> : null}
          {error ? <span className="text-sm text-red-700">{error}</span> : null}
        </div>
      </section>

      <section className="space-y-4">
        <div className="rounded-md border border-line bg-white p-4">
          <h2 className="text-lg font-bold text-charcoal">Channels</h2>
          <ul className="mt-2 space-y-2 text-sm">
            <li>
              <span className="font-semibold">Email: </span>
              {data.health.email.ready ? (
                <span className="text-green-800">ready</span>
              ) : (
                <span className="text-red-700">not set up (missing {data.health.email.missing.join(', ')})</span>
              )}
              <span className="block text-xs text-muted">
                Right now an alert goes to: {data.recipients.emails.join(', ') || 'nobody'}
              </span>
            </li>
            <li>
              <span className="font-semibold">WhatsApp: </span>
              {data.health.whatsapp.ready ? (
                <span className="text-green-800">ready</span>
              ) : (
                <span className="text-amber-800">waiting for an approved template (missing {data.health.whatsapp.missing.join(', ')})</span>
              )}
              <span className="block text-xs text-muted">
                {data.recipients.phones.length ? `To: ${data.recipients.phones.join(', ')}` : 'No WhatsApp numbers listed.'} The
                template to submit to Meta is in docs/WAREHOUSE-SPEC.md.
              </span>
            </li>
          </ul>
        </div>

        <div className="rounded-md border border-line bg-white p-4">
          <h2 className="text-lg font-bold text-charcoal">Recent alerts</h2>
          {data.log.length === 0 ? (
            <p className="mt-2 text-sm text-muted">None yet.</p>
          ) : (
            <ul className="mt-2 divide-y divide-[#f0f0f0] text-sm">
              {data.log.map((a) => (
                <li key={a.id} className="py-2">
                  <span className="font-semibold text-charcoal">
                    {EVENT_LABELS[a.event] ?? a.event}
                    {a.requestNumber ? ` #${a.requestNumber}` : ''}
                  </span>{' '}
                  <span className="text-muted">
                    · {a.channel === 'email' ? 'email' : 'WhatsApp'} to {a.to} · {when(a.createdAt)}
                  </span>{' '}
                  <span className={`font-semibold ${STATUS_TONE[a.status] ?? ''}`}>{a.status}</span>
                  {a.detail ? <span className="block text-xs text-muted">{describeSkipReason(a.detail)}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}
