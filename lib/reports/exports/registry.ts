// Every downloadable report in one list: what the Downloads page shows and the
// export route (app/api/owner/reports/export) looks a ?report= key up in. A
// report belongs to a group; the groups appear on the page in this order.

import 'server-only';
import { CASH_REPORTS } from '@/lib/reports/exports/cashReportsServer';
import { GST_REPORTS } from '@/lib/reports/exports/gstReportsServer';
import { LOYALTY_REPORTS } from '@/lib/reports/exports/loyaltyReportsServer';
import { RETENTION_REPORTS } from '@/lib/reports/exports/retentionReportsServer';
import { SALES_REPORTS } from '@/lib/reports/exports/salesReportsServer';
import { STAFF_REPORTS } from '@/lib/reports/exports/staffReportsServer';
import type { ReportDef, ReportGroup } from '@/lib/reports/exports/types';

/** Groups in the order the Downloads page lists them. */
export const REPORT_GROUPS: { group: ReportGroup; title: string }[] = [
  { group: 'gst', title: 'GST filing (GSTR-1 / GSTR-3B)' },
  { group: 'sales', title: 'Sales' },
  { group: 'cash', title: 'Cash & expenses' },
  { group: 'staff', title: 'Staff & attendance' },
  { group: 'loyalty', title: 'Loyalty, promotions & retention' },
];

export const ALL_REPORTS: ReportDef[] = [
  ...GST_REPORTS,
  ...SALES_REPORTS,
  ...CASH_REPORTS,
  ...STAFF_REPORTS,
  ...LOYALTY_REPORTS,
  ...RETENTION_REPORTS,
];

export function findReport(key: string | null | undefined): ReportDef | undefined {
  return key ? ALL_REPORTS.find((r) => r.key === key) : undefined;
}

/** The reports of one group, in registry order. */
export function reportsInGroup(group: ReportGroup): ReportDef[] {
  return ALL_REPORTS.filter((r) => r.group === group);
}
