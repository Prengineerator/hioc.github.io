'use client';

// Push (docs/WEB-PUSH-SPEC.md): offers as phone notifications. Free, to customers
// who said yes. A title, a line of text and the page it opens, a live preview, a
// test to the owner's own phone, and one send to everyone per day behind a confirm
// that shows how many phones it goes to.

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Textarea } from '@/components/ui/Textarea';
import { PUSH_BODY_MAX, PUSH_TITLE_MAX, type PushSendResult, type PushSummary } from '@/lib/push/types';
import { parseMessage } from '@/lib/push/validate';
import { requestJson } from './api';
import { formatCount, formatIstDateTime } from './format';
import { useApi } from './hooks';
import { ConfirmDialog, Kpi, Notice, Panel, Pill, ResourceGate, TabIntro } from './ui';

const API_PUSH = '/api/owner/marketing/push';
const NOT_SET_UP = 'Push is not set up yet. Run supabase/2026-11-web-push.sql in Supabase (Hioc India) → SQL editor, then reload.';

const OPENS = [
  { value: '/menu', label: 'The menu' },
  { value: '/shop', label: 'The shop' },
  { value: 'custom', label: 'Another hioc.in page' },
];

export function PushTab() {
  const summary = useApi<PushSummary>(API_PUSH);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [opens, setOpens] = useState('/menu');
  const [custom, setCustom] = useState('/');
  const [busy, setBusy] = useState<'test' | 'send' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const url = opens === 'custom' ? custom : opens;
  const parsed = parseMessage({ title, body: text, url });

  const describe = (r: PushSendResult) =>
    `Reached ${formatCount(r.delivered)} of ${formatCount(r.device_count)} ${r.device_count === 1 ? 'phone' : 'phones'}` +
    (r.removed > 0 ? `. ${formatCount(r.removed)} no longer exist and were removed.` : '.') +
    (r.skipped > 0 ? ` ${formatCount(r.skipped)} were not tried because it took too long.` : '');

  const sendTest = async () => {
    setResult(null);
    setBusy('test');
    const r = await requestJson<PushSendResult>(`${API_PUSH}/test`, { method: 'POST', body: { title, body: text, url } });
    setBusy(null);
    if (!r.ok) {
      setResult({ ok: false, text: r.error.kind === 'migration_missing' ? NOT_SET_UP : r.error.message });
      return;
    }
    setResult({ ok: true, text: `Test sent. ${describe(r.data)}` });
    summary.reload();
  };

  const sendAll = async (count: number) => {
    setConfirmError(null);
    setBusy('send');
    const r = await requestJson<PushSendResult>(`${API_PUSH}/send`, { method: 'POST', body: { title, body: text, url, confirm_count: count } });
    setBusy(null);
    if (!r.ok) {
      setConfirmError(r.error.kind === 'migration_missing' ? NOT_SET_UP : r.error.message);
      summary.reload();
      return;
    }
    setConfirm(false);
    setResult({ ok: true, text: `Sent to everyone. ${describe(r.data)}` });
    summary.reload();
  };

  return (
    <div className="flex flex-col gap-5">
      <TabIntro title="Phone notifications">
        Offers that pop up on the phones of customers who said yes. They cost nothing to send. You can send one to everyone a day, so people do not switch them off.
      </TabIntro>

      <ResourceGate resource={summary} label="Loading notifications">
        {(data) => {
          const anyone = data.devices > 0;
          return (
            <>
              {!data.configured ? (
                <Notice tone="warn" title="Not switched on yet">
                  The notification keys are missing in Vercel, so nothing can be sent. Add NEXT_PUBLIC_VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT, then redeploy.
                </Notice>
              ) : null}

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Kpi label="Customers signed up" value={formatCount(data.customers)} />
                <Kpi label="Phones signed up" value={formatCount(data.devices)} hint="One customer can have more than one phone." />
                <Kpi label="Your own phones" value={formatCount(data.own_devices)} hint={data.own_devices === 0 ? 'Turn it on in Account, Profile on your phone to try a test.' : undefined} />
              </div>

              <Panel title="Write a notification">
                <div className="grid gap-5 lg:grid-cols-2">
                  <div className="flex flex-col gap-3">
                    <Input
                      label={`Title (up to ${PUSH_TITLE_MAX} characters)`}
                      value={title}
                      maxLength={PUSH_TITLE_MAX}
                      onChange={(e) => setTitle(e.target.value)}
                      hint={`${title.length} of ${PUSH_TITLE_MAX}`}
                    />
                    <Textarea
                      label={`Text (up to ${PUSH_BODY_MAX} characters)`}
                      value={text}
                      maxLength={PUSH_BODY_MAX}
                      rows={3}
                      onChange={(e) => setText(e.target.value)}
                      hint={`${text.length} of ${PUSH_BODY_MAX}`}
                    />
                    <Select label="When tapped, it opens" value={opens} onChange={(e) => setOpens(e.target.value)} options={OPENS} />
                    {opens === 'custom' ? (
                      <Input
                        label="Page on hioc.in"
                        value={custom}
                        onChange={(e) => setCustom(e.target.value)}
                        hint="For example /menu or /order. Starts with a slash."
                        error={parseMessage({ title: 'x', body: 'x', url: custom }).ok ? undefined : 'Enter a page on hioc.in, starting with /'}
                      />
                    ) : null}
                  </div>

                  <div>
                    <p className="text-sm font-semibold text-charcoal">Preview</p>
                    <div className="mt-1 flex gap-3 rounded-md border border-line bg-white p-3 shadow-sm" aria-label="Notification preview">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src="/icon.png" alt="" width={40} height={40} className="h-10 w-10 shrink-0 rounded-md" />
                      <div className="min-w-0">
                        <p className="break-words text-sm font-bold text-charcoal">{title || 'Your title'}</p>
                        <p className="break-words text-sm text-charcoal">{text || 'Your text will show here.'}</p>
                        <p className="mt-1 text-xs text-muted">hioc.in</p>
                      </div>
                    </div>
                  </div>
                </div>

                {result ? (
                  <p role={result.ok ? 'status' : 'alert'} className={`mt-3 text-sm font-semibold ${result.ok ? 'text-green-700' : 'text-red-700'}`}>
                    {result.text}
                  </p>
                ) : null}

                <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                  <Button variant="secondary" onClick={sendTest} loading={busy === 'test'} disabled={!parsed.ok || busy !== null || data.own_devices === 0 || !data.configured}>
                    Send test to me
                  </Button>
                  <Button
                    onClick={() => {
                      setConfirmError(null);
                      setConfirm(true);
                    }}
                    disabled={!parsed.ok || busy !== null || !anyone || data.sent_today || !data.configured}
                  >
                    Send to everyone
                  </Button>
                </div>
                {data.sent_today ? <p className="mt-2 text-sm text-muted">You have already sent one to everyone today. You can send the next one tomorrow.</p> : null}
                {!parsed.ok && (title || text) ? <p className="mt-2 text-sm text-muted">{parsed.error}</p> : null}
              </Panel>

              <Panel title="Past notifications">
                {data.recent.length === 0 ? (
                  <p className="text-sm text-muted">Nothing sent yet.</p>
                ) : (
                  <ul className="divide-y divide-line">
                    {data.recent.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                        <div className="min-w-0">
                          <p className="break-words text-sm font-bold text-charcoal">{s.title}</p>
                          <p className="break-words text-sm text-muted">{s.body}</p>
                          <p className="mt-0.5 text-xs text-muted">{formatIstDateTime(s.created_at)}</p>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-sm text-charcoal">
                          <Pill tone={s.kind === 'test' ? 'neutral' : 'good'}>{s.kind === 'test' ? 'Test' : 'To everyone'}</Pill>
                          <span>Reached {formatCount(s.delivered)} of {formatCount(s.device_count)}</span>
                          <span>Tapped {formatCount(s.clicked)}</span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <ConfirmDialog
                open={confirm}
                title="Send to everyone?"
                confirmLabel={`Send to ${formatCount(data.devices)} ${data.devices === 1 ? 'phone' : 'phones'}`}
                busy={busy === 'send'}
                error={confirmError}
                onConfirm={() => void sendAll(data.devices)}
                onCancel={() => setConfirm(false)}
              >
                <p>
                  This goes to <span className="font-bold">{formatCount(data.devices)}</span> {data.devices === 1 ? 'phone' : 'phones'} ({formatCount(data.customers)}{' '}
                  {data.customers === 1 ? 'customer' : 'customers'}) straight away and cannot be taken back. You can only send one a day.
                </p>
                <p className="rounded-md border border-line bg-white p-3">
                  <span className="font-bold">{title}</span>
                  <br />
                  {text}
                </p>
              </ConfirmDialog>
            </>
          );
        }}
      </ResourceGate>
    </div>
  );
}
