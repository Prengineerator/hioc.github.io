// Owner → Traffic: where visitors to the ordering and Shop pages come from,
// and which of those visits end in an order (docs/TRAFFIC-TRACKING.md).
// Server component in the style of app/owner/online/page.tsx. The rows come
// from traffic_events (lib/traffic/load.ts); all the arithmetic is in
// lib/traffic/summary.ts.

import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card, inr } from '@/components/owner/dashboard';
import { CampaignLinkBuilder } from '@/components/owner/traffic/CampaignLinkBuilder';
import { flags } from '@/lib/flags';
import { surfaceOrigin } from '@/lib/routing/surface';
import { loadTraffic } from '@/lib/traffic/load';
import {
  TRAFFIC_RANGES,
  conversionRate,
  istDay,
  parseTrafficRange,
  type TrafficRangeDays,
  type TrafficSummary,
} from '@/lib/traffic/summary';
import { PAGE_GROUP_LABEL, TRAFFIC_DEVICE_LABEL, TRAFFIC_SOURCE_LABEL, type TrafficDevice } from '@/lib/traffic/types';

export const dynamic = 'force-dynamic';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtDay(day: string, withYear = false): string {
  const d = `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
  return withYear ? `${d} ${day.slice(0, 4)}` : d;
}

const n = (x: number) => x.toLocaleString('en-IN');
const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(x < 0.1 ? 1 : 0)}%`);

const th = 'py-1.5 pr-3';
const thNum = 'py-1.5 pr-3 text-right';
const td = 'py-1.5 pr-3';
const tdNum = 'py-1.5 pr-3 text-right tabular-nums';
const row = 'border-t border-[#f2efe9] text-charcoal';

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-charcoal">{value}</p>
      {sub ? <p className="text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

function RangeFilter({ days }: { days: TrafficRangeDays }) {
  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs font-bold ${active ? 'border-tan-dark bg-tan-dark text-white' : 'border-line bg-white text-charcoal hover:border-charcoal'}`;
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Period">
      {TRAFFIC_RANGES.map((d) => (
        <Link key={d} href={`/owner/traffic?range=${d}`} className={pill(d === days)} aria-current={d === days ? 'true' : undefined}>
          Last {d} days
        </Link>
      ))}
    </div>
  );
}

function Swatch({ group }: { group: 'orders' | 'shop' }) {
  return <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${group === 'orders' ? 'bg-tan-dark' : 'bg-charcoal'}`} />;
}

// Visits per day, ordering and Shop side by side. Numbers are stated in text
// above it, because a bar's hover title is invisible on the owner's phone.
function DailyBars({ s }: { s: TrafficSummary }) {
  const days = s.daily;
  const max = Math.max(1, ...days.map((d) => Math.max(d.orderingVisits, d.shopVisits)));
  const best = days.reduce((a, b) => (b.orderingVisits + b.shopVisits > a.orderingVisits + a.shopVisits ? b : a), days[0]);
  const today = days[days.length - 1];
  return (
    <div>
      <p className="mb-3 text-sm text-charcoal">
        Busiest day <span className="font-mono tabular-nums">{fmtDay(best.day)}</span>:{' '}
        <span className="font-mono tabular-nums">{n(best.orderingVisits)}</span> ordering and{' '}
        <span className="font-mono tabular-nums">{n(best.shopVisits)}</span> Shop visits · today so far{' '}
        <span className="font-mono tabular-nums">{n(today.orderingVisits)}</span> and{' '}
        <span className="font-mono tabular-nums">{n(today.shopVisits)}</span>
      </p>
      <div className="mb-2 flex flex-wrap gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5"><Swatch group="orders" /> {PAGE_GROUP_LABEL.orders}</span>
        <span className="inline-flex items-center gap-1.5"><Swatch group="shop" /> {PAGE_GROUP_LABEL.shop}</span>
      </div>
      <div
        role="img"
        aria-label={`Visits per day from ${fmtDay(days[0].day)} to ${fmtDay(today.day)}. Busiest day ${fmtDay(best.day)} with ${best.orderingVisits} ordering and ${best.shopVisits} Shop visits.`}
        className="flex h-40 items-end gap-px border-b border-line"
      >
        {days.map((d) => (
          <div key={d.day} className="flex h-full min-w-0 flex-1 items-end justify-center gap-px" title={`${fmtDay(d.day)}: ${d.orderingVisits} ordering, ${d.shopVisits} Shop`}>
            <div className="w-1/2 max-w-[10px] rounded-t-sm bg-tan-dark" style={{ height: `${d.orderingVisits > 0 ? Math.max((d.orderingVisits / max) * 100, 2) : 0}%` }} />
            <div className="w-1/2 max-w-[10px] rounded-t-sm bg-charcoal" style={{ height: `${d.shopVisits > 0 ? Math.max((d.shopVisits / max) * 100, 2) : 0}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between font-mono text-xs tabular-nums text-muted">
        <span>{fmtDay(days[0].day)}</span>
        <span>{fmtDay(today.day)}</span>
      </div>
    </div>
  );
}

function SourcesTable({ s }: { s: TrafficSummary }) {
  if (s.sources.length === 0) return <Empty>No visits in this period yet.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted">
            <th className={th}>Source</th>
            <th className={thNum}>Visits</th>
            <th className={`${thNum} hidden md:table-cell`}>Ordering</th>
            <th className={`${thNum} hidden md:table-cell`}>Shop</th>
            <th className={thNum}>Orders</th>
            <th className={thNum}>Order value</th>
            <th className={`${thNum} hidden sm:table-cell`}>Ordered</th>
            <th className={thNum}>Shop orders</th>
            <th className={`${thNum} hidden sm:table-cell`}>Shop value</th>
          </tr>
        </thead>
        <tbody>
          {s.sources.map((r) => (
            <tr key={r.source} className={row}>
              <td className={`${td} whitespace-nowrap font-semibold`}>{r.label}</td>
              <td className={tdNum}>{n(r.visits)}</td>
              <td className={`${tdNum} hidden md:table-cell`}>{n(r.orderingVisits)}</td>
              <td className={`${tdNum} hidden md:table-cell`}>{n(r.shopVisits)}</td>
              <td className={tdNum}>{n(r.orders)}</td>
              <td className={tdNum}>{inr(r.orderValue)}</td>
              <td className={`${tdNum} hidden sm:table-cell`}>{pct(conversionRate(r.orders, r.orderingVisits))}</td>
              <td className={tdNum}>{n(r.shopOrders)}</td>
              <td className={`${tdNum} hidden sm:table-cell`}>{inr(r.shopValue)}</td>
            </tr>
          ))}
          <tr className={`${row} font-bold`}>
            <td className={td}>All</td>
            <td className={tdNum}>{n(s.visits)}</td>
            <td className={`${tdNum} hidden md:table-cell`}>{n(s.orderingVisits)}</td>
            <td className={`${tdNum} hidden md:table-cell`}>{n(s.shopVisits)}</td>
            <td className={tdNum}>{n(s.orders)}</td>
            <td className={tdNum}>{inr(s.orderValue)}</td>
            <td className={`${tdNum} hidden sm:table-cell`}>{pct(conversionRate(s.orders, s.orderingVisits))}</td>
            <td className={tdNum}>{n(s.shopOrders)}</td>
            <td className={`${tdNum} hidden sm:table-cell`}>{inr(s.shopValue)}</td>
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted">
        Ordered is orders per ordering visit. A visit that opened both the ordering pages and the Shop counts once in
        Visits and once in each group.
      </p>
    </div>
  );
}

function CampaignsTable({ s }: { s: TrafficSummary }) {
  if (s.campaigns.length === 0) {
    return <Empty>No tagged links used in this period. Make one with the link maker below.</Empty>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted">
            <th className={th}>Source tag</th>
            <th className={th}>Placement</th>
            <th className={th}>Campaign</th>
            <th className={thNum}>Visits</th>
            <th className={thNum}>Orders</th>
            <th className={thNum}>Shop orders</th>
            <th className={`${thNum} hidden sm:table-cell`}>Value</th>
          </tr>
        </thead>
        <tbody>
          {s.campaigns.map((c) => (
            <tr key={c.key} className={row}>
              <td className={`${td} font-mono text-xs`}>{c.utmSource ?? '—'}</td>
              <td className={`${td} font-mono text-xs`}>{c.utmMedium ?? '—'}</td>
              <td className={`${td} font-mono text-xs`}>{c.utmCampaign ?? '—'}</td>
              <td className={tdNum}>{n(c.visits)}</td>
              <td className={tdNum}>{n(c.orders)}</td>
              <td className={tdNum}>{n(c.shopOrders)}</td>
              <td className={`${tdNum} hidden sm:table-cell`}>{inr(c.orderValue + c.shopValue)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReferrersTable({ s }: { s: TrafficSummary }) {
  if (s.referrers.length === 0) return <Empty>No visits from other websites in this period.</Empty>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-muted">
          <th className={th}>Website</th>
          <th className={th}>Source</th>
          <th className={thNum}>Visits</th>
        </tr>
      </thead>
      <tbody>
        {s.referrers.slice(0, 15).map((r) => (
          <tr key={r.host} className={row}>
            <td className={`${td} break-all font-mono text-xs`}>{r.host}</td>
            <td className={`${td} whitespace-nowrap`}>{TRAFFIC_SOURCE_LABEL[r.source] ?? r.source}</td>
            <td className={tdNum}>{n(r.visits)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PagesTable({ s }: { s: TrafficSummary }) {
  if (s.pages.length === 0) return <Empty>No page views in this period.</Empty>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-xs uppercase tracking-wide text-muted">
          <th className={th}>Page</th>
          <th className={thNum}>Views</th>
          <th className={thNum}>Visits</th>
          <th className={`${thNum} hidden sm:table-cell`}>First page of visit</th>
        </tr>
      </thead>
      <tbody>
        {s.pages.map((p) => (
          <tr key={p.route} className={row}>
            <td className={td}>
              <span className="inline-flex items-center gap-1.5">
                <Swatch group={p.group} /> {p.label}
              </span>
              <span className="block font-mono text-[11px] text-muted">{p.route}</span>
            </td>
            <td className={tdNum}>{n(p.views)}</td>
            <td className={tdNum}>{n(p.visits)}</td>
            <td className={`${tdNum} hidden sm:table-cell`}>{n(p.landings)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function regionName(code: string | null): string {
  if (!code) return 'Unknown';
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function AudienceLists({ s }: { s: TrafficSummary }) {
  const total = Math.max(1, s.visits);
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <div>
        <h3 className="mb-2 text-sm font-bold text-charcoal">Devices</h3>
        {s.devices.length === 0 ? (
          <Empty>No visits yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2 text-sm">
            {s.devices.map((d) => (
              <li key={d.device} className="grid grid-cols-[6rem_1fr_auto] items-center gap-2">
                <span>{TRAFFIC_DEVICE_LABEL[d.device as TrafficDevice] ?? 'Unknown'}</span>
                <span className="h-2 overflow-hidden rounded-full bg-[#ece7dd]">
                  <span className="block h-full rounded-full bg-tan-dark" style={{ width: `${(d.visits / total) * 100}%` }} />
                </span>
                <span className="font-mono tabular-nums">{n(d.visits)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <h3 className="mb-2 text-sm font-bold text-charcoal">Places</h3>
        {s.places.length === 0 ? (
          <Empty>No visits yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5 text-sm">
            {s.places.slice(0, 10).map((p) => (
              <li key={`${p.country}|${p.city}`} className="flex justify-between gap-3">
                <span className="min-w-0 break-words">
                  {p.city ? `${p.city}, ` : ''}
                  {regionName(p.country)}
                </span>
                <span className="font-mono tabular-nums">{n(p.visits)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function Body({ s }: { s: TrafficSummary }) {
  const top = s.sources.find((r) => r.source !== 'direct');
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Ordering visits" value={n(s.orderingVisits)} sub={`${n(s.pageViews)} page views in all`} />
        <StatCard
          label="Orders from visits"
          value={n(s.orders)}
          sub={`${inr(s.orderValue)} · ${pct(conversionRate(s.orders, s.orderingVisits))} of ordering visits`}
        />
        <StatCard label="Shop visits" value={n(s.shopVisits)} />
        <StatCard
          label="Paid Shop orders"
          value={n(s.shopOrders)}
          sub={`${inr(s.shopValue)} · ${pct(conversionRate(s.shopOrders, s.shopVisits))} of Shop visits`}
        />
      </div>
      {top ? (
        <p className="text-sm text-charcoal">
          After direct visits, the biggest source was <strong>{top.label}</strong> with {n(top.visits)} visits,{' '}
          {n(top.orders)} orders and {n(top.shopOrders)} Shop orders.
        </p>
      ) : null}

      <Card title="Where visits come from">
        <SourcesTable s={s} />
      </Card>
      <Card title="Visits per day">
        <DailyBars s={s} />
      </Card>
      <Card title="Tagged links (campaigns)">
        <CampaignsTable s={s} />
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Linking websites">
          <ReferrersTable s={s} />
        </Card>
        <Card title="Pages">
          <PagesTable s={s} />
        </Card>
      </div>
      <Card title="Devices and places">
        <AudienceLists s={s} />
      </Card>
      {s.truncated ? (
        <p className="text-xs text-red-700">This period has more rows than the page reads at once; the oldest days are counted in part.</p>
      ) : null}
    </>
  );
}

function Notes() {
  return (
    <details className="rounded-md border border-line bg-cream p-4 text-sm text-muted shadow-sm">
      <summary className="cursor-pointer font-bold text-charcoal">How these numbers are counted</summary>
      <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5">
        <li>
          A <strong>visit</strong> is one browser tab on the ordering or Shop pages. It ends when the tab closes or after
          30 minutes without a page. There is no cookie and no lasting id, so a customer who comes back tomorrow is a new
          visit.
        </li>
        <li>
          <strong>Direct</strong> means the browser passed no linking website: WhatsApp bills and messages, QR codes,
          bookmarks and typed addresses. WhatsApp offers you send from Marketing are tagged automatically and show as
          WhatsApp. Use tagged links to split the rest.
        </li>
        <li>
          <strong>Orders</strong> are website and table-QR orders placed during a tracked visit and not waiting for
          payment, rejected or cancelled. <strong>Shop orders</strong> count once paid. Counter orders are not website
          visits and are not here.
        </li>
        <li>
          Visitors whose browser asks not to be tracked (Global Privacy Control or Do Not Track) are not counted, and nor
          are search-engine crawlers. Days are days in India.
        </li>
        <li>Rows are kept for 13 months, then deleted.</li>
      </ul>
    </details>
  );
}

export default async function OwnerTrafficPage({ searchParams }: { searchParams: { range?: string } }) {
  const days = parseTrafficRange(searchParams.range);
  const load = await loadTraffic(days);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Traffic</h1>
        <p className="text-sm text-muted">
          Where visitors to the ordering pages and the Shop come from, and which visits ended in an order.
          {load.ok ? ` ${fmtDay(load.summary.range.sinceDay, true)} to ${fmtDay(load.summary.range.untilDay, true)}.` : ''}
        </p>
      </div>

      <RangeFilter days={days} />

      {!flags.trafficTracking ? (
        <Card title="Tracking is switched off">
          <p className="text-sm text-charcoal">
            NEXT_PUBLIC_FLAG_TRAFFIC_TRACKING is set to false, so no new visits are being recorded. Anything recorded before
            is still shown below.
          </p>
        </Card>
      ) : null}

      {!load.ok && load.missingTable ? (
        <Card title="One-time setup">
          <p className="text-sm text-charcoal">
            Apply <span className="font-mono">supabase/2026-11-traffic-tracking.sql</span> in the Supabase SQL editor.
            Visits are recorded from then on; the full setup is in docs/TRAFFIC-TRACKING.md.
          </p>
        </Card>
      ) : !load.ok ? (
        <Card title="Traffic">
          <p className="py-6 text-center text-sm text-red-700">Traffic could not be loaded. Try again in a minute.</p>
        </Card>
      ) : (
        <>
          {load.summary.firstAt && istDay(load.summary.firstAt) > load.summary.range.sinceDay ? (
            <p className="text-xs text-muted">
              The first visit in this period was recorded on {fmtDay(istDay(load.summary.firstAt), true)}.
            </p>
          ) : null}
          <Body s={load.summary} />
        </>
      )}

      <Card title="Make a tagged link">
        <CampaignLinkBuilder origin={surfaceOrigin('main')} />
      </Card>

      <Notes />
    </div>
  );
}
