// The CA's Excel workbook for a period's GST: one finished file the accountant
// can file the month's GSTR-1 and GSTR-3B from. Rendered from the same
// GstComputation the owner's GST page and the GST CSVs use, so every view shows
// the same figures.
//
// Sheets, in order: Summary (business, tax to pay, GSTR-3B Table 3.1 / 3.1.1,
// GSTR-1 at a glance, the two reconciliations, checks, notes), one sheet per
// GSTR-1 table in the offline tool's columns, the day-wise and invoice
// registers, and a glossary. Static values only — no formulas — so the file is
// identical to the screen and nothing in a cell can run.
//
// Money is stored as numbers (format #,##,##0.00); HSN/SAC codes and invoice
// numbers are stored as TEXT so 0901 keeps its zero.

import 'server-only';
import ExcelJS from 'exceljs';
import { round2 } from '@/lib/reports/csv';
import { GSTR3B_TABLE_31_HEADING } from '@/lib/reports/exports/gstComputation';
import { wholeMonthOf } from '@/lib/reports/exports/period';
import type {
  DocsRow,
  GstComputation,
  Gstr3bRow,
  ReconLine,
} from '@/lib/reports/exports/gstTypes';

export const XLSX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Money: Indian-style grouping where the viewer's Excel supports it, plain thousands otherwise. */
export const MONEY_FORMAT = '#,##,##0.00';
export const COUNT_FORMAT = '#,##0';
export const QUANTITY_FORMAT = '#,##0.000';
export const RATE_FORMAT = '0.00';
export const DATE_FORMAT = 'dd-mmm-yyyy';
const TEXT_FORMAT = '@';

export const SHEET_NAMES = {
  summary: 'Summary',
  b2cs: 'GSTR-1 Table 7 (B2CS)',
  nilExempt: 'GSTR-1 Table 8 (Nil-Exempt)',
  hsn: 'GSTR-1 Table 12 (HSN)',
  docs: 'GSTR-1 Table 13 (Docs)',
  days: 'Day-wise register',
  invoices: 'Invoice register',
  glossary: 'Glossary',
} as const;

/** HIOC-GST-<GSTIN>-<MMYYYY for a whole month, else from_to_to>.xlsx */
export function gstWorkbookFileName(gstin: string, from: string, to: string): string {
  const safe = gstin.replace(/[^A-Za-z0-9]/g, '') || 'GSTIN';
  const month = wholeMonthOf(from, to);
  const period = month ? `${month.slice(5, 7)}${month.slice(0, 4)}` : `${from}_to_${to}`;
  return `HIOC-GST-${safe}-${period}.xlsx`;
}

// ---------------------------------------------------------------- palette

const C = {
  ink: 'FF232325',
  white: 'FFFFFFFF',
  brand: 'FF8A6446',
  surface: 'FFF6EFE9',
  sand: 'FFEFE4D8',
  band: 'FFFBF8F5',
  line: 'FFC9BEB3',
  muted: 'FF6B6560',
  greyText: 'FF8C8C8C',
  greyFill: 'FFF0F0F0',
  refHead: 'FF7A7570',
  ok: 'FF1E6B30',
  okFill: 'FFE7F4EA',
  warn: 'FF9A4D00',
  warnFill: 'FFFFF1D6',
  info: 'FF1F5E99',
  infoFill: 'FFE8F1FA',
  link: 'FF1F5E99',
};

// ---------------------------------------------------------------- cell helpers

type Align = 'left' | 'center' | 'right';

interface Style {
  bold?: boolean;
  italic?: boolean;
  size?: number;
  color?: string;
  fill?: string;
  h?: Align;
  v?: 'top' | 'middle' | 'bottom';
  wrap?: boolean;
  indent?: number;
  numFmt?: string;
  box?: boolean;
  underline?: boolean;
}

const THIN: ExcelJS.Border = { style: 'thin', color: { argb: C.line } };

function applyStyle(cell: ExcelJS.Cell, s: Style): void {
  cell.font = {
    name: 'Calibri',
    size: s.size ?? 11,
    bold: !!s.bold,
    italic: !!s.italic,
    underline: !!s.underline,
    color: { argb: s.color ?? C.ink },
  };
  if (s.fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: s.fill } };
  cell.alignment = {
    horizontal: s.h ?? 'left',
    vertical: s.v ?? 'middle',
    wrapText: !!s.wrap,
    indent: s.indent ?? 0,
  };
  if (s.numFmt) cell.numFmt = s.numFmt;
  if (s.box) cell.border = { top: THIN, left: THIN, bottom: THIN, right: THIN };
}

type Value = string | number | Date | null | ExcelJS.CellHyperlinkValue;

/** Writes one cell (or a merged run of cells, styled alike so borders and fills reach the edges). */
function put(ws: ExcelJS.Worksheet, row: number, col: number, value: Value, s: Style = {}, toCol = col): ExcelJS.Cell {
  if (toCol > col) ws.mergeCells(row, col, row, toCol);
  const cell = ws.getCell(row, col);
  cell.value = typeof value === 'number' && !Number.isFinite(value) ? 0 : value;
  for (let c = col; c <= toCol; c++) applyStyle(ws.getCell(row, c), s);
  return cell;
}

/** Adds a border side to the outer edge of a block without disturbing the inner borders. */
function outline(ws: ExcelJS.Worksheet, r1: number, r2: number, c1: number, c2: number, border: ExcelJS.Border): void {
  for (let r = r1; r <= r2; r++) {
    for (let c = c1; c <= c2; c++) {
      const cell = ws.getCell(r, c);
      const b = { ...(cell.border ?? {}) } as ExcelJS.Borders;
      if (r === r1) b.top = border;
      if (r === r2) b.bottom = border;
      if (c === c1) b.left = border;
      if (c === c2) b.right = border;
      cell.border = b;
    }
  }
}

function setBorderSide(cell: ExcelJS.Cell, side: 'top' | 'bottom', border: ExcelJS.Border): void {
  cell.border = { ...(cell.border ?? {}), [side]: border } as ExcelJS.Borders;
}

/** Lines a text takes in a column (or merged run) `width` characters wide. */
function lineCount(text: string, width: number, size = 11, bold = false): number {
  const perLine = Math.max(4, Math.floor(width * (11 / size) * (bold ? 1.05 : 1.15)));
  return text.split('\n').reduce((n, para) => n + Math.max(1, Math.ceil(para.length / perLine)), 0);
}

function rowHeightFor(lines: number, size = 11): number {
  return Math.max(18, Math.ceil(lines * size * 1.36) + 5);
}

/** Raises a row to at least `height` (rows with several wrapped cells take the tallest). */
function grow(ws: ExcelJS.Worksheet, row: number, height: number): void {
  const r = ws.getRow(row);
  r.height = Math.max(r.height ?? 0, height);
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** '2026-11-11' → '11 November 2026'. */
function longDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** An ISO instant as IST wall time: '2 November 2026, 10:11 am IST'. */
function istStamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t + 330 * 60_000);
  const h = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h % 12 || 12}:${mm} ${h < 12 ? 'am' : 'pm'} IST`;
}

/** 'YYYY-MM-DD' → a real Excel date (UTC midnight, so no day shifts). */
function excelDate(iso: string): Date | string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : iso;
}

/** ₹ with Indian grouping, for sentences: ₹4,50,000.00 */
export function formatInr(n: number): string {
  const v = round2(Math.abs(n)).toFixed(2);
  const [int, dec] = v.split('.');
  const grouped = int.length > 3 ? `${int.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${int.slice(-3)}` : int;
  return `${n < 0 ? '-' : ''}₹${grouped}.${dec}`;
}

const sum = (xs: number[]): number => round2(xs.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0));

/** '3.1(a)' → '(a)', '3.1.1(ii)' → '(ii)'. */
function rowPrefix(row: Gstr3bRow): string {
  if (/^\(\w+\)/.test(row.label)) return '';
  const m = /\(([a-z]+)\)$/i.exec(row.code);
  return m ? `(${m[1]}) ` : '';
}

// ---------------------------------------------------------------- print setup

function esc(s: string): string {
  return s.replace(/&/g, '&&');
}

function finishSheet(ws: ExcelJS.Worksheet, c: GstComputation, lastCol: number, lastRow: number, titleRows?: string): void {
  ws.pageSetup = {
    paperSize: 9, // A4
    orientation: 'landscape',
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    horizontalCentered: true,
    margins: { left: 0.4, right: 0.4, top: 0.8, bottom: 0.7, header: 0.3, footer: 0.3 },
    printArea: `A1:${ws.getColumn(lastCol).letter}${Math.max(lastRow, 1)}`,
    ...(titleRows ? { printTitlesRow: titleRows } : {}),
  };
  ws.headerFooter.oddHeader = `&L&B${esc(`HIOC · GSTIN ${c.business.gstin} · ${c.period.label}`)}&R${esc(c.business.legalName)}`;
  ws.headerFooter.oddFooter = `&L${esc(`GST working · prepared ${istStamp(c.generatedAt)}`)}&CPage &P of &N&R&A`;
}

// ---------------------------------------------------------------- generic data sheet

type Cellish = string | number | Date | null;

interface ColSpec {
  header: string;
  width: number;
  type: 'text' | 'center' | 'money' | 'count' | 'qty' | 'rate' | 'date';
  /** For reading only — not a column of the offline tool. Gets a grey heading. */
  ref?: boolean;
}

interface DataSheet {
  name: string;
  tab: string;
  title: string;
  subtitle: string;
  cols: ColSpec[];
  rows: Cellish[][];
  emptyText: string;
  totals?: { label: string; span: number; values: Cellish[] };
  footnote?: string;
  muted?: (rowIndex: number) => boolean;
  filter?: boolean;
  freezeCols?: number;
}

function bodyStyle(col: ColSpec): Style {
  switch (col.type) {
    case 'money':
      return { h: 'right', numFmt: MONEY_FORMAT, indent: 1 };
    case 'count':
      return { h: 'right', numFmt: COUNT_FORMAT, indent: 1 };
    case 'qty':
      return { h: 'right', numFmt: QUANTITY_FORMAT, indent: 1 };
    case 'rate':
      return { h: 'right', numFmt: RATE_FORMAT, indent: 1 };
    case 'date':
      return { h: 'center', numFmt: DATE_FORMAT };
    case 'center':
      return { h: 'center', numFmt: TEXT_FORMAT };
    default:
      return { h: 'left', numFmt: TEXT_FORMAT, indent: 1 };
  }
}

function addDataSheet(wb: ExcelJS.Workbook, c: GstComputation, d: DataSheet): ExcelJS.Worksheet {
  const n = d.cols.length;
  const ws = wb.addWorksheet(d.name, {
    properties: { tabColor: { argb: d.tab } },
    views: [{ state: 'frozen', xSplit: d.freezeCols ?? 0, ySplit: 3, showGridLines: false }],
  });
  d.cols.forEach((col, i) => (ws.getColumn(i + 1).width = col.width));
  const totalWidth = d.cols.reduce((a, col) => a + col.width, 0);

  put(ws, 1, 1, d.title, { bold: true, size: 14, color: C.white, fill: C.ink, indent: 1 }, n);
  ws.getRow(1).height = 28;

  put(ws, 2, 1, d.subtitle, { italic: true, color: C.muted, fill: C.surface, wrap: true, v: 'top', indent: 1 }, n);
  ws.getRow(2).height = rowHeightFor(lineCount(d.subtitle, totalWidth - 2, 11), 11);

  d.cols.forEach((col, i) => {
    put(ws, 3, i + 1, col.header, {
      bold: true,
      color: C.white,
      fill: col.ref ? C.refHead : C.brand,
      h: 'center',
      wrap: true,
      box: true,
    });
  });
  const headerLines = Math.max(...d.cols.map((col) => lineCount(col.header, col.width - 1, 11, true)));
  ws.getRow(3).height = rowHeightFor(headerLines);

  let r = 4;
  if (d.rows.length === 0) {
    put(ws, r, 1, d.emptyText, { italic: true, color: C.greyText, h: 'center', box: true }, n);
    ws.getRow(r).height = 22;
    r++;
  }
  d.rows.forEach((row, i) => {
    const muted = d.muted?.(i) ?? false;
    d.cols.forEach((col, j) => {
      const raw = row[j] ?? null;
      let value: Cellish = raw;
      if (raw !== null && (col.type === 'text' || col.type === 'center')) value = String(raw);
      if (value === '') value = null;
      const s: Style = { ...bodyStyle(col), box: true };
      if (muted) {
        s.color = C.greyText;
        s.fill = C.greyFill;
      } else if (d.rows.length > 6 && i % 2 === 1) {
        s.fill = C.band;
      }
      put(ws, r, j + 1, value, s);
    });
    ws.getRow(r).height = 18;
    r++;
  });
  const lastDataRow = r - 1;

  if (d.totals) {
    const t = d.totals;
    put(ws, r, 1, t.label, { bold: true, fill: C.sand, box: true, h: 'left', indent: 1 }, t.span);
    d.cols.forEach((col, j) => {
      if (j < t.span) return;
      const v = t.values[j] ?? null;
      put(ws, r, j + 1, v, { ...bodyStyle(col), bold: true, fill: C.sand, box: true });
    });
    for (let j = 1; j <= n; j++) setBorderSide(ws.getCell(r, j), 'top', { style: 'medium', color: { argb: C.ink } });
    ws.getRow(r).height = 20;
    r++;
  }

  if (d.footnote) {
    put(ws, r + 1, 1, d.footnote, { italic: true, color: C.muted, wrap: true, v: 'top' }, n);
    ws.getRow(r + 1).height = rowHeightFor(lineCount(d.footnote, totalWidth, 11));
    r += 2;
  }

  if (d.filter && d.rows.length > 0) {
    ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: lastDataRow, column: n } };
  }
  finishSheet(ws, c, n, r - 1, '3:3');
  return ws;
}

// ---------------------------------------------------------------- the GSTR-1 / register sheets

function addB2csSheet(wb: ExcelJS.Workbook, c: GstComputation): void {
  const rows = c.gstr1.b2cs;
  addDataSheet(wb, c, {
    name: SHEET_NAMES.b2cs,
    tab: C.brand,
    title: `GSTR-1 Table 7 — B2C (Small) supplies · ${c.period.label}`,
    subtitle:
      'Sales to consumers without a GSTIN, one line per tax rate. The dark-headed columns are the GST offline tool’s b2cs columns; the grey-headed columns are for checking and are not imported.',
    cols: [
      { header: 'Type', width: 10, type: 'center' },
      { header: 'Place Of Supply', width: 22, type: 'text' },
      { header: 'Applicable % of Tax Rate', width: 16, type: 'center' },
      { header: 'Rate', width: 10, type: 'rate' },
      { header: 'Taxable Value', width: 18, type: 'money' },
      { header: 'Cess Amount', width: 14, type: 'money' },
      { header: 'E-Commerce GSTIN', width: 20, type: 'text' },
      { header: 'Central Tax (for checking)', width: 17, type: 'money', ref: true },
      { header: 'State/UT Tax (for checking)', width: 17, type: 'money', ref: true },
    ],
    rows: rows.map((x) => [
      x.type, x.placeOfSupply, x.applicablePercent, x.rate, x.taxableValueInr, x.cessInr, x.ecommerceGstin, x.cgstInr, x.sgstInr,
    ]),
    emptyText: 'No taxable sales in this period.',
    totals: {
      label: 'TOTAL',
      span: 4,
      values: [
        null, null, null, null,
        sum(rows.map((x) => x.taxableValueInr)),
        sum(rows.map((x) => x.cessInr)),
        null,
        sum(rows.map((x) => x.cgstInr)),
        sum(rows.map((x) => x.sgstInr)),
      ],
    },
  });
}

function addNilExemptSheet(wb: ExcelJS.Workbook, c: GstComputation): void {
  const rows = c.gstr1.nilExempt;
  addDataSheet(wb, c, {
    name: SHEET_NAMES.nilExempt,
    tab: C.brand,
    title: `GSTR-1 Table 8 — Nil rated, exempted and non-GST supplies · ${c.period.label}`,
    subtitle:
      'All four rows of the table are shown so the full table is visible; the café only ever has sales to unregistered persons within the state.',
    cols: [
      { header: 'Description', width: 46, type: 'text' },
      { header: 'Nil Rated Supplies', width: 22, type: 'money' },
      { header: 'Exempted (other than nil rated/non GST supply)', width: 30, type: 'money' },
      { header: 'Non-GST Supplies', width: 22, type: 'money' },
    ],
    rows: rows.map((x) => [x.description, x.nilRatedInr, x.exemptedInr, x.nonGstInr]),
    emptyText: 'No nil-rated, exempted or non-GST supplies in this period.',
    totals: {
      label: 'TOTAL',
      span: 1,
      values: [null, sum(rows.map((x) => x.nilRatedInr)), sum(rows.map((x) => x.exemptedInr)), sum(rows.map((x) => x.nonGstInr))],
    },
  });
}

function addHsnSheet(wb: ExcelJS.Workbook, c: GstComputation): void {
  const rows = c.gstr1.hsn;
  addDataSheet(wb, c, {
    name: SHEET_NAMES.hsn,
    tab: C.brand,
    title: `GSTR-1 Table 12 — HSN / SAC summary of outward supplies (B2C) · ${c.period.label}`,
    subtitle:
      'Sales by HSN (goods) or SAC (services) code. HSN/SAC codes are stored as text so a leading zero is kept. Total Value is taxable value plus tax; the taxable values here add up to Table 7 plus Table 8.',
    cols: [
      { header: 'HSN', width: 11, type: 'center' },
      { header: 'Description', width: 30, type: 'text' },
      { header: 'UQC', width: 18, type: 'text' },
      { header: 'Total Quantity', width: 14, type: 'qty' },
      { header: 'Total Value', width: 17, type: 'money' },
      { header: 'Rate', width: 8, type: 'rate' },
      { header: 'Taxable Value', width: 17, type: 'money' },
      { header: 'Integrated Tax Amount', width: 15, type: 'money' },
      { header: 'Central Tax Amount', width: 15, type: 'money' },
      { header: 'State/UT Tax Amount', width: 15, type: 'money' },
      { header: 'Cess Amount', width: 12, type: 'money' },
    ],
    rows: rows.map((x) => [
      x.hsn, x.description, x.uqc, x.quantity, x.totalValueInr, x.rate, x.taxableValueInr, x.igstInr, x.cgstInr, x.sgstInr, x.cessInr,
    ]),
    emptyText: 'No sales in this period.',
    totals: {
      label: 'TOTAL',
      span: 4,
      values: [
        null, null, null, null,
        sum(rows.map((x) => x.totalValueInr)),
        null,
        sum(rows.map((x) => x.taxableValueInr)),
        sum(rows.map((x) => x.igstInr)),
        sum(rows.map((x) => x.cgstInr)),
        sum(rows.map((x) => x.sgstInr)),
        sum(rows.map((x) => x.cessInr)),
      ],
    },
  });
}

function addDocsSheet(wb: ExcelJS.Workbook, c: GstComputation): void {
  const rows: DocsRow[] = c.gstr1.docs;
  addDataSheet(wb, c, {
    name: SHEET_NAMES.docs,
    tab: C.brand,
    title: `GSTR-1 Table 13 — Documents issued during the period · ${c.period.label}`,
    subtitle:
      'The invoice number series used. The first five columns are the GST offline tool’s docs columns; Net Issued (grey heading) is for reading — it is Total Number less Cancelled.',
    cols: [
      { header: 'Nature of Document', width: 32, type: 'text' },
      { header: 'Sr. No. From', width: 18, type: 'center' },
      { header: 'Sr. No. To', width: 18, type: 'center' },
      { header: 'Total Number', width: 14, type: 'count' },
      { header: 'Cancelled', width: 12, type: 'count' },
      { header: 'Net Issued', width: 12, type: 'count', ref: true },
    ],
    rows: rows.map((x) => [x.nature, x.fromNo, x.toNo, x.totalNumber, x.cancelled, x.netIssued]),
    emptyText: 'No invoices were issued in this period.',
  });
}

function addDaySheet(wb: ExcelJS.Workbook, c: GstComputation): void {
  const rows = c.dayRegister;
  addDataSheet(wb, c, {
    name: SHEET_NAMES.days,
    tab: C.muted,
    title: `Day-wise register · ${c.period.label}`,
    subtitle:
      'One line per day. First and last invoice number cover every bill of the day, including cancelled ones; the amounts are for bills issued. Days with no bills are greyed.',
    cols: [
      { header: 'Date', width: 14, type: 'date' },
      { header: 'First invoice no.', width: 18, type: 'center' },
      { header: 'Last invoice no.', width: 18, type: 'center' },
      { header: 'Bills issued', width: 10, type: 'count' },
      { header: 'Bills cancelled', width: 11, type: 'count' },
      { header: 'Taxable value', width: 16, type: 'money' },
      { header: 'Central tax (CGST)', width: 15, type: 'money' },
      { header: 'State/UT tax (SGST)', width: 15, type: 'money' },
      { header: 'GST-exempt value', width: 15, type: 'money' },
      { header: 'Invoice value', width: 16, type: 'money' },
    ],
    rows: rows.map((x) => [
      excelDate(x.date), x.firstInvoice, x.lastInvoice, x.bills, x.cancelled,
      x.taxableValueInr, x.cgstInr, x.sgstInr, x.exemptValueInr, x.invoiceValueInr,
    ]),
    emptyText: 'No days in this period.',
    muted: (i) => rows[i].bills === 0 && rows[i].cancelled === 0,
    totals: {
      label: 'TOTAL',
      span: 3,
      values: [
        null, null, null,
        rows.reduce((a, x) => a + x.bills, 0),
        rows.reduce((a, x) => a + x.cancelled, 0),
        sum(rows.map((x) => x.taxableValueInr)),
        sum(rows.map((x) => x.cgstInr)),
        sum(rows.map((x) => x.sgstInr)),
        sum(rows.map((x) => x.exemptValueInr)),
        sum(rows.map((x) => x.invoiceValueInr)),
      ],
    },
    filter: true,
    freezeCols: 1,
  });
}

function addInvoiceSheet(wb: ExcelJS.Workbook, c: GstComputation): void {
  const rows = c.invoiceRegister;
  const issued = rows.filter((x) => x.status === 'Issued');
  const others = rows.length - issued.length;
  addDataSheet(wb, c, {
    name: SHEET_NAMES.invoices,
    tab: C.muted,
    title: `Invoice register · ${c.period.label}`,
    subtitle:
      'Every bill of the period in invoice-number order. Cancelled and rejected bills are greyed: their printed values are shown for completeness but they are in no total.',
    cols: [
      { header: 'Invoice no.', width: 16, type: 'center' },
      { header: 'Date', width: 13, type: 'date' },
      { header: 'Time', width: 8, type: 'center' },
      { header: 'Status', width: 11, type: 'center' },
      { header: 'GST worked out', width: 17, type: 'center' },
      { header: 'Taxable value', width: 15, type: 'money' },
      { header: 'Central tax (CGST)', width: 14, type: 'money' },
      { header: 'State/UT tax (SGST)', width: 14, type: 'money' },
      { header: 'GST-exempt value', width: 14, type: 'money' },
      { header: 'Packaging', width: 12, type: 'money' },
      { header: 'Discount', width: 12, type: 'money' },
      { header: 'Invoice value', width: 15, type: 'money' },
      { header: 'Paid by', width: 18, type: 'text' },
    ],
    rows: rows.map((x) => [
      x.invoiceNo, excelDate(x.date), x.time, x.status, x.gstBasis,
      x.taxableValueInr, x.cgstInr, x.sgstInr, x.exemptValueInr, x.packagingInr, x.discountInr, x.invoiceValueInr, x.paymentMode,
    ]),
    emptyText: 'No bills in this period.',
    muted: (i) => rows[i].status !== 'Issued',
    totals: {
      label: `TOTAL — ${issued.length} issued bill${issued.length === 1 ? '' : 's'} only`,
      span: 5,
      values: [
        null, null, null, null, null,
        sum(issued.map((x) => x.taxableValueInr)),
        sum(issued.map((x) => x.cgstInr)),
        sum(issued.map((x) => x.sgstInr)),
        sum(issued.map((x) => x.exemptValueInr)),
        sum(issued.map((x) => x.packagingInr)),
        sum(issued.map((x) => x.discountInr)),
        sum(issued.map((x) => x.invoiceValueInr)),
        null,
      ],
    },
    footnote:
      others > 0
        ? `${others} cancelled or rejected bill${others === 1 ? ' is' : 's are'} listed above and left out of the total.`
        : undefined,
    filter: true,
    freezeCols: 1,
  });
}

function addGlossarySheet(wb: ExcelJS.Workbook, c: GstComputation): void {
  const ws = wb.addWorksheet(SHEET_NAMES.glossary, {
    properties: { tabColor: { argb: C.greyText } },
    views: [{ state: 'frozen', xSplit: 0, ySplit: 3, showGridLines: false }],
  });
  ws.getColumn(1).width = 28;
  ws.getColumn(2).width = 110;
  put(ws, 1, 1, 'Glossary — the terms in plain words', { bold: true, size: 14, color: C.white, fill: C.ink, indent: 1 }, 2);
  ws.getRow(1).height = 28;
  put(ws, 2, 1, 'For the owner reading this alongside the CA.', { italic: true, color: C.muted, fill: C.surface, indent: 1 }, 2);
  ws.getRow(2).height = 20;
  put(ws, 3, 1, 'Term', { bold: true, color: C.white, fill: C.brand, h: 'center', box: true });
  put(ws, 3, 2, 'Meaning', { bold: true, color: C.white, fill: C.brand, h: 'center', box: true });
  ws.getRow(3).height = 22;
  let r = 4;
  if (c.glossary.length === 0) {
    put(ws, r, 1, 'No glossary entries.', { italic: true, color: C.greyText, h: 'center', box: true }, 2);
    r++;
  }
  c.glossary.forEach((g, i) => {
    const fill = i % 2 === 1 ? C.band : undefined;
    put(ws, r, 1, g.term, { bold: true, v: 'top', wrap: true, box: true, fill });
    put(ws, r, 2, g.meaning, { v: 'top', wrap: true, box: true, fill });
    ws.getRow(r).height = rowHeightFor(Math.max(lineCount(g.meaning, 108), lineCount(g.term, 27, 11, true)));
    r++;
  });
  finishSheet(ws, c, 2, r - 1, '3:3');
}

// ---------------------------------------------------------------- the Summary sheet

const SUMMARY_COLS = [46, 17, 17, 17, 17, 17, 40]; // A..G
const LAST = SUMMARY_COLS.length;
const widthOf = (c1: number, c2: number): number => SUMMARY_COLS.slice(c1 - 1, c2).reduce((a, b) => a + b, 0);

/** A full-width merged text row; the row grows to fit the wrapped text. */
function textRow(ws: ExcelJS.Worksheet, r: number, c1: number, c2: number, text: string, s: Style): void {
  put(ws, r, c1, text, { wrap: true, v: 'top', ...s }, c2);
  grow(ws, r, rowHeightFor(lineCount(text, widthOf(c1, c2) - 1, s.size ?? 11, !!s.bold), s.size ?? 11));
}

function sectionBand(ws: ExcelJS.Worksheet, r: number, title: string, caption?: string): number {
  put(ws, r, 1, title, { bold: true, size: 12, fill: C.sand, indent: 1 }, LAST);
  for (let c = 1; c <= LAST; c++) setBorderSide(ws.getCell(r, c), 'bottom', { style: 'medium', color: { argb: C.brand } });
  ws.getRow(r).height = 22;
  if (!caption) return r + 1;
  textRow(ws, r + 1, 1, LAST, caption, { italic: true, color: C.muted, indent: 1 });
  return r + 2;
}

function moneyCell(ws: ExcelJS.Worksheet, r: number, col: number, v: number, s: Style = {}): void {
  put(ws, r, col, round2(v), { h: 'right', numFmt: MONEY_FORMAT, box: true, indent: 1, ...s });
}

/** The "–" shown where a figure does not apply. */
function dash(ws: ExcelJS.Worksheet, r: number, col: number, s: Style = {}): void {
  put(ws, r, col, '–', { h: 'center', color: C.greyText, box: true, ...s });
}

/** 'Less: …' / 'Add: …' by the step's sign (amounts are signed, so a less step is negative). */
function lessAddLabel(line: ReconLine): string {
  if ((line.kind !== 'add' && line.kind !== 'less') || /^(add|less)\b/i.test(line.label)) return line.label;
  return `${line.kind === 'less' || line.amountInr < 0 ? 'Less' : 'Add'}: ${line.label}`;
}

function writeRecon(ws: ExcelJS.Worksheet, r0: number, lines: ReconLine[], tieLabel: string, tieAmount: number): number {
  let r = r0;
  put(ws, r, 1, 'Step', { bold: true, color: C.white, fill: C.brand, h: 'left', box: true, indent: 1 });
  put(ws, r, 2, 'Amount (₹)', { bold: true, color: C.white, fill: C.brand, h: 'right', box: true });
  put(ws, r, 3, 'Why', { bold: true, color: C.white, fill: C.brand, h: 'left', box: true, indent: 1 }, LAST);
  ws.getRow(r).height = 20;
  r++;
  if (lines.length === 0) {
    put(ws, r, 1, 'Nothing to reconcile in this period.', { italic: true, color: C.greyText, h: 'center', box: true }, LAST);
    return r + 2;
  }
  for (const line of lines) {
    const strong = line.kind === 'start' || line.kind === 'subtotal' || line.kind === 'total';
    const fill = line.kind === 'total' ? C.sand : line.kind === 'subtotal' ? C.band : undefined;
    const label = lessAddLabel(line);
    put(ws, r, 1, label, { bold: strong, wrap: true, box: true, fill, indent: strong ? 1 : 2 });
    moneyCell(ws, r, 2, line.amountInr, { bold: strong, fill, size: line.kind === 'total' ? 12 : 11 });
    put(ws, r, 3, line.note ?? '', { italic: true, size: 10, color: C.muted, wrap: true, box: true, fill, indent: 1 }, LAST);
    grow(
      ws,
      r,
      rowHeightFor(
        Math.max(lineCount(label, SUMMARY_COLS[0] - 4, 11, strong), lineCount(line.note ?? '', widthOf(3, LAST) - 3, 10)),
      ),
    );
    if (line.kind === 'subtotal' || line.kind === 'total') {
      for (let c = 1; c <= LAST; c++) setBorderSide(ws.getCell(r, c), 'top', { style: 'thin', color: { argb: C.ink } });
    }
    if (line.kind === 'total') {
      for (let c = 1; c <= LAST; c++) setBorderSide(ws.getCell(r, c), 'bottom', { style: 'double', color: { argb: C.ink } });
    }
    r++;
  }
  const total = [...lines].reverse().find((l) => l.kind === 'total');
  if (total) {
    const agrees = Math.abs(total.amountInr - tieAmount) < 0.005;
    const text = agrees
      ? `✓  Agrees to ${tieLabel} (${formatInr(tieAmount)}).`
      : `!  Differs from ${tieLabel} (${formatInr(tieAmount)}) by ${formatInr(total.amountInr - tieAmount)} — ask the CA to look at this before filing.`;
    textRow(ws, r, 1, LAST, text, { bold: true, color: agrees ? C.ok : C.warn, indent: 1 });
    r++;
  }
  return r + 1;
}

function addSummarySheet(wb: ExcelJS.Workbook, c: GstComputation): void {
  const ws = wb.addWorksheet(SHEET_NAMES.summary, {
    properties: { tabColor: { argb: C.ink } },
    views: [{ showGridLines: false }],
  });
  SUMMARY_COLS.forEach((w, i) => (ws.getColumn(i + 1).width = w));
  const b = c.business;
  let r = 1;

  // ---- title
  put(ws, r, 1, `GST working — ${c.period.label}`, { bold: true, size: 20, color: C.white, fill: C.ink, indent: 1 }, LAST);
  ws.getRow(r).height = 38;
  r++;
  put(
    ws,
    r,
    1,
    `${b.legalName} (${b.tradeName}) · GSTIN ${b.gstin} · figures are as charged on the bills; every number in this file is a fixed value, not a formula`,
    { italic: true, color: C.muted, fill: C.surface, indent: 1, wrap: true },
    LAST,
  );
  ws.getRow(r).height = 22;
  r += 2;

  // ---- business and period
  r = sectionBand(ws, r, 'Business and period');
  const returnPeriod = c.period.returnPeriod
    ? `${c.period.returnPeriod} (${c.period.label})`
    : 'None — custom dates, not a whole month';
  const block: [string, string][] = [
    ['Legal name', b.legalName],
    ['Trade name', b.tradeName],
    ['GSTIN', b.gstin],
    ['State', `${b.stateName} (${b.stateCode})`],
    ['Address', b.address],
    ['Period', `${longDate(c.period.from)} to ${longDate(c.period.to)}`],
    ['Return period', returnPeriod],
    ['Financial year', c.period.financialYear],
    ['Prepared on', istStamp(c.generatedAt)],
  ];
  for (const [label, value] of block) {
    put(ws, r, 1, label, { bold: true, fill: C.surface, box: true, indent: 1 });
    put(ws, r, 2, value, { box: true, wrap: true, numFmt: TEXT_FORMAT, indent: 1, bold: label === 'GSTIN' }, LAST);
    grow(ws, r, rowHeightFor(lineCount(value, widthOf(2, LAST) - 2)));
    r++;
  }
  r++;

  // ---- tax to pay (boxed)
  const boxTop = r;
  put(ws, r, 1, `TAX TO PAY — ${c.period.label}`, { bold: true, size: 13, color: C.white, fill: C.brand, indent: 1 }, LAST);
  ws.getRow(r).height = 24;
  r++;
  const tp = c.taxPayable;
  const taxable31a = c.gstr3b.find((x) => x.code === '3.1(a)')?.amounts.taxableValueInr ?? 0;
  const half = c.ratePercent / 2;
  const payRows: [string, number, string][] = [
    ['Central tax (CGST)', tp.cgstInr, `${half}% of the taxable value`],
    ['State / UT tax (SGST)', tp.sgstInr, `${half}% of the taxable value`],
  ];
  if (Math.abs(tp.igstInr) >= 0.005) payRows.push(['Integrated tax (IGST)', tp.igstInr, '']);
  if (Math.abs(tp.cessInr) >= 0.005) payRows.push(['Cess', tp.cessInr, '']);
  for (const [label, amount, note] of payRows) {
    put(ws, r, 1, label, { indent: 1 });
    moneyCell(ws, r, 2, amount, { box: false });
    put(ws, r, 3, note, { italic: true, color: C.muted, size: 10, indent: 1 }, LAST);
    ws.getRow(r).height = 20;
    r++;
  }
  put(ws, r, 1, 'Total GST to pay', { bold: true, size: 14, fill: C.sand, indent: 1 });
  put(ws, r, 2, round2(tp.totalInr), { bold: true, size: 14, fill: C.sand, h: 'right', numFmt: MONEY_FORMAT, indent: 1 });
  put(
    ws,
    r,
    3,
    `${c.ratePercent}% GST on a taxable value of ${formatInr(taxable31a)}`,
    { italic: true, color: C.muted, size: 10, fill: C.sand, indent: 1 },
    LAST,
  );
  for (let col = 1; col <= LAST; col++) setBorderSide(ws.getCell(r, col), 'top', { style: 'thin', color: { argb: C.ink } });
  ws.getRow(r).height = 28;
  r++;
  const pct = c.ratePercent;
  textRow(ws, r, 1, LAST, `Paid in cash — no input tax credit for restaurants at ${pct}% (GSTR-3B Table 6.1).`, { bold: true, indent: 1 });
  r++;
  textRow(
    ws,
    r,
    1,
    LAST,
    'File GSTR-1 first — since July 2025 GSTR-3B Table 3.1 is filled from it and locked.',
    { indent: 1 },
  );
  r++;
  if (c.period.isWholeMonth && c.period.gstr1DueDate && c.period.gstr3bDueDate) {
    put(ws, r, 1, 'GSTR-1 due by', { bold: true, indent: 1 });
    put(ws, r, 2, longDate(c.period.gstr1DueDate), { indent: 1 }, LAST);
    ws.getRow(r).height = 20;
    r++;
    put(ws, r, 1, 'GSTR-3B and payment due by', { bold: true, indent: 1 });
    put(ws, r, 2, longDate(c.period.gstr3bDueDate), { indent: 1 }, LAST);
    ws.getRow(r).height = 20;
    r++;
    // The QRMP remark appears once: here, unless the computation's own notes already carry it.
    const qrmpInNotes = c.notes.some((n) => /QRMP/i.test(n));
    textRow(
      ws,
      r,
      1,
      LAST,
      qrmpInNotes
        ? 'These are the dates for a monthly filer; the notes below say what changes for a quarterly (QRMP) filer.'
        : 'These are the dates for a monthly filer. A QRMP filer (turnover up to ₹5 crore) files quarterly instead — ask your CA which applies.',
      { italic: true, color: C.muted, size: 10, indent: 1 },
    );
    r++;
  } else {
    textRow(
      ws,
      r,
      1,
      LAST,
      'Due dates are shown for a whole month only; this working covers custom dates.',
      { italic: true, color: C.muted, size: 10, indent: 1 },
    );
    r++;
  }
  outline(ws, boxTop, r - 1, 1, LAST, { style: 'medium', color: { argb: C.ink } });
  r += 1;

  // ---- GSTR-3B 3.1 / 3.1.1 as the portal lays it out
  ws.getRow(r - 1).addPageBreak(); // printing: the box above is page 1
  r = sectionBand(
    ws,
    r,
    'GSTR-3B — Table 3.1 and 3.1.1',
    'Outward supplies, laid out as on the GST portal. Amounts are in rupees; 0.00 means nil.',
  );
  const heads = ['Nature of Supplies', 'Total Taxable value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess', 'Remarks'];
  heads.forEach((h, i) =>
    put(ws, r, i + 1, h, { bold: true, color: C.white, fill: C.brand, h: i === 0 || i === 6 ? 'left' : 'center', wrap: true, box: true, indent: i === 0 || i === 6 ? 1 : 0 }),
  );
  ws.getRow(r).height = 22;
  r++;
  const write3b = (rows: Gstr3bRow[]) => {
    for (const row of rows) {
      const label = `${rowPrefix(row)}${row.label}`;
      const grey = row.applies ? undefined : C.greyText;
      put(ws, r, 1, label, { bold: row.applies, wrap: true, box: true, color: grey, indent: 1, v: 'top' });
      const a = row.amounts;
      [a.taxableValueInr, a.igstInr, a.cgstInr, a.sgstInr, a.cessInr].forEach((v, i) =>
        moneyCell(ws, r, i + 2, v, { bold: row.applies, color: grey, v: 'top' }),
      );
      put(ws, r, 7, row.note, { italic: true, size: 10, color: C.muted, wrap: true, box: true, indent: 1, v: 'top' });
      grow(
        ws,
        r,
        rowHeightFor(Math.max(lineCount(label, SUMMARY_COLS[0] - 3, 11, row.applies), lineCount(row.note, SUMMARY_COLS[6] - 3, 10))),
      );
      r++;
    }
  };
  const caption = (text: string) => {
    put(ws, r, 1, text, { bold: true, fill: C.surface, wrap: true, box: true, indent: 1, v: 'top' }, LAST);
    grow(ws, r, rowHeightFor(lineCount(text, widthOf(1, LAST) - 3, 11, true)));
    r++;
  };
  caption(`3.1  ${GSTR3B_TABLE_31_HEADING}`);
  write3b(c.gstr3b.filter((x) => !x.code.startsWith('3.1.1')));
  caption('3.1.1  Details of supplies notified under section 9(5) of the CGST Act, 2017 and corresponding provisions in IGST/UTGST/SGST Acts');
  write3b(c.gstr3b.filter((x) => x.code.startsWith('3.1.1')));
  r++;

  // ---- GSTR-1 at a glance
  r = sectionBand(
    ws,
    r,
    'GSTR-1 at a glance',
    'The four GSTR-1 tables for the period. Each has its own sheet in this workbook, in the offline tool’s columns.',
  );
  ['GSTR-1 table', 'Taxable value', 'Central Tax', 'State/UT Tax', 'Nil / exempt / non-GST', 'Invoices (net)', 'What it holds'].forEach((h, i) =>
    put(ws, r, i + 1, h, { bold: true, color: C.white, fill: C.brand, h: i === 0 || i === 6 ? 'left' : 'center', wrap: true, box: true, indent: i === 0 || i === 6 ? 1 : 0 }),
  );
  ws.getRow(r).height = 32;
  r++;
  const b2cs = c.gstr1.b2cs;
  const nil = c.gstr1.nilExempt;
  const hsn = c.gstr1.hsn;
  const docs = c.gstr1.docs;
  const issued = docs.reduce((a, x) => a + x.netIssued, 0);
  const totalDocs = docs.reduce((a, x) => a + x.totalNumber, 0);
  const cancelledDocs = docs.reduce((a, x) => a + x.cancelled, 0);
  const range = docs.length > 0 ? `${docs[0].fromNo} to ${docs[docs.length - 1].toNo}` : 'no invoices';
  const glance: { label: string; vals: (number | null)[]; note: string }[] = [
    {
      label: 'Table 7 — B2C (Small) supplies',
      vals: [sum(b2cs.map((x) => x.taxableValueInr)), sum(b2cs.map((x) => x.cgstInr)), sum(b2cs.map((x) => x.sgstInr)), null, null],
      note: 'Sales to consumers, one line per tax rate.',
    },
    {
      label: 'Table 8 — Nil rated, exempted and non-GST',
      vals: [null, null, null, sum(nil.flatMap((x) => [x.nilRatedInr, x.exemptedInr, x.nonGstInr])), null],
      note: 'Sales that carry no GST.',
    },
    {
      label: 'Table 12 — HSN / SAC summary',
      vals: [sum(hsn.map((x) => x.taxableValueInr)), sum(hsn.map((x) => x.cgstInr)), sum(hsn.map((x) => x.sgstInr)), null, null],
      note: 'The same sales by HSN / SAC code, exempt sales included (Table 7 plus Table 8).',
    },
    {
      label: 'Table 13 — Documents issued',
      vals: [null, null, null, null, issued],
      note: `${totalDocs} invoice numbers used (${range}), ${cancelledDocs} cancelled.`,
    },
  ];
  for (const g of glance) {
    put(ws, r, 1, g.label, { bold: true, box: true, indent: 1, wrap: true });
    g.vals.forEach((v, i) => {
      if (v === null) dash(ws, r, i + 2);
      else if (i === 4) put(ws, r, i + 2, v, { h: 'right', numFmt: COUNT_FORMAT, box: true, indent: 1 });
      else moneyCell(ws, r, i + 2, v);
    });
    put(ws, r, 7, g.note, { italic: true, size: 10, color: C.muted, wrap: true, box: true, indent: 1 });
    grow(ws, r, rowHeightFor(Math.max(lineCount(g.label, SUMMARY_COLS[0] - 3, 11, true), lineCount(g.note, SUMMARY_COLS[6] - 3, 10))));
    r++;
  }
  r++;

  // ---- reconciliations
  ws.getRow(r - 1).addPageBreak();
  r = sectionBand(
    ws,
    r,
    'Reconciliation 1 — from item sales to taxable value',
    'Starts at the total of the item prices on the bills issued and ends at the taxable value reported in GSTR-1 and GSTR-3B.',
  );
  r = writeRecon(ws, r, c.toTaxableValue, 'GSTR-3B Table 3.1(a) taxable value', taxable31a);

  const issuedBills = c.invoiceRegister.filter((x) => x.status === 'Issued');
  r = sectionBand(
    ws,
    r,
    'Reconciliation 2 — from taxable value to the total on the bills',
    'Starts at the taxable value and ends at the total invoice value of the bills issued.',
  );
  r = writeRecon(ws, r, c.toInvoiceValue, 'the total of the issued bills in the Invoice register', sum(issuedBills.map((x) => x.invoiceValueInr)));

  // ---- checks
  ws.getRow(r - 1).addPageBreak();
  r = sectionBand(ws, r, 'Checks before you file');
  const nOk = c.checks.filter((x) => x.status === 'ok').length;
  const nWarn = c.checks.filter((x) => x.status === 'warn').length;
  const nInfo = c.checks.filter((x) => x.status === 'info').length;
  if (c.checks.length === 0) {
    textRow(ws, r, 1, LAST, 'No checks were run.', { italic: true, color: C.greyText, indent: 1 });
    r++;
  } else {
    textRow(
      ws,
      r,
      1,
      LAST,
      `${nOk} passed · ${nWarn} to look at · ${nInfo} for information`,
      { bold: true, color: nWarn > 0 ? C.warn : C.ok, indent: 1 },
    );
    r++;
  }
  const look = {
    ok: { icon: '✓', color: C.ok, fill: C.okFill },
    warn: { icon: '!', color: C.warn, fill: C.warnFill },
    info: { icon: 'i', color: C.info, fill: C.infoFill },
  } as const;
  for (const chk of c.checks) {
    const l = look[chk.status];
    const title = `${l.icon}   ${chk.title}`;
    put(ws, r, 1, title, { bold: true, color: l.color, fill: l.fill, wrap: true, box: true, indent: 1, v: 'top' });
    put(ws, r, 2, chk.detail, { wrap: true, box: true, indent: 1, v: 'top' }, LAST);
    grow(ws, r, rowHeightFor(Math.max(lineCount(title, SUMMARY_COLS[0] - 3, 11, true), lineCount(chk.detail, widthOf(2, LAST) - 3))));
    r++;
  }
  r++;

  // ---- notes
  r = sectionBand(ws, r, 'Notes for the CA');
  if (c.notes.length === 0) {
    textRow(ws, r, 1, LAST, 'No notes.', { italic: true, color: C.greyText, indent: 1 });
    r++;
  }
  c.notes.forEach((note, i) => {
    textRow(ws, r, 1, LAST, `${i + 1}.  ${note}`, { indent: 1 });
    r++;
  });
  r++;

  // ---- contents (links to the other sheets)
  r = sectionBand(ws, r, 'Sheets in this workbook');
  const contents: [string, string][] = [
    [SHEET_NAMES.b2cs, 'Table 7: sales to consumers, one line per tax rate.'],
    [SHEET_NAMES.nilExempt, 'Table 8: nil rated, exempted and non-GST sales.'],
    [SHEET_NAMES.hsn, 'Table 12: sales by HSN / SAC code.'],
    [SHEET_NAMES.docs, 'Table 13: invoice number series, issued and cancelled.'],
    [SHEET_NAMES.days, 'One line per day: bills, taxable value, tax, invoice value.'],
    [SHEET_NAMES.invoices, 'Every bill of the period, including cancelled ones.'],
    [SHEET_NAMES.glossary, 'The terms in plain words.'],
  ];
  for (const [name, what] of contents) {
    put(ws, r, 1, { text: name, hyperlink: `#'${name}'!A1` }, { color: C.link, underline: true, box: true, indent: 1 });
    put(ws, r, 2, what, { box: true, indent: 1 }, LAST);
    ws.getRow(r).height = 19;
    r++;
  }

  finishSheet(ws, c, LAST, r - 1);
}

// ---------------------------------------------------------------- entry point

/** The CA's workbook for a period's GST working, as .xlsx bytes. */
export async function buildGstWorkbook(c: GstComputation): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const stamp = new Date(c.generatedAt);
  const when = Number.isNaN(stamp.getTime()) ? new Date() : stamp;
  wb.creator = 'HIOC billing';
  wb.lastModifiedBy = 'HIOC billing';
  wb.created = when;
  wb.modified = when;
  wb.title = `GST working — ${c.period.label}`;
  wb.subject = `GSTR-1 and GSTR-3B working for GSTIN ${c.business.gstin}`;
  wb.company = c.business.legalName;
  wb.keywords = 'GST, GSTR-1, GSTR-3B';
  wb.description = 'Figures are as charged on the bills. All cells are fixed values; there are no formulas.';

  addSummarySheet(wb, c);
  addB2csSheet(wb, c);
  addNilExemptSheet(wb, c);
  addHsnSheet(wb, c);
  addDocsSheet(wb, c);
  addDaySheet(wb, c);
  addInvoiceSheet(wb, c);
  addGlossarySheet(wb, c);
  wb.views = [{ x: 0, y: 0, width: 28800, height: 17000, firstSheet: 0, activeTab: 0, visibility: 'visible' }];

  return Buffer.from(await wb.xlsx.writeBuffer());
}
