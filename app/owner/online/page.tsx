// Owner → Online orders: Zomato (and, once its parser lands, Swiggy) payouts,
// read from the settlement reports the platforms email every week. Server
// component in the style of app/owner/payments/page.tsx; all money math is in
// lib/online-settlements/summary.ts. Setup: docs/ONLINE-SETTLEMENTS.md.

import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card, inr } from '@/components/owner/dashboard';
import { OnlineReportActions } from '@/components/owner/online/OnlineReportActions';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { istDateIso } from '@/lib/api/date';
import { formatIstDateTime } from '@/lib/print/labels';
import { loadOnlineData, type OnlineData, type ReportListRow } from '@/lib/online-settlements/load';
import { mailboxConfigFromEnv } from '@/lib/online-settlements/mailbox';
import {
  buildOnlineSummary,
  istDay,
  RANGES,
  resolveRange,
  type Metrics,
  type OnlineSummary,
  type RangeKey,
} from '@/lib/online-settlements/summary';
import { PLATFORM_LABEL, type Platform } from '@/lib/online-settlements/types';

export const dynamic = 'force-dynamic';

const PLATFORMS: { key: Platform | 'all'; label: string }[] = [
  { key: 'all', label: 'All platforms' },
  { key: 'zomato', label: 'Zomato' },
  { key: 'swiggy', label: 'Swiggy' },
];

/** 'owner@gmail.com' → 'ow…@gmail.com': enough to recognise, not to copy. */
function maskEmail(addr: string): string {
  const [user, host] = addr.split('@');
  if (!host) return addr;
  return `${user.slice(0, 2)}…@${host}`;
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const per100 = (x: number | null) => (x === null ? '—' : `₹${x.toFixed(1)}`);

function fmtDay(day: string | null): string {
  if (!day) return '—';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(day.slice(8, 10))} ${months[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold text-charcoal">{value}</p>
      {sub ? <p className="text-xs text-muted">{sub}</p> : null}
    </div>
  );
}

function Pill({ tone, children }: { tone: 'ok' | 'warn' | 'bad' | 'muted'; children: React.ReactNode }) {
  const cls = {
    ok: 'border-green-700 text-green-800',
    warn: 'border-amber-600 text-amber-800',
    bad: 'border-red-700 text-red-700',
    muted: 'border-line text-muted',
  }[tone];
  return <span className={`inline-block whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-bold ${cls}`}>{children}</span>;
}

const th = 'py-1.5 pr-3';
const thNum = 'py-1.5 pr-3 text-right';
const td = 'py-1.5 pr-3';
const tdNum = 'py-1.5 pr-3 text-right tabular-nums';

function MetricsRow({ label, m, strong }: { label: string; m: Metrics; strong?: boolean }) {
  return (
    <tr className={`border-t border-[#f2efe9] ${strong ? 'font-bold text-charcoal' : 'text-charcoal'}`}>
      <td className={`${td} whitespace-nowrap`}>{label}</td>
      <td className={tdNum}>{m.orders.toLocaleString('en-IN')}</td>
      <td className={tdNum}>{inr(m.menuSales)}</td>
      <td className={tdNum}>{pct(m.discountShare)}</td>
      <td className={`${tdNum} hidden sm:table-cell`}>{inr(m.fees)}</td>
      <td className={`${tdNum} hidden sm:table-cell`}>{inr(m.ads)}</td>
      <td className={`${tdNum} hidden md:table-cell`}>{inr(m.payout)}</td>
      <td className={tdNum}>{inr(m.inBank)}</td>
      <td className={tdNum}>{per100(m.keptPer100)}</td>
    </tr>
  );
}

function MetricsHead({ first }: { first: string }) {
  return (
    <thead>
      <tr className="text-left text-xs uppercase tracking-wide text-muted">
        <th className={th}>{first}</th>
        <th className={thNum}>Orders</th>
        <th className={thNum}>Menu sales</th>
        <th className={thNum}>Discount</th>
        <th className={`${thNum} hidden sm:table-cell`}>Platform fees</th>
        <th className={`${thNum} hidden sm:table-cell`}>Ads</th>
        <th className={`${thNum} hidden md:table-cell`}>Payout</th>
        <th className={thNum}>In your bank</th>
        <th className={thNum}>Kept per ₹100</th>
      </tr>
    </thead>
  );
}

function reportTone(status: string): 'ok' | 'warn' | 'bad' {
  return status === 'read' ? 'ok' : status === 'unsupported' ? 'warn' : 'bad';
}
const REPORT_STATUS: Record<string, string> = { read: 'Read', unsupported: 'Saved, not read yet', failed: 'Could not read' };

function ReportsTable({ rows }: { rows: ReportListRow[] }) {
  if (!rows.length) return <p className="py-6 text-center text-sm text-muted">No reports yet. Check email or upload one above.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[620px] text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted">
            <th className={th}>Received</th>
            <th className={th}>Platform</th>
            <th className={th}>Covers</th>
            <th className={th}>File</th>
            <th className={thNum}>Orders</th>
            <th className={th}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-[#f2efe9] align-top text-charcoal">
              <td className={`${td} whitespace-nowrap`}>
                {formatIstDateTime(r.email_received_at ?? r.created_at)}
                <span className="block text-xs text-muted">{r.source === 'email' ? 'by email' : 'uploaded'}</span>
              </td>
              <td className={td}>{PLATFORM_LABEL[r.platform as Platform] ?? r.platform}</td>
              <td className={`${td} whitespace-nowrap`}>
                {r.period_start ? `${fmtDay(r.period_start)} – ${fmtDay(r.period_end)}` : '—'}
              </td>
              <td className={`${td} max-w-[16rem] break-all text-xs text-muted`}>{r.file_name}</td>
              <td className={tdNum}>{r.status === 'read' ? r.orders_count.toLocaleString('en-IN') : '—'}</td>
              <td className={td}>
                <Pill tone={reportTone(r.status)}>{REPORT_STATUS[r.status] ?? r.status}</Pill>
                {r.error ? <span className="mt-1 block text-xs text-muted">{r.error}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EmailStatus({ data, configured, mailbox }: { data: OnlineData; configured: boolean; mailbox: string | null }) {
  const last = data.runs[0];
  return (
    <div className="flex flex-col gap-2 text-sm text-charcoal">
      {configured ? (
        <p>
          Reading <span className="font-bold">{mailbox}</span> every morning at about 9:15 AM for Zomato and Swiggy settlement emails.
        </p>
      ) : (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900">
          Email isn&rsquo;t connected yet, so reports only arrive when you upload them. Setup takes about five minutes: see
          docs/ONLINE-SETTLEMENTS.md (a mailbox app password and two settings in Vercel).
        </p>
      )}
      {last ? (
        <p className="text-xs text-muted">
          Last checked {formatIstDateTime(last.started_at)} ({last.trigger === 'cron' ? 'automatic' : 'by you'}):{' '}
          {last.error ? (
            <span className="text-red-700">{last.error}</span>
          ) : (
            <>
              {last.messages_found} email{last.messages_found === 1 ? '' : 's'}, {last.files_read} new report
              {last.files_read === 1 ? '' : 's'} read
              {last.files_skipped ? `, ${last.files_skipped} already read` : ''}
              {last.files_failed ? `, ${last.files_failed} could not be read` : ''}.
            </>
          )}
        </p>
      ) : null}
    </div>
  );
}

function Filters({ range, platform }: { range: RangeKey; platform: Platform | 'all' }) {
  const pill = (active: boolean) =>
    `rounded-full border px-3 py-1 text-xs font-bold ${active ? 'border-tan-dark bg-tan-dark text-white' : 'border-line bg-white text-charcoal hover:border-charcoal'}`;
  const href = (r: RangeKey, p: Platform | 'all') => `/owner/online?range=${r}${p === 'all' ? '' : `&platform=${p}`}`;
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Period and platform">
      {(Object.keys(RANGES) as RangeKey[]).map((r) => (
        <Link key={r} href={href(r, platform)} className={pill(r === range)} aria-current={r === range ? 'true' : undefined}>
          {RANGES[r].label}
        </Link>
      ))}
      <span className="mx-1 h-5 w-px bg-line" aria-hidden="true" />
      {PLATFORMS.map((p) => (
        <Link key={p.key} href={href(range, p.key)} className={pill(p.key === platform)} aria-current={p.key === platform ? 'true' : undefined}>
          {p.label}
        </Link>
      ))}
    </div>
  );
}

function Body({ s, data }: { s: OnlineSummary; data: OnlineData }) {
  const t = s.totals;
  if (t.orders === 0 && t.notDelivered === 0) {
    const last = data.coverage.last ? istDay(data.coverage.last) : null;
    return (
      <Card title="Nothing in this period">
        <p className="py-4 text-center text-sm text-muted">
          {last
            ? `No online orders between ${fmtDay(s.from)} and ${fmtDay(s.to)}. The latest report covers orders up to ${fmtDay(last)}: pick a longer period.`
            : 'No reports have been read yet. Check email or upload a report above.'}
        </p>
      </Card>
    );
  }
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard label="Orders delivered" value={t.orders.toLocaleString('en-IN')} sub={`${t.notDelivered} not delivered`} />
        <StatCard label="Menu sales" value={inr(t.menuSales)} sub={t.avgBill !== null ? `avg bill ${inr(t.avgBill)}` : undefined} />
        <StatCard label="Discounts you funded" value={inr(t.discount)} sub={`${pct(t.discountShare)} of menu sales`} />
        <StatCard label="Platform fees" value={inr(t.fees)} sub={`${pct(t.feesShare)} · commission, gateway, GST`} />
        <StatCard label="Ads" value={inr(t.ads)} sub="spread over the days billed" />
        <StatCard label="In your bank" value={inr(t.inBank)} sub={`${per100(t.keptPer100)} kept per ₹100 of sales`} />
      </div>

      {s.platforms.length > 1 ? (
        <Card title="By platform">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm">
              <MetricsHead first="Platform" />
              <tbody>
                {s.platforms.map((p) => (s.byPlatform[p] ? <MetricsRow key={p} label={PLATFORM_LABEL[p]} m={s.byPlatform[p] as Metrics} /> : null))}
                <MetricsRow label="Total" m={t} strong />
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Card title={s.group === 'week' ? 'Week by week' : 'Month by month'}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-sm">
            <MetricsHead first={s.group === 'week' ? 'Week' : 'Month'} />
            <tbody>
              {s.buckets.map((b) => (
                <MetricsRow key={b.key} label={b.label} m={b.all} />
              ))}
              <MetricsRow label="Total" m={t} strong />
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-muted">
          Orders are counted in the week or month they were placed. Payout includes refunds and penalties on cancelled
          orders. In your bank is payout minus ads.{t.unsettled > 0 ? ` ${inr(t.unsettled)} was still unsettled when its report was made.` : ''}
        </p>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Bank transfers">
          {s.transfers.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted">
                    <th className={th}>Settled</th>
                    <th className={th}>Platform</th>
                    <th className={th}>UTR</th>
                    <th className={thNum}>Orders</th>
                    <th className={thNum}>Order payouts</th>
                  </tr>
                </thead>
                <tbody>
                  {s.transfers.map((x) => (
                    <tr key={`${x.platform}-${x.utr}`} className="border-t border-[#f2efe9] text-charcoal">
                      <td className={`${td} whitespace-nowrap`}>{fmtDay(x.settlementDate)}</td>
                      <td className={td}>{PLATFORM_LABEL[x.platform]}</td>
                      <td className={`${td} font-mono text-xs`}>{x.utr}</td>
                      <td className={tdNum}>{x.orders}</td>
                      <td className={tdNum}>{inr(x.payout)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">
                Match each UTR with your bank statement. The amount credited is lower by any ads billed in that payout.
              </p>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted">No settled transfers in this period.</p>
          )}
        </Card>

        <Card title="Offers used">
          {s.offers.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-muted">
                    <th className={th}>Offer</th>
                    <th className={thNum}>Orders</th>
                    <th className={thNum}>Discount</th>
                    <th className={thNum}>You keep</th>
                  </tr>
                </thead>
                <tbody>
                  {s.offers.map((o) => (
                    <tr key={`${o.platform}-${o.offer}`} className="border-t border-[#f2efe9] text-charcoal">
                      <td className={td}>
                        {o.offer}
                        {s.platforms.length > 1 ? <span className="ml-1 text-xs text-muted">{PLATFORM_LABEL[o.platform]}</span> : null}
                      </td>
                      <td className={tdNum}>{o.orders}</td>
                      <td className={tdNum}>{pct(o.discountShare)}</td>
                      <td className={tdNum}>{pct(o.payoutShare)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-muted">Discount and payout as a share of menu sales on those orders.</p>
            </div>
          ) : (
            <p className="py-6 text-center text-sm text-muted">No delivered orders in this period.</p>
          )}
        </Card>
      </div>

      <Card title="Orders that went wrong">
        {s.problems.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted">
                  <th className={th}>Placed</th>
                  <th className={th}>Order</th>
                  <th className={th}>Status</th>
                  <th className={th}>Reason</th>
                  <th className={thNum}>Bill</th>
                  <th className={thNum}>Payout</th>
                </tr>
              </thead>
              <tbody>
                {s.problems.map((p) => (
                  <tr key={`${p.platform}-${p.orderId}`} className="border-t border-[#f2efe9] align-top text-charcoal">
                    <td className={`${td} whitespace-nowrap`}>{formatIstDateTime(p.orderedAt)}</td>
                    <td className={`${td} font-mono text-xs`}>
                      {p.orderId}
                      <span className="block font-sans text-muted">{PLATFORM_LABEL[p.platform]}</span>
                    </td>
                    <td className={td}>
                      <Pill tone={p.status === 'cancelled' ? 'muted' : 'bad'}>{p.status.replace('_', ' ')}</Pill>
                    </td>
                    <td className={td}>
                      {p.reason || '—'}
                      {p.stage ? <span className="block text-xs text-muted">{p.stage}</span> : null}
                    </td>
                    <td className={tdNum}>{inr(p.menuSales)}</td>
                    <td className={`${tdNum} ${p.payout < 0 ? 'text-red-700' : ''}`}>{inr(p.payout)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted">
              A negative payout is a penalty (an order not accepted in time, or rejected). A positive one is a refund for a
              cancellation that wasn&rsquo;t your fault.
            </p>
          </div>
        ) : (
          <p className="py-6 text-center text-sm text-muted">Every order in this period was delivered.</p>
        )}
      </Card>
    </>
  );
}

export default async function OwnerOnlineOrdersPage({
  searchParams,
}: {
  searchParams: { range?: string; platform?: string };
}) {
  const range: RangeKey =
    searchParams.range && Object.prototype.hasOwnProperty.call(RANGES, searchParams.range) ? (searchParams.range as RangeKey) : '12w';
  const platform: Platform | 'all' =
    searchParams.platform === 'zomato' || searchParams.platform === 'swiggy' ? searchParams.platform : 'all';
  const { from, to, group } = resolveRange(range, istDateIso());
  const mailbox = mailboxConfigFromEnv();

  let data: OnlineData | null = null;
  try {
    data = await loadOnlineData(createAdminSupabaseClient(), from, to);
  } catch (err) {
    console.error('owner online orders: load failed', err);
  }

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div>
        <h1 className="text-2xl font-bold text-charcoal">Online orders</h1>
        <p className="text-sm text-muted">
          Zomato and Swiggy payouts, read from the settlement reports they email you. {fmtDay(from)} to {fmtDay(to)}.
        </p>
      </div>

      <Filters range={range} platform={platform} />

      {!data ? (
        <Card title="Online orders">
          <p className="py-6 text-center text-sm text-red-700">Online orders could not be loaded. Try again in a minute.</p>
        </Card>
      ) : !data.migrated ? (
        <Card title="One-time setup">
          <p className="text-sm text-charcoal">
            Apply <span className="font-mono">supabase/2026-10-online-settlements.sql</span> in the Supabase SQL editor, then
            come back here. The full setup is in docs/ONLINE-SETTLEMENTS.md.
          </p>
        </Card>
      ) : (
        <>
          <Card title="Reports & email">
            <div className="flex flex-col gap-4">
              <EmailStatus data={data} configured={!!mailbox} mailbox={mailbox ? maskEmail(mailbox.user) : null} />
              <OnlineReportActions configured={!!mailbox} rereadable={data.rereadable} />
            </div>
          </Card>
          <Body s={buildOnlineSummary({ orders: data.orders, deductions: data.deductions, from, to, group, platform })} data={data} />
          <Card title="Reports received">
            <ReportsTable rows={data.reports} />
          </Card>
        </>
      )}
    </div>
  );
}
