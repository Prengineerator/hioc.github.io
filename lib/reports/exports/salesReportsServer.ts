// The sales downloads on Owner → Reports → Downloads: each report loads the one
// OrderDataset for the range (lib/reports/exports/orderDataServer.ts) and hands
// it to its pure builder in lib/reports/exports/salesReports.ts.

import 'server-only';
import { loadOrderDataset } from '@/lib/reports/exports/orderDataServer';
import {
  cancellationReport,
  categorySales,
  daySales,
  discountReport,
  hourlySales,
  itemSales,
  orderRegister,
  refundReport,
  staffSales,
} from '@/lib/reports/exports/salesReports';
import type { CsvTable } from '@/lib/reports/csv';
import type { OrderDataset, ReportDef } from '@/lib/reports/exports/types';

function salesReport(
  key: string,
  title: string,
  description: string,
  build: (ds: OrderDataset) => CsvTable,
): ReportDef {
  return {
    key,
    group: 'sales',
    title,
    description,
    load: async (admin, from, to) => build(await loadOrderDataset(admin, from, to)),
  };
}

export const SALES_REPORTS: ReportDef[] = [
  salesReport(
    'orders',
    'Order-wise sales register',
    'Every bill placed in the period with its GST, discounts, tip, refund and payment method; cancelled bills are listed but left out of the total.',
    orderRegister,
  ),
  salesReport(
    'day-wise',
    'Day-wise sales',
    'One row per day: bills, items sold, discounts, taxable value, GST, packaging, bill total and net sales.',
    daySales,
  ),
  salesReport(
    'items',
    'Item-wise sales',
    'What sold, by item and variant: quantity, gross sales, taxable value, GST and share of sales, best seller first.',
    itemSales,
  ),
  salesReport(
    'categories',
    'Category-wise sales',
    'Sales rolled up by menu category, with taxable value, GST and share of sales.',
    categorySales,
  ),
  salesReport(
    'hourly',
    'Hour-wise sales',
    'Bills and sales for each hour of the day, to see when the café is busiest.',
    hourlySales,
  ),
  salesReport(
    'staff',
    'Staff-wise sales',
    'Bills rung up by each staff member (and online orders), with their discounts, tips, cancelled bills and voided items.',
    staffSales,
  ),
  salesReport(
    'discounts',
    'Discounts given',
    'Every bill with a coupon, Beanies, settle discount or Ritual cups covered, and how much was knocked off.',
    discountReport,
  ),
  salesReport(
    'cancellations',
    'Cancelled bills & voided items',
    'Bills that were cancelled or rejected and items voided from any bill, with the reason given.',
    cancellationReport,
  ),
  salesReport(
    'refunds',
    'Refunds',
    'Refunds raised in the period with the bill, amount, method and reason; for your accountant, as no credit notes are issued.',
    refundReport,
  ),
];
