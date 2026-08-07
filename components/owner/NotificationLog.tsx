'use client';

// BILL-5 — the owner-facing delivery log.
//
// The gap it fills: bills could fail (or never be attempted) and absolutely
// nothing in the product said so. This is the one screen that answers "did the
// customer get their bill?" without opening Supabase — and, when the answer is
// no, whether the cause is the customer (no number), the configuration (a
// missing env var) or the provider (Meta rejected it).

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { describeSkipReason } from '@/lib/notifications/reasons';
import { hasBeenSent } from '@/lib/notifications/status';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import { formatIstTime } from '@/lib/store/hours';
import type { NotificationRecord } from '@/lib/types';

type Row = NotificationRecord & { order_number: number | null };

interface ChannelHealth {
  channel: string;
  configured: boolean;
  missing: string[];
  warnings: string[];
  note: string;
}

// WA-3 — the shape POST /api/owner/notifications/test-send returns. `accepted`
// means a real provider took the request; it is NOT a delivery receipt, and the
// copy below is careful never to imply otherwise.
interface TestSendChannel {
  channel: string;
  sent: boolean;
  reason: string;
  detail: string;
  provider_error: string;
}

interface TestSendResult {
  accepted: boolean;
  summary: string;
  channels: TestSendChannel[];
}

const FILTERS = [
  { key: 'bill-undelivered', label: 'Bills not delivered', event: 'bill', status: 'undelivered' },
  { key: 'bill', label: 'All bills', event: 'bill', status: '' },
  { key: 'undelivered', label: 'All failures', event: '', status: 'undelivered' },
  { key: 'all', label: 'Everything', event: '', status: '' },
] as const;

export function NotificationLog() {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('bill-undelivered');
  const [rows, setRows] = useState<Row[]>([]);
  const [health, setHealth] = useState<ChannelHealth[]>([]);
  const [providerWarning, setProviderWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [resendingId, setResendingId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [testPhone, setTestPhone] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestSendResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);

  const load = useCallback(() => {
    const active = FILTERS.find((f) => f.key === filter) ?? FILTERS[0];
    const params = new URLSearchParams();
    if (active.event) params.set('event', active.event);
    if (active.status) params.set('status', active.status);
    setLoading(true);
    fetch(`/api/owner/notifications?${params.toString()}`, { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : { notifications: [], health: [] }))
      .then((data: { notifications?: Row[]; health?: ChannelHealth[]; provider_warning?: string | null }) => {
        setRows(data.notifications ?? []);
        setHealth(data.health ?? []);
        setProviderWarning(data.provider_warning ?? null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  const resend = async (row: Row) => {
    setResendingId(row.id);
    setToast(null);
    try {
      const res = await fetch(`/api/orders/${row.order_id}/resend-bill`, { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        sent?: { whatsapp: boolean; email: boolean };
      };
      if (!res.ok) {
        setToast(data.error ?? 'Could not resend.');
        return;
      }
      const sent = data.sent ?? { whatsapp: false, email: false };
      setToast(sent.whatsapp || sent.email ? 'Bill resent.' : 'Still not sent — see the reason on the row.');
      load();
    } catch {
      setToast('Network error.');
    } finally {
      setResendingId(null);
    }
  };

  // WA-3. Nothing is written to an order, so the log below doesn't reload — the
  // verdict lives entirely in this inline result.
  const testSend = async (e: FormEvent) => {
    e.preventDefault();
    setTesting(true);
    setTestResult(null);
    setTestError(null);
    try {
      const res = await fetch('/api/owner/notifications/test-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: testPhone }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<TestSendResult> & { error?: string };
      if (!res.ok) {
        setTestError(data.error ?? 'Could not send the test.');
        return;
      }
      setTestResult({
        accepted: data.accepted ?? false,
        // A 200 whose body we can't read is not a success. Without this the
        // card renders a bare red ✗ with no text and nothing to act on.
        summary: data.summary || 'The server answered, but the result could not be read.',
        channels: data.channels ?? [],
      });
    } catch {
      setTestError('Network error.');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Channel health — BILL-3. An empty log means one of two very different
          things; this is what tells them apart. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {health.map((h) => (
          <div
            key={h.channel}
            className={
              'rounded-md border px-4 py-3 ' +
              (h.configured ? 'border-[#e5e5e5] bg-cream' : 'border-red-200 bg-red-50')
            }
          >
            <p className="flex items-center gap-2 text-sm font-bold capitalize text-charcoal">
              {h.channel}
              <span className={h.configured ? 'text-green-700' : 'text-red-700'}>
                {h.configured ? '● configured' : '● off'}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-muted">{h.note}</p>
            {h.warnings.map((w) => (
              <p key={w} className="mt-1 text-xs text-red-700">
                ⚠ {w}
              </p>
            ))}
          </div>
        ))}
      </div>

      {providerWarning ? (
        <p className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          ⚠ {providerWarning}
        </p>
      ) : null}

      {/* WA-3 — "is it working right now?" without a deploy, a script, or a
          customer guinea pig. The real bill template, the real engine, sample
          data marked TEST. */}
      <form onSubmit={testSend} className="rounded-md border border-[#e5e5e5] bg-cream px-4 py-3">
        <p className="text-sm font-bold text-charcoal">Send a test bill</p>
        <p className="mt-0.5 text-xs text-muted">
          Sends the real bill message to a number you choose, through the same path a customer&apos;s bill
          takes. It carries sample data marked TEST and belongs to no order, so nothing appears in the log
          below.
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            value={testPhone}
            onChange={(e) => {
              setTestPhone(e.target.value);
              // A verdict belongs to the number it was run against. Leaving it
              // rendered under a freshly typed number invites the exact wrong
              // conclusion on a tool whose only job is telling the truth about
              // one specific handset.
              setTestResult(null);
              setTestError(null);
            }}
            inputMode="tel"
            placeholder="10-digit mobile"
            aria-label="Mobile number for the test bill"
            className="w-44 rounded-md border border-[#d8d2c7] bg-white px-3 py-2 text-sm text-charcoal outline-none focus:border-tan"
          />
          <button
            type="submit"
            disabled={testing || testPhone.trim().length === 0}
            className="rounded-md border border-tan bg-tan px-3 py-2 text-sm font-bold text-cream transition-opacity disabled:opacity-50"
          >
            {testing ? 'Sending…' : 'Send test bill'}
          </button>
        </div>

        {testError ? <p className="mt-2 text-sm font-bold text-red-700">{testError}</p> : null}

        {testResult ? (
          <div className="mt-2">
            {/* Amber, not green, on success. The tick used to read as "it
                arrived"; all this proves is that Meta accepted the request. */}
            <p className={'text-sm font-bold ' + (testResult.accepted ? 'text-amber-800' : 'text-red-700')}>
              {testResult.accepted ? '→' : '✗'} {testResult.summary}
            </p>
            <ul className="mt-1 space-y-0.5">
              {testResult.channels.map((c) => (
                <li key={c.channel} className="text-xs text-muted">
                  <span className="font-bold capitalize text-charcoal">{c.channel}</span> — {c.detail}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </form>

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={
              'rounded-md border px-3 py-1.5 text-sm font-bold transition-colors ' +
              (filter === f.key
                ? 'border-tan bg-tan text-cream'
                : 'border-[#e5e5e5] text-charcoal hover:border-tan')
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {toast ? <p className="text-sm font-bold text-charcoal">{toast}</p> : null}

      {loading ? (
        <Spinner label="Loading delivery log…" />
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-line bg-cream p-6 text-center text-sm text-muted">
          Nothing here — no notifications match this filter.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-[#e5e5e5] text-left text-xs uppercase tracking-wide text-muted">
                <th className="py-2 pr-3 font-bold">Order</th>
                <th className="py-2 pr-3 font-bold">Event</th>
                <th className="py-2 pr-3 font-bold">Channel</th>
                <th className="py-2 pr-3 font-bold">Status</th>
                <th className="py-2 pr-3 font-bold">Detail</th>
                <th className="py-2 pr-3 font-bold">When</th>
                <th className="py-2 font-bold" />
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-b border-[#f0eeea] align-top">
                  <td className="py-2 pr-3 font-bold text-charcoal">
                    {row.order_number !== null ? formatOrderNumber(row.order_number) : '—'}
                  </td>
                  <td className="py-2 pr-3 text-charcoal">{row.event}</td>
                  <td className="py-2 pr-3 text-charcoal">{row.channel}</td>
                  <td className="py-2 pr-3">
                    <StatusPill status={row.status} />
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted">
                    {row.error || describeSkipReason(row.skip_reason) || '—'}
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted">
                    {formatIstTime(new Date(row.sent_at ?? row.created_at))}
                  </td>
                  <td className="py-2">
                    {/* WA-4: `!== 'sent'` was true for 'delivered' and 'read',
                        i.e. the log offered Resend on the two rows that PROVE
                        the customer has their bill. A stray tap there is a
                        second billable template to someone who already read it,
                        and the engine's upsert would wipe the receipt. */}
                    {row.event === 'bill' && !hasBeenSent(row.status) ? (
                      <button
                        type="button"
                        onClick={() => resend(row)}
                        disabled={resendingId === row.id}
                        className="rounded-md border border-[#e5e5e5] px-2 py-1 text-xs font-bold text-charcoal hover:border-tan hover:text-tan disabled:opacity-50"
                      >
                        {resendingId === row.id ? '…' : 'Resend'}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// WA-4 widened the vocabulary, and without a branch here 'delivered' and 'read'
// — the only two statuses a handset can vouch for — rendered in the same neutral
// grey as 'queued'. They get the strongest green; 'sent' steps down to amber,
// because "the Cloud API accepted the request" is a statement about an HTTP call
// and this screen exists precisely because that was being read as delivery.
const STATUS_TONES: Record<string, string> = {
  read: 'bg-green-100 text-green-900',
  delivered: 'bg-green-50 text-green-800',
  sent: 'bg-amber-50 text-amber-900',
  failed: 'bg-red-50 text-red-800',
  skipped: 'bg-[#f6efe9] text-tan-dark',
};

function StatusPill({ status }: { status: string }) {
  const tone = STATUS_TONES[status] ?? 'bg-[#f2f2f2] text-muted';
  return <span className={`rounded px-2 py-0.5 text-xs font-bold ${tone}`}>{status}</span>;
}
