// The GST filing pack as sheets (CsvTable), each rendered FROM the GstComputation
// (lib/reports/exports/gstComputation.ts) so a CSV, the owner's page and the CA's
// workbook show the same figures:
//   • gstSummary    one clean working: tax to pay, GSTR-3B Table 3.1, the two
//                   reconciliations, checks and notes, in blank-line-separated
//                   sections (no paragraph cells)
//   • b2cs          GSTR-1 Table 7        — the GST offline tool's b2cs.csv
//   • exemptTable   GSTR-1 Table 8        — exemp.csv
//   • hsnB2c        GSTR-1 Table 12 (B2C) — hsn(b2c).csv
//   • docsIssued    GSTR-1 Table 13       — docs.csv
//   • dayRegister, invoiceRegister — the day-by-day and bill-by-bill registers
// The five import files carry exactly the offline tool's columns and no totals row.
// Pure and unit-tested; lib/reports/exports/gstReportsServer.ts loads the computation.

import type { CsvTable, CsvValue } from '@/lib/reports/csv';
import { GSTR3B_TABLE_31_HEADING, longDate } from '@/lib/reports/exports/gstComputation';
import type { GstComputation, ReconLine } from '@/lib/reports/exports/gstTypes';

const paise = (n: number): number => Math.round(n * 100);
const inr = (p: number): number => p / 100;
const sum = <T>(list: readonly T[], f: (x: T) => number): number => inr(list.reduce((s, x) => s + paise(f(x)), 0));

/** '2026-10-20T08:35:00.000Z' → '20 Oct 2026, 14:05 IST'. */
function preparedOn(iso: string): string {
  const ist = new Date(Date.parse(iso) + 5.5 * 60 * 60 * 1000).toISOString();
  return `${longDate(ist.slice(0, 10))}, ${ist.slice(11, 16)} IST`;
}

const BLANK: CsvValue[] = [];

// ── Summary ─────────────────────────────────────────────────────────────────

const STEP_PREFIX: Record<ReconLine['kind'], string> = {
  start: '',
  add: 'Add: ',
  less: 'Less: ',
  subtotal: 'Subtotal: ',
  total: 'Equals: ',
};

const CHECK_LABEL = { ok: 'OK', warn: 'Look at this', info: 'Note' } as const;

export function gstSummary(c: GstComputation): CsvTable {
  const { business: b, period: p } = c;
  const rows: CsvValue[][] = [];
  const section = (title: string) => {
    rows.push(BLANK, [title]);
  };

  rows.push(['Business', `${b.legalName} (${b.tradeName})`]);
  rows.push(['GSTIN', b.gstin]);
  rows.push(['State', b.stateName ? `${b.stateCode} - ${b.stateName}` : b.stateCode]);
  rows.push(['Address', b.address]);
  rows.push(['Period', p.from === p.to ? longDate(p.from) : `${longDate(p.from)} to ${longDate(p.to)}`]);
  rows.push(['Return period', p.returnPeriod ?? 'Not a whole month']);
  rows.push(['Financial year', p.financialYear]);
  rows.push(['Prepared on', preparedOn(c.generatedAt)]);

  section(`Tax to pay (all in cash: a restaurant at ${c.ratePercent}% takes no input tax credit)`);
  rows.push(['CGST', c.taxPayable.cgstInr]);
  rows.push(['SGST', c.taxPayable.sgstInr]);
  if (c.taxPayable.igstInr !== 0) rows.push(['IGST', c.taxPayable.igstInr]);
  if (c.taxPayable.cessInr !== 0) rows.push(['Cess', c.taxPayable.cessInr]);
  rows.push(['Total GST to pay', c.taxPayable.totalInr]);
  if (p.gstr1DueDate && p.gstr3bDueDate) {
    rows.push(['GSTR-1 due', longDate(p.gstr1DueDate)]);
    rows.push(['GSTR-3B due, with payment', longDate(p.gstr3bDueDate)]);
  } else {
    rows.push(['Due dates', 'Not a whole month']);
  }

  section('Bills');
  rows.push(['Bills issued', c.counts.issuedBills]);
  rows.push(['Bills cancelled or rejected', c.counts.cancelledBills]);

  section(`GSTR-3B Table 3.1: ${GSTR3B_TABLE_31_HEADING}`);
  rows.push([
    'Nature of supplies',
    'Total taxable value (INR)',
    'Integrated tax (INR)',
    'Central tax (INR)',
    'State/UT tax (INR)',
    'Cess (INR)',
  ]);
  for (const r of c.gstr3b) {
    rows.push([
      `${r.code} ${r.label}`,
      r.amounts.taxableValueInr,
      r.amounts.igstInr,
      r.amounts.cgstInr,
      r.amounts.sgstInr,
      r.amounts.cessInr,
    ]);
  }

  const recon = (title: string, lines: readonly ReconLine[]) => {
    section(title);
    rows.push(['Step', 'Amount (INR)']);
    for (const l of lines) rows.push([`${STEP_PREFIX[l.kind]}${l.label}`, l.amountInr]);
  };
  recon('From sales to taxable value', c.toTaxableValue);
  recon('From taxable value to the bills’ totals', c.toInvoiceValue);

  section('Checks before you file');
  rows.push(['Result', 'Check', 'Detail']);
  for (const k of c.checks) rows.push([CHECK_LABEL[k.status], k.title, k.detail]);

  section('Notes for your CA');
  for (const n of c.notes) rows.push([n]);

  return { columns: [`GST working for ${p.label}`], rows };
}

// ── GSTR-1 Table 7: B2C small (b2cs.csv) ────────────────────────────────────

export function b2cs(c: GstComputation): CsvTable {
  return {
    columns: [
      'Type',
      'Place Of Supply',
      'Applicable % of Tax Rate',
      'Rate',
      'Taxable Value',
      'Cess Amount',
      'E-Commerce GSTIN',
    ],
    rows: c.gstr1.b2cs.map((r): CsvValue[] => [
      r.type,
      r.placeOfSupply,
      r.applicablePercent,
      r.rate,
      r.taxableValueInr,
      r.cessInr,
      r.ecommerceGstin,
    ]),
  };
}

// ── GSTR-1 Table 8: nil rated, exempted and non-GST supplies (exemp.csv) ────

export function exemptTable(c: GstComputation): CsvTable {
  return {
    columns: ['Description', 'Nil Rated Supplies', 'Exempted(other than nil rated/non GST supply)', 'Non-GST Supplies'],
    rows: c.gstr1.nilExempt.map((r): CsvValue[] => [r.description, r.nilRatedInr, r.exemptedInr, r.nonGstInr]),
  };
}

// ── GSTR-1 Table 12: HSN / SAC summary, B2C tab (hsn(b2c).csv) ──────────────

export function hsnB2c(c: GstComputation): CsvTable {
  return {
    columns: [
      'HSN',
      'Description',
      'UQC',
      'Total Quantity',
      'Total Value',
      'Rate',
      'Taxable Value',
      'Integrated Tax Amount',
      'Central Tax Amount',
      'State/UT Tax Amount',
      'Cess Amount',
    ],
    rows: c.gstr1.hsn.map((r): CsvValue[] => [
      r.hsn,
      r.description,
      r.uqc,
      r.quantity,
      r.totalValueInr,
      r.rate,
      r.taxableValueInr,
      r.igstInr,
      r.cgstInr,
      r.sgstInr,
      r.cessInr,
    ]),
  };
}

// ── GSTR-1 Table 13: documents issued (docs.csv) ────────────────────────────

export function docsIssued(c: GstComputation): CsvTable {
  return {
    columns: ['Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled'],
    rows: c.gstr1.docs.map((r): CsvValue[] => [r.nature, r.fromNo, r.toNo, r.totalNumber, r.cancelled]),
  };
}

// ── Registers ───────────────────────────────────────────────────────────────

export function dayRegister(c: GstComputation): CsvTable {
  const days = c.dayRegister;
  const rows: CsvValue[][] = days.map((d): CsvValue[] => [
    d.date,
    d.firstInvoice,
    d.lastInvoice,
    d.bills,
    d.cancelled,
    d.taxableValueInr,
    d.cgstInr,
    d.sgstInr,
    d.exemptValueInr,
    d.invoiceValueInr,
  ]);
  rows.push([
    'Total',
    '',
    '',
    days.reduce((s, d) => s + d.bills, 0),
    days.reduce((s, d) => s + d.cancelled, 0),
    sum(days, (d) => d.taxableValueInr),
    sum(days, (d) => d.cgstInr),
    sum(days, (d) => d.sgstInr),
    sum(days, (d) => d.exemptValueInr),
    sum(days, (d) => d.invoiceValueInr),
  ]);
  return {
    columns: [
      'Date',
      'First invoice',
      'Last invoice',
      'Bills issued',
      'Cancelled or rejected',
      'Taxable value (INR)',
      'CGST (INR)',
      'SGST (INR)',
      'GST-exempt sales (INR)',
      'Invoice value (INR)',
    ],
    rows,
  };
}

export function invoiceRegister(c: GstComputation): CsvTable {
  const all = c.invoiceRegister;
  const issued = all.filter((r) => r.status === 'Issued');
  const rows: CsvValue[][] = all.map((r): CsvValue[] => [
    r.invoiceNo,
    r.date,
    r.time,
    r.status,
    r.gstBasis,
    r.taxableValueInr,
    r.cgstInr,
    r.sgstInr,
    r.exemptValueInr,
    r.packagingInr,
    r.discountInr,
    r.invoiceValueInr,
    r.paymentMode,
  ]);
  // Cancelled and rejected bills show what was printed but count in no total.
  rows.push([
    'Total of issued bills',
    '',
    '',
    `${issued.length} issued`,
    '',
    sum(issued, (r) => r.taxableValueInr),
    sum(issued, (r) => r.cgstInr),
    sum(issued, (r) => r.sgstInr),
    sum(issued, (r) => r.exemptValueInr),
    sum(issued, (r) => r.packagingInr),
    sum(issued, (r) => r.discountInr),
    sum(issued, (r) => r.invoiceValueInr),
    '',
  ]);
  return {
    columns: [
      'Invoice no.',
      'Date',
      'Time',
      'Status',
      'GST basis',
      'Taxable value (INR)',
      'CGST (INR)',
      'SGST (INR)',
      'GST-exempt sales (INR)',
      'Packaging charged (INR)',
      'Discount (INR)',
      'Invoice value (INR)',
      'Paid by',
    ],
    rows,
  };
}
