// The GST filing pack as downloadable reports: each loads the period's GST working
// once (gstComputationServer.ts) and hands it to a pure renderer (gstReports.ts).
// Keys are stable — links to them are in the owner's bookmarks and on the GST page.

import 'server-only';
import { loadGstComputation } from '@/lib/reports/exports/gstComputationServer';
import {
  b2cs,
  dayRegister,
  docsIssued,
  exemptTable,
  gstSummary,
  hsnB2c,
  invoiceRegister,
} from '@/lib/reports/exports/gstReports';
import type { ReportDef } from '@/lib/reports/exports/types';

export const GST_REPORTS: ReportDef[] = [
  {
    key: 'gst-summary',
    group: 'gst',
    title: 'GST working (one-page summary)',
    description:
      'The GST to pay, GSTR-3B Table 3.1, how sales turn into taxable value and into the bills’ totals, checks to look at before filing and notes for your CA.',
    load: async (admin, from, to) => gstSummary(await loadGstComputation(admin, from, to)),
  },
  {
    key: 'gstr1-b2cs',
    group: 'gst',
    title: 'GSTR-1 Table 7: walk-in sales (for the GST offline tool)',
    description: 'Taxable value of the period’s sales to walk-in customers, by rate, as the GST offline tool imports it.',
    load: async (admin, from, to) => b2cs(await loadGstComputation(admin, from, to)),
  },
  {
    key: 'gstr1-exempt',
    group: 'gst',
    title: 'GSTR-1 Table 8: nil rated and exempt sales (for the GST offline tool)',
    description:
      'Sales with no GST (items marked GST-exempt on the menu), in the four rows of Table 8 as the GST offline tool imports them.',
    load: async (admin, from, to) => exemptTable(await loadGstComputation(admin, from, to)),
  },
  {
    key: 'gstr1-hsn',
    group: 'gst',
    title: 'GSTR-1 Table 12: sales by HSN / SAC code (for the GST offline tool)',
    description:
      'Sales and GST by code: restaurant service (SAC 996331, takeaway packaging included where it is taxed) and roasted coffee beans by the kilo (HSN 0901), with exempt items in their own rate-0 row.',
    load: async (admin, from, to) => hsnB2c(await loadGstComputation(admin, from, to)),
  },
  {
    key: 'gstr1-docs',
    group: 'gst',
    title: 'GSTR-1 Table 13: bills issued (for the GST offline tool)',
    description:
      'First and last invoice number of the period, how many numbers were used and how many were cancelled (gaps in the numbering count as cancelled).',
    load: async (admin, from, to) => docsIssued(await loadGstComputation(admin, from, to)),
  },
  {
    key: 'gst-day-register',
    group: 'gst',
    title: 'GST day by day',
    description:
      'One row for every day of the period: first and last invoice number, bills issued and cancelled, taxable value, CGST, SGST, exempt sales and invoice value.',
    load: async (admin, from, to) => dayRegister(await loadGstComputation(admin, from, to)),
  },
  {
    key: 'gst-invoice-register',
    group: 'gst',
    title: 'GST bill by bill',
    description:
      'Every bill in invoice-number order, cancelled and rejected ones included (marked, and left out of the totals), with its GST basis, taxable value, CGST, SGST, exempt sales, packaging, discount and total.',
    load: async (admin, from, to) => invoiceRegister(await loadGstComputation(admin, from, to)),
  },
];
