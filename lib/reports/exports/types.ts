// Shared shapes for the owner's downloadable reports (Owner → Reports →
// Downloads). Each report is a ReportDef; the order-based reports all read one
// OrderDataset (lib/reports/exports/orderDataServer.ts), so every sheet agrees
// on what a sale, its GST and its invoice number are.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { CsvTable } from '@/lib/reports/csv';

export type ReportGroup = 'gst' | 'sales' | 'cash' | 'loyalty' | 'staff';

export interface ReportDef {
  /** URL slug: /api/owner/reports/export?report=<key>. Also the file name. */
  key: string;
  group: ReportGroup;
  /** Shown on the Downloads panel. */
  title: string;
  /** One plain sentence for the owner: what the sheet is and what it is for. */
  description: string;
  /** Builds the sheet for IST dates from..to (inclusive, YYYY-MM-DD). Server-only. */
  load: (admin: SupabaseClient, from: string, to: string) => Promise<CsvTable>;
}

/** The HSN (goods) or SAC (services) code a line is reported under. */
export interface GstCode {
  code: string;
  description: string;
  /** Unit Quantity Code for GSTR-1 Table 12, as the offline tool spells it: 'KGS-KILOGRAMS' for beans by weight, 'NA' for services. */
  uqc: string;
  kind: 'service' | 'goods';
}

/**
 * Which GST rule an order was billed under (lib/store/hours.ts GST_NET_OF_DISCOUNT_FROM):
 * 'pre_discount' = GST on the price before coupon / Beanies discounts, packaging untaxed;
 * 'net_of_discount' = GST on the price after the discount's share, packaging taxed.
 */
export type GstRule = 'pre_discount' | 'net_of_discount';

/** One order line that was not voided, with its share of the order's GST. */
export interface ExportLine {
  id: string;
  menuItemId: string | null;
  /** order_items.name_snapshot */
  name: string;
  /** variant_label_snapshot, '' when none */
  variant: string;
  /** menu_items.category; 'HIOC Ritual' for a pass-sale line; 'Uncategorised' when the item is gone. */
  category: string;
  quantity: number;
  /** Grams in one unit, sell-by-weight lines only (2026-10-sell-by-weight.sql). */
  weightGrams: number | null;
  lineTotalInr: number;
  /** What redeemed HIOC Ritual cups covered on this line (prepaid; GST was charged at the pass sale). */
  passCoveredInr: number;
  passDrinks: number;
  gstExempt: boolean;
  gstCode: GstCode;
  /**
   * Taxable value of the line, 2 dp; 0 for exempt lines. After the pass cover, and
   * (net_of_discount orders) after the line's share of the discount; with
   * inclusive pricing, less the line's GST.
   */
  taxableInr: number;
  /** What an exempt line is worth for the exempt-supplies figures (same basis as taxableInr); 0 for taxable lines. */
  exemptValueInr: number;
  /** The line's share of the order's tax_inr, split half and half, 2 dp. */
  cgstInr: number;
  sgstInr: number;
}

export interface VoidedLine {
  name: string;
  variant: string;
  quantity: number;
  lineTotalInr: number;
  reason: string | null;
}

/** One order created in the range, cancelled and rejected ones included. */
export interface ExportOrder {
  id: string;
  orderNumber: number;
  /** formatOrderNumber(order_number), e.g. 'HIOC-001234' — the number printed on the RETAIL INVOICE. */
  invoiceNo: string;
  /** orders.created_at, ISO UTC. */
  createdAt: string;
  /** IST date, YYYY-MM-DD. */
  date: string;
  /** IST time, HH:MM (24 h). */
  time: string;
  /** IST hour, 0–23. */
  hour: number;
  status: string;
  /** False for cancelled and rejected orders; they stay in the register but count in no totals. */
  valid: boolean;
  rejectReason: string | null;
  paymentStatus: string;
  /** Distinct methods: the order_payments parts when there are any, else orders.payment_method; [] when unpaid. */
  paymentMethods: string[];
  channel: string;
  orderType: string;
  /** 'menu' | 'coffee_pass' */
  orderKind: string;
  tableLabel: string | null;
  createdById: string | null;
  /** The staff member who rang it up; '' for customer orders. */
  createdByName: string;
  subtotalInr: number;
  taxInr: number;
  packagingInr: number;
  /** Coupon + Beanies, as orders.discount_inr. */
  discountInr: number;
  passDiscountInr: number;
  totalInr: number;
  settleDiscountInr: number;
  tipInr: number;
  couponCodes: string[];
  couponDiscountInr: number;
  /** discountInr − couponDiscountInr − manualDiscountInr, never below 0. */
  beaniesDiscountInr: number;
  /** A manager discount given at the POS (2026-11-manual-discount.sql); absent = 0. */
  manualDiscountInr?: number;
  /** Why it was given; '' when there is none. */
  manualDiscountReason?: string;
  /** Processed refunds against this order, whenever they happened. */
  refundedInr: number;
  /** The rule the bill's GST was charged under. */
  gstRule: GstRule;
  /** Σ lines' taxableInr, plus packagingTaxableInr. */
  taxableValueInr: number;
  /** Σ exempt lines' exemptValueInr (after the pass cover and, under net_of_discount, the discount's share). */
  exemptValueInr: number;
  /** taxInr split half and half, 2 dp (all sales are intra-state: CGST + SGST, no IGST). Lines + packaging add up to these. */
  cgstInr: number;
  sgstInr: number;
  /** Packaging's own taxable value and GST (SAC 996331); all 0 under pre_discount, where packaging is untaxed. */
  packagingTaxableInr: number;
  packagingCgstInr: number;
  packagingSgstInr: number;
  /** Lines that were not voided. */
  lines: ExportLine[];
  voidedLines: VoidedLine[];
}

export interface ExportRefund {
  id: string;
  orderId: string;
  invoiceNo: string;
  /** IST date of the refunded order. */
  orderDate: string;
  /** IST date of processed_at, or of created_at while not processed. */
  date: string;
  amountInr: number;
  method: string | null;
  reason: string | null;
  status: string;
  processedAt: string | null;
  /** refunds.created_by: the staff member who issued it; null when none is recorded. */
  createdById: string | null;
  createdByName: string;
}

export interface OrderDataset {
  from: string;
  to: string;
  /** store_settings.gst_percent and gst_inclusive as they are now (not snapshotted per order). */
  gstRatePercent: number;
  gstInclusive: boolean;
  /** Every order created in the range, sorted by orderNumber. */
  orders: ExportOrder[];
  /** Refunds whose processed_at (or created_at while pending) falls in the range. */
  refunds: ExportRefund[];
}
