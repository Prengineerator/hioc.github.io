// Presentational pieces for the OPS-1 "Channel mix & dine-in" section. Pure (no
// hooks) so they render inside the async owner server page, matching the
// dashboard.tsx idiom: dependency-free inline SVG/CSS, cream/charcoal/tan/muted
// palette. All numbers arrive server-computed; here we only format them
// (₹ integers grouped en-IN, IST business dates).

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
    <div className="overflow-x-auto">
      <table className="w-full min-w-[420px] text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
            <th className="pb-2 font-semibold">Channel</th>
            <th className="pb-2 font-semibold">Type</th>
            <th className="pb-2 text-right font-semibold">Orders</th>
            <th className="pb-2 text-right font-semibold">Revenue</th>
            <th className="pb-2 text-right font-semibold">Avg ticket</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.channel}-${r.order_type}`} className="border-t border-[#f2efe9]">
              <td className="py-1.5 text-charcoal">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
              <td className="py-1.5 text-muted">{TYPE_LABEL[r.order_type] ?? r.order_type}</td>
              <td className="py-1.5 text-right text-charcoal">{r.orders}</td>
              <td className="py-1.5 text-right text-charcoal">{inr(r.revenue_inr)}</td>
              <td className="py-1.5 text-right text-muted">{inr(r.avg_ticket_inr)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
    <div className="overflow-x-auto">
      <table className="w-full min-w-[360px] text-sm">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wide text-muted">
            <th className="pb-2 font-semibold">Table</th>
            <th className="pb-2 font-semibold">Date</th>
            <th className="pb-2 text-right font-semibold">Settles</th>
            <th className="pb-2 text-right font-semibold">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.table_id ?? r.table_label}-${r.business_date}`} className="border-t border-[#f2efe9]">
              <td className="py-1.5 text-charcoal">{r.table_label}</td>
              <td className="py-1.5 text-muted">{fmtIstDate(r.business_date)}</td>
              <td className="py-1.5 text-right text-charcoal">{r.settled_orders}</td>
              <td className="py-1.5 text-right text-muted">{inr(r.revenue_inr)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
