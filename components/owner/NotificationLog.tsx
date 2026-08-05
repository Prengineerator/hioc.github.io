'use client';

// BILL-5 — the owner-facing delivery log.
//
// The gap it fills: bills could fail (or never be attempted) and absolutely
// nothing in the product said so. This is the one screen that answers "did the
// customer get their bill?" without opening Supabase — and, when the answer is
// no, whether the cause is the customer (no number), the configuration (a
// missing env var) or the provider (Meta rejected it).

import { useCallback, useEffect, useState } from 'react';
import { Spinner } from '@/components/ui/Spinner';
import { describeSkipReason } from '@/lib/notifications/reasons';
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
                    {row.event === 'bill' && row.status !== 'sent' ? (
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

function StatusPill({ status }: { status: string }) {
  const tone =
    status === 'sent'
      ? 'bg-green-50 text-green-800'
      : status === 'failed'
        ? 'bg-red-50 text-red-800'
        : status === 'skipped'
          ? 'bg-[#f6efe9] text-tan-dark'
          : 'bg-[#f2f2f2] text-muted';
  return <span className={`rounded px-2 py-0.5 text-xs font-bold ${tone}`}>{status}</span>;
}
