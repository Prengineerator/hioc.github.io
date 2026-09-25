'use client';

// Owner feedback inbox list (/owner/feedback). Filter tabs (Needs attention /
// All / Resolved), a rating chip, unread badge, and a snippet of the last
// message — everything the owner needs to triage without opening a thread.

import { useCallback, useEffect, useState } from 'react';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Spinner } from '@/components/ui/Spinner';
import { formatOrderNumber } from '@/lib/utils/orderNumber';
import type { FeedbackThreadStatus } from '@/lib/types';

interface ThreadRow {
  id: string;
  order_id: string;
  order_number: number | null;
  phone: string;
  customer_name: string;
  rating: number | null;
  thread_status: FeedbackThreadStatus;
  unread: boolean;
  updated_at: string;
  status: string;
  last_message: { body: string; direction: 'in' | 'out'; created_at: string } | null;
}

const TABS = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'all', label: 'All' },
  { key: 'resolved', label: 'Resolved' },
] as const;

function RatingChip({ rating }: { rating: number | null }) {
  if (rating === null) return <span className="text-xs text-muted">No rating yet</span>;
  const color = rating <= 2 ? 'bg-red-700 text-cream' : rating === 3 ? 'bg-tan text-cream' : 'bg-charcoal text-cream';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-bold ${color}`}>{rating}★</span>;
}

export function FeedbackInbox() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('attention');
  const [rows, setRows] = useState<ThreadRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    setLoading(true);
    fetch(`/api/owner/feedback?filter=${tab}`)
      .then((r) => r.json())
      .then((d) => setRows(d.threads ?? []))
      .finally(() => setLoading(false));
  }, [tab]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              'rounded-md px-3 py-2 text-sm font-bold ' +
              (tab === t.key ? 'bg-charcoal text-cream' : 'bg-surface text-charcoal hover:bg-[#f2efe9]')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <Spinner label="Loading feedback…" />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted">Nothing here.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-line rounded-md border border-line bg-cream shadow-sm">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/owner/feedback/${row.id}`}
                className="flex items-start justify-between gap-3 px-4 py-3 hover:bg-[#f2efe9]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <RatingChip rating={row.rating} />
                    <span className="text-sm font-bold text-charcoal">{row.customer_name || row.phone}</span>
                    {row.order_number ? (
                      <span className="text-xs text-muted">{formatOrderNumber(row.order_number)}</span>
                    ) : null}
                    {row.unread ? <span className="h-2 w-2 shrink-0 rounded-full bg-tan" aria-label="Unread" /> : null}
                  </div>
                  {row.last_message ? (
                    <p className="mt-1 truncate text-sm text-muted">
                      {row.last_message.direction === 'out' ? 'You: ' : ''}
                      {row.last_message.body || '(no text)'}
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-muted">No messages yet — {row.status}.</p>
                  )}
                </div>
                <span className="shrink-0 text-xs uppercase tracking-wide text-muted">
                  {row.thread_status.replace('_', ' ')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
