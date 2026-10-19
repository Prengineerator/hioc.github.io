// The GST filing pack as downloadable reports: each loads the month's
// OrderDataset once and hands it to a pure builder (gstReports.ts).

import 'server-only';
import { loadOrderDataset } from '@/lib/reports/exports/orderDataServer';
import { b2cs, docsIssued, gstSummary, hsnB2c } from '@/lib/reports/exports/gstReports';
import type { ReportDef } from '@/lib/reports/exports/types';

export const GST_REPORTS: ReportDef[] = [
  {
    key: 'gst-summary',
    group: 'gst',
    title: 'GST summary (for GSTR-3B)',
    description:
      'Taxable sales with CGST and SGST, exempt sales, packaging, discounts, cancelled bills and refunds in plain words, each tagged with the return it goes into.',
    load: async (admin, from, to) => gstSummary(await loadOrderDataset(admin, from, to)),
  },
  {
    key: 'gstr1-b2cs',
    group: 'gst',
    title: 'GSTR-1 Table 7 — B2C small sales',
    description: 'Taxable value of the period’s sales to walk-in customers, by rate, in the GST offline tool’s format.',
    load: async (admin, from, to) => b2cs(await loadOrderDataset(admin, from, to)),
  },
  {
    key: 'gstr1-hsn',
    group: 'gst',
    title: 'GSTR-1 Table 12 — HSN / SAC summary',
    description:
      'Sales and GST by code: restaurant service (SAC 996331) and roasted coffee beans by the kilo (HSN 0901), with exempt items in their own rate-0 row.',
    load: async (admin, from, to) => hsnB2c(await loadOrderDataset(admin, from, to)),
  },
  {
    key: 'gstr1-docs',
    group: 'gst',
    title: 'GSTR-1 Table 13 — Documents issued',
    description:
      'First and last invoice number of the period, how many were issued and how many were cancelled (gaps in the numbering count as cancelled).',
    load: async (admin, from, to) => docsIssued(await loadOrderDataset(admin, from, to)),
  },
];
