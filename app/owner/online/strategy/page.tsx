// Owner → Online orders → Strategy: the Zomato scorecard, recomputed from the
// settlement reports on every visit, so it updates itself when a new weekly
// report is read. Server component in the style of app/owner/online/page.tsx;
// all the math and the targets are in lib/online-settlements/strategy.ts.

import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card, inr } from '@/components/owner/dashboard';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { loadStrategyData, type StrategyData } from '@/lib/online-settlements/loadStrategy';
import { buildStrategy, type Anatomy, type KpiResult, type KpiStatus, type StrategyResult } from '@/lib/online-settlements/strategy';

export const dynamic = 'force-dynamic';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-11-22' → '22 Nov 2026'; without the year when `withYear` is false. */
function fmtDay(day: string, withYear = true): string {
  return `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}${withYear ? ` ${day.slice(0, 4)}` : ''}`;
}

/** '26 Oct to 22 Nov 2026', or with both years when the window spans New Year. */
function windowWords(from: string, to: string): string {
  return `${fmtDay(from, from.slice(0, 4) !== to.slice(0, 4))} to ${fmtDay(to)}`;
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const inrOrDash = (x: number | null) => (x === null ? '—' : inr(x));

function fmtKpi(unit: KpiResult['unit'], v: number | null): string {
  if (v === null) return '—';
  if (unit === 'percent') return pct(v);
  if (unit === 'inr') return inr(v);
  return v.toLocaleString('en-IN', { maximumFractionDigits: 1 });
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

const STATUS: Record<KpiStatus, { tone: 'ok' | 'warn' | 'bad'; label: string }> = {
  met: { tone: 'ok', label: 'Met' },
  close: { tone: 'warn', label: 'Close' },
  off: { tone: 'bad', label: 'Off target' },
};

const th = 'py-1.5 pr-3';
const thNum = 'py-1.5 pr-3 text-right';
const td = 'py-1.5 pr-3';
const tdNum = 'py-1.5 pr-3 text-right tabular-nums';

function Scorecard({ s }: { s: StrategyResult }) {
  return (
    <Card title="Scorecard">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className={th}>Measure</th>
              <th className={thNum}>Last 4 weeks</th>
              <th className={thNum}>4 weeks before</th>
              <th className={thNum}>Target</th>
              <th className={th}>Status</th>
            </tr>
          </thead>
          <tbody>
            {s.kpis.map((k) => (
              <tr key={k.key} className="border-t border-[#f2efe9] text-charcoal">
                <td className={td}>{k.label}</td>
                <td className={`${tdNum} font-bold`}>{fmtKpi(k.unit, k.current)}</td>
                <td className={tdNum}>{fmtKpi(k.unit, k.previous)}</td>
                <td className={`${tdNum} whitespace-nowrap`}>
                  {k.direction === 'min' ? 'at least ' : 'at most '}
                  {fmtKpi(k.unit, k.target)}
                </td>
                <td className={td}>
                  <Pill tone={STATUS[k.status].tone}>{STATUS[k.status].label}</Pill>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">Close means within 5% of the target on the wrong side.</p>
    </Card>
  );
}

function Actions({ s }: { s: StrategyResult }) {
  return (
    <Card title="What to do next">
      <ol className="flex flex-col gap-3 text-sm text-charcoal">
        {s.actions.map((a) => (
          <li key={a.key}>
            <p className="font-bold">{a.title}</p>
            <p>{a.detail}</p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** One line of the order anatomy: `sign` says whether it adds to or comes off the payout. */
function anatomyLines(a: Anatomy): { label: string; value: number; sign: '+' | '−' | '='; note?: string }[] {
  return [
    { label: 'Menu sales', value: a.menu, sign: '+' },
    { label: 'Packaging', value: a.packaging, sign: '+' },
    { label: 'Discount you fund', value: a.discount, sign: '−' },
    { label: 'Platform fees', value: a.platformFees, sign: '−', note: 'commission, payment fee and GST on both' },
    { label: 'Tax withheld', value: a.taxWithheld, sign: '−', note: 'TCS and TDS' },
    { label: 'Marketing: sales-linked fee (Grow Maxx)', value: a.marketingSalesLinked, sign: '−' },
    { label: 'Marketing: fixed-budget ads', value: a.marketingFixed, sign: '−' },
    {
      label: 'Everything else',
      value: Math.abs(a.other),
      sign: a.other < 0 ? '−' : '+',
      note: 'GST from the customer and paid on your behalf, refunds, adjustments',
    },
    { label: 'In your bank', value: a.inBank, sign: '=' },
  ];
}

function AnatomyCard({ a }: { a: Anatomy }) {
  const lines = anatomyLines(a);
  return (
    <Card title="An average order">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className={th}>Per delivered order</th>
              <th className={thNum}>Amount</th>
              <th className={`${th} w-1/3`}>
                <span className="sr-only">Share of the menu price</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const width = a.menu > 0 ? Math.min(100, (Math.abs(l.value) / a.menu) * 100) : 0;
              const bar = l.sign === '=' ? 'bg-green-700' : l.sign === '−' ? 'bg-red-700' : 'bg-tan-dark';
              return (
                <tr key={l.label} className={`border-t border-[#f2efe9] text-charcoal ${l.sign === '=' ? 'font-bold' : ''}`}>
                  <td className={td}>
                    {l.label}
                    {l.note ? <span className="block text-xs font-normal text-muted">{l.note}</span> : null}
                  </td>
                  <td className={`${tdNum} whitespace-nowrap`}>
                    {l.sign === '−' ? '− ' : l.sign === '=' ? '= ' : ''}
                    {`₹${Math.abs(l.value).toFixed(2)}`}
                  </td>
                  <td className={td}>
                    <div className="h-2 w-full rounded bg-[#f2efe9]" aria-hidden="true">
                      <div className={`h-2 rounded ${bar}`} style={{ width: `${width}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">Bars are drawn against the menu price. Last 4 weeks, delivered orders.</p>
    </Card>
  );
}

function Ladder({ s }: { s: StrategyResult }) {
  return (
    <Card title="Offers used">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[520px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className={th}>Offer minimum order</th>
              <th className={thNum}>Orders</th>
              <th className={thNum}>Share</th>
              <th className={thNum}>Average bill</th>
              <th className={thNum}>Discount</th>
              <th className={thNum}>You get per order</th>
            </tr>
          </thead>
          <tbody>
            {s.ladder.map((t) => (
              <tr key={t.key} className="border-t border-[#f2efe9] text-charcoal">
                <td className={td}>{t.label}</td>
                <td className={tdNum}>{t.orders.toLocaleString('en-IN')}</td>
                <td className={tdNum}>{pct(t.share)}</td>
                <td className={tdNum}>{inrOrDash(t.avgBill)}</td>
                <td className={tdNum}>{pct(t.discountShare)}</td>
                <td className={tdNum}>{inrOrDash(t.payoutPerOrder)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Delivered orders in the last 4 weeks, grouped by the minimum order written in the offer code. Discount is a share of menu
        sales on those orders; payout is what Zomato pays before the marketing fee.
      </p>
    </Card>
  );
}

function Weeks({ s }: { s: StrategyResult }) {
  return (
    <Card title="Marketing fee by week">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted">
              <th className={th}>Week</th>
              <th className={thNum}>Fee with GST</th>
              <th className={thNum}>Sales-linked fee (Grow Maxx)</th>
              <th className={thNum}>Fixed-budget ads</th>
              <th className={thNum}>Fee rate</th>
              <th className={thNum}>Orders</th>
              <th className={thNum}>New customers</th>
            </tr>
          </thead>
          <tbody>
            {[...s.weeks].reverse().map((w) => (
              <tr key={w.start} className="border-t border-[#f2efe9] text-charcoal">
                <td className={`${td} whitespace-nowrap`}>{w.label}</td>
                <td className={`${tdNum} font-bold`}>{inr(w.fee)}</td>
                <td className={tdNum}>{inr(w.salesLinked)}</td>
                <td className={tdNum}>{inr(w.fixedAds)}</td>
                <td className={tdNum}>{pct(w.effectiveRate)}</td>
                <td className={tdNum}>{w.orders.toLocaleString('en-IN')}</td>
                <td className={tdNum}>{w.newCustomers.toLocaleString('en-IN')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Bills are spread evenly over the days they cover. Fee rate is the sales-linked fee before GST as a share of net sales
        (menu sales after discounts, before GST).
      </p>
      {s.billingNotes.length ? (
        <ul className="mt-3 flex flex-col gap-1 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900" role="status">
          {s.billingNotes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}

function Body({ s }: { s: StrategyResult }) {
  if (!s.hasData) {
    return (
      <Card title="Nothing to show yet">
        <p className="py-4 text-center text-sm text-muted">
          No delivered Zomato orders have been read yet. Once a settlement report is in, this page fills itself.
        </p>
      </Card>
    );
  }
  return (
    <>
      <Scorecard s={s} />
      <Actions s={s} />
      {s.anatomy ? <AnatomyCard a={s.anatomy} /> : null}
      <Ladder s={s} />
      <Weeks s={s} />
      <p className="text-xs text-muted">
        Every figure is worked out from the settlement reports each time you open this page. Windows are 4 weeks (28 days) ending on
        the latest delivered order. Marketing includes GST. A new customer is one whose first delivered order, in all the reports
        loaded, falls in the window. Targets are set in lib/online-settlements/strategy.ts.
      </p>
    </>
  );
}

export default async function OwnerOnlineStrategyPage() {
  let data: StrategyData | null = null;
  try {
    data = await loadStrategyData(createAdminSupabaseClient());
  } catch (err) {
    console.error('owner online strategy: load failed', err);
  }
  const s = data?.migrated ? buildStrategy({ orders: data.orders, deductions: data.deductions }) : null;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div>
        <Link href="/owner/online" className="text-sm font-bold text-charcoal underline">
          ← Online orders
        </Link>
        <h1 className="mt-2 text-2xl font-bold text-charcoal">Zomato strategy and targets</h1>
        <p className="text-sm text-muted">
          {s?.current && s.previous
            ? `${windowWords(s.current.from, s.current.to)}, compared with the 4 weeks before.`
            : 'The last 4 weeks of settlement reports, compared with the 4 weeks before.'}{' '}
          Zomato only for now: Swiggy has too little data.
        </p>
      </div>

      {!data ? (
        <Card title="Strategy">
          <p className="py-6 text-center text-sm text-red-700">The strategy page could not be loaded. Try again in a minute.</p>
        </Card>
      ) : !data.migrated || !s ? (
        <Card title="One-time setup">
          <p className="text-sm text-charcoal">
            Apply <span className="font-mono">supabase/2026-10-online-settlements.sql</span> in the Supabase SQL editor, then
            come back here. The full setup is in docs/ONLINE-SETTLEMENTS.md.
          </p>
        </Card>
      ) : (
        <Body s={s} />
      )}
    </div>
  );
}
