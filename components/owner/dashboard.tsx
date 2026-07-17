// Presentational owner-dashboard pieces (O1–O4). Pure (no hooks) so they render
// inside the async server page. All charts are dependency-free inline SVG/CSS.

import type { DailySalesRow, HourlyOrdersRow, ItemSalesRow, RejectReasonRow } from '@/lib/types';
import type { GlanceMetric, TodayAtAGlance } from '@/lib/analytics/queries';

function Delta({ m }: { m: GlanceMetric }) {
  if (m.deltaPct === null) return <span className="text-xs text-muted">no baseline</span>;
  const up = m.deltaPct >= 0;
  return (
    <span className={'text-xs font-bold ' + (up ? 'text-green-600' : 'text-red-600')}>
      {up ? '▲' : '▼'} {Math.abs(m.deltaPct)}% vs last wk
    </span>
  );
}

export function GlanceCards({ g }: { g: TodayAtAGlance }) {
  const cards = [
    { label: 'Revenue', value: `₹${g.revenue.value}`, m: g.revenue },
    { label: 'Orders', value: String(g.orders.value), m: g.orders },
    { label: 'AOV', value: `₹${g.aov.value}`, m: g.aov },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {cards.map((c) => (
        <div key={c.label} className="rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
          <p className="text-xs uppercase tracking-wide text-muted">{c.label}</p>
          <p className="mt-1 text-2xl font-bold text-charcoal">{c.value}</p>
          <Delta m={c.m} />
        </div>
      ))}
      <div className="rounded-md border border-[#e5e5e5] bg-cream p-4 shadow-sm">
        <p className="text-xs uppercase tracking-wide text-muted">In progress</p>
        <p className="mt-1 text-2xl font-bold text-charcoal">{g.inProgress}</p>
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
  return (
    <div className="flex h-40 items-end gap-1">
      {data.map((r) => (
        <div key={r.sale_date} className="group flex flex-1 flex-col items-center justify-end" title={`${r.sale_date}: ₹${r.revenue_inr}`}>
          <div className="w-full rounded-t bg-tan" style={{ height: `${(r.revenue_inr / max) * 100}%` }} />
        </div>
      ))}
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
          <li key={(r.menu_item_id ?? '') + r.item_name} className="flex justify-between border-b border-[#f2efe9] py-1">
            <span className="text-charcoal">{r.item_name}</span>
            <span className="text-muted">{r.units_sold}× · ₹{r.revenue_inr}</span>
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
    <div className="overflow-x-auto">
      <div className="min-w-[560px]">
        <div className="flex">
          <div className="w-10 shrink-0" />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="flex-1 text-center text-[9px] text-muted">{h}</div>
          ))}
        </div>
        {DOW.map((d, dow) => (
          <div key={d} className="flex items-center">
            <div className="w-10 shrink-0 text-[10px] text-muted">{d}</div>
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
        <li key={i} className="flex justify-between border-b border-[#f2efe9] py-1">
          <span className="text-charcoal">{r.reason} <span className="text-xs text-muted">({r.status})</span></span>
          <span className="text-muted">{r.cnt}</span>
        </li>
      ))}
    </ul>
  );
}

export function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-[#e5e5e5] bg-cream p-5 shadow-sm">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-charcoal">{title}</h2>
      {children}
    </section>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="py-6 text-center text-sm text-muted">{label}</p>;
}
