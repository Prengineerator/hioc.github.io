// Owner → Reports → Items & custom — the screen (app/owner/reports/sales/page.tsx
// loads the data and hands it here). A server component: a plain GET form, so
// the whole setup lives in the URL and the page works without JavaScript; only
// "My reports" (saved views) runs in the browser.

import { istDateDaysAgo } from '@/lib/api/date';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { inr } from '@/components/owner/dashboard';
import { ReportsNav } from '@/components/owner/ReportsNav';
import { SavedReportViews } from '@/components/owner/SavedReportViews';
import {
  DIMENSIONS,
  METRICS,
  PRESETS,
  SORTS,
  TOP_CHOICES,
  WEEKDAY_LABELS,
  activeFilterCount,
  changePct,
  explorerParams,
  hourLabel,
  matchingPreset,
  presetQuery,
  type ExplorerQuery,
  type ExplorerResult,
  type FilterOptions,
  type Metric,
} from '@/lib/reports/salesExplorer';

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function datePresets(today: string): { label: string; from: string; to: string }[] {
  const [y, m] = today.split('-').map(Number);
  const prevMonthEnd = new Date(Date.UTC(y, m - 1, 0));
  return [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: istDateDaysAgo(1), to: istDateDaysAgo(1) },
    { label: 'Last 7 days', from: istDateDaysAgo(6), to: today },
    { label: 'Last 30 days', from: istDateDaysAgo(29), to: today },
    { label: 'This month', from: `${today.slice(0, 7)}-01`, to: today },
    { label: 'Last month', from: `${prevMonthEnd.toISOString().slice(0, 7)}-01`, to: prevMonthEnd.toISOString().slice(0, 10) },
  ];
}

const num = (n: number) => n.toLocaleString('en-IN');
function fmt(m: Metric, v: number): string {
  return m === 'qty' || m === 'orders' ? num(Math.round(v)) : inr(v);
}

export interface SalesReportViewProps {
  today: string;
  from: string;
  to: string;
  /** The dates asked for were refused (shown, with what is shown instead). */
  rangeMessage: string | null;
  query: ExplorerQuery;
  result: ExplorerResult | null;
  options: FilterOptions | null;
  loadError: string;
  before: { from: string; to: string };
}

export function SalesReportView({ today, from, to, rangeMessage, query, result, options, loadError, before }: SalesReportViewProps) {
  const setup = explorerParams(query).toString();
  const label = from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;
  const withSetup = (f: string, t: string, s: string = setup) => `/owner/reports/sales?from=${f}&to=${t}${s ? `&${s}` : ''}`;
  const csvHref = `/api/owner/reports/sales?from=${from}&to=${to}${setup ? `&${setup}` : ''}`;
  const presetOn = matchingPreset(query);

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <ReportsNav active="sales" from={from} to={to} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Items &amp; custom reports</h1>
          <p className="text-sm text-muted">What sold, and any other way you want to cut the sales.</p>
        </div>
        <a
          href={csvHref}
          className="rounded-md border border-line bg-white px-4 py-2 text-sm font-bold text-charcoal hover:border-charcoal"
        >
          Download CSV
        </a>
      </div>

      {/* Dates — the setup rides along as hidden fields. */}
      <form method="get" className="flex flex-wrap items-end gap-3 rounded-md border border-line bg-white p-4">
        <label className="text-sm">
          <span className="block text-muted">From</span>
          <input type="date" name="from" defaultValue={from} max={today} className="mt-1 min-h-[40px] rounded-md border border-line px-3" />
        </label>
        <label className="text-sm">
          <span className="block text-muted">To</span>
          <input type="date" name="to" defaultValue={to} max={today} className="mt-1 min-h-[40px] rounded-md border border-line px-3" />
        </label>
        <HiddenSetup setup={setup} />
        <button type="submit" className="min-h-[40px] rounded-md bg-tan-dark px-4 text-sm font-bold text-cream hover:bg-tan-darker">
          Show
        </button>
        <div className="flex flex-wrap gap-2">
          {datePresets(today).map((p) => {
            const active = p.from === from && p.to === to;
            return (
              <Link
                key={p.label}
                href={withSetup(p.from, p.to)}
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
      {rangeMessage ? <p className="text-sm text-red-700">{rangeMessage} Showing the last 7 days instead.</p> : null}

      {/* Ready-made reports, then the owner's own. */}
      <section className="flex flex-col gap-3 rounded-md border border-line bg-white p-4">
        <h2 className="text-xs font-bold uppercase tracking-wide text-muted">Reports</h2>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Link
              key={p.id}
              href={withSetup(from, to, explorerParams(presetQuery(p)).toString())}
              title={p.description}
              aria-current={presetOn === p.id ? 'true' : undefined}
              className={`rounded-md border px-3 py-2 text-sm font-bold ${
                presetOn === p.id ? 'border-charcoal bg-charcoal text-cream' : 'border-line bg-white text-charcoal hover:border-charcoal'
              }`}
            >
              {p.label}
            </Link>
          ))}
        </div>
        <div className="border-t border-line pt-3">
          <SavedReportViews params={setup} from={from} to={to} />
        </div>
      </section>

      {/* Open when the report on screen is not one of the ready-made ones (or
          has filters on): the owner is building, so show the controls.
          Otherwise folded, so the numbers are near the top. */}
      <details
        open={presetOn === null || activeFilterCount(query.filters) > 0}
        className="rounded-md border border-line bg-white"
      >
        <summary className="flex min-h-[48px] cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 text-sm">
          <span className="font-bold text-charcoal">Customise</span>
          <span className="text-muted">{setupSummary(query)}</span>
        </summary>
        <div className="border-t border-line">
          <Builder query={query} from={from} to={to} options={options} />
        </div>
      </details>

      {loadError ? <p className="text-sm text-red-700">{loadError}</p> : null}
      {result ? <Results result={result} label={label} before={before} /> : null}

      <p className="text-xs text-muted">
        <strong>Sales</strong> is each item at its menu price, before discounts. <strong>Net sales</strong> is what the
        bills came to — after coupons, Beanies and offers, with GST and packaging, less settle discounts — shared across
        each bill&apos;s items by their menu price; over everything it is the Overview&apos;s Net sales. Cancelled and
        rejected bills are left out; a sale is dated by the day it was placed (IST).
      </p>
    </div>
  );
}


/** "Item · split by hour · top 25 · 2 filters · compared" — what the Customise panel holds, folded. */
function setupSummary(q: ExplorerQuery): string {
  const dim = (k: string) => DIMENSIONS.find((d) => d.key === k)!.label;
  const filters = activeFilterCount(q.filters);
  return [
    `Rows: ${dim(q.rows)}`,
    q.split ? `split by ${dim(q.split).toLowerCase()}` : null,
    q.top ? `top ${q.top}` : null,
    q.sort !== 'default' ? `sorted by ${SORTS.find((x) => x.key === q.sort)!.label.toLowerCase()}` : null,
    filters ? `${filters} filter${filters === 1 ? '' : 's'}` : null,
    q.compare ? 'compared with before' : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** The setup as hidden inputs, so changing the dates keeps it. */
function HiddenSetup({ setup }: { setup: string }) {
  return (
    <>
      {[...new URLSearchParams(setup)].map(([k, v], i) => (
        <input key={`${k}-${i}`} type="hidden" name={k} value={v} />
      ))}
    </>
  );
}

const selectCls = 'mt-1 min-h-[40px] w-full rounded-md border border-line bg-white px-2 text-sm';

function Builder({ query, from, to, options }: { query: ExplorerQuery; from: string; to: string; options: FilterOptions | null }) {
  const f = query.filters;
  const filters = activeFilterCount(f);
  return (
    <form method="get" className="flex flex-col gap-4 p-4">
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="to" value={to} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <label className="text-sm">
          <span className="block text-muted">Rows</span>
          <select name="rows" defaultValue={query.rows} className={selectCls}>
            {DIMENSIONS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-muted">Split by</span>
          <select name="split" defaultValue={query.split ?? ''} className={selectCls}>
            <option value="">Nothing</option>
            {DIMENSIONS.map((d) => (
              <option key={d.key} value={d.key}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-muted">Grid shows</span>
          <select name="cell" defaultValue={query.cell} className={selectCls}>
            {METRICS.map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-muted">Sort by</span>
          <select name="sort" defaultValue={query.sort} className={selectCls}>
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-muted">Show</span>
          <select name="top" defaultValue={query.top ? String(query.top) : ''} className={selectCls}>
            <option value="">All rows</option>
            {TOP_CHOICES.map((n) => (
              <option key={n} value={n}>
                Top {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-end gap-2 pb-2 text-sm font-semibold text-charcoal">
          <input type="checkbox" name="compare" value="1" defaultChecked={query.compare} className="h-5 w-5" />
          Compare with the period before
        </label>
      </div>

      <details open={filters > 0} className="rounded-md border border-line">
        <summary className="flex min-h-[44px] cursor-pointer items-center px-3 text-sm font-bold text-charcoal">
          Filters{filters ? ` (${filters} on)` : ''}
        </summary>
        <div className="grid gap-4 border-t border-line p-3 md:grid-cols-2 lg:grid-cols-3">
          <label className="text-sm">
            <span className="block text-muted">Item or size contains</span>
            <input name="q" defaultValue={f.search} placeholder="e.g. latte" className="mt-1 min-h-[40px] w-full rounded-md border border-line px-3" />
          </label>
          <div className="flex gap-3 text-sm">
            <label className="flex-1">
              <span className="block text-muted">From hour</span>
              <select name="hourFrom" defaultValue={f.hourFrom === null ? '' : String(f.hourFrom)} className={selectCls}>
                <option value="">Any</option>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex-1">
              <span className="block text-muted">To hour</span>
              <select name="hourTo" defaultValue={f.hourTo === null ? '' : String(f.hourTo)} className={selectCls}>
                <option value="">Any</option>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {hourLabel(h)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <Checks title="Days of week" name="weekday" choices={WEEKDAY_LABELS.map((l, i) => ({ key: String(i), label: l }))} picked={f.weekdays.map(String)} />
          {options ? (
            <>
              <Checks title="Category" name="category" choices={options.categories.map((c) => ({ key: c, label: c }))} picked={f.categories} />
              <Checks title="Channel" name="channel" choices={options.channels} picked={f.channels} />
              <Checks title="Order type" name="type" choices={options.orderTypes} picked={f.orderTypes} />
              <Checks title="Payment" name="payment" choices={options.payments} picked={f.payments} />
              <Checks title="Staff" name="staff" choices={options.staff.map((s) => ({ key: s, label: s }))} picked={f.staff} />
            </>
          ) : null}
        </div>
      </details>

      <div className="flex flex-wrap gap-2">
        <button type="submit" className="min-h-[44px] rounded-md bg-tan-dark px-5 text-sm font-bold text-cream hover:bg-tan-darker">
          Apply
        </button>
        <Link
          href={`/owner/reports/sales?from=${from}&to=${to}`}
          className="flex min-h-[44px] items-center rounded-md border border-line px-4 text-sm font-bold text-charcoal hover:border-charcoal"
        >
          Reset
        </Link>
      </div>
    </form>
  );
}

function Checks({
  title,
  name,
  choices,
  picked,
}: {
  title: string;
  name: string;
  choices: { key: string; label: string }[];
  picked: string[];
}) {
  if (choices.length === 0) return null;
  return (
    <fieldset className="text-sm">
      <legend className="text-muted">{title}</legend>
      <div className="mt-1 flex max-h-40 flex-wrap gap-x-3 gap-y-1 overflow-y-auto">
        {choices.map((c) => (
          <label key={c.key} className="flex min-h-[32px] items-center gap-1.5 text-charcoal">
            <input type="checkbox" name={name} value={c.key} defaultChecked={picked.includes(c.key)} className="h-4 w-4" />
            {c.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function Change({ now, prev }: { now: number; prev: number }) {
  const pct = changePct(now, prev);
  if (pct === null) return <span className="text-xs font-bold text-green-700">new</span>;
  if (pct === 0) return <span className="text-xs text-muted">same</span>;
  const up = pct > 0;
  return (
    <span className={'text-xs font-bold ' + (up ? 'text-green-700' : 'text-red-700')}>
      <span aria-hidden>{up ? '▲' : '▼'}</span>
      <span className="sr-only">{up ? 'up' : 'down'}</span> {Math.abs(pct)}%
    </span>
  );
}

function Results({ result, label, before }: { result: ExplorerResult; label: string; before: { from: string; to: string } }) {
  const { totals: t, prevTotals: p } = result;
  const dimLabel = DIMENSIONS.find((d) => d.key === result.query.rows)!.label;
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold text-charcoal">{label}</h2>
        {p ? (
          <p className="text-xs text-muted">
            Compared with {shortDate(before.from)}
            {before.from === before.to ? '' : ` – ${shortDate(before.to)}`}
          </p>
        ) : null}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Net sales" value={inr(t.netInr)} change={p ? <Change now={t.netInr} prev={p.netInr} /> : null} />
        <Tile label="Items sold" value={num(t.qty)} change={p ? <Change now={t.qty} prev={p.qty} /> : null} />
        <Tile label="Bills" value={num(t.orders)} change={p ? <Change now={t.orders} prev={p.orders} /> : null} />
        <Tile label="Average bill" value={inr(t.avgBillInr)} change={p ? <Change now={t.avgBillInr} prev={p.avgBillInr} /> : null} />
      </div>

      {result.rows.length === 0 ? (
        <p className="rounded-md border border-line bg-cream p-6 text-center text-sm text-muted">
          No sales on these dates with these filters.
        </p>
      ) : result.query.split ? (
        <Grid result={result} dimLabel={dimLabel} />
      ) : (
        <Table result={result} dimLabel={dimLabel} />
      )}
      {result.rowCount > result.rows.length ? (
        <p className="text-xs text-muted">
          Showing the top {result.rows.length} of {result.rowCount}. The totals are for all of them.
        </p>
      ) : null}
    </>
  );
}

function Tile({ label, value, change }: { label: string; value: string; change: React.ReactNode }) {
  return (
    <div className="rounded-md border border-line bg-cream p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold tabular-nums text-charcoal">{value}</p>
      {change ? <p className="mt-0.5">{change} <span className="text-xs text-muted">vs before</span></p> : null}
    </div>
  );
}

function Table({ result, dimLabel }: { result: ExplorerResult; dimLabel: string }) {
  const comparing = Boolean(result.prevTotals) && result.query.rows !== 'day';
  const t = result.totals;
  const avgHeader = result.avgKind === 'price' ? 'Avg price' : 'Avg per bill';
  const maxShare = Math.max(...result.rows.map((r) => r.sharePct), 1);
  const th = 'py-2 pr-3 text-right';
  return (
    <div className="overflow-x-auto rounded-md border border-line bg-cream">
      <table className="w-full min-w-[760px] text-sm tabular-nums">
        <thead>
          <tr className="border-b border-line text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
            <th className="w-10 py-2 pl-3 pr-2 text-right">#</th>
            <th className="py-2 pr-3">{dimLabel}</th>
            <th className={th}>Qty</th>
            <th className={th}>Bills</th>
            <th className={th}>Sales</th>
            <th className={th}>Net sales</th>
            <th className={th}>{avgHeader}</th>
            <th className="w-44 py-2 pr-3">Share of net</th>
            {comparing ? <th className={th}>vs before</th> : null}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((r, i) => (
            <tr key={r.key} className="border-t border-[#f2efe9]">
              <td className="py-2 pl-3 pr-2 text-right text-xs text-muted">{i + 1}</td>
              <td className="py-2 pr-3 font-semibold text-charcoal">{r.label}</td>
              <td className="py-2 pr-3 text-right">{num(r.qty)}</td>
              <td className="py-2 pr-3 text-right">{num(r.orders)}</td>
              <td className="py-2 pr-3 text-right">{inr(r.salesInr)}</td>
              <td className="py-2 pr-3 text-right font-semibold">{inr(r.netInr)}</td>
              <td className="py-2 pr-3 text-right">{inr(r.avgInr)}</td>
              <td className="py-2 pr-3">
                <div className="flex items-center gap-2">
                  <div className="h-2 flex-1 overflow-hidden rounded-full bg-[#f2efe9]">
                    <div className="h-full bg-tan" style={{ width: `${(r.sharePct / maxShare) * 100}%` }} />
                  </div>
                  <span className="w-12 text-right text-xs text-muted">{r.sharePct}%</span>
                </div>
              </td>
              {comparing ? (
                <td className="py-2 pr-3 text-right">
                  <Change now={r.netInr} prev={r.prev?.netInr ?? 0} />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line font-bold text-charcoal">
            <td />
            <td className="py-2 pr-3">Total{result.rowCount > result.rows.length ? ` (all ${result.rowCount})` : ''}</td>
            <td className="py-2 pr-3 text-right">{num(t.qty)}</td>
            <td className="py-2 pr-3 text-right">{num(t.orders)}</td>
            <td className="py-2 pr-3 text-right">{inr(t.salesInr)}</td>
            <td className="py-2 pr-3 text-right">{inr(t.netInr)}</td>
            <td className="py-2 pr-3 text-right">
              {inr(result.avgKind === 'price' ? (t.qty > 0 ? t.salesInr / t.qty : 0) : t.avgBillInr)}
            </td>
            <td className="py-2 pr-3 text-xs text-muted">{t.netInr > 0 ? '100%' : '—'}</td>
            {comparing ? (
              <td className="py-2 pr-3 text-right">
                <Change now={t.netInr} prev={result.prevTotals!.netInr} />
              </td>
            ) : null}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/** Rows × split columns, cells shaded by size: what sells when (or where, or by whom). */
function Grid({ result, dimLabel }: { result: ExplorerResult; dimLabel: string }) {
  const cell = result.query.cell;
  const splitLabel = DIMENSIONS.find((d) => d.key === result.query.split)!.label;
  const metricLabel = METRICS.find((m) => m.key === cell)!.label;
  const rowTotal = (r: ExplorerResult['rows'][number]) =>
    cell === 'qty' ? r.qty : cell === 'sales' ? r.salesInr : cell === 'net' ? r.netInr : r.orders;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted">
        {dimLabel} by {splitLabel.toLowerCase()} · {metricLabel.toLowerCase()} in each cell — darker is more.
      </p>
      <div className="overflow-x-auto rounded-md border border-line bg-cream">
        <table className="w-full text-sm tabular-nums">
          <thead>
            <tr className="border-b border-line text-[10px] font-semibold uppercase tracking-wide text-muted">
              <th className="sticky left-0 z-10 bg-cream py-2 pl-3 pr-3 text-left">{dimLabel}</th>
              {result.columns.map((c) => (
                <th key={c.key} className="whitespace-nowrap px-2 py-2 text-right">
                  {c.label}
                </th>
              ))}
              <th className="py-2 pl-2 pr-3 text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {result.rows.map((r) => (
              <tr key={r.key} className="border-t border-[#f2efe9]">
                <th scope="row" className="sticky left-0 z-10 max-w-[220px] truncate bg-cream py-1.5 pl-3 pr-3 text-left font-semibold text-charcoal">
                  {r.label}
                </th>
                {result.columns.map((c) => {
                  const v = r.cells?.[c.key] ?? 0;
                  const alpha = result.maxCell > 0 ? v / result.maxCell : 0;
                  return (
                    <td
                      key={c.key}
                      className="whitespace-nowrap px-2 py-1.5 text-right"
                      // Brand tan (#ad825e), never so dark that the charcoal figure loses contrast.
                      style={v > 0 ? { backgroundColor: `rgba(173, 130, 94, ${0.08 + alpha * 0.5})` } : undefined}
                    >
                      {v > 0 ? fmt(cell, v) : <span className="text-muted">·</span>}
                    </td>
                  );
                })}
                <td className="py-1.5 pl-2 pr-3 text-right font-bold text-charcoal">{fmt(cell, rowTotal(r))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
