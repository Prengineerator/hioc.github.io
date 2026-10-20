// Owner → Reports → GST: the month's GST on one page, written to be read by the
// owner first and filed from by a CA second. Plain words lead (what you owe,
// your sales, how the taxable value was reached) and the exact return tables
// follow (GSTR-3B Table 3.1, GSTR-1 Tables 7, 8, 12 and 13), then the checks,
// notes and a glossary. Every figure comes from one GstComputation
// (lib/reports/exports/gstComputation.ts), the same object the Excel workbook
// and the GST CSVs are cut from, so the screen, the workbook and the files agree.
// It prints cleanly to PDF: the nav, forms and buttons drop out, the collapsed
// sections open (components/owner/PrintReportButton.tsx) and tables don't split.

import { istDateIso } from '@/lib/api/date';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { SurfaceLink as Link } from '@/components/SurfaceLink';
import { Card } from '@/components/owner/dashboard';
import { PrintReportButton } from '@/components/owner/PrintReportButton';
import { GST_NET_OF_DISCOUNT_FROM } from '@/lib/store/hours';
import { exportHref, lastDayOfMonth, previousMonth, resolvePeriod, wholeMonthOf } from '@/lib/reports/exports/period';
import { GSTR3B_TABLE_31_HEADING } from '@/lib/reports/exports/gstComputation';
import { loadGstComputation } from '@/lib/reports/exports/gstComputationServer';
import type {
  B2csRow,
  DocsRow,
  Gstr3bRow,
  GstCheck,
  GstComputation,
  GstDayRow,
  HsnRow,
  NilExemptRow,
  ReconLine,
} from '@/lib/reports/exports/gstTypes';

export const dynamic = 'force-dynamic';

// ── Formatting ───────────────────────────────────────────────────────────────

function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** '20 Oct 2026, 3:02 pm' in IST. */
function istStamp(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** 1,23,456.78 (Indian grouping, always paise: a return is filed to the paisa). */
const amount = (n: number): string =>
  Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** ₹1,23,456.78, with a real minus for a negative. */
const money = (n: number): string => `${Math.round(n * 100) < 0 ? '−' : ''}₹${amount(n)}`;
const num = (n: number): string => n.toLocaleString('en-IN');
const percent = (n: number): string => `${Number(n.toFixed(2))}%`;

// ── Styles shared by the tables ──────────────────────────────────────────────

const BUTTON =
  'inline-flex min-h-[40px] items-center rounded-md border border-line bg-white px-4 text-sm font-bold text-charcoal hover:border-charcoal';
const BUTTON_PRIMARY =
  'inline-flex min-h-[40px] items-center rounded-md bg-tan-dark px-4 text-sm font-bold text-cream hover:bg-tan-darker';
const HEAD_ROW = 'text-left text-[10px] font-semibold uppercase tracking-wide text-muted';
const TH = 'py-1.5 pr-4 align-bottom';
const THR = `${TH} text-right`;
const TD = 'py-1.5 pr-4 align-top print:py-0.5';
const TDR = `${TD} text-right font-mono`;
const ROW = 'border-t border-[#f2efe9]';
const TOTAL_ROW = 'border-t border-charcoal font-bold text-charcoal';

// Print rules, active only while this page is open. The site header, footer and
// owner nav hide themselves in print (print:hidden). Colours (check icons, shaded
// totals) are kept in the printout, a table row is never cut in half, and the
// page is A4 with a modest margin.
const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 12mm; }
  html, body { background: #fff !important; }
  [data-gst-report] { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  [data-gst-report] section { box-shadow: none !important; }
  [data-gst-report] tr { break-inside: avoid; }
  [data-gst-report] details > summary { list-style: none; }
  [data-gst-report] section > h2, [data-gst-report] h3 { break-after: avoid; }
}
`;

export default async function OwnerGstReportPage({
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

  let c: GstComputation | null = null;
  let loadError = '';
  try {
    c = await loadGstComputation(createAdminSupabaseClient(), from, to);
  } catch (err) {
    console.error('owner gst page: load failed', err);
    loadError = 'The GST report could not be built. Please try again.';
  }

  const warnCount = c ? c.checks.filter((k) => k.status === 'warn').length : 0;

  return (
    <div
      data-gst-report=""
      className="mx-auto flex max-w-7xl flex-col gap-5 px-4 py-6 print:max-w-none print:gap-3 print:p-0 print:text-[12px]"
    >
      <style dangerouslySetInnerHTML={{ __html: PRINT_CSS }} />

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-charcoal">GST for {c?.period.label ?? label}</h1>
          <p className="text-sm text-muted">
            {c ? (
              <>
                {c.business.legalName} ({c.business.tradeName}) · GSTIN <span className="font-mono">{c.business.gstin}</span>
                {c.period.returnPeriod ? ` · Return period ${c.period.returnPeriod}` : ''} · Financial year {c.period.financialYear}
              </>
            ) : (
              'What you owe, how it was worked out, and the tables your CA files from.'
            )}
          </p>
          {c ? (
            <p className="text-xs text-muted">
              {c.business.address} · Prepared {istStamp(c.generatedAt)}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
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

      <div className="grid items-start gap-5 print:hidden lg:grid-cols-2">
        <PeriodForms today={today} lastMonth={lastMonth} from={from} to={to} month={month} />
        {c ? <TakeItWithYou from={from} to={to} month={month} /> : null}
      </div>

      {!first.ok && asked ? <p className="text-sm text-red-700 print:hidden">{first.message} Showing last month instead.</p> : null}
      {inProgress ? (
        <p className="text-sm text-amber-800">
          This month is still in progress, so these figures run up to today. GST is filed for a whole month, so wait until the
          month has ended before you file.
        </p>
      ) : c && !c.period.isWholeMonth ? (
        <p className="text-sm text-amber-800">
          These dates are not one calendar month, so there is no return period or due date. Use them for checking; a monthly
          return covers a whole month.
        </p>
      ) : null}

      {loadError ? (
        <div role="alert" className="rounded-md border border-red-300 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-bold">{loadError}</p>
          <p className="mt-1">
            Nothing has been changed.{' '}
            <Link
              href={month ? `/owner/reports/gst?month=${month}` : `/owner/reports/gst?from=${from}&to=${to}`}
              className="font-semibold underline"
            >
              Try again
            </Link>
            , or pick the dates again above.
          </p>
        </div>
      ) : null}

      {c ? (
        <>
          <JumpLinks warnCount={warnCount} />
          <Owe c={c} today={today} />
          <Sales c={c} />
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <Reconciliation
              id="taxable"
              title="How we got to the taxable value"
              intro="Start with everything sold, take out what GST is not charged on, and what is left is the amount GST is worked out on."
              lines={c.toTaxableValue}
              top={<BasisNote c={c} />}
            />
            <Reconciliation
              id="invoice"
              title="From taxable value to your bill totals"
              intro="Add the GST and the items that carry no GST, and you are back at what your bills add up to."
              lines={c.toInvoiceValue}
            />
          </div>
          <Gstr3b rows={c.gstr3b} />
          <Gstr1 c={c} />
          <Checks checks={c.checks} />
          <Notes c={c} />
          <DayRegister c={c} from={from} to={to} />
          <p className="text-xs text-muted">
            Every figure is the GST the bills actually charged; nothing is recalculated. Confirm with your accountant before
            filing.
          </p>
        </>
      ) : null}
    </div>
  );
}

// ── Month picker and downloads ───────────────────────────────────────────────

function PeriodForms({
  today,
  lastMonth,
  from,
  to,
  month,
}: {
  today: string;
  lastMonth: string;
  from: string;
  to: string;
  month: string | null;
}) {
  return (
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
              href={`/owner/reports/gst?month=${p.month}`}
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
  );
}

const OFFLINE_FILES = [
  { key: 'gstr1-b2cs', label: 'Table 7 · B2C', file: 'b2cs' },
  { key: 'gstr1-exempt', label: 'Table 8 · Exempt', file: 'exemp' },
  { key: 'gstr1-hsn', label: 'Table 12 · HSN', file: 'hsn(b2c)' },
  { key: 'gstr1-docs', label: 'Table 13 · Docs', file: 'docs' },
] as const;

function TakeItWithYou({ from, to, month }: { from: string; to: string; month: string | null }) {
  const workbook = month
    ? `/api/owner/reports/gst-workbook?month=${month}`
    : `/api/owner/reports/gst-workbook?from=${from}&to=${to}`;
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-white p-4">
      <div className="flex flex-wrap items-center gap-2">
        <a href={workbook} className={BUTTON_PRIMARY}>
          Download Excel for your CA
        </a>
        <PrintReportButton className={BUTTON} />
      </div>
      <p className="-mt-1 text-xs text-muted">
        The Excel file has this whole report, the day-wise and invoice-by-invoice registers and the glossary, one tab each.
      </p>
      <div className="border-t border-[#f2efe9] pt-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">Files for the GST offline tool (CSV)</p>
        <ul className="mt-2 grid grid-cols-2 gap-2">
          {OFFLINE_FILES.map((f) => (
            <li key={f.key}>
              <a
                href={exportHref(f.key, from, to)}
                aria-label={`Download GSTR-1 ${f.label} as a CSV for the GST offline tool`}
                className="flex min-h-[40px] flex-col justify-center rounded-md border border-line bg-white px-3 py-1 hover:border-charcoal"
              >
                <span className="text-sm font-bold text-charcoal">{f.label}</span>
                <span className="font-mono text-[11px] text-muted">{f.file}.csv</span>
              </a>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-muted">
          Import these exactly as downloaded. If you open one in Excel and save it, HSN 0901 loses its leading zero.
        </p>
      </div>
    </div>
  );
}

function JumpLinks({ warnCount }: { warnCount: number }) {
  const links = [
    ['#owe', 'What you owe'],
    ['#sales', 'Your sales'],
    ['#taxable', 'Taxable value'],
    ['#gstr3b', 'GSTR-3B'],
    ['#gstr1', 'GSTR-1'],
    ['#checks', 'Checks'],
    ['#notes', 'Notes'],
    ['#days', 'Day by day'],
  ];
  return (
    <nav aria-label="Sections of this report" className="relative -mx-4 flex items-center gap-2 overflow-x-auto px-4 print:hidden">
      {links.map(([href, text]) => (
        <a
          key={href}
          href={href}
          className="shrink-0 rounded-full border border-line bg-white px-3 py-1.5 text-xs font-semibold text-charcoal hover:border-charcoal"
        >
          {text}
          {href === '#checks' && warnCount > 0 ? (
            <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-900">
              {warnCount}
              <span className="sr-only"> to look at</span>
            </span>
          ) : null}
        </a>
      ))}
    </nav>
  );
}

// ── What you owe / Your sales ────────────────────────────────────────────────

function Owe({ c, today }: { c: GstComputation; today: string }) {
  const t = c.taxPayable;
  const half = c.ratePercent / 2;
  const parts = [
    { label: `CGST (${percent(half)})`, value: t.cgstInr, always: true },
    { label: `SGST (${percent(half)})`, value: t.sgstInr, always: true },
    { label: 'IGST', value: t.igstInr, always: false },
    { label: 'Cess', value: t.cessInr, always: false },
  ].filter((p) => p.always || p.value !== 0);
  const dues = [
    { label: 'File your sales return (GSTR-1) by', date: c.period.gstr1DueDate },
    { label: 'File your tax return (GSTR-3B) and pay by', date: c.period.gstr3bDueDate },
  ];
  return (
    <div id="owe" className="scroll-mt-28 print:break-inside-avoid">
      <Card title="What you owe">
        <div className="grid items-start gap-5 md:grid-cols-2">
          <div>
            <p className="font-mono text-4xl font-bold tabular-nums text-charcoal">{money(t.totalInr)}</p>
            <p className="mt-1 text-sm text-muted">GST to pay for {c.period.label}</p>
            <dl className="mt-3 flex max-w-xs flex-col gap-1 text-sm">
              {parts.map((p) => (
                <div key={p.label} className="flex items-baseline justify-between gap-3 border-t border-[#f2efe9] pt-1 first:border-t-0 first:pt-0">
                  <dt className="text-muted">{p.label}</dt>
                  <dd className="font-mono tabular-nums text-charcoal">{money(p.value)}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div>
            {c.period.gstr1DueDate && c.period.gstr3bDueDate ? (
              <dl className="flex flex-col gap-2 text-sm">
                {dues.map((d) => {
                  const passed = d.date !== null && d.date < today;
                  return (
                    <div key={d.label} className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-[#f2efe9] pt-2 first:border-t-0 first:pt-0">
                      <dt className="text-charcoal">{d.label}</dt>
                      <dd className="font-bold text-charcoal">
                        {d.date ? longDate(d.date) : '—'}
                        {passed ? <span className="ml-1.5 text-xs font-semibold text-amber-800">date has passed</span> : null}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            ) : (
              <p className="text-sm text-muted">There is no due date for custom dates. Due dates belong to a whole month.</p>
            )}
            <p className="mt-3 text-sm font-semibold text-charcoal">File GSTR-1 first — since July 2025 GSTR-3B is filled from it and locked.</p>
            {c.period.gstr1DueDate ? (
              <p className="mt-1 text-xs text-muted">
                These are the dates for a monthly filer. A café with a turnover up to ₹5 crore may file quarterly instead (the
                QRMP scheme); ask your CA which one you are on.
              </p>
            ) : null}
          </div>
        </div>
        <p className="mt-4 rounded-md bg-surface p-3 text-sm text-charcoal">
          <span className="font-bold">Paid in cash.</span> A restaurant charging {percent(c.ratePercent)} GST takes no input tax
          credit, so nothing is set off: the whole amount is paid through the cash ledger on the GST portal (GSTR-3B, Table 6.1).
        </p>
      </Card>
    </div>
  );
}

function Sales({ c }: { c: GstComputation }) {
  const n = c.counts;
  const exempt = c.gstr3b.find((r) => r.code === '3.1(c)')?.amounts.taxableValueInr ?? 0;
  const invoiceValue = c.toInvoiceValue.length ? c.toInvoiceValue[c.toInvoiceValue.length - 1].amountInr : 0;
  const taxable = c.gstr3b.find((r) => r.code === '3.1(a)')?.amounts.taxableValueInr ?? 0;
  return (
    <div id="sales" className="scroll-mt-28 print:break-inside-avoid">
      <Card title={c.period.isWholeMonth ? 'Your sales this month' : 'Your sales in these dates'}>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Bills issued" value={num(n.issuedBills)} sub={`${num(n.cancelledBills)} cancelled, left out`} />
          <Stat label="Taxable value" value={money(taxable)} sub="what GST is worked out on" />
          <Stat label="GST-exempt sales" value={money(exempt)} sub="items that carry no GST" />
          <Stat label="Invoice value" value={money(invoiceValue)} sub="bills issued, GST included" />
        </div>
        <p className="mt-3 text-xs text-muted">
          GST is charged at {percent(c.ratePercent)} ({percent(c.ratePercent / 2)} CGST + {percent(c.ratePercent / 2)} SGST), all
          within {c.business.stateName}.
          {n.issuedBills === 0 ? ' No bills were issued in these dates.' : ''} Cancelled and rejected bills are in no total.
        </p>
      </Card>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="min-w-0 rounded-md border border-line bg-cream p-4 shadow-sm print:shadow-none">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 whitespace-nowrap font-mono text-lg font-bold tabular-nums text-charcoal sm:text-xl xl:text-2xl">{value}</p>
      <p className="text-xs text-muted">{sub}</p>
    </div>
  );
}

// ── The two reconciliations ──────────────────────────────────────────────────

/** Which bills were taxed which way, so the discount lines below make sense. */
function BasisNote({ c }: { c: GstComputation }) {
  const { afterDiscountBills: after, beforeDiscountBills: before } = c.counts;
  const since = longDate(GST_NET_OF_DISCOUNT_FROM);
  let text: string | null = null;
  if (after > 0 && before > 0) {
    text = `${num(after)} of the ${num(after + before)} bills were taxed after discounts (the rule from ${since}) and ${num(before)} on the price before discounts.`;
  } else if (after > 0) {
    text = `All ${num(after)} bills were taxed after discounts, the rule from ${since}.`;
  } else if (before > 0) {
    text = `All ${num(before)} bills were taxed on the price before discounts, the rule before ${since}.`;
  }
  const inclusive = c.pricesIncludeGst
    ? ' Menu prices include GST, so the GST inside each price is taken out to reach the taxable value.'
    : '';
  if (!text && !inclusive) return null;
  return (
    <p className="mt-2 text-xs text-muted">
      {text}
      {inclusive}
    </p>
  );
}

function Reconciliation({
  id,
  title,
  intro,
  lines,
  top,
}: {
  id: string;
  title: string;
  intro: string;
  lines: ReconLine[];
  top?: React.ReactNode;
}) {
  return (
    <div id={id} className="scroll-mt-28 print:break-inside-avoid">
      <Card title={title}>
        <p className="mb-3 text-xs text-muted">{intro}</p>
        <ul className="flex flex-col text-sm">
          {lines.map((l, i) => (
            <LedgerRow key={`${i}-${l.label}`} line={l} />
          ))}
        </ul>
        {top}
      </Card>
    </div>
  );
}

/** How one step reads: its word ("Less", "Add") and its signed amount. Amounts are signed in the data (a "less" step is negative), so the steps add up; a step of nothing carries no sign. */
function ledgerStep(l: ReconLine): { word: string; shown: string; zero: boolean } {
  const zero = Math.round(l.amountInr * 100) === 0;
  const abs = money(Math.abs(l.amountInr));
  if (l.kind === 'less') return { word: 'Less: ', shown: zero ? abs : `− ${abs}`, zero };
  if (l.kind === 'add') return { word: 'Add: ', shown: zero ? abs : `${l.amountInr < 0 ? '−' : '+'} ${abs}`, zero };
  return { word: '', shown: money(l.amountInr), zero: false };
}

function LedgerRow({ line }: { line: ReconLine }) {
  const { word, shown, zero } = ledgerStep(line);
  const total = line.kind === 'total';
  const tone = total
    ? 'mt-1 rounded-md border-t-2 border-charcoal bg-surface px-2 py-2 font-bold text-charcoal'
    : line.kind === 'subtotal'
      ? 'border-t border-line py-2 font-semibold text-charcoal print:py-1'
      : line.kind === 'start'
        ? 'py-2 font-semibold text-charcoal print:py-1'
        : `${ROW} py-2 text-charcoal print:py-1`;
  return (
    <li className={`grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 ${tone}`}>
      <span className="min-w-0">
        <span>
          {word ? <span className="font-normal text-muted">{word}</span> : null}
          {line.label}
        </span>
        {line.note ? <span className="block text-xs font-normal text-muted">{line.note}</span> : null}
      </span>
      <span className={`whitespace-nowrap text-right font-mono tabular-nums ${total ? 'text-base' : ''} ${zero ? 'text-muted' : ''}`}>
        {shown}
      </span>
    </li>
  );
}

// ── Tables ───────────────────────────────────────────────────────────────────

/** One column of a return table, named as the portal or the offline tool names it. */
interface Col<T> {
  head: string;
  cell: (r: T) => React.ReactNode;
  /** Right-aligned monospace figures. */
  num?: boolean;
  /** Extra classes for this cell in one row (a nil row is muted, say). */
  tone?: (r: T) => string;
  /** The cell in the Total row. */
  total?: React.ReactNode;
  /** On a phone this column is already in the card's title, so its list leaves it out. */
  inTitle?: boolean;
  /** Width class for the header cell. */
  w?: string;
}

/**
 * A return table. From the sm breakpoint (and in print) it is a real table that
 * scrolls inside its card if it is wider than the card; on a phone it becomes one
 * small card per row, so the figures are not off-screen to the right.
 */
function DataTable<T>({
  cols,
  rows,
  rowKey,
  empty,
  tableClass,
  dense,
  title,
  quiet,
}: {
  cols: Col<T>[];
  rows: T[];
  rowKey: (r: T, i: number) => string;
  empty: string;
  /** Minimum width on screen, so a wide table scrolls rather than squeezes. */
  tableClass: string;
  dense?: boolean;
  /** The phone card's title; by default the first column's cell. */
  title?: (r: T) => React.ReactNode;
  /** A row with nothing in it: its phone card says so instead of listing zeros. */
  quiet?: (r: T) => boolean;
}) {
  const last = cols.length - 1;
  const hasTotal = rows.length > 0 && cols.some((c) => c.total !== undefined);
  const listed = title ? cols.filter((c) => !c.inTitle) : cols.slice(1);
  const head = title ?? cols[0].cell;
  return (
    <>
      <div className="hidden overflow-x-auto sm:block print:block print:overflow-visible">
        <table className={`w-full text-sm tabular-nums print:min-w-0 ${dense ? 'print:text-[10px]' : 'print:text-[11px]'} ${tableClass}`}>
          <thead>
            <tr className={HEAD_ROW}>
              {cols.map((c, i) => (
                <th key={c.head} className={`${c.num ? THR : TH} ${i === last ? 'pr-0' : ''} ${c.w ?? ''}`}>
                  {c.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, n) => (
              <tr key={rowKey(r, n)} className={ROW}>
                {cols.map((c, i) => (
                  <td key={c.head} className={`${c.num ? TDR : TD} ${i === last ? 'pr-0' : ''} ${c.tone?.(r) ?? ''}`}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr className={ROW}>
                <td colSpan={cols.length} className="py-2 text-xs text-muted">
                  {empty}
                </td>
              </tr>
            ) : null}
          </tbody>
          {hasTotal ? (
            <tfoot>
              <tr className={TOTAL_ROW}>
                {cols.map((c, i) => (
                  <td key={c.head} className={`${c.num ? TDR : TD} ${i === last ? 'pr-0' : ''}`}>
                    {i === 0 ? 'Total' : c.total}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      <ul className="flex flex-col gap-2 sm:hidden print:hidden">
        {rows.map((r, n) => (
          <li key={rowKey(r, n)} className="rounded-md border border-line p-3 text-sm">
            <div className="text-charcoal">{head(r)}</div>
            {quiet?.(r) ? (
              <p className="mt-1 text-xs text-muted">Every amount is 0.00.</p>
            ) : (
              <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
                {listed.map((c) => (
                  <PhoneField key={c.head} term={c.head} tone={c.tone?.(r)} num={c.num}>
                    {c.cell(r)}
                  </PhoneField>
                ))}
              </dl>
            )}
          </li>
        ))}
        {rows.length === 0 ? <li className="text-xs text-muted">{empty}</li> : null}
        {hasTotal ? (
          <li className="rounded-md border-t-2 border-charcoal bg-surface p-3 text-sm font-bold text-charcoal">
            Total
            <dl className="mt-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1">
              {cols
                .filter((c) => c.total !== undefined)
                .map((c) => (
                  <PhoneField key={c.head} term={c.head} num={c.num} strong>
                    {c.total}
                  </PhoneField>
                ))}
            </dl>
          </li>
        ) : null}
      </ul>
    </>
  );
}

function PhoneField({
  term,
  tone,
  num,
  strong,
  children,
}: {
  term: string;
  tone?: string;
  num?: boolean;
  strong?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className={strong ? 'font-bold' : 'text-muted'}>{term}</dt>
      <dd className={`text-right ${num ? 'font-mono tabular-nums' : ''} ${tone ?? ''}`}>{children}</dd>
    </>
  );
}

const sum = (xs: number[]): number => xs.reduce((s, x) => s + Math.round(x * 100), 0) / 100;

// ── GSTR-3B ──────────────────────────────────────────────────────────────────

function Gstr3b({ rows }: { rows: Gstr3bRow[] }) {
  const main = rows.filter((r) => !r.code.startsWith('3.1.1'));
  const eco = rows.filter((r) => r.code.startsWith('3.1.1'));
  const amountCol = (head: string, pick: (r: Gstr3bRow) => number): Col<Gstr3bRow> => ({
    head,
    num: true,
    cell: (r) => amount(pick(r)),
    tone: (r) => (r.applies ? 'font-semibold text-charcoal' : 'text-muted'),
  });
  const cols: Col<Gstr3bRow>[] = [
    {
      head: 'Nature of Supplies',
      w: 'w-[40%]',
      cell: (r) => (
        <>
          <span className={`font-mono text-xs ${r.applies ? 'font-bold text-charcoal' : 'text-muted'}`}>{r.code}</span>{' '}
          <span className={r.applies ? 'font-semibold text-charcoal' : 'text-charcoal'}>{r.label}</span>
          {r.note ? <span className="mt-0.5 block text-xs font-normal text-muted">{r.note}</span> : null}
        </>
      ),
    },
    amountCol('Total Taxable value', (r) => r.amounts.taxableValueInr),
    amountCol('Integrated Tax', (r) => r.amounts.igstInr),
    amountCol('Central Tax', (r) => r.amounts.cgstInr),
    amountCol('State/UT Tax', (r) => r.amounts.sgstInr),
    amountCol('Cess', (r) => r.amounts.cessInr),
  ];
  return (
    <div id="gstr3b" className="scroll-mt-28">
      <Card title="GSTR-3B (Table 3.1)">
        <p className="mb-4 text-xs text-muted">
          The tax return you pay with. Only the first row applies to a café selling food and drinks; the rest are nil, and the
          line under each says why.
        </p>
        <div className="print:break-inside-avoid">
          <h3 className="mb-1 text-sm font-bold text-charcoal">3.1 {GSTR3B_TABLE_31_HEADING}</h3>
          <DataTable cols={cols} rows={main} rowKey={(r) => r.code} empty="No rows." tableClass="min-w-[760px]" quiet={(r) => !r.applies} />
        </div>
        {eco.length ? (
          <div className="mt-5 print:break-inside-avoid">
            <h3 className="mb-1 text-sm font-bold text-charcoal">
              3.1.1 Details of supplies notified under section 9(5) of the CGST Act, 2017 and corresponding provisions in
              IGST/UTGST/SGST Acts
            </h3>
            <DataTable cols={cols} rows={eco} rowKey={(r) => r.code} empty="No rows." tableClass="min-w-[760px]" quiet={(r) => !r.applies} />
          </div>
        ) : null}
        <p className="mt-3 text-xs text-muted">
          Payment (Table 6.1): pay the whole tax in cash. Input tax credit is nil for a restaurant at 5%.
        </p>
      </Card>
    </div>
  );
}

// ── GSTR-1 ───────────────────────────────────────────────────────────────────

function Gstr1({ c }: { c: GstComputation }) {
  const { b2cs, nilExempt, hsn, docs } = c.gstr1;
  // A Card, but written out so that in print the title, the intro and Table 7 stay together
  // while the rest of the tables can fall onto the next page.
  return (
    <div id="gstr1" className="scroll-mt-28">
      <section className="rounded-md border border-line bg-cream p-5 shadow-sm">
        <div className="print:break-inside-avoid">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-charcoal">GSTR-1 (your sales return)</h2>
          <p className="text-xs text-muted">
            The return that lists your sales. A café with walk-in customers only fills four tables; the columns below are the
            ones the GST portal and the offline tool use.
          </p>
          <TableBlock
            tag="Table 7"
            title="B2C (small) sales"
            caption="Sales to customers with no GSTIN, added up for each tax rate. It is all within the state, so the place of supply is always the same. The tax columns are for reading; the offline tool works them out."
            first
          >
            <Table7 rows={b2cs} />
          </TableBlock>
        </div>
        <TableBlock
          tag="Table 8"
          title="Nil-rated, exempted and non-GST supplies"
          caption="Sales that carry no GST. A café only ever has the last row (customers without a GSTIN, inside the state); the others stay at zero."
        >
          <Table8 rows={nilExempt} />
        </TableBlock>
        <TableBlock
          tag="Table 12"
          title="HSN / SAC summary"
          caption="Your sales grouped by the government's code: 996331 is restaurant service and 0901 is roasted coffee beans. It adds up to Tables 7 and 8 together."
        >
          <Table12 rows={hsn} />
        </TableBlock>
        <TableBlock
          tag="Table 13"
          title="Documents issued"
          caption="Your invoice numbers for the month: the first and last, how many were used and how many were cancelled."
        >
          <Table13 rows={docs} />
        </TableBlock>
      </section>
    </div>
  );
}

function TableBlock({
  tag,
  title,
  caption,
  first,
  children,
}: {
  tag: string;
  title: string;
  caption: string;
  first?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={`print:break-inside-avoid ${first ? 'mt-4' : 'mt-6 border-t border-[#f2efe9] pt-4'}`}>
      <h3 className="flex flex-wrap items-baseline gap-x-2 text-sm font-bold text-charcoal">
        <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-xs text-tan-dark">{tag}</span>
        {title}
      </h3>
      <p className="mb-2 mt-1 text-xs text-muted">{caption}</p>
      {children}
    </div>
  );
}

function Table7({ rows }: { rows: B2csRow[] }) {
  const cols: Col<B2csRow>[] = [
    { head: 'Type', cell: (r) => r.type, tone: () => 'font-mono' },
    { head: 'Place Of Supply', cell: (r) => r.placeOfSupply, tone: () => 'whitespace-nowrap' },
    { head: 'Applicable % of Tax Rate', num: true, cell: (r) => r.applicablePercent || '—' },
    { head: 'Rate', num: true, inTitle: true, cell: (r) => percent(r.rate) },
    { head: 'Taxable Value', num: true, cell: (r) => amount(r.taxableValueInr), total: amount(sum(rows.map((r) => r.taxableValueInr))) },
    { head: 'Cess Amount', num: true, cell: (r) => amount(r.cessInr), total: amount(sum(rows.map((r) => r.cessInr))) },
    { head: 'E-Commerce GSTIN', cell: (r) => r.ecommerceGstin || '—', tone: () => 'font-mono' },
    { head: 'CGST', num: true, cell: (r) => amount(r.cgstInr), total: amount(sum(rows.map((r) => r.cgstInr))) },
    { head: 'SGST', num: true, cell: (r) => amount(r.sgstInr), total: amount(sum(rows.map((r) => r.sgstInr))) },
  ];
  return (
    <DataTable
      cols={cols}
      rows={rows}
      rowKey={(r, i) => `${r.rate}-${i}`}
      empty="No taxable sales in these dates."
      tableClass="min-w-[820px]"
      title={(r) => <span className="font-bold">{percent(r.rate)} rate</span>}
    />
  );
}

function Table8({ rows }: { rows: NilExemptRow[] }) {
  const any = (r: NilExemptRow) => r.nilRatedInr !== 0 || r.exemptedInr !== 0 || r.nonGstInr !== 0;
  const tone = (r: NilExemptRow) => (any(r) ? 'text-charcoal' : 'text-muted');
  const cols: Col<NilExemptRow>[] = [
    { head: 'Description', cell: (r) => <span className={any(r) ? 'font-semibold text-charcoal' : 'text-charcoal'}>{r.description}</span> },
    { head: 'Nil Rated Supplies', num: true, tone, cell: (r) => amount(r.nilRatedInr), total: amount(sum(rows.map((r) => r.nilRatedInr))) },
    {
      head: 'Exempted (other than nil rated/non GST supply)',
      num: true,
      tone,
      cell: (r) => amount(r.exemptedInr),
      total: amount(sum(rows.map((r) => r.exemptedInr))),
    },
    { head: 'Non-GST Supplies', num: true, tone, cell: (r) => amount(r.nonGstInr), total: amount(sum(rows.map((r) => r.nonGstInr))) },
  ];
  return (
    <DataTable cols={cols} rows={rows} rowKey={(r) => r.description} empty="Nothing to show." tableClass="min-w-[640px]" quiet={(r) => !any(r)} />
  );
}

function Table12({ rows }: { rows: HsnRow[] }) {
  const cols: Col<HsnRow>[] = [
    { head: 'HSN', inTitle: true, cell: (r) => r.hsn, tone: () => 'font-mono font-semibold text-charcoal' },
    { head: 'Description', inTitle: true, cell: (r) => r.description, tone: () => 'whitespace-nowrap text-charcoal' },
    { head: 'UQC', cell: (r) => r.uqc, tone: () => 'whitespace-nowrap font-mono text-xs' },
    { head: 'Total Quantity', num: true, cell: (r) => r.quantity.toLocaleString('en-IN', { maximumFractionDigits: 3 }) },
    { head: 'Total Value', num: true, cell: (r) => amount(r.totalValueInr), total: amount(sum(rows.map((r) => r.totalValueInr))) },
    { head: 'Rate', num: true, inTitle: true, cell: (r) => percent(r.rate) },
    { head: 'Taxable Value', num: true, cell: (r) => amount(r.taxableValueInr), total: amount(sum(rows.map((r) => r.taxableValueInr))) },
    { head: 'Integrated Tax Amount', num: true, cell: (r) => amount(r.igstInr), total: amount(sum(rows.map((r) => r.igstInr))) },
    { head: 'Central Tax Amount', num: true, cell: (r) => amount(r.cgstInr), total: amount(sum(rows.map((r) => r.cgstInr))) },
    { head: 'State/UT Tax Amount', num: true, cell: (r) => amount(r.sgstInr), total: amount(sum(rows.map((r) => r.sgstInr))) },
    { head: 'Cess Amount', num: true, cell: (r) => amount(r.cessInr), total: amount(sum(rows.map((r) => r.cessInr))) },
  ];
  return (
    <DataTable
      cols={cols}
      rows={rows}
      rowKey={(r, i) => `${r.hsn}-${r.rate}-${i}`}
      empty="Nothing was sold in these dates."
      tableClass="min-w-[1040px]"
      dense
      title={(r) => (
        <span className="font-bold">
          <span className="font-mono">{r.hsn}</span> · {r.description} · {percent(r.rate)}
        </span>
      )}
    />
  );
}

function Table13({ rows }: { rows: DocsRow[] }) {
  const cols: Col<DocsRow>[] = [
    { head: 'Nature of Document', cell: (r) => <span className="font-semibold text-charcoal">{r.nature}</span> },
    { head: 'Sr. No. From', cell: (r) => r.fromNo || '—', tone: () => 'font-mono' },
    { head: 'Sr. No. To', cell: (r) => r.toNo || '—', tone: () => 'font-mono' },
    { head: 'Total Number', num: true, cell: (r) => num(r.totalNumber) },
    { head: 'Cancelled', num: true, cell: (r) => num(r.cancelled) },
    { head: 'Net Issued', num: true, tone: () => 'font-bold text-charcoal', cell: (r) => num(r.netIssued) },
  ];
  return <DataTable cols={cols} rows={rows} rowKey={(r) => r.nature} empty="No invoices were issued in these dates." tableClass="min-w-[620px]" />;
}

// ── Checks, notes, glossary ──────────────────────────────────────────────────

const CHECK_ORDER: Record<GstCheck['status'], number> = { warn: 0, info: 1, ok: 2 };

const CHECK_LOOK: Record<GstCheck['status'], { icon: string; badge: string; row: string; word: string }> = {
  ok: { icon: '✓', badge: 'bg-green-100 text-green-800', row: '', word: 'Passed' },
  warn: { icon: '!', badge: 'bg-amber-200 text-amber-900', row: 'bg-amber-50', word: 'Look at this' },
  info: { icon: 'i', badge: 'bg-sky-100 text-sky-900', row: '', word: 'For your information' },
};

function Checks({ checks }: { checks: GstCheck[] }) {
  const sorted = [...checks].sort((a, b) => CHECK_ORDER[a.status] - CHECK_ORDER[b.status]);
  const warn = checks.filter((k) => k.status === 'warn').length;
  return (
    <div id="checks" className="scroll-mt-28">
      <Card title="Checks before you file">
        <p className={`mb-3 text-sm font-semibold ${warn > 0 ? 'text-amber-800' : 'text-green-700'}`}>
          {checks.length === 0
            ? 'No checks were run.'
            : warn > 0
              ? `${warn} ${warn === 1 ? 'thing needs' : 'things need'} a look before you file.`
              : 'Nothing needs a look. Every check passed.'}
        </p>
        <ul className="flex flex-col overflow-hidden rounded-md border border-line">
          {sorted.map((k, i) => {
            const look = CHECK_LOOK[k.status];
            return (
              <li
                key={`${i}-${k.title}`}
                className={`flex gap-3 border-t border-[#f2efe9] px-3 py-2.5 first:border-t-0 print:break-inside-avoid ${look.row}`}
              >
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${look.badge}`}
                >
                  {look.icon}
                </span>
                <div className="min-w-0 text-sm">
                  <p className="font-bold text-charcoal">
                    <span className="sr-only">{look.word}: </span>
                    {k.title}
                  </p>
                  <p className="text-muted">{k.detail}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

const DETAILS = 'group rounded-md border border-line bg-cream p-5 shadow-sm print:break-inside-avoid print:shadow-none';
const SUMMARY =
  'flex min-h-[28px] cursor-pointer list-none items-center justify-between gap-3 text-sm font-bold uppercase tracking-wide text-charcoal [&::-webkit-details-marker]:hidden';

function Chevron() {
  return (
    <span aria-hidden="true" className="text-muted transition-transform group-open:rotate-90 print:hidden">
      ▸
    </span>
  );
}

function Notes({ c }: { c: GstComputation }) {
  return (
    <div id="notes" className="scroll-mt-28 flex flex-col gap-5">
      <Card title="Notes for your CA">
        {c.notes.length > 0 ? (
          <ul className="list-disc space-y-1.5 pl-5 text-sm text-charcoal">
            {c.notes.map((n, i) => (
              <li key={`${i}-${n}`}>{n}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">No notes for these dates.</p>
        )}
      </Card>
      <details data-print-open="" className={DETAILS}>
        <summary className={SUMMARY}>
          What do these words mean?
          <Chevron />
        </summary>
        <dl className="mt-3 grid gap-x-6 gap-y-3 text-sm md:grid-cols-2">
          {c.glossary.map((g) => (
            <div key={g.term} className="min-w-0 print:break-inside-avoid">
              <dt className="font-bold text-charcoal">{g.term}</dt>
              <dd className="text-muted">{g.meaning}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}

// ── Day-wise register ────────────────────────────────────────────────────────

function DayRegister({ c, from, to }: { c: GstComputation; from: string; to: string }) {
  const days = c.dayRegister;
  const t = {
    bills: days.reduce((s, d) => s + d.bills, 0),
    cancelled: days.reduce((s, d) => s + d.cancelled, 0),
    taxable: sum(days.map((d) => d.taxableValueInr)),
    cgst: sum(days.map((d) => d.cgstInr)),
    sgst: sum(days.map((d) => d.sgstInr)),
    exempt: sum(days.map((d) => d.exemptValueInr)),
    invoice: sum(days.map((d) => d.invoiceValueInr)),
  };
  return (
    <div id="days" className="scroll-mt-28 flex flex-col gap-5">
      <details data-print-open="" className={`${DETAILS} print:break-before-page`}>
        <summary className={SUMMARY}>
          Day-wise register ({num(days.length)} {days.length === 1 ? 'day' : 'days'})
          <Chevron />
        </summary>
        <p className="mb-2 mt-3 text-xs text-muted">
          One line a day: the first and last invoice number used, the bills issued and cancelled, and the amounts. A day with no
          bills shows dashes.{' '}
          <a href={exportHref('gst-day-register', from, to)} className="font-semibold text-charcoal underline print:hidden">
            Download as CSV
          </a>
          <span className="sm:hidden print:hidden"> Swipe the table sideways to see the amounts.</span>
        </p>
        <div className="overflow-x-auto print:overflow-visible">
          <table className="w-full min-w-[900px] text-sm tabular-nums print:min-w-0 print:text-[10px]">
            <thead>
              <tr className={HEAD_ROW}>
                <th className={`${TH} sticky left-0 bg-cream print:static`}>Date</th>
                <th className={TH}>First invoice</th>
                <th className={TH}>Last invoice</th>
                <th className={THR}>Bills</th>
                <th className={THR}>Cancelled</th>
                <th className={THR}>Taxable value</th>
                <th className={THR}>CGST</th>
                <th className={THR}>SGST</th>
                <th className={THR}>Exempt</th>
                <th className={`${THR} pr-0`}>Invoice value</th>
              </tr>
            </thead>
            <tbody>
              {days.map((d) => (
                <DayLine key={d.date} d={d} />
              ))}
            </tbody>
            <tfoot>
              <tr className={TOTAL_ROW}>
                <td className={`${TD} sticky left-0 bg-cream print:static`} colSpan={3}>
                  Total
                </td>
                <td className={TDR}>{num(t.bills)}</td>
                <td className={TDR}>{num(t.cancelled)}</td>
                <td className={TDR}>{amount(t.taxable)}</td>
                <td className={TDR}>{amount(t.cgst)}</td>
                <td className={TDR}>{amount(t.sgst)}</td>
                <td className={TDR}>{amount(t.exempt)}</td>
                <td className={`${TDR} pr-0`}>{amount(t.invoice)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </details>
      <Card title="Every invoice">
        <p className="text-sm text-charcoal">
          The invoice-by-invoice register has one line for each of the {num(c.invoiceRegister.length)}{' '}
          {c.invoiceRegister.length === 1 ? 'bill' : 'bills'} in these dates, cancelled ones included and marked. It is too long
          for the screen, so it is a download.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
          <a href={exportHref('gst-invoice-register', from, to)} className={BUTTON}>
            Download invoice register (CSV)
          </a>
          <span className="text-xs text-muted">It is also a tab in the Excel file for your CA.</span>
        </div>
        <p className="hidden text-xs text-muted print:block">It is also a tab in the Excel file for your CA.</p>
      </Card>
    </div>
  );
}

function DayLine({ d }: { d: GstDayRow }) {
  const empty = d.bills === 0 && d.cancelled === 0;
  const cell = `${TDR} ${empty ? 'text-muted' : 'text-charcoal'}`;
  const money2 = (n: number) => (empty ? '—' : amount(n));
  return (
    <tr className={ROW}>
      <td className={`${TD} sticky left-0 whitespace-nowrap bg-cream font-semibold text-charcoal print:static`}>{shortDate(d.date)}</td>
      <td className={`${TD} font-mono ${empty ? 'text-muted' : 'text-charcoal'}`}>{d.firstInvoice || '—'}</td>
      <td className={`${TD} font-mono ${empty ? 'text-muted' : 'text-charcoal'}`}>{d.lastInvoice || '—'}</td>
      <td className={cell}>{empty ? '—' : num(d.bills)}</td>
      <td className={`${cell} ${d.cancelled ? 'text-amber-800' : ''}`}>{d.cancelled ? num(d.cancelled) : '—'}</td>
      <td className={cell}>{money2(d.taxableValueInr)}</td>
      <td className={cell}>{money2(d.cgstInr)}</td>
      <td className={cell}>{money2(d.sgstInr)}</td>
      <td className={cell}>{empty || d.exemptValueInr === 0 ? '—' : amount(d.exemptValueInr)}</td>
      <td className={`${cell} pr-0 font-semibold`}>{money2(d.invoiceValueInr)}</td>
    </tr>
  );
}
