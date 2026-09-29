// Owner → Reports: reconcile any range of IST days. What was sold (by the day
// it was placed), what money came in and how (by the day it was received —
// the cash day's own rules), refunds, unpaid bills, cash in/out and each
// day's drawer close, with a CSV download. Rules: lib/reports/reconcile.ts.

import { istDateDaysAgo, istDateIso } from '@/lib/api/date';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card, inr } from '@/components/owner/dashboard';
import { parseRange, REPORT_METHODS, type Report, type ReportDay } from '@/lib/reports/reconcile';
import { loadReport } from '@/lib/reports/reconcileServer';

export const dynamic = 'force-dynamic';

const METHOD_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', online: 'Online (website)' } as const;

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function presets(today: string): { label: string; from: string; to: string }[] {
  const [y, m] = today.split('-').map(Number);
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  const prevMonthEnd = new Date(Date.UTC(y, m - 1, 0));
  const prevMonthStart = `${prevMonthEnd.toISOString().slice(0, 7)}-01`;
  return [
    { label: 'Today', from: today, to: today },
    { label: 'Yesterday', from: istDateDaysAgo(1), to: istDateDaysAgo(1) },
    { label: 'Last 7 days', from: istDateDaysAgo(6), to: today },
    { label: 'This month', from: firstOfMonth, to: today },
    { label: 'Last month', from: prevMonthStart, to: prevMonthEnd.toISOString().slice(0, 10) },
  ];
}

export default async function OwnerReportsPage({ searchParams }: { searchParams: { from?: string; to?: string } }) {
  const today = istDateIso();
  const range = parseRange(searchParams.from, searchParams.to, today);
  const from = range.ok ? range.from : today;
  const to = range.ok ? range.to : today;

  let report: Report | null = null;
  let loadError = '';
  try {
    report = await loadReport(createAdminSupabaseClient(), from, to);
  } catch (err) {
    console.error('owner reports page: load failed', err);
    loadError = 'The report could not be built. Please try again.';
  }

  const csvHref = `/api/owner/reports?from=${from}&to=${to}&format=csv`;
  const label = from === to ? shortDate(from) : `${shortDate(from)} – ${shortDate(to)}`;

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Reports</h1>
          <p className="text-sm text-muted">Reconcile sales, payments and the cash drawer for any dates.</p>
        </div>
        <a
          href={csvHref}
          className="rounded-md border border-line bg-white px-4 py-2 text-sm font-bold text-charcoal hover:border-charcoal"
        >
          Download CSV
        </a>
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
          Show report
        </button>
        <div className="flex flex-wrap gap-2">
          {presets(today).map((p) => {
            const active = p.from === from && p.to === to;
            return (
              <Link
                key={p.label}
                href={`/owner/reports?from=${p.from}&to=${p.to}`}
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

      {!range.ok ? <p className="text-sm text-red-700">{range.message} Showing today instead.</p> : null}
      {loadError ? <p className="text-sm text-red-700">{loadError}</p> : null}

      {report ? <ReportBody report={report} label={label} /> : null}
    </div>
  );
}

function ReportBody({ report, label }: { report: Report; label: string }) {
  const t = report.totals;
  const cashNet = t.received.cash - t.refunds.cash + t.cashInInr - t.cashOutInr;
  return (
    <>
      <h2 className="text-lg font-bold text-charcoal">{label}</h2>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Net sales" value={inr(t.netSalesInr)} sub={`${t.orders} orders`} />
        <Stat label="Money received" value={inr(t.receivedTotalInr)} sub={t.refundsTotalInr ? `${inr(t.refundsTotalInr)} refunded` : 'no refunds'} />
        <Stat label="Net received" value={inr(t.netReceivedInr)} sub="received − refunds" />
        <Stat
          label="Still unpaid"
          value={inr(t.unpaidInr)}
          sub={`${t.unpaidOrders} order${t.unpaidOrders === 1 ? '' : 's'} from these dates`}
          warn={t.unpaidOrders > 0}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="How the money came in">
          <ul className="flex flex-col gap-2 text-sm">
            {REPORT_METHODS.map((m) => {
              const amt = t.received[m];
              const pct = t.receivedTotalInr > 0 ? Math.round((amt / t.receivedTotalInr) * 100) : 0;
              return (
                <li key={m}>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-charcoal">{METHOD_LABEL[m]}</span>
                    <span className="font-mono tabular-nums text-charcoal">
                      {inr(amt)} <span className="text-xs text-muted">· {pct}%</span>
                    </span>
                  </div>
                  <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-[#f2efe9]">
                    <div className="h-full bg-tan" style={{ width: `${pct}%` }} />
                  </div>
                  {t.refunds[m] ? <p className="mt-0.5 text-xs text-red-700">− {inr(t.refunds[m])} refunded</p> : null}
                </li>
              );
            })}
          </ul>
          <p className="mt-3 text-xs text-muted">
            Counted on the day the money was received. A bill placed on one day and paid the next is money on the day it
            was paid. Tips {inr(t.tipsInr)} are included in these amounts but not in sales.
          </p>
        </Card>

        <Card title="Sales">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <Row k="Gross sales" v={inr(t.grossSalesInr)} />
            <Row k="of which GST" v={inr(t.taxInr)} />
            <Row k="Discounts (coupons, points)" v={inr(t.discountInr)} />
            <Row k="Settle discounts" v={`− ${inr(t.settleDiscountInr)}`} />
            <Row k="Net sales" v={inr(t.netSalesInr)} strong />
            <Row k="Cancelled / rejected" v={String(t.cancelled)} />
          </dl>
          <p className="mt-3 text-xs text-muted">Counted on the day the order was placed.</p>
        </Card>
      </div>

      <Card title="Cash drawer">
        <dl className="grid grid-cols-2 gap-y-1 text-sm sm:grid-cols-4">
          <Row k="Cash received" v={inr(t.received.cash)} />
          <Row k="Cash refunds" v={`− ${inr(t.refunds.cash)}`} />
          <Row k="Cash in" v={inr(t.cashInInr)} />
          <Row k="Cash out" v={`− ${inr(t.cashOutInr)}`} />
          <Row k="Net cash movement" v={inr(cashNet)} strong />
          <Row
            k={`Over / short (${t.cashDaysClosed} closed day${t.cashDaysClosed === 1 ? '' : 's'})`}
            v={t.cashDaysClosed ? `${t.overShortInr >= 0 ? '+' : '−'} ${inr(Math.abs(t.overShortInr))}` : '—'}
            strong
          />
        </dl>
      </Card>

      <Card title="Day by day">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm tabular-nums">
            <thead>
              <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                <th className="py-1.5 pr-3">Date</th>
                <th className="py-1.5 pr-3 text-right">Orders</th>
                <th className="py-1.5 pr-3 text-right">Net sales</th>
                <th className="py-1.5 pr-3 text-right">Cash</th>
                <th className="py-1.5 pr-3 text-right">UPI</th>
                <th className="py-1.5 pr-3 text-right">Card</th>
                <th className="py-1.5 pr-3 text-right">Online</th>
                <th className="py-1.5 pr-3 text-right">Refunds</th>
                <th className="py-1.5 pr-3 text-right">Net received</th>
                <th className="py-1.5 pr-3 text-right">Unpaid</th>
                <th className="py-1.5 pr-3 text-right">Drawer</th>
              </tr>
            </thead>
            <tbody>
              {[...report.days].reverse().map((d) => (
                <DayRow key={d.date} d={d} />
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function DayRow({ d }: { d: ReportDay }) {
  const cell = 'py-1.5 pr-3 text-right';
  const drawer =
    d.cashDay?.status === 'closed'
      ? `${(d.cashDay.over_short_inr ?? 0) >= 0 ? '+' : '−'}${inr(Math.abs(d.cashDay.over_short_inr ?? 0))}`
      : d.cashDay
        ? 'open'
        : '—';
  const drawerTone =
    d.cashDay?.status === 'closed' && (d.cashDay.over_short_inr ?? 0) < 0 ? 'text-red-700' : 'text-charcoal';
  return (
    <tr className="border-t border-[#f2efe9]">
      <td className="py-1.5 pr-3 font-semibold text-charcoal">{shortDate(d.date)}</td>
      <td className={cell}>{d.orders}</td>
      <td className={cell}>{inr(d.netSalesInr)}</td>
      <td className={cell}>{inr(d.received.cash)}</td>
      <td className={cell}>{inr(d.received.upi)}</td>
      <td className={cell}>{inr(d.received.card)}</td>
      <td className={cell}>{inr(d.received.online)}</td>
      <td className={`${cell} ${d.refundsTotalInr ? 'text-red-700' : ''}`}>{d.refundsTotalInr ? `−${inr(d.refundsTotalInr)}` : '—'}</td>
      <td className={`${cell} font-semibold`}>{inr(d.netReceivedInr)}</td>
      <td className={`${cell} ${d.unpaidOrders ? 'text-amber-800' : ''}`}>{d.unpaidOrders ? `${d.unpaidOrders} · ${inr(d.unpaidInr)}` : '—'}</td>
      <td className={`${cell} ${drawerTone}`}>{drawer}</td>
    </tr>
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

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
  return (
    <>
      <dt className={strong ? 'font-bold text-charcoal' : 'text-muted'}>{k}</dt>
      <dd className={`text-right font-mono tabular-nums ${strong ? 'font-bold text-charcoal' : 'text-charcoal'}`}>{v}</dd>
    </>
  );
}
