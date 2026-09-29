'use client';

// Owner-feedback fix: "Customer is not segregated in Owner app, and staff name
// is not displayed on the owner's dashboard — orders all show as 'customer'".
// Presentational, matching the dashboard.tsx / ChannelAnalytics.tsx idiom (a
// client module so the sortable/filterable table's column functions can live here). Badge/label text comes from the pure classifier in
// lib/analytics/customerSegments.ts so the rule lives in one tested place.

import { DataTable } from '@/components/ui/DataTable';
import { customerBadgeLabel, enteredByLabel, type CustomerSegment } from '@/lib/analytics/customerSegments';
import type { RecentOrderRow } from '@/lib/analytics/queries';

const inr = (n: number | null) => `₹${(n ?? 0).toLocaleString('en-IN')}`;

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function BadgeChip({ label }: { label: string }) {
  const isWalkIn = label === 'Walk-in';
  return (
    <span
      className={
        'inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ' +
        (isWalkIn ? 'bg-[#f2efe9] text-muted' : 'bg-[#efe5d8] text-[#8a5a2b]')
      }
    >
      {label}
    </span>
  );
}

/**
 * Last-N orders (any status) with a clear customer-type badge and, for
 * staff-entered orders, who entered it. `staffNames` maps created_by → the
 * resolved staff display name (lib/staff/displayName.ts) — passed in so this
 * component stays presentational. A plain record, not a Map, so it can cross
 * from the server page.
 */
export function RecentOrdersCard({
  rows,
  staffNames,
}: {
  rows: RecentOrderRow[];
  staffNames: Record<string, string>;
}) {
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-muted">No orders yet</p>;
  }
  const badgeOf = (r: RecentOrderRow) => customerBadgeLabel(r);
  const enteredByOf = (r: RecentOrderRow) =>
    enteredByLabel(r.channel, r.created_by ? staffNames[r.created_by] : null);
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => r.id}
      minWidth={560}
      cellPadding="py-1.5 pr-3"
      columns={[
        {
          key: 'order',
          header: 'Order',
          filter: 'text',
          value: (r) => `#${r.order_number}`,
          cellClassName: 'align-top text-charcoal',
          render: (r) => (
            <>
              #{r.order_number}
              <span className="block text-xs text-muted">{fmtTime(r.created_at)}</span>
            </>
          ),
        },
        {
          key: 'customer',
          header: 'Customer',
          filter: 'select',
          value: badgeOf,
          cellClassName: 'align-top',
          render: (r) => <BadgeChip label={badgeOf(r)} />,
        },
        {
          key: 'entered_by',
          header: 'Entered by',
          filter: 'select',
          value: (r) => enteredByOf(r),
          cellClassName: 'align-top text-xs text-muted',
          render: (r) => enteredByOf(r) ?? '—',
        },
        {
          key: 'total',
          header: 'Total',
          filter: 'number',
          align: 'right',
          value: (r) => r.total_inr ?? 0,
          cellClassName: 'align-top font-bold text-tan-dark',
          render: (r) => inr(r.total_inr),
        },
        {
          key: 'status',
          header: 'Status',
          filter: 'select',
          align: 'right',
          value: (r) => r.status,
          cellClassName: 'align-top text-xs uppercase text-muted',
        },
      ]}
    />
  );
}

const SEGMENT_LABEL: Record<CustomerSegment, string> = {
  walk_in: 'Walk-in',
  identified: 'Identified',
  online: 'Online',
};

/** Orders-by-customer-type split, side by side for two windows (e.g. today / 30 days). */
export function CustomerTypeSplit({
  windows,
}: {
  windows: { label: string; counts: Record<CustomerSegment, number> }[];
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {windows.map((w) => {
        const total = w.counts.walk_in + w.counts.identified + w.counts.online;
        return (
          <div key={w.label} className="rounded-md bg-[#f2efe9] p-3">
            <p className="mb-2 text-xs uppercase tracking-wide text-muted">{w.label}</p>
            {total === 0 ? (
              <p className="text-sm text-muted">No orders yet</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {(Object.keys(SEGMENT_LABEL) as CustomerSegment[]).map((seg) => {
                  const n = w.counts[seg];
                  const pct = total ? Math.round((n / total) * 100) : 0;
                  return (
                    <li key={seg} className="flex items-center justify-between">
                      <span className="text-charcoal">{SEGMENT_LABEL[seg]}</span>
                      <span className="text-muted">
                        {n} · {pct}%
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
