// Owner → Reports → Downloads: the month's numbers as CSV files for the
// accountant — the GST filing pack (GSTR-1 / GSTR-3B), sales, cash and
// expenses, staff, and loyalty. The page only lists the reports and links to
// the export route; every sheet is built on download
// (lib/reports/exports/registry.ts, app/api/owner/reports/export).

import { istDateIso } from '@/lib/api/date';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { ReportsNav } from '@/components/owner/ReportsNav';
import { Card } from '@/components/owner/dashboard';
import { BUSINESS } from '@/lib/legal';
import { getStoreSettings } from '@/lib/store/settings';
import { GST_NET_OF_DISCOUNT_FROM } from '@/lib/store/hours';
import { exportHref, lastDayOfMonth, previousMonth, resolvePeriod, wholeMonthOf } from '@/lib/reports/exports/period';
import { REPORT_GROUPS, reportsInGroup } from '@/lib/reports/exports/registry';

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

function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

const DOWNLOAD_BUTTON =
  'inline-flex min-h-[40px] items-center rounded-md border border-line bg-white px-4 text-sm font-bold text-charcoal hover:border-charcoal';

export default async function OwnerReportDownloadsPage({
  searchParams,
}: {
  searchParams: { month?: string; from?: string; to?: string };
}) {
  const today = istDateIso();
  const lastMonth = previousMonth(today);
  // GST is filed for the month that just ended, so that is where the page opens.
  const asked = Boolean(searchParams.month || searchParams.from || searchParams.to);
  const first = resolvePeriod(asked ? searchParams : { month: lastMonth }, today);
  const range = first.ok ? first : resolvePeriod({ month: lastMonth }, today);
  const from = range.ok ? range.from : `${lastMonth}-01`;
  const to = range.ok ? range.to : lastDayOfMonth(lastMonth);
  const month = wholeMonthOf(from, to);
  const label = month ? monthName(month) : from === to ? longDate(from) : `${longDate(from)} – ${longDate(to)}`;
  const inProgress = !month && to === today && from.endsWith('-01');

  const settings = await getStoreSettings();

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6">
      <ReportsNav active="downloads" from={from} to={to} />
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-charcoal">Downloads</h1>
          <p className="text-sm text-muted">Month-end CSV reports for your accountant: GST, sales, cash, staff and loyalty.</p>
        </div>
      </div>

      <div className="flex flex-col gap-3 rounded-md border border-line bg-white p-4">
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="text-sm">
            <span className="block text-muted">Month</span>
            <input
              type="month"
              name="month"
              defaultValue={month ?? lastMonth}
              max={today.slice(0, 7)}
              placeholder="2026-09"
              pattern="\d{4}-\d{2}"
              required
              className="mt-1 min-h-[40px] rounded-md border border-line px-3"
            />
          </label>
          <button type="submit" className="min-h-[40px] rounded-md bg-tan-dark px-4 text-sm font-bold text-cream hover:bg-tan-darker">
            Show month
          </button>
          <div className="flex flex-wrap gap-2">
            {[
              { label: 'Last month', month: lastMonth },
              { label: 'This month', month: today.slice(0, 7) },
            ].map((p) => (
              <Link
                key={p.label}
                href={`/owner/reports/downloads?month=${p.month}`}
                className={`rounded-full border px-3 py-1.5 text-xs font-semibold ${
                  month === p.month ? 'border-charcoal bg-charcoal text-cream' : 'border-line bg-white text-charcoal'
                }`}
              >
                {p.label}
              </Link>
            ))}
          </div>
        </form>
        <form method="get" className="flex flex-wrap items-end gap-3 border-t border-[#f2efe9] pt-3">
          <span className="w-full text-xs font-semibold uppercase tracking-wide text-muted">or custom dates</span>
          <label className="text-sm">
            <span className="block text-muted">From</span>
            <input type="date" name="from" defaultValue={from} max={today} className="mt-1 min-h-[40px] rounded-md border border-line px-3" />
          </label>
          <label className="text-sm">
            <span className="block text-muted">To</span>
            <input type="date" name="to" defaultValue={to} max={today} className="mt-1 min-h-[40px] rounded-md border border-line px-3" />
          </label>
          <button type="submit" className="min-h-[40px] rounded-md bg-tan-dark px-4 text-sm font-bold text-cream hover:bg-tan-darker">
            Show dates
          </button>
        </form>
      </div>

      {!first.ok && asked ? <p className="text-sm text-red-700">{first.message} Showing last month instead.</p> : null}

      <div>
        <h2 className="text-lg font-bold text-charcoal">{label}</h2>
        <p className="text-xs text-muted">
          GSTIN {BUSINESS.gstin} · GST at {settings.gst_percent}%, {settings.gst_inclusive ? 'included in menu prices' : 'added on top of menu prices'}{' '}
          (today’s setting; each bill keeps the GST it was charged). Dates are IST, by the day the order was placed.
        </p>
        {inProgress ? (
          <p className="mt-1 text-xs text-amber-800">
            This month is still in progress, so the files run up to today. For GST, wait until the month has ended.
          </p>
        ) : null}
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        {REPORT_GROUPS.map(({ group, title }) => {
          const reports = reportsInGroup(group);
          if (reports.length === 0) return null;
          return (
            <Card key={group} title={title}>
              {group === 'gst' ? (
                <>
                  <OpenGstReport
                    label={label}
                    href={month ? `/owner/reports/gst?month=${month}` : `/owner/reports/gst?from=${from}&to=${to}`}
                  />
                  <BeforeYouFile />
                </>
              ) : null}
              <ul className="flex flex-col">
                {reports.map((r) => (
                  <ReportRow key={r.key} title={r.title} description={r.description} href={exportHref(r.key, from, to)} />
                ))}
                {group === 'sales' ? (
                  <ReportRow
                    title="Daily reconciliation"
                    description="One row per day: sales, money received by cash, UPI, card and apps, refunds, unpaid bills and the cash drawer, with a total row."
                    href={`/api/owner/reports?from=${from}&to=${to}&format=csv`}
                  />
                ) : null}
              </ul>
              {group === 'sales' ? (
                <p className="mt-3 text-xs text-muted">
                  Prefer to read it on screen, or cut it another way?{' '}
                  <Link href={`/owner/reports/sales?from=${from}&to=${to}`} className="font-semibold text-charcoal underline">
                    Open Items &amp; custom
                  </Link>
                  .
                </p>
              ) : null}
              {group === 'loyalty' ? (
                <p className="mt-3 text-xs text-muted">
                  Prefer to read it on screen?{' '}
                  <Link href={`/owner/reports/insights?from=${from}&to=${to}`} className="font-semibold text-charcoal underline">
                    Open Insights
                  </Link>
                  .
                </p>
              ) : null}
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function ReportRow({ title, description, href }: { title: string; description: string; href: string }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-[#f2efe9] py-3 first:border-t-0 first:pt-0">
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-sm font-bold text-charcoal">{title}</p>
        <p className="text-xs text-muted">{description}</p>
      </div>
      <a href={href} aria-label={`Download ${title} as CSV`} className={DOWNLOAD_BUTTON}>
        Download CSV
      </a>
    </li>
  );
}

// The finished GST report (app/owner/reports/gst): what you owe and how it was
// worked out, with the return tables, an Excel file for the CA and a printable page.
function OpenGstReport({ href, label }: { href: string; label: string }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-tan bg-surface p-3">
      <div className="min-w-0 flex-1 basis-60">
        <p className="text-sm font-bold text-charcoal">The GST report for {label}</p>
        <p className="text-xs text-muted">
          What you owe, how it was worked out, the GSTR-3B and GSTR-1 tables and the checks, on one page. Print it or
          download it as Excel for your CA.
        </p>
      </div>
      <Link
        href={href}
        className="inline-flex min-h-[40px] items-center rounded-md bg-tan-dark px-4 text-sm font-bold text-cream hover:bg-tan-darker"
      >
        Open the GST report
      </Link>
    </div>
  );
}

// What the GST sheets do and do not do, so the accountant is not surprised.
function BeforeYouFile() {
  return (
    <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-charcoal">
      <p className="font-bold">Before you file</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        <li>GST is shown as it was charged on the bills; nothing is recalculated.</li>
        <li>
          From {longDate(GST_NET_OF_DISCOUNT_FROM)}, GST is charged on the bill after coupons and Beanies, and on
          takeaway packaging too: the taxable value is after the discount and includes packaging (under SAC 996331).
        </li>
        <li>
          Orders before {longDate(GST_NET_OF_DISCOUNT_FROM)} were taxed on the price before discounts, with packaging
          untaxed, so those discounts are not deducted and that packaging is not in the taxable value. A month that
          spans the date has both, and the GST summary says how many bills of each.
        </li>
        <li>HIOC Ritual GST is charged when the pass is sold, not when a cup is served.</li>
        <li>
          HSN 0901 loses its leading zero if the CSV is opened in Excel and saved. The GST offline tool imports the CSV
          as it is, so import the downloaded file, not a re-saved copy.
        </li>
      </ul>
      <p className="mt-1">Confirm with your accountant before filing.</p>
    </div>
  );
}
