// Presentational owner-dashboard pieces (O1–O4). Pure (no hooks) so they render
// inside the async server page. All charts are dependency-free inline SVG/CSS.

import type { DailySalesRow, HourlyOrdersRow, ItemSalesRow, RejectReasonRow } from '@/lib/types';
import type { GlanceMetric, TodayAtAGlance } from '@/lib/analytics/queries';

/** ₹ with Indian digit grouping (₹1,23,456) — raw 6-digit sums were hard to read at a glance. */
export function inr(n: number): string {
  return `₹${Math.round(n).toLocaleString('en-IN')}`;
}

function Delta({ m }: { m: GlanceMetric }) {
  if (m.deltaPct === null) return <span className="text-xs text-muted">no baseline</span>;
  const up = m.deltaPct >= 0;
  return (
    <span className={'text-xs font-bold ' + (up ? 'text-green-700' : 'text-red-700')}>
      <span aria-hidden="true">{up ? '▲' : '▼'}</span>
      <span className="sr-only">{up ? 'Up' : 'Down'}</span> {Math.abs(m.deltaPct)}% vs last wk
    </span>
  );
}

export function GlanceCards({ g }: { g: TodayAtAGlance }) {
  const cards = [
    { label: 'Revenue', value: inr(g.revenue.value), m: g.revenue },
    { label: 'Orders', value: g.orders.value.toLocaleString('en-IN'), m: g.orders },
    { label: 'Avg order value', value: inr(g.aov.value), m: g.aov },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-md border border-line bg-cream p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-muted">{c.label}</p>
          <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-charcoal">{c.value}</p>
          <Delta m={c.m} />
        </div>
      ))}
      <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
        <p className="text-xs uppercase tracking-wide text-muted">In progress</p>
        <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-charcoal">{g.inProgress}</p>
        <span className="text-xs text-muted">live orders</span>
      </div>
    </div>
  );
}

// Simple revenue bar chart over the last N days (oldest→newest left→right).
export function RevenueBars({ rows }: { rows: DailySalesRow[] }) {
  const data = [...rows].reverse();
  if (data.length === 0) return <Empty label="No revenue yet" />;
  const max = Math.max(...data.map((r) => r.revenue_inr), 1);
  const total = data.reduce((sum, r) => sum + r.revenue_inr, 0);
  const best = data.reduce((a, b) => (b.revenue_inr > a.revenue_inr ? b : a));
  // The bars alone had no numbers and only a hover title (invisible on the
  // owner's phone) — so state the headline figures in text, give the chart an
  // accessible summary, and label the date range under the axis.
  return (
    <div>
      <p className="mb-3 text-sm text-charcoal">
        <span className="font-mono font-bold tabular-nums">{inr(total)}</span> total · best day{' '}
        <span className="font-mono tabular-nums">{best.sale_date}</span> at{' '}
        <span className="font-mono tabular-nums">{inr(best.revenue_inr)}</span>
      </p>
      <div
        role="img"
        aria-label={`Daily revenue for the last ${data.length} days: ${inr(total)} total, best day ${best.sale_date} at ${inr(best.revenue_inr)}.`}
        className="flex h-40 items-end gap-1 border-b border-line"
      >
        {data.map((r) => (
          <div key={r.sale_date} className="group flex h-full flex-1 flex-col items-center justify-end" title={`${r.sale_date}: ${inr(r.revenue_inr)}`}>
            <div
              className={'w-full rounded-t ' + (r.sale_date === best.sale_date ? 'bg-tan-dark' : 'bg-tan')}
              style={{ height: `${Math.max((r.revenue_inr / max) * 100, r.revenue_inr > 0 ? 2 : 0)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-xs tabular-nums text-muted">
        <span>{data[0].sale_date}</span>
        <span>{data[data.length - 1].sale_date}</span>
      </div>
    </div>
  );
}

export function SellerList({ title, rows }: { title: string; rows: ItemSalesRow[] }) {
  if (rows.length === 0) return null;
  return (
    <div>
      <h3 className="mb-2 text-sm font-bold text-charcoal">{title}</h3>
      <ul className="flex flex-col gap-1 text-sm">
        {rows.map((r) => (
          <li key={(r.menu_item_id ?? '') + r.item_name} className="flex justify-between gap-2 border-b border-[#f2efe9] py-1">
            <span className="min-w-0 truncate text-charcoal">{r.item_name}</span>
            <span className="shrink-0 font-mono tabular-nums text-muted">{r.units_sold}× · {inr(r.revenue_inr)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// 7×24 peak-hours heatmap shaded by order volume (OWN-007).
export function Heatmap({ rows }: { rows: HourlyOrdersRow[] }) {
  const grid = new Map<string, number>();
  let max = 1;
  for (const r of rows) {
    grid.set(`${r.dow}-${r.hour_of_day}`, r.orders);
    if (r.orders > max) max = r.orders;
  }
  return (
    <div className="overflow-x-auto" role="img" aria-label="Orders by weekday and hour; darker cells mean more orders.">
      <div className="min-w-[560px]">
        <div className="flex">
          <div className="w-10 shrink-0" />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="flex-1 text-center text-[9px] text-muted">{h}</div>
          ))}
        </div>
        {DOW.map((d, dow) => (
          <div key={d} className="flex items-center">
            <div className="w-10 shrink-0 text-xs text-muted">{d}</div>
            {Array.from({ length: 24 }, (_, h) => {
              const v = grid.get(`${dow}-${h}`) ?? 0;
              const alpha = v === 0 ? 0 : 0.15 + (v / max) * 0.85;
              return (
                <div key={h} className="m-[1px] h-5 flex-1 rounded-sm" style={{ backgroundColor: `rgba(173,130,94,${alpha})` }} title={`${d} ${h}:00 — ${v} orders`} />
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

export function ReasonList({ rows }: { rows: RejectReasonRow[] }) {
  if (rows.length === 0) return <Empty label="No rejections/cancellations" />;
  return (
    <ul className="flex flex-col gap-1 text-sm">
      {rows.map((r, i) => (
        <li key={i} className="flex justify-between gap-2 border-b border-[#f2efe9] py-1">
          <span className="min-w-0 truncate text-charcoal">{r.reason} <span className="text-xs text-muted">({r.status})</span></span>
          <span className="shrink-0 font-mono tabular-nums text-muted">{r.cnt}</span>
        </li>
      ))}
    </ul>
  );
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-line bg-cream p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-charcoal">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="py-6 text-center text-sm text-muted">{label}</p>;
}

// How the money came in — cash / UPI / card / online (website), with refunds
// and the still-unpaid amount. Fed by the reconciliation report
// (lib/reports/reconcile.ts), so it counts counter payments and split bills,
// not only website payments. Shared by the Overview and Payments pages.
const PAY_METHODS = [
  ['cash', 'Cash'],
  ['upi', 'UPI'],
  ['card', 'Card'],
  ['online', 'Online (website)'],
] as const;

export function PaymentsByMethod({
  received,
  refunds,
  unpaidInr,
  unpaidOrders,
  reportHref,
}: {
  received: Record<'cash' | 'upi' | 'card' | 'online', number>;
  refunds: Record<'cash' | 'upi' | 'card' | 'online', number>;
  unpaidInr: number;
  unpaidOrders: number;
  reportHref?: string;
}) {
  const total = PAY_METHODS.reduce((s, [m]) => s + received[m], 0);
  const refunded = PAY_METHODS.reduce((s, [m]) => s + refunds[m], 0);
  return (
    <div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {PAY_METHODS.map(([m, label]) => {
          const pct = total > 0 ? Math.round((received[m] / total) * 100) : 0;
          return (
            <div key={m} className="rounded-md bg-[#f2efe9] p-3">
              <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
              <p className="mt-1 font-mono text-xl font-bold tabular-nums text-charcoal">{inr(received[m])}</p>
              <p className="text-xs text-muted">
                {pct}% of received{refunds[m] ? ` · −${inr(refunds[m])} refunded` : ''}
              </p>
            </div>
          );
        })}
      </div>
      <p className="mt-3 text-sm text-charcoal">
        <span className="font-bold">Total received {inr(total)}</span>
        {refunded ? <span className="text-red-700"> · refunds −{inr(refunded)}</span> : null}
        {unpaidOrders ? (
          <span className="text-amber-800">
            {' '}
            · {unpaidOrders} unpaid ({inr(unpaidInr)}) still to collect
          </span>
        ) : null}
      </p>
      {reportHref ? (
        <a href={reportHref} className="mt-2 inline-block text-sm font-bold text-tan hover:underline">
          Full report →
        </a>
      ) : null}
    </div>
  );
}
