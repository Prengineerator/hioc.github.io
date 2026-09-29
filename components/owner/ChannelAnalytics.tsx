'use client';

// Presentational pieces for the OPS-1 "Channel mix & dine-in" section. No state
// of their own, but a client module: the two tables are sortable/filterable
// DataTables whose column definitions are functions, which can't cross from the
// async owner server page as props. Matching the dashboard.tsx idiom: dependency-free inline SVG/CSS, cream/charcoal/tan/muted
// palette. All numbers arrive server-computed; here we only format them
// (₹ integers grouped en-IN, IST business dates).

import { DataTable } from '@/components/ui/DataTable';
import type { ChannelMixRow, OrderChannel, OrderType, TableTurnoverRow } from '@/lib/types';
import type {
  ChannelSummaryRow,
  HourlyDineInRow,
  StaffLeaderboardRow,
} from '@/lib/analytics/queries';

const CHANNEL_LABEL: Record<OrderChannel, string> = {
  customer_web: 'Customer web',
  staff_pos: 'Staff POS',
  table_qr: 'Table QR',
};

const TYPE_LABEL: Record<OrderType, string> = {
  takeaway: 'Takeaway',
  dine_in: 'Dine-in',
  delivery: 'Delivery',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const inr = (n: number) => `₹${n.toLocaleString('en-IN')}`;

// business_date is an IST calendar date ('YYYY-MM-DD') already computed in SQL,
// so format from its parts — never re-parse through a timezone.
function fmtIstDate(d: string): string {
  const [, m, day] = d.split('-');
  return `${Number(day)} ${MONTHS[Number(m) - 1] ?? ''}`;
}

function Empty({ label }: { label: string }) {
  return <p className="py-6 text-center text-sm text-muted">{label}</p>;
}

// Orders + revenue by channel × order type (OPS-1).
export function ChannelMixTable({ rows }: { rows: ChannelMixRow[] }) {
  if (rows.length === 0) return <Empty label="No orders yet" />;
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => `${r.channel}-${r.order_type}`}
      minWidth={420}
      columns={[
        {
          key: 'channel',
          header: 'Channel',
          filter: 'select',
          value: (r) => CHANNEL_LABEL[r.channel] ?? r.channel,
          cellClassName: 'text-charcoal',
        },
        {
          key: 'type',
          header: 'Type',
          filter: 'select',
          value: (r) => TYPE_LABEL[r.order_type] ?? r.order_type,
          cellClassName: 'text-muted',
        },
        { key: 'orders', header: 'Orders', filter: 'number', align: 'right', value: (r) => r.orders, cellClassName: 'text-charcoal' },
        {
          key: 'revenue',
          header: 'Revenue',
          filter: 'number',
          align: 'right',
          value: (r) => r.revenue_inr,
          cellClassName: 'text-charcoal',
          render: (r) => inr(r.revenue_inr),
        },
        {
          key: 'avg',
          header: 'Avg ticket',
          filter: 'number',
          align: 'right',
          value: (r) => r.avg_ticket_inr,
          cellClassName: 'text-muted',
          render: (r) => inr(r.avg_ticket_inr),
        },
      ]}
    />
  );
}

// Average ticket per channel (OPS-1) — one tile per channel.
export function ChannelSummaryCards({ rows }: { rows: ChannelSummaryRow[] }) {
  if (rows.length === 0) return <Empty label="No orders yet" />;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
      {rows.map((r) => (
        <div key={r.channel} className="rounded-md bg-[#f2efe9] p-3">
          <p className="text-xs uppercase tracking-wide text-muted">
            {CHANNEL_LABEL[r.channel] ?? r.channel}
          </p>
          <p className="mt-1 text-xl font-bold text-charcoal">{inr(r.avg_ticket_inr)}</p>
          <p className="text-xs text-muted">
            {r.orders} orders · {inr(r.revenue_inr)}
          </p>
        </div>
      ))}
    </div>
  );
}

// Dine-in orders by IST hour-of-day (OPS-1) — 24-bar volume chart.
export function DineInPeakBars({ rows }: { rows: HourlyDineInRow[] }) {
  const max = Math.max(...rows.map((r) => r.orders), 1);
  if (rows.every((r) => r.orders === 0)) return <Empty label="No dine-in orders yet" />;
  return (
    <div className="overflow-x-auto">
      <div className="flex h-40 min-w-[560px] items-end gap-1">
        {rows.map((r) => (
          <div
            key={r.hour}
            className="flex flex-1 flex-col items-center justify-end"
            title={`${r.hour}:00 — ${r.orders} orders`}
          >
            <div
              className="w-full rounded-t bg-tan"
              style={{ height: `${(r.orders / max) * 100}%` }}
            />
            <span className="mt-1 text-[9px] text-muted">{r.hour}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// Table turnover — settled orders per table per IST day (OPS-1).
export function TableTurnoverList({ rows }: { rows: TableTurnoverRow[] }) {
  if (rows.length === 0) return <Empty label="No settled dine-in orders yet" />;
  return (
    <DataTable
      rows={rows}
      rowKey={(r) => `${r.table_id ?? r.table_label}-${r.business_date}`}
      minWidth={360}
      columns={[
        { key: 'table', header: 'Table', filter: 'select', value: (r) => r.table_label, cellClassName: 'text-charcoal' },
        {
          key: 'date',
          header: 'Date',
          filter: 'date',
          value: (r) => r.business_date,
          cellClassName: 'text-muted',
          render: (r) => fmtIstDate(r.business_date),
        },
        { key: 'settles', header: 'Settles', filter: 'number', align: 'right', value: (r) => r.settled_orders, cellClassName: 'text-charcoal' },
        {
          key: 'revenue',
          header: 'Revenue',
          filter: 'number',
          align: 'right',
          value: (r) => r.revenue_inr,
          cellClassName: 'text-muted',
          render: (r) => inr(r.revenue_inr),
        },
      ]}
    />
  );
}

// Staff order-entry leaderboard (OPS-1) — ranked by orders entered.
export function StaffLeaderboard({ rows }: { rows: StaffLeaderboardRow[] }) {
  if (rows.length === 0) return <Empty label="No staff-entered orders yet" />;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {rows.map((r, i) => (
        <li key={r.staff_id} className="flex items-center justify-between border-b border-[#f2efe9] py-1.5">
          <span className="flex items-center gap-2 text-charcoal">
            <span className="w-5 text-right text-xs font-bold text-muted">{i + 1}</span>
            {r.name}
          </span>
          <span className="text-muted">
            {r.orders_entered}× · {inr(r.revenue_inr)}
          </span>
        </li>
      ))}
    </ul>
  );
}
