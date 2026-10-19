// Owner → Reports → Insights: the loyalty side of the café on one screen for
// any dates — who came back (new vs returning, how often, who is drifting
// away), what Beanies and HIOC Ritual are costing and earning, and which
// coupons and campaigns brought new customers. The numbers come from
// lib/reports/exports (retentionReportsServer, loyaltyReportsServer); each
// section loads on its own, so one failing does not blank the rest, and each
// links to the CSVs behind it (Downloads).

import { istDateDaysAgo, istDateIso } from '@/lib/api/date';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card, inr } from '@/components/owner/dashboard';
import { flags } from '@/lib/flags';
import { beaniesLabel } from '@/lib/loyalty/brand';
import { cupsLabel, PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { parseRange } from '@/lib/reports/reconcile';
import { exportHref, lastDayOfMonth, previousMonth } from '@/lib/reports/exports/period';
import { findReport } from '@/lib/reports/exports/registry';
import { loadProgrammeInsights, type ProgrammeInsights } from '@/lib/reports/exports/loyaltyReportsServer';
import { RENEWAL_WINDOW_DAYS } from '@/lib/reports/exports/loyaltyReports';
import { loadRetentionInsights, type RetentionInsights } from '@/lib/reports/exports/retentionReportsServer';

export const dynamic = 'force-dynamic';

function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function presets(today: string): { label: string; from: string; to: string }[] {
  const [y, m] = today.split('-').map(Number);
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const prevMonthEnd = new Date(Date.UTC(y, m - 1, 0));
  const prevMonthStart = `${prevMonthEnd.toISOString().slice(0, 7)}-01`;
  return [
    { label: 'Last 7 days', from: istDateDaysAgo(6), to: today },
    { label: 'Last 30 days', from: istDateDaysAgo(29), to: today },
    { label: 'This month', from: firstOfMonth, to: today },
    { label: 'Last month', from: prevMonthStart, to: prevMonthEnd.toISOString().slice(0, 10) },
  ];
}

type Loaded<T> = { data: T; error: '' } | { data: null; error: string };

/** A section's data, or the reason it could not load (logged); one failure never takes down the others. */
async function attempt<T>(label: string, run: () => Promise<T>): Promise<Loaded<T>> {
  try {
    return { data: await run(), error: '' };
  } catch (err) {
    console.error(`owner insights page: ${label} failed`, err);
    return { data: null, error: `The ${label} numbers could not be loaded. Please try again.` };
  }
}

/** Alternates the two lists (retention first) so neither crowds the other out. */
function mergeHighlights(a: string[], b: string[], max = 8): string[] {
  const out: string[] = [];
  for (let i = 0; out.length < max && (i < a.length || i < b.length); i += 1) {
    if (i < a.length) out.push(a[i]);
    if (out.length < max && i < b.length) out.push(b[i]);
  }
  return out;
}

const num = (n: number) => n.toLocaleString('en-IN');
const pct = (n: number | null) => (n === null ? '—' : `${n}%`);

export default async function OwnerInsightsPage({ searchParams }: { searchParams: { from?: string; to?: string } }) {
  const today = istDateIso();
  // Opens on the month that just ended, like Downloads.
  const lastMonth = previousMonth(today);
  const asked = Boolean(searchParams.from || searchParams.to);
  const range = asked
    ? parseRange(searchParams.from, searchParams.to, today)
    : parseRange(`${lastMonth}-01`, lastDayOfMonth(lastMonth), today);
  const from = range.ok ? range.from : `${lastMonth}-01`;
  const to = range.ok ? range.to : lastDayOfMonth(lastMonth);
  const label = from === to ? longDate(from) : `${longDate(from)} – ${longDate(to)}`;

  const admin = createAdminSupabaseClient();
  const [retention, programme] = await Promise.all([
    attempt('customer retention', () => loadRetentionInsights(admin, from, to)),
    attempt('Beanies and programme', () => loadProgrammeInsights(admin, from, to)),
  ]);

  const highlights = mergeHighlights(retention.data?.highlights ?? [], programme.data?.highlights ?? []);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Insights</h1>
          <p className="text-sm text-muted">Who comes back, and what Beanies, {PASS_PROGRAM_NAME} and coupons do for it.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href={`/owner/reports?from=${from}&to=${to}`}
            className="rounded-md border border-line bg-white px-4 py-2 text-sm font-bold text-charcoal hover:border-charcoal"
          >
            Reports
          </Link>
          <Link
            href={`/owner/reports/downloads?from=${from}&to=${to}`}
            className="rounded-md border border-line bg-white px-4 py-2 text-sm font-bold text-charcoal hover:border-charcoal"
          >
            Downloads
          </Link>
        </div>
      </div>

      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-white p-4">
        <label className="text-sm">
          <span className="block text-muted">From</span>
          <input type="date" name="from" defaultValue={from} max={today} className="mt-1 min-h-[40px] rounded-md border border-line px-3" />
        </label>
        <label className="text-sm">
          <span className="block text-muted">To</span>
          <input type="date" name="to" defaultValue={to} max={today} className="mt-1 min-h-[40px] rounded-md border border-line px-3" />
        </label>
        <button type="submit" className="min-h-[40px] rounded-md bg-tan-dark px-4 text-sm font-bold text-cream hover:bg-tan-darker">
          Show insights
        </button>
        <div className="flex flex-wrap gap-2">
          {presets(today).map((p) => {
            const active = p.from === from && p.to === to;
            return (
              <Link
                key={p.label}
                href={`/owner/reports/insights?from=${p.from}&to=${p.to}`}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                  active ? 'border-charcoal bg-charcoal text-cream' : 'border-line bg-white text-charcoal'
                }`}
              >
                {p.label}
              </Link>
            );
          })}
        </div>
      </form>

      {!range.ok && asked ? <p className="text-sm text-red-700">{range.message} Showing last month instead.</p> : null}

      <h2 className="text-lg font-bold text-charcoal">{label}</h2>

      <Card title="Highlights">
        {highlights.length > 0 ? (
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-charcoal">
            {highlights.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        ) : retention.error && programme.error ? (
          <p className="text-sm text-red-700">The highlights could not be worked out. Please try again.</p>
        ) : (
          <p className="text-sm text-muted">Nothing stands out for these dates yet. Highlights appear once there are returning customers, Beanies or coupons to compare.</p>
        )}
      </Card>

      <RetentionSection result={retention} from={from} to={to} />
      <BeaniesSection result={programme} from={from} to={to} />
      {flags.coffeePass ? <RitualSection result={programme} from={from} to={to} /> : null}
      <CouponsSection result={retention} from={from} to={to} />
      {flags.marketing ? <CampaignsSection result={programme} from={from} to={to} /> : null}
    </div>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

function RetentionSection({ result, from, to }: { result: Loaded<RetentionInsights>; from: string; to: string }) {
  const r = result.data;
  return (
    <Card title="Customer retention">
      {result.error ? <p className="text-sm text-red-700">{result.error}</p> : null}
      {r ? <RetentionBody r={r} /> : null}
      <Downloads keys={['retention-summary', 'customer-visits', 'cohort-retention']} from={from} to={to} />
    </Card>
  );
}

function RetentionBody({ r }: { r: RetentionInsights }) {
  const k = r.kpis;
  if (k.bills === 0) return <p className="text-sm text-muted">No bills in these dates.</p>;
  const l = r.lifecycle;
  const ret = k.newCustomerReturn;
  const followed = k.bills > 0 ? Math.round((k.trackedBills / k.bills) * 100) : 0;
  const hasCohorts = r.cohorts.some((c) => c.customers > 0);
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Customers" value={num(k.customers)} sub={`${num(k.newCustomers)} new · ${num(k.returningCustomers)} returning`} />
        <Stat label="Repeat rate" value={pct(k.repeatRatePct)} sub={`${num(k.repeatCustomers)} came on 2+ different days`} />
        <Stat
          label="Visits per customer"
          value={k.avgVisitsPerCustomer === null ? '—' : String(k.avgVisitsPerCustomer)}
          sub={k.avgGapDays === null ? 'not enough repeat visits for a usual gap' : `usually every ${k.avgGapDays} days`}
        />
        <Stat label="Avg bill, new" value={k.avgBillNewInr === null ? '—' : inr(k.avgBillNewInr)} sub={`${inr(k.newRevenueInr)} from new customers`} />
        <Stat
          label="Avg bill, returning"
          value={k.avgBillReturningInr === null ? '—' : inr(k.avgBillReturningInr)}
          sub={`${inr(k.returningRevenueInr)} from returning customers`}
        />
        <Stat label="Bills we can follow" value={`${followed}%`} sub={`${num(k.bills - k.trackedBills)} of ${num(k.bills)} bills could not be linked to a customer`} />
      </div>

      <div className="flex flex-col gap-1 text-sm text-charcoal">
        {ret.eligible > 0 ? (
          <p>
            Of {ret.label}’s {num(ret.customers)} new customers, {num(ret.returned)} came back within 30 days
            {ret.pending > 0 ? ` (${num(ret.pending)} more are still inside their first 30 days)` : ''}.
          </p>
        ) : null}
        {k.petpoojaLapsedRegulars !== null && k.petpoojaLapsedRegulars > 0 ? (
          <p>
            {num(k.petpoojaLapsedRegulars)} Petpooja {k.petpoojaLapsedRegulars === 1 ? 'regular' : 'regulars'} (5+ bills) have not visited in 60+
            days and have not ordered in the app.
          </p>
        ) : null}
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Where customers stand at the end of these dates</h3>
        <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <Stat label="New" value={num(l.new)} sub="one bill so far" />
          <Stat label="Active" value={num(l.active)} sub="visiting as usual" />
          <Stat
            label="At risk"
            value={num(l.atRisk)}
            sub={r.atRisk ? `usually every ${r.atRisk.typicalGapDays} days` : 'about to lapse'}
            warn={l.atRisk > 0}
          />
          <Stat label="Lapsed" value={num(l.lapsed)} sub="away longer than usual" />
          <Stat label="Lost" value={num(l.lost)} sub="away for a long time" />
        </div>
        <p className="mt-2 text-xs text-muted">
          Out of {num(l.total)} customers seen in the last 12 months. How soon someone counts as lapsed depends on their own usual
          gap between visits.
        </p>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Monthly cohorts: first-time customers who came back</h3>
        {hasCohorts ? (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[520px] text-sm tabular-nums">
              <thead>
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                  <th className="py-1.5 pr-3">First visit</th>
                  <th className="py-1.5 pr-3 text-right">Customers</th>
                  {[1, 2, 3, 4, 5, 6].map((n) => (
                    <th key={n} className="px-1 py-1.5 text-center">
                      Month {n}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {r.cohorts.map((c) => (
                  <tr key={c.month} className="border-t border-[#f2efe9]">
                    <td className="py-1.5 pr-3 font-semibold text-charcoal">{c.label}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{num(c.customers)}</td>
                    {c.retention.map((v, i) => (
                      <td
                        key={i}
                        title={v === null ? undefined : `${v}% of ${c.label}’s ${c.customers} came back in month ${i + 1}`}
                        className="px-1 py-1.5 text-center font-mono text-charcoal"
                        style={v === null ? undefined : { backgroundColor: cohortShade(v) }}
                      >
                        {v === null ? <span className="text-muted">—</span> : `${v}%`}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted">No first-time customers in the last 12 months yet.</p>
        )}
        <p className="mt-2 text-xs text-muted">
          Month 1 is the share of that month’s first-time customers who came back in the next calendar month, and so on. A dash means
          that month has not finished yet. Only customers the café can follow (an account or a phone number) are counted, and Petpooja
          history is included, so an old regular is not counted as new.
        </p>
      </div>
    </div>
  );
}

/** Tan, darker with the share who came back (60% and over is the darkest); matches the dashboard heatmap. */
function cohortShade(pctValue: number): string {
  const alpha = 0.08 + (Math.min(Math.max(pctValue, 0), 60) / 60) * 0.5;
  return `rgba(173,130,94,${alpha.toFixed(2)})`;
}

function BeaniesSection({ result, from, to }: { result: Loaded<ProgrammeInsights>; from: string; to: string }) {
  const b = result.data?.beanies;
  return (
    <Card title="Beanies">
      {result.error ? <p className="text-sm text-red-700">{result.error}</p> : null}
      {b ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Earned" value={beaniesLabel(b.earnedPoints)} sub={`${num(b.earnedCustomers)} customers`} />
            <Stat label="Redeemed" value={beaniesLabel(b.redeemedPoints)} sub={`${num(b.redeemedCustomers)} customers`} />
            <Stat label="Discount given" value={inr(b.discountGivenInr)} sub={`${num(b.billsWithRedemption)} of ${num(b.validBills)} bills`} />
            <Stat
              label="Avg bill with Beanies"
              value={b.avgBillWithRedemptionInr === null ? '—' : inr(b.avgBillWithRedemptionInr)}
              sub={b.avgBillWithoutRedemptionInr === null ? 'no bills without' : `vs ${inr(b.avgBillWithoutRedemptionInr)} without`}
            />
            <Stat
              label="Outstanding at the end"
              value={inr(b.outstandingValueInr)}
              sub={`${beaniesLabel(b.outstandingPoints)} · ${num(b.holders)} customers`}
            />
            <Stat
              label="Expire in 7 days"
              value={beaniesLabel(b.expiring7.points)}
              sub={`${inr(b.expiring7.valueInr)} · ${num(b.expiring7.customers)} customers`}
              warn={b.expiring7.points > 0}
            />
            <Stat
              label="Expire in 30 days"
              value={beaniesLabel(b.expiring30.points)}
              sub={`${inr(b.expiring30.valueInr)} · ${num(b.expiring30.customers)} customers`}
            />
            <Stat label="Active members" value={num(b.activeMembers)} sub="earned or redeemed" />
          </div>
          <p className="mt-3 text-xs text-muted">
            Outstanding is what customers held at the end of these dates, valued at ₹{b.inrPerPoint} a Beanie: what the café owes if
            all of it is redeemed. The expiring figures are as of today, not the end of the dates. {beaniesLabel(b.expiredPoints)}{' '}
            expired in these dates.
          </p>
        </>
      ) : null}
      <Downloads keys={['beanies-summary', 'beanies-ledger', 'beanies-customers']} from={from} to={to} />
    </Card>
  );
}

function RitualSection({ result, from, to }: { result: Loaded<ProgrammeInsights>; from: string; to: string }) {
  const p = result.data;
  const r = p?.ritual ?? null;
  const problem = result.error || p?.problems.ritual || '';
  return (
    <Card title={PASS_PROGRAM_NAME}>
      {problem ? <p className="text-sm text-red-700">{problem}</p> : null}
      {p && !r && !problem ? <p className="text-sm text-muted">No {PASS_PROGRAM_NAME} passes to report yet.</p> : null}
      {r ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat
              label="Passes sold"
              value={num(r.soldCount)}
              sub={`${inr(r.soldInr)}${r.refundedCount > 0 ? ` · ${num(r.refundedCount)} refunded` : ''}`}
            />
            <Stat label="Cups served" value={num(r.cupsServed)} sub={`${inr(r.coveredInr)} covered · ${num(r.holdersServed)} holders`} />
            <Stat label="Buyers" value={num(r.uniqueBuyers)} sub={`${num(r.repeatBuyers)} have bought more than one`} />
            <Stat
              label="Renewal rate"
              value={pct(r.renewalRatePct)}
              sub={r.endedPasses > 0 ? `${num(r.renewedPasses)} of ${num(r.endedPasses)} ended passes, within ${RENEWAL_WINDOW_DAYS} days` : 'no pass has ended yet'}
            />
            <Stat
              label="Visits per holder"
              value={r.visitsPerHolder === null ? '—' : String(r.visitsPerHolder)}
              sub={`${num(r.ritualBills)} ${PASS_PROGRAM_NAME} bills`}
            />
            <Stat label="Extra spend" value={inr(r.extraSpendInr)} sub="on those bills, on top of the cups" />
            <Stat
              label="Owed at the end"
              value={inr(r.liabilityAtEndInr)}
              sub={`${cupsLabel(r.cupsOutstandingAtEnd)} still to serve`}
            />
            <Stat label="Expired unused" value={inr(r.breakageInr)} sub={cupsLabel(r.breakageCups)} />
          </div>
          {r.avgDaysToFirstCup !== null ? (
            <p className="mt-3 text-sm text-charcoal">
              Buyers have their first cup {r.avgDaysToFirstCup} {r.avgDaysToFirstCup === 1 ? 'day' : 'days'} after buying, on average.
            </p>
          ) : null}
          {r.soldByPlan.length > 0 ? (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[320px] text-sm tabular-nums">
                <thead>
                  <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                    <th className="py-1.5 pr-3">Plan</th>
                    <th className="py-1.5 pr-3 text-right">Sold</th>
                    <th className="py-1.5 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {r.soldByPlan.map((s) => (
                    <tr key={s.plan_name} className="border-t border-[#f2efe9]">
                      <td className="py-1.5 pr-3 font-semibold text-charcoal">{s.plan_name}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{num(s.count)}</td>
                      <td className="py-1.5 text-right font-mono">{inr(s.inr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
      <Downloads keys={['ritual-summary', 'ritual-passes', 'ritual-redemptions']} from={from} to={to} />
    </Card>
  );
}

function CouponsSection({ result, from, to }: { result: Loaded<RetentionInsights>; from: string; to: string }) {
  const coupons = result.data?.coupons;
  return (
    <Card title="Coupons & promotions">
      {result.error ? <p className="text-sm text-red-700">{result.error}</p> : null}
      {coupons && coupons.length === 0 ? <p className="text-sm text-muted">No coupon was used on a valid bill in these dates.</p> : null}
      {coupons && coupons.length > 0 ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm tabular-nums">
              <thead>
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                  <th className="py-1.5 pr-3">Coupon / campaign</th>
                  <th className="py-1.5 pr-3 text-right">Uses</th>
                  <th className="py-1.5 pr-3 text-right">Customers</th>
                  <th className="py-1.5 pr-3 text-right">New</th>
                  <th className="py-1.5 pr-3 text-right">Discount</th>
                  <th className="py-1.5 pr-3 text-right">Bills</th>
                  <th className="py-1.5 pr-3 text-right">Discount %</th>
                  <th className="py-1.5 text-right">Per new customer</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr key={c.label} className="border-t border-[#f2efe9]">
                    <td className="py-1.5 pr-3 font-semibold text-charcoal">{c.label}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{num(c.redemptions)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{num(c.uniqueCustomers)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{num(c.newCustomers)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{inr(c.discountInr)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{inr(c.billTotalInr)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{pct(c.discountPct)}</td>
                    <td className="py-1.5 text-right font-mono">{c.costPerNewCustomerInr === null ? '—' : inr(c.costPerNewCustomerInr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted">
            The most used first. A marketing campaign’s codes are added together. A new customer is one whose first visit ever was on the
            coupon’s bill. Cancelled bills are left out; the download has every coupon.
          </p>
        </>
      ) : null}
      <Downloads keys={['coupon-performance', 'coupon-redemptions']} from={from} to={to} />
    </Card>
  );
}

function CampaignsSection({ result, from, to }: { result: Loaded<ProgrammeInsights>; from: string; to: string }) {
  const p = result.data;
  const c = p?.campaigns ?? null;
  const problem = result.error || p?.problems.campaigns || '';
  return (
    <Card title="Marketing campaigns">
      {problem ? <p className="text-sm text-red-700">{problem}</p> : null}
      {p && !c && !problem ? <p className="text-sm text-muted">No marketing campaign data yet.</p> : null}
      {c && c.campaigns.length === 0 ? <p className="text-sm text-muted">No campaign was sending in these dates.</p> : null}
      {c && c.campaigns.length > 0 ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Messages sent" value={num(c.totals.sent)} sub={`${num(c.totals.delivered)} delivered · ${num(c.totals.read)} read`} />
            <Stat label="Came back" value={num(c.totals.conversions)} sub={`${pct(c.totals.conversionPct)} of those sent`} />
            <Stat label="Revenue" value={inr(c.totals.revenueInr)} sub="from customers who came back" />
            <Stat label="Cost" value={inr(c.totals.costInr)} sub={`${inr(c.totals.couponDiscountInr)} coupon discount`} />
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm tabular-nums">
              <thead>
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                  <th className="py-1.5 pr-3">Campaign</th>
                  <th className="py-1.5 pr-3 text-right">Sent</th>
                  <th className="py-1.5 pr-3 text-right">Read</th>
                  <th className="py-1.5 pr-3 text-right">Came back</th>
                  <th className="py-1.5 pr-3 text-right">Rate</th>
                  <th className="py-1.5 pr-3 text-right">Revenue</th>
                  <th className="py-1.5 pr-3 text-right">Lift</th>
                  <th className="py-1.5 text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {c.campaigns.map((x) => (
                  <tr key={`${x.name}-${x.startedAt ?? ''}`} className="border-t border-[#f2efe9]">
                    <td className="py-1.5 pr-3">
                      <span className="font-semibold text-charcoal">{x.name}</span>
                      <span className="block text-xs text-muted">{x.kind}</span>
                    </td>
                    <td className="py-1.5 pr-3 text-right font-mono">{num(x.sent)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{num(x.read)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{num(x.conversions)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{pct(x.conversionPct)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{inr(x.revenueInr)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono">{x.liftPp === null ? '—' : `${x.liftPp > 0 ? '+' : ''}${x.liftPp} pp`}</td>
                    <td className="py-1.5 text-right font-mono">{inr(x.costInr)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-muted">
            Results are for each campaign’s whole run so far. Lift is how many percentage points more of the customers messaged came back
            than the holdout group that was not messaged; a dash means the holdout is too small to say.
          </p>
        </>
      ) : null}
      <Downloads keys={['campaign-performance']} from={from} to={to} />
    </Card>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** "Download CSV" links to a section's sheets. A sheet missing from the registry (its flag is off) is left out. */
function Downloads({ keys, from, to }: { keys: string[]; from: string; to: string }) {
  const reports = keys.map((k) => findReport(k)).filter((r): r is NonNullable<typeof r> => Boolean(r));
  if (reports.length === 0) return null;
  return (
    <ul className="mt-4 flex flex-wrap gap-2 border-t border-[#f2efe9] pt-3">
      {reports.map((r) => (
        <li key={r.key}>
          <a
            href={exportHref(r.key, from, to)}
            className="inline-flex min-h-[40px] items-center gap-1.5 rounded-md border border-line bg-white px-3 text-xs hover:border-charcoal"
          >
            <span className="font-bold text-charcoal">Download CSV</span>
            <span className="text-muted">{r.title}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub: string; warn?: boolean }) {
  return (
    <div className={`rounded-md border p-4 shadow-sm ${warn ? 'border-amber-300 bg-amber-50' : 'border-line bg-cream'}`}>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-charcoal">{value}</p>
      <p className="text-xs text-muted">{sub}</p>
    </div>
  );
}
