// Owner → Reports: reconcile any range of IST days. What was sold (by the day
// it was placed), what money came in and how (by the day it was received —
// the cash day's own rules), refunds, unpaid bills, and the cash drawer by
// cash day — each close's statement and its count by denomination — with a
// CSV download. Rules: lib/reports/reconcile.ts.

import { istDateDaysAgo, istDateIso } from '@/lib/api/date';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card, inr } from '@/components/owner/dashboard';
import { flags } from '@/lib/flags';
import { reportPassRows } from '@/lib/passes/ownerUi';
import { ReportEmailSettingsPanel } from '@/components/owner/ReportEmailSettingsPanel';
import {
  closingCountRows,
  closingDayOf,
  parseRange,
  REPORT_METHODS,
  type CashDayRow,
  type Report,
  type ReportDay,
} from '@/lib/reports/reconcile';
import { loadReport } from '@/lib/reports/reconcileServer';

export const dynamic = 'force-dynamic';

const METHOD_LABEL = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  online: 'Online (website)',
  swiggy_dineout: 'Swiggy Dineout',
  zomato_district: 'Zomato District',
} as const;

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** '5 Oct, 3:02 pm' in IST. */
function istTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

const signed = (n: number) => `${n >= 0 ? '+' : '−'} ${inr(Math.abs(n))}`;

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
        <div className="flex flex-wrap gap-2">
          <a
            href="#report-emails"
            className="rounded-md border border-line bg-white px-4 py-2 text-sm font-bold text-charcoal hover:border-charcoal"
          >
            Email reports
          </a>
          <a
            href={csvHref}
            className="rounded-md border border-line bg-white px-4 py-2 text-sm font-bold text-charcoal hover:border-charcoal"
          >
            Download CSV
          </a>
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

      {/* The same numbers, emailed daily / weekly / monthly (lib/reports/ownerDigest.ts). */}
      <div id="report-emails" className="scroll-mt-24">
        <Card title="Report emails">
          <ReportEmailSettingsPanel />
        </Card>
      </div>
    </div>
  );
}

function ReportBody({ report, label }: { report: Report; label: string }) {
  const t = report.totals;
  // HIOC Ritual (CP-D21): two informational rows. Ritual sales are already inside
  // Gross sales, and the cover on a redeemed cup is not a discount, so neither
  // changes Gross or Net. Only with the flag on and something to show.
  const ritual = reportPassRows(t, flags.coffeePass);
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
            was paid. Tips {inr(t.tipsInr)} are included in these amounts but not in sales. Cash here is by calendar day;
            the cash drawer below is by cash day.
          </p>
        </Card>

        <Card title="Sales">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <Row k="Gross sales" v={inr(t.grossSalesInr)} />
            <Row k="of which GST" v={inr(t.taxInr)} />
            {ritual.sales ? <Row k={ritual.sales.label} v={ritual.sales.value} /> : null}
            <Row k="Discounts (coupons, Beanies)" v={inr(t.discountInr)} />
            <Row k="Settle discounts" v={`− ${inr(t.settleDiscountInr)}`} />
            <Row k="Net sales" v={inr(t.netSalesInr)} strong />
            <Row k="Cancelled / rejected" v={String(t.cancelled)} />
            {ritual.cups ? <Row k={ritual.cups.label} v={ritual.cups.value} /> : null}
          </dl>
          <p className="mt-3 text-xs text-muted">Counted on the day the order was placed.</p>
          {ritual.sales || ritual.cups ? (
            <p className="mt-1 text-xs text-muted">
              Ritual sales are inside Gross sales. Cups served on a Ritual were paid for when it was sold, so what they
              covered is not in Discounts.
            </p>
          ) : null}
        </Card>
      </div>

      <CashDrawer report={report} />

      <Card title="Day by day">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[980px] text-sm tabular-nums">
            <thead>
              <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                <th className="py-1.5 pr-3">Date</th>
                <th className="py-1.5 pr-3 text-right">Orders</th>
                <th className="py-1.5 pr-3 text-right">Net sales</th>
                <th className="py-1.5 pr-3 text-right">Cash</th>
                <th className="py-1.5 pr-3 text-right">UPI</th>
                <th className="py-1.5 pr-3 text-right">Card</th>
                <th className="py-1.5 pr-3 text-right">Online</th>
                <th className="py-1.5 pr-3 text-right">Dineout</th>
                <th className="py-1.5 pr-3 text-right">District</th>
                <th className="py-1.5 pr-3 text-right">Refunds</th>
                <th className="py-1.5 pr-3 text-right">Net received</th>
                <th className="py-1.5 pr-3 text-right">Unpaid</th>
                <th className="py-1.5 pr-3 text-right">Counted</th>
                <th className="py-1.5 pr-3 text-right">Over/short</th>
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
  // The drawer by the cash day opened on this date: the last close's count, and
  // the over/short of every close.
  const closing = closingDayOf(d);
  const overShort = d.cashDays.reduce((s, c) => s + (c.status === 'closed' ? c.over_short_inr ?? 0 : 0), 0);
  const notClosed = d.cashDays.length ? 'open' : '—';
  const counted = closing ? inr(closing.counted_total_inr ?? 0) : notClosed;
  const drawer = closing ? signed(overShort) : notClosed;
  const drawerTone = closing && overShort < 0 ? 'text-red-700' : 'text-charcoal';
  return (
    <tr className="border-t border-[#f2efe9]">
      <td className="py-1.5 pr-3 font-semibold text-charcoal">{shortDate(d.date)}</td>
      <td className={cell}>{d.orders}</td>
      <td className={cell}>{inr(d.netSalesInr)}</td>
      <td className={cell}>{inr(d.received.cash)}</td>
      <td className={cell}>{inr(d.received.upi)}</td>
      <td className={cell}>{inr(d.received.card)}</td>
      <td className={cell}>{inr(d.received.online)}</td>
      <td className={cell}>{inr(d.received.swiggy_dineout)}</td>
      <td className={cell}>{inr(d.received.zomato_district)}</td>
      <td className={`${cell} ${d.refundsTotalInr ? 'text-red-700' : ''}`}>{d.refundsTotalInr ? `−${inr(d.refundsTotalInr)}` : '—'}</td>
      <td className={`${cell} font-semibold`}>{inr(d.netReceivedInr)}</td>
      <td className={`${cell} ${d.unpaidOrders ? 'text-amber-800' : ''}`}>{d.unpaidOrders ? `${d.unpaidOrders} · ${inr(d.unpaidInr)}` : '—'}</td>
      <td className={cell}>{counted}</td>
      <td className={`${cell} ${drawerTone}`}>{drawer}</td>
    </tr>
  );
}

// The drawer, by cash day (lib/reports/reconcile.ts): the range's totals, then
// one card per cash day — its statement as staff closed it and the closing
// count by denomination (what stayed as the float, what was taken out).
function CashDrawer({ report }: { report: Report }) {
  const d = report.drawer;
  const daysClosed = report.days.filter((x) => x.cashDays.some((c) => c.status === 'closed')).length;
  const cashDays = report.days.flatMap((x) => x.cashDays).reverse();
  const single = report.from === report.to;
  return (
    <Card title="Cash drawer">
      <p className="mb-3 text-xs text-muted">
        By cash day — from when the drawer was opened to when it was counted and closed, the figures staff saw at the
        close. A cash day sits on the date it was opened, so cash taken after midnight is here but under the next date in
        How the money came in.
      </p>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-4">
        <Row k="Days closed" v={`${daysClosed} of ${report.days.length}`} />
        <Row k={`Cash sales${d.cashSalesCount ? ` (${d.cashSalesCount})` : ''}`} v={inr(d.cashSalesInr)} />
        <Row k="Cash refunds" v={`− ${inr(d.cashRefundsInr)}`} />
        <Row k="Cash in" v={inr(d.cashInInr)} />
        <Row k="Cash out" v={`− ${inr(d.cashOutInr)}`} />
        {d.expensesInr > 0 ? <Row k="of which expenses" v={`− ${inr(d.expensesInr)}`} /> : null}
        <Row k="Over / short" v={d.closed ? signed(d.overShortInr) : '—'} strong />
        <Row k="Handed over to owner/bank" v={inr(d.handoverInr)} strong />
        <Row k="Float left in drawer" v={d.floatLeftInr === null ? '—' : inr(d.floatLeftInr)} />
      </dl>
      {d.open ? (
        <p className="mt-2 text-xs text-amber-800">
          {d.open} cash day{d.open === 1 ? ' is' : 's are'} still open — not counted yet, so not in these totals.
        </p>
      ) : null}
      {cashDays.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No cash day was opened on these dates.</p>
      ) : (
        <div className="mt-4 flex flex-col gap-2">
          {cashDays.map((c, i) => (
            <CashDayCard key={c.id ?? `${c.business_date}-${i}`} c={c} open={single} />
          ))}
        </div>
      )}
    </Card>
  );
}

function CashDayCard({ c, open }: { c: CashDayRow; open: boolean }) {
  const closed = c.status === 'closed';
  const os = c.over_short_inr ?? 0;
  const reason = (c.close_reason || c.notes || '').trim();
  const hasHandover = c.handover_inr !== null && c.handover_inr !== undefined;
  const rows = closed ? closingCountRows(c) : [];
  return (
    <details open={open} className="group rounded-md border border-line bg-white">
      <summary className="flex min-h-[44px] cursor-pointer list-none flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
        <span className="min-w-0">
          <span className="font-bold text-charcoal">{shortDate(c.business_date)}</span>
          <span className="ml-2 text-xs text-muted">
            {istTime(c.opened_at)} → {closed ? istTime(c.closed_at) : 'still open'}
          </span>
        </span>
        <span className="text-right text-sm text-charcoal">
          {closed ? (
            <>
              Counted <span className="font-mono font-bold tabular-nums">{inr(c.counted_total_inr ?? 0)}</span>
              {' · '}
              <span className={`font-mono font-bold tabular-nums ${os < 0 ? 'text-red-700' : 'text-green-700'}`}>
                {os === 0 ? 'ties out' : signed(os)}
              </span>
            </>
          ) : (
            <span className="font-bold text-amber-800">Open — not counted yet</span>
          )}
        </span>
      </summary>
      <div className="grid gap-4 border-t border-line px-3 py-3 md:grid-cols-2">
        <dl className="grid grid-cols-2 content-start gap-y-1 text-sm">
          <Row k="Opening float" v={inr(c.opening_total_inr ?? 0)} />
          {closed ? (
            <>
              <Row
                k={`+ Cash sales${c.cash_sales_count ? ` (${c.cash_sales_count})` : ''}`}
                v={c.cash_sales_inr === null || c.cash_sales_inr === undefined ? '—' : inr(c.cash_sales_inr)}
              />
              <Row k="− Cash refunds" v={inr(c.cash_refunds_inr ?? 0)} />
              <Row k="+ Cash in" v={inr(c.cash_in_inr ?? 0)} />
              <Row k="− Cash out" v={inr(c.cash_out_inr ?? 0)} />
              {c.expenses_inr ? <Row k="of which expenses" v={inr(c.expenses_inr)} /> : null}
              <Row k="= Expected in drawer" v={inr(c.expected_cash_inr ?? 0)} />
              <Row k="Counted at close" v={inr(c.counted_total_inr ?? 0)} strong />
              <Row k="Over / short" v={os === 0 ? 'ties out' : signed(os)} strong />
              {os !== 0 && reason ? (
                <dd className="col-span-2 text-xs text-muted">Reason: {reason}</dd>
              ) : null}
              <Row k="Handed over to owner/bank" v={hasHandover ? inr(c.handover_inr ?? 0) : '—'} />
              <Row k="Float left in drawer" v={hasHandover ? inr(c.float_left_total_inr ?? 0) : '—'} />
            </>
          ) : null}
        </dl>
        {closed ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm tabular-nums">
              <thead>
                <tr className="text-left text-[10px] font-semibold uppercase tracking-wide text-muted">
                  <th className="py-1 pr-2">Closing count</th>
                  <th className="py-1 pr-2 text-right">Count</th>
                  <th className="py-1 pr-2 text-right">Amount</th>
                  <th className="py-1 pr-2 text-right">Float left</th>
                  <th className="py-1 text-right">Taken out</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="py-1 text-xs text-muted">
                      Nothing counted by denomination.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.key} className="border-t border-[#f2efe9]">
                      <td className="py-1 pr-2 font-semibold text-charcoal">{r.label}</td>
                      <td className="py-1 pr-2 text-right font-mono">{r.count}</td>
                      <td className="py-1 pr-2 text-right font-mono">{inr(r.amountInr)}</td>
                      <td className="py-1 pr-2 text-right font-mono text-muted">{r.floatLeft || '—'}</td>
                      <td className="py-1 text-right font-mono text-muted">{r.takenOut || '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
              <tfoot>
                <tr className="border-t border-line font-bold text-charcoal">
                  <td className="py-1 pr-2">Total</td>
                  <td className="py-1 pr-2" />
                  <td className="py-1 pr-2 text-right font-mono">{inr(c.counted_total_inr ?? 0)}</td>
                  <td className="py-1 pr-2 text-right font-mono">{hasHandover ? inr(c.float_left_total_inr ?? 0) : '—'}</td>
                  <td className="py-1 text-right font-mono">{hasHandover ? inr(c.handover_inr ?? 0) : '—'}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : null}
      </div>
    </details>
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
