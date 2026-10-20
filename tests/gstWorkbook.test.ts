import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import {
  buildGstWorkbook,
  COUNT_FORMAT,
  DATE_FORMAT,
  formatInr,
  gstWorkbookFileName,
  MONEY_FORMAT,
  QUANTITY_FORMAT,
  SHEET_NAMES,
} from '@/lib/reports/exports/gstWorkbook';
import type { GstComputation } from '@/lib/reports/exports/gstTypes';
import { gstComputationFixture } from '@/tests/helpers/gstComputationFixture';

// The CA's workbook, built from a hand-made GstComputation (October 2026: GST
// moves from "before discount" to "after discount" on the 19th; beans and
// restaurant service; an exempt item; cancelled and rejected bills; a warning
// check), read back with exceljs. Static values only.

async function load(c: GstComputation): Promise<ExcelJS.Workbook> {
  const buf = await buildGstWorkbook(c);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ExcelJS.Buffer); // exceljs' typings predate Node's generic Buffer
  return wb;
}

/** What a cell shows as text, whatever its value type. */
function text(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && !(v instanceof Date)) {
    if ('text' in v && typeof v.text === 'string') return v.text;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
  }
  return String(v);
}

/** First row at or after `from` whose cell in `col` starts with `label`. */
function rowOf(ws: ExcelJS.Worksheet, label: string, col = 1, from = 1): number {
  for (let r = from; r <= ws.rowCount; r++) {
    if (text(ws.getCell(r, col)).startsWith(label)) return r;
  }
  throw new Error(`no row starting "${label}" in ${ws.name}`);
}

const num = (ws: ExcelJS.Worksheet, r: number, c: number): number => {
  const v = ws.getCell(r, c).value;
  if (typeof v !== 'number') throw new Error(`${ws.name} ${r}:${c} is ${JSON.stringify(v)}, not a number`);
  return v;
};
const sum = (xs: number[]) => Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;

describe('buildGstWorkbook', () => {
  const c = gstComputationFixture();

  it('has the eight sheets, in order, and the Summary opens first', async () => {
    const wb = await load(c);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      'Summary',
      'GSTR-1 Table 7 (B2CS)',
      'GSTR-1 Table 8 (Nil-Exempt)',
      'GSTR-1 Table 12 (HSN)',
      'GSTR-1 Table 13 (Docs)',
      'Day-wise register',
      'Invoice register',
      'Glossary',
    ]);
    expect(Object.values(SHEET_NAMES)).toEqual(wb.worksheets.map((w) => w.name));
    expect(wb.worksheets.every((w) => w.name.length <= 31)).toBe(true);
    expect(wb.title).toBe('GST working — October 2026');
    expect(wb.company).toBe('Arry Foods');
  });

  it('Summary: title and the business block', async () => {
    const ws = (await load(c)).getWorksheet('Summary')!;
    expect(text(ws.getCell('A1'))).toBe('GST working — October 2026');
    const value = (label: string) => text(ws.getCell(rowOf(ws, label), 2));
    expect(value('Legal name')).toBe('Arry Foods');
    expect(value('Trade name')).toBe('HIOC');
    expect(value('GSTIN')).toBe('09AGJPA9390E1Z9');
    expect(value('State')).toBe('Uttar Pradesh (09)');
    expect(value('Address')).toContain('Kamla Nagar, Agra');
    expect(value('Period')).toBe('1 October 2026 to 31 October 2026');
    expect(value('Return period')).toBe('102026 (October 2026)');
    expect(value('Financial year')).toBe('2026-27');
    expect(value('Prepared on')).toBe('2 November 2026, 10:11 am IST');
    // The GSTIN is text, not a number or formula.
    expect(typeof ws.getCell(rowOf(ws, 'GSTIN'), 2).value).toBe('string');
  });

  it('Summary: the boxed tax to pay', async () => {
    const ws = (await load(c)).getWorksheet('Summary')!;
    const top = rowOf(ws, 'TAX TO PAY');
    expect(text(ws.getCell(top, 1))).toBe('TAX TO PAY — October 2026');
    const cgst = rowOf(ws, 'Central tax (CGST)', 1, top);
    const sgst = rowOf(ws, 'State / UT tax (SGST)', 1, top);
    const total = rowOf(ws, 'Total GST to pay', 1, top);
    expect(num(ws, cgst, 2)).toBe(c.taxPayable.cgstInr);
    expect(num(ws, sgst, 2)).toBe(c.taxPayable.sgstInr);
    expect(num(ws, total, 2)).toBe(c.taxPayable.totalInr);
    expect(num(ws, total, 2)).toBe(sum([num(ws, cgst, 2), num(ws, sgst, 2)]));
    expect(ws.getCell(total, 2).numFmt).toBe(MONEY_FORMAT);
    expect(ws.getCell(total, 2).font?.bold).toBe(true);
    expect(text(ws.getCell(total + 1, 1))).toBe('Paid in cash — no input tax credit for restaurants at 5% (GSTR-3B Table 6.1).');
    expect(text(ws.getCell(total + 2, 1))).toBe('File GSTR-1 first — since July 2025 GSTR-3B Table 3.1 is filled from it and locked.');
    expect(text(ws.getCell(rowOf(ws, 'GSTR-1 due by'), 2))).toBe('11 November 2026');
    expect(text(ws.getCell(rowOf(ws, 'GSTR-3B and payment due by'), 2))).toBe('20 November 2026');
    expect(text(ws.getCell(rowOf(ws, 'These are the dates for a monthly filer'), 1))).toContain('QRMP');
    // A box: medium border on the banner's top and left edges and on the last row's bottom edge.
    expect(ws.getCell(top, 1).border?.top?.style).toBe('medium');
    expect(ws.getCell(top, 1).border?.left?.style).toBe('medium');
    const last = rowOf(ws, 'These are the dates for a monthly filer');
    expect(ws.getCell(last, 1).border?.bottom?.style).toBe('medium');
  });

  it('Summary: GSTR-3B Table 3.1 and 3.1.1 as the portal lays them out', async () => {
    const ws = (await load(c)).getWorksheet('Summary')!;
    const head = rowOf(ws, 'Nature of Supplies');
    expect([1, 2, 3, 4, 5, 6].map((i) => text(ws.getCell(head, i)))).toEqual([
      'Nature of Supplies', 'Total Taxable value', 'Integrated Tax', 'Central Tax', 'State/UT Tax', 'Cess',
    ]);
    expect(text(ws.getCell(head + 1, 1))).toBe(
      '3.1  Details of Outward Supplies and inward supplies liable to reverse charge (other than those covered by Table 3.1.1)',
    );
    const labels = [
      '(a) Outward taxable supplies (other than zero rated, nil rated and exempted)',
      '(b) Outward taxable supplies (zero rated)',
      '(c) Other outward supplies (nil rated, exempted)',
      '(d) Inward supplies (liable to reverse charge)',
      '(e) Non-GST outward supplies',
    ];
    labels.forEach((label, i) => expect(text(ws.getCell(head + 2 + i, 1))).toBe(label));
    expect(text(ws.getCell(head + 7, 1))).toMatch(/^3\.1\.1 {2}Details of supplies notified under section 9\(5\)/);
    expect(text(ws.getCell(head + 8, 1))).toBe(
      '(i) Taxable supplies on which electronic commerce operator pays tax u/s 9(5) [to be furnished by the ECO]',
    );
    expect(text(ws.getCell(head + 9, 1))).toBe(
      '(ii) Taxable supplies made by the registered person through electronic commerce operator, on which ECO is liable to pay tax u/s 9(5)',
    );
    const a = head + 2;
    expect([2, 3, 4, 5, 6].map((i) => num(ws, a, i))).toEqual([
      c.gstr3b[0].amounts.taxableValueInr, 0, c.taxPayable.cgstInr, c.taxPayable.sgstInr, 0,
    ]);
    expect(num(ws, head + 4, 2)).toBe(c.gstr1.nilExempt[3].exemptedInr); // 3.1(c)
    for (let r = head + 2; r <= head + 9; r++) {
      if (r === head + 7) continue;
      for (let col = 2; col <= 6; col++) expect(ws.getCell(r, col).numFmt, `${r}:${col}`).toBe(MONEY_FORMAT);
    }
    // Why each nil row is nil, in the Remarks column.
    expect(text(ws.getCell(head + 3, 7))).toContain('Nil');
  });

  it('Summary: GSTR-1 at a glance agrees with the tables', async () => {
    const ws = (await load(c)).getWorksheet('Summary')!;
    const r7 = rowOf(ws, 'Table 7 —');
    const r8 = rowOf(ws, 'Table 8 —');
    const r12 = rowOf(ws, 'Table 12 —');
    const r13 = rowOf(ws, 'Table 13 —');
    const taxable7 = sum(c.gstr1.b2cs.map((x) => x.taxableValueInr));
    const exempt8 = sum(c.gstr1.nilExempt.map((x) => x.exemptedInr));
    expect(num(ws, r7, 2)).toBe(taxable7);
    expect(num(ws, r8, 5)).toBe(exempt8);
    expect(num(ws, r12, 2)).toBe(sum([taxable7, exempt8])); // Table 12 = Table 7 + Table 8
    expect(num(ws, r13, 6)).toBe(c.counts.issuedBills);
    expect(ws.getCell(r13, 6).numFmt).toBe(COUNT_FORMAT);
    expect(text(ws.getCell(r13, 7))).toContain('HIOC-000412');
  });

  it('Summary: both reconciliations add up, and are tied to the figures they feed', async () => {
    const ws = (await load(c)).getWorksheet('Summary')!;
    for (const [title, firstLabel, lastLabel, expectedTotal] of [
      ['Reconciliation 1', 'Gross item sales', 'Taxable value', c.gstr3b[0].amounts.taxableValueInr],
      ['Reconciliation 2', 'Taxable value', 'Total invoice value of bills issued', sum(c.invoiceRegister.filter((x) => x.status === 'Issued').map((x) => x.invoiceValueInr))],
    ] as const) {
      const band = rowOf(ws, title);
      const first = rowOf(ws, firstLabel, 1, band + 3);
      const last = rowOf(ws, lastLabel, 1, first + 1);
      let running = 0;
      for (let r = first; r < last; r++) {
        running = sum([running, num(ws, r, 2)]);
        expect(ws.getCell(r, 2).numFmt).toBe(MONEY_FORMAT);
      }
      // Less-lines are shown as negatives, so the column adds up to the total.
      expect(running).toBe(num(ws, last, 2));
      expect(num(ws, last, 2)).toBe(expectedTotal);
      expect(ws.getCell(last, 1).font?.bold).toBe(true);
      expect(ws.getCell(last, 1).border?.top?.style).toBe('thin');
      expect(ws.getCell(last, 1).border?.bottom?.style).toBe('double');
      expect(text(ws.getCell(last + 1, 1))).toMatch(/^✓ {2}Agrees to /);
    }
    const lessRow = rowOf(ws, 'Less: HIOC Ritual cups covered by a pass');
    expect(num(ws, lessRow, 2)).toBeLessThan(0);
    expect(text(ws.getCell(rowOf(ws, 'Add: Packaging charged with GST'), 2))).not.toBe('');
  });

  it('Summary: a reconciliation that does not tie says so', async () => {
    const bad = gstComputationFixture();
    bad.toTaxableValue = bad.toTaxableValue.map((l) => (l.kind === 'total' ? { ...l, amountInr: l.amountInr + 12.5 } : l));
    const ws = (await load(bad)).getWorksheet('Summary')!;
    const r = rowOf(ws, '!  Differs from GSTR-3B Table 3.1(a) taxable value');
    expect(text(ws.getCell(r, 1))).toContain('by ₹12.50');
  });

  it('Summary: checks carry their icon and colour, and notes are numbered', async () => {
    const ws = (await load(c)).getWorksheet('Summary')!;
    const band = rowOf(ws, 'Checks before you file');
    expect(text(ws.getCell(band + 1, 1))).toBe('3 passed · 1 to look at · 2 for information');
    const ok = rowOf(ws, '✓   GST is 5% of taxable value');
    const warn = rowOf(ws, '!   Bills still unpaid at the end of the period');
    const info = rowOf(ws, 'i   Cancelled and rejected bills');
    expect(ws.getCell(ok, 1).font?.color?.argb).toBe('FF1E6B30');
    expect(ws.getCell(warn, 1).font?.color?.argb).toBe('FF9A4D00');
    expect(ws.getCell(info, 1).font?.color?.argb).toBe('FF1F5E99');
    expect(text(ws.getCell(warn, 2))).toContain('2 bills (₹1,284.00)');
    expect(ws.getCell(warn, 1).fill).toMatchObject({ type: 'pattern', fgColor: { argb: 'FFFFF1D6' } });
    const notes = rowOf(ws, 'Notes for the CA');
    c.notes.forEach((n, i) => expect(text(ws.getCell(notes + 1 + i, 1))).toBe(`${i + 1}.  ${n}`));
  });

  it('Summary: links to the other sheets', async () => {
    const ws = (await load(c)).getWorksheet('Summary')!;
    const r = rowOf(ws, 'GSTR-1 Table 7 (B2CS)');
    expect(ws.getCell(r, 1).value).toMatchObject({ text: 'GSTR-1 Table 7 (B2CS)', hyperlink: "#'GSTR-1 Table 7 (B2CS)'!A1" });
  });

  it('Table 7: the offline tool columns, a total, money formats', async () => {
    const ws = (await load(c)).getWorksheet('GSTR-1 Table 7 (B2CS)')!;
    expect([1, 2, 3, 4, 5, 6, 7].map((i) => text(ws.getCell(3, i)))).toEqual([
      'Type', 'Place Of Supply', 'Applicable % of Tax Rate', 'Rate', 'Taxable Value', 'Cess Amount', 'E-Commerce GSTIN',
    ]);
    expect(text(ws.getCell('A1'))).toBe('GSTR-1 Table 7 — B2C (Small) supplies · October 2026');
    expect(text(ws.getCell(4, 1))).toBe('OE');
    expect(text(ws.getCell(4, 2))).toBe('09-Uttar Pradesh');
    expect(num(ws, 4, 4)).toBe(5);
    expect(num(ws, 4, 5)).toBe(c.gstr1.b2cs[0].taxableValueInr);
    expect(ws.getCell(4, 5).numFmt).toBe(MONEY_FORMAT);
    expect(text(ws.getCell(5, 1))).toBe('TOTAL');
    expect(num(ws, 5, 5)).toBe(num(ws, 4, 5));
    expect(ws.getCell(5, 5).font?.bold).toBe(true);
    expect(ws.getCell(3, 5).font?.bold).toBe(true);
    expect(ws.getCell(3, 5).fill).toMatchObject({ type: 'pattern' });
    expect(ws.getCell(4, 5).border?.bottom?.style).toBe('thin');
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 3 });
  });

  it('Table 8: the four fixed rows with the offline tool headers, and a total', async () => {
    const ws = (await load(c)).getWorksheet('GSTR-1 Table 8 (Nil-Exempt)')!;
    expect([1, 2, 3, 4].map((i) => text(ws.getCell(3, i)))).toEqual([
      'Description', 'Nil Rated Supplies', 'Exempted (other than nil rated/non GST supply)', 'Non-GST Supplies',
    ]);
    expect([4, 5, 6, 7].map((r) => text(ws.getCell(r, 1)))).toEqual([
      'Inter-State supplies to registered persons',
      'Intra-State supplies to registered persons',
      'Inter-State supplies to unregistered persons',
      'Intra-State supplies to unregistered persons',
    ]);
    expect(num(ws, 7, 3)).toBe(c.gstr1.nilExempt[3].exemptedInr);
    expect(text(ws.getCell(8, 1))).toBe('TOTAL');
    expect(num(ws, 8, 3)).toBe(c.gstr1.nilExempt[3].exemptedInr);
    expect(ws.getCell(7, 3).numFmt).toBe(MONEY_FORMAT);
  });

  it('Table 12: HSN / SAC codes are text, quantities in kg, totals tie to Tables 7 + 8', async () => {
    const wb = await load(c);
    const ws = wb.getWorksheet('GSTR-1 Table 12 (HSN)')!;
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((i) => text(ws.getCell(3, i)))).toEqual([
      'HSN', 'Description', 'UQC', 'Total Quantity', 'Total Value', 'Rate', 'Taxable Value',
      'Integrated Tax Amount', 'Central Tax Amount', 'State/UT Tax Amount', 'Cess Amount',
    ]);
    const beans = rowOf(ws, '0901');
    expect(ws.getCell(beans, 1).value).toBe('0901'); // a string, zero kept
    expect(typeof ws.getCell(beans, 1).value).toBe('string');
    expect(ws.getCell(beans, 1).numFmt).toBe('@');
    expect(typeof ws.getCell(rowOf(ws, '996331'), 1).value).toBe('string');
    expect(text(ws.getCell(beans, 2))).toBe('Coffee, roasted');
    expect(text(ws.getCell(beans, 3))).toBe('KGS-KILOGRAMS');
    expect(num(ws, beans, 4)).toBe(c.gstr1.hsn[1].quantity);
    expect(ws.getCell(beans, 4).numFmt).toBe(QUANTITY_FORMAT);
    const service = rowOf(ws, '996331');
    expect(text(ws.getCell(service, 3))).toBe('NA');
    expect(num(ws, service, 4)).toBe(0);

    const total = rowOf(ws, 'TOTAL');
    expect(total).toBe(3 + c.gstr1.hsn.length + 1);
    const taxableTotal = num(ws, total, 7);
    expect(taxableTotal).toBe(sum(c.gstr1.hsn.map((h) => h.taxableValueInr)));
    expect(num(ws, total, 5)).toBe(sum(c.gstr1.hsn.map((h) => h.totalValueInr)));
    expect(num(ws, total, 9)).toBe(c.taxPayable.cgstInr);
    expect(num(ws, total, 10)).toBe(c.taxPayable.sgstInr);

    const t7 = wb.getWorksheet('GSTR-1 Table 7 (B2CS)')!;
    const t8 = wb.getWorksheet('GSTR-1 Table 8 (Nil-Exempt)')!;
    expect(taxableTotal).toBe(sum([num(t7, 5, 5), num(t8, 8, 3) + num(t8, 8, 2) + num(t8, 8, 4)]));
  });

  it('Table 13: the series as text, no total row, Net Issued after the tool columns', async () => {
    const ws = (await load(c)).getWorksheet('GSTR-1 Table 13 (Docs)')!;
    expect([1, 2, 3, 4, 5, 6].map((i) => text(ws.getCell(3, i)))).toEqual([
      'Nature of Document', 'Sr. No. From', 'Sr. No. To', 'Total Number', 'Cancelled', 'Net Issued',
    ]);
    expect(text(ws.getCell(4, 1))).toBe('Invoices for outward supply');
    expect(ws.getCell(4, 2).value).toBe('HIOC-000412');
    expect(typeof ws.getCell(4, 3).value).toBe('string');
    expect(num(ws, 4, 4)).toBe(c.gstr1.docs[0].totalNumber);
    expect(num(ws, 4, 5)).toBe(4);
    expect(num(ws, 4, 6)).toBe(c.counts.issuedBills);
    expect(num(ws, 4, 4) - num(ws, 4, 5)).toBe(num(ws, 4, 6));
    expect(ws.getCell(5, 1).value).toBeNull();
    expect(text(ws.getCell(5, 1))).not.toBe('TOTAL');
  });

  it('Day-wise register: every day, real dates, totals that match the tables', async () => {
    const wb = await load(c);
    const ws = wb.getWorksheet('Day-wise register')!;
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((i) => text(ws.getCell(3, i)))).toEqual([
      'Date', 'First invoice no.', 'Last invoice no.', 'Bills issued', 'Bills cancelled', 'Taxable value',
      'Central tax (CGST)', 'State/UT tax (SGST)', 'GST-exempt value', 'Invoice value',
    ]);
    const first = ws.getCell(4, 1);
    expect(first.value).toBeInstanceOf(Date);
    expect((first.value as Date).toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(first.numFmt).toBe(DATE_FORMAT);
    expect((ws.getCell(34, 1).value as Date).toISOString().slice(0, 10)).toBe('2026-10-31');
    expect(text(ws.getCell(35, 1))).toBe('TOTAL');
    expect(ws.getCell(4, 2).value).toBe(c.dayRegister[0].firstInvoice);
    const total = 35;
    expect(num(ws, total, 4)).toBe(c.counts.issuedBills);
    expect(num(ws, total, 5)).toBe(c.counts.cancelledBills);
    const t7 = wb.getWorksheet('GSTR-1 Table 7 (B2CS)')!;
    expect(num(ws, total, 6)).toBe(num(t7, 5, 5));
    expect(num(ws, total, 7)).toBe(c.taxPayable.cgstInr);
    expect(num(ws, total, 8)).toBe(c.taxPayable.sgstInr);
    const lastTotal = [...c.toInvoiceValue].reverse().find((l) => l.kind === 'total')!;
    expect(num(ws, total, 10)).toBe(lastTotal.amountInr);
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 3, xSplit: 1 });
  });

  it('Day-wise register: a day with no bills is greyed', async () => {
    const quiet = gstComputationFixture();
    quiet.dayRegister[2] = {
      date: '2026-10-03', firstInvoice: '', lastInvoice: '', bills: 0, cancelled: 0,
      taxableValueInr: 0, cgstInr: 0, sgstInr: 0, exemptValueInr: 0, invoiceValueInr: 0,
    };
    const ws = (await load(quiet)).getWorksheet('Day-wise register')!;
    expect(ws.getCell(6, 1).font?.color?.argb).toBe('FF8C8C8C');
    expect(ws.getCell(5, 1).font?.color?.argb).not.toBe('FF8C8C8C');
    expect(ws.getCell(6, 2).value).toBeNull();
  });

  it('Invoice register: invoice numbers as text, cancelled rows greyed and in no total', async () => {
    const ws = (await load(c)).getWorksheet('Invoice register')!;
    expect(c.invoiceRegister).toHaveLength(462);
    expect(text(ws.getCell(3, 1))).toBe('Invoice no.');
    expect(ws.getCell(4, 1).value).toBe('HIOC-000412');
    expect(typeof ws.getCell(4, 1).value).toBe('string');
    expect(ws.getCell(4, 2).numFmt).toBe(DATE_FORMAT);
    expect(text(ws.getCell(4, 3))).toBe(c.invoiceRegister[0].time);
    expect(ws.getCell(4, 12).numFmt).toBe(MONEY_FORMAT);

    const cancelledAt = c.invoiceRegister.findIndex((x) => x.status === 'Cancelled');
    const rejectedAt = c.invoiceRegister.findIndex((x) => x.status === 'Rejected');
    for (const i of [cancelledAt, rejectedAt]) {
      const cell = ws.getCell(4 + i, 4);
      expect(['Cancelled', 'Rejected']).toContain(text(cell));
      expect(cell.font?.color?.argb).toBe('FF8C8C8C');
      expect(cell.fill).toMatchObject({ type: 'pattern', fgColor: { argb: 'FFF0F0F0' } });
    }
    expect(ws.getCell(4, 4).font?.color?.argb).not.toBe('FF8C8C8C');

    const total = 4 + c.invoiceRegister.length;
    expect(text(ws.getCell(total, 1))).toBe('TOTAL — 458 issued bills only');
    const issued = c.invoiceRegister.filter((x) => x.status === 'Issued');
    const all = c.invoiceRegister;
    expect(num(ws, total, 12)).toBe(sum(issued.map((x) => x.invoiceValueInr)));
    expect(num(ws, total, 12)).not.toBe(sum(all.map((x) => x.invoiceValueInr)));
    expect(num(ws, total, 6)).toBe(sum(issued.map((x) => x.taxableValueInr)));
    expect(num(ws, total, 7)).toBe(c.taxPayable.cgstInr);
    expect(text(ws.getCell(total + 2, 1))).toBe('4 cancelled or rejected bills are listed above and left out of the total.');
  });

  it('Glossary: every term and meaning', async () => {
    const ws = (await load(c)).getWorksheet('Glossary')!;
    expect(text(ws.getCell(3, 1))).toBe('Term');
    c.glossary.forEach((g, i) => {
      expect(text(ws.getCell(4 + i, 1))).toBe(g.term);
      expect(text(ws.getCell(4 + i, 2))).toBe(g.meaning);
      expect(ws.getCell(4 + i, 2).alignment?.wrapText).toBe(true);
    });
  });

  it('prints landscape A4, one page wide, with the GSTIN header and page numbers', async () => {
    const wb = await load(c);
    for (const ws of wb.worksheets) {
      expect(ws.pageSetup.orientation, ws.name).toBe('landscape');
      expect(ws.pageSetup.paperSize, ws.name).toBe(9);
      expect(ws.pageSetup.fitToPage, ws.name).toBe(true);
      expect(ws.pageSetup.fitToWidth, ws.name).toBe(1);
      expect(ws.pageSetup.fitToHeight, ws.name).toBe(0);
      expect(ws.headerFooter.oddHeader, ws.name).toContain('HIOC · GSTIN 09AGJPA9390E1Z9 · October 2026');
      expect(ws.headerFooter.oddFooter, ws.name).toContain('Page &P of &N');
    }
    expect(wb.getWorksheet('Invoice register')!.pageSetup.printTitlesRow).toBe('3:3');
  });

  it('sets sensible column widths and wraps notes', async () => {
    const wb = await load(c);
    const summary = wb.getWorksheet('Summary')!;
    expect(summary.getColumn(1).width).toBeGreaterThanOrEqual(40);
    for (const ws of wb.worksheets) {
      for (let i = 1; i <= ws.columnCount; i++) expect(ws.getColumn(i).width ?? 0, `${ws.name} col ${i}`).toBeGreaterThanOrEqual(8);
    }
    const note = rowOf(summary, '1.  No sale is to a registered business');
    expect(summary.getCell(note, 1).alignment?.wrapText).toBe(true);
    expect(summary.getRow(note).height).toBeGreaterThanOrEqual(18);
  });

  it('has no formulas anywhere, and text that looks like one stays text', async () => {
    const hostile = gstComputationFixture();
    hostile.notes[0] = '=HYPERLINK("http://evil.example","click")';
    hostile.business.tradeName = '@SUM(1+1)';
    hostile.invoiceRegister[0].paymentMode = '+1+1';
    hostile.glossary[0].meaning = '-2+3';
    const wb = await load(hostile);
    let formulas = 0;
    let cells = 0;
    for (const ws of wb.worksheets) {
      ws.eachRow({ includeEmpty: false }, (row) =>
        row.eachCell({ includeEmpty: false }, (cell) => {
          cells++;
          if (cell.type === ExcelJS.ValueType.Formula || (cell.value && typeof cell.value === 'object' && 'formula' in cell.value)) formulas++;
        }),
      );
    }
    expect(cells).toBeGreaterThan(1000);
    expect(formulas).toBe(0);
    const summary = wb.getWorksheet('Summary')!;
    const note = rowOf(summary, '1.  =HYPERLINK');
    expect(summary.getCell(note, 1).type).toBe(ExcelJS.ValueType.String);
    expect(wb.getWorksheet('Invoice register')!.getCell(4, 13).value).toBe('+1+1');
    expect(wb.getWorksheet('Glossary')!.getCell(4, 2).value).toBe('-2+3');
    // The raw file holds no <f> formula element in any sheet.
    const zip = await JSZip.loadAsync(await buildGstWorkbook(hostile));
    const sheets = Object.keys(zip.files).filter((f) => /^xl\/worksheets\/sheet\d+\.xml$/.test(f));
    expect(sheets).toHaveLength(8);
    for (const f of sheets) expect(await zip.file(f)!.async('string')).not.toMatch(/<f[ >]/);
  });

  it('escapes & in the printed header', async () => {
    const amp = gstComputationFixture();
    amp.business.legalName = 'Arry & Sons';
    const ws = (await load(amp)).getWorksheet('Summary')!;
    expect(ws.headerFooter.oddHeader).toContain('Arry && Sons');
  });

  it('says QRMP once: in the box, or only in the notes when the notes carry it', async () => {
    const own = (await load(c)).getWorksheet('Summary')!;
    expect(text(own.getCell(rowOf(own, 'These are the dates for a monthly filer'), 1))).toContain('QRMP filer (turnover up to ₹5 crore)');
    const withNote = gstComputationFixture();
    withNote.notes = ['Monthly filer: GSTR-1 by the 11th. If you are on QRMP (turnover up to ₹5 Cr): quarterly.', ...withNote.notes];
    const ws = (await load(withNote)).getWorksheet('Summary')!;
    const box = text(ws.getCell(rowOf(ws, 'These are the dates for a monthly filer'), 1));
    expect(box).not.toContain('turnover up to');
    let mentions = 0;
    ws.eachRow((row) => {
      if (/QRMP/.test(text(row.getCell(1)))) mentions++;
    });
    expect(mentions).toBe(2); // the box pointing to the note, and the note itself
  });

  it('a custom range has no return period or due dates', async () => {
    const custom = gstComputationFixture();
    custom.period = {
      ...custom.period,
      from: '2026-10-05',
      to: '2026-10-19',
      label: '5 Oct – 19 Oct 2026',
      isWholeMonth: false,
      returnPeriod: null,
      gstr1DueDate: null,
      gstr3bDueDate: null,
    };
    const ws = (await load(custom)).getWorksheet('Summary')!;
    expect(text(ws.getCell('A1'))).toBe('GST working — 5 Oct – 19 Oct 2026');
    expect(text(ws.getCell(rowOf(ws, 'Return period'), 2))).toBe('None — custom dates, not a whole month');
    expect(() => rowOf(ws, 'GSTR-1 due by')).toThrow();
    expect(text(ws.getCell(rowOf(ws, 'Due dates are shown for a whole month only'), 1))).toContain('custom dates');
  });

  it('builds a clean workbook for a month with no sales', async () => {
    const empty: GstComputation = {
      ...gstComputationFixture(),
      taxPayable: { igstInr: 0, cgstInr: 0, sgstInr: 0, cessInr: 0, totalInr: 0 },
      gstr3b: gstComputationFixture().gstr3b.map((r) => ({ ...r, amounts: { taxableValueInr: 0, igstInr: 0, cgstInr: 0, sgstInr: 0, cessInr: 0 } })),
      gstr1: { b2cs: [], nilExempt: [], hsn: [], docs: [] },
      toTaxableValue: [],
      toInvoiceValue: [],
      dayRegister: [],
      invoiceRegister: [],
      checks: [],
      notes: [],
      glossary: [],
      counts: { issuedBills: 0, cancelledBills: 0, afterDiscountBills: 0, beforeDiscountBills: 0 },
    };
    const wb = await load(empty);
    expect(wb.worksheets).toHaveLength(8);
    const summary = wb.getWorksheet('Summary')!;
    expect(num(summary, rowOf(summary, 'Total GST to pay'), 2)).toBe(0);
    expect(text(summary.getCell(rowOf(summary, 'Nothing to reconcile in this period.'), 1))).toBeTruthy();
    expect(text(summary.getCell(rowOf(summary, 'No checks were run.'), 1))).toBeTruthy();
    expect(text(wb.getWorksheet('GSTR-1 Table 7 (B2CS)')!.getCell(4, 1))).toBe('No taxable sales in this period.');
    expect(text(wb.getWorksheet('Invoice register')!.getCell(4, 1))).toBe('No bills in this period.');
    expect(text(wb.getWorksheet('GSTR-1 Table 13 (Docs)')!.getCell(4, 1))).toBe('No invoices were issued in this period.');
    expect(num(wb.getWorksheet('Invoice register')!, 5, 12)).toBe(0);
  });
});

describe('gstWorkbookFileName', () => {
  it('names a whole month by its return period, anything else by its dates', () => {
    expect(gstWorkbookFileName('09AGJPA9390E1Z9', '2026-10-01', '2026-10-31')).toBe('HIOC-GST-09AGJPA9390E1Z9-102026.xlsx');
    expect(gstWorkbookFileName('09AGJPA9390E1Z9', '2026-02-01', '2026-02-28')).toBe('HIOC-GST-09AGJPA9390E1Z9-022026.xlsx');
    expect(gstWorkbookFileName('09AGJPA9390E1Z9', '2026-10-05', '2026-10-19')).toBe(
      'HIOC-GST-09AGJPA9390E1Z9-2026-10-05_to_2026-10-19.xlsx',
    );
  });

  it('keeps only letters and digits of the GSTIN', () => {
    expect(gstWorkbookFileName('09AGJ"\r\nPA9390E1Z9', '2026-10-01', '2026-10-31')).toBe('HIOC-GST-09AGJPA9390E1Z9-102026.xlsx');
  });
});

describe('formatInr', () => {
  it('groups lakhs and crores the Indian way', () => {
    expect(formatInr(0)).toBe('₹0.00');
    expect(formatInr(999.5)).toBe('₹999.50');
    expect(formatInr(12345.6)).toBe('₹12,345.60');
    expect(formatInr(270807.2)).toBe('₹2,70,807.20');
    expect(formatInr(12345678.9)).toBe('₹1,23,45,678.90');
    expect(formatInr(-1284)).toBe('-₹1,284.00');
  });
});
