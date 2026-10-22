// Shapes shared by the online-settlement pipeline (supabase/2026-10-online-
// settlements.sql): what a parser returns for one report file, and the rows
// written for it. Money is in rupees with paise (the platforms report to the
// paisa), dates are IST calendar dates 'YYYY-MM-DD', times are ISO strings
// with the +05:30 offset.

export type Platform = 'zomato' | 'swiggy';

export const PLATFORM_LABEL: Record<Platform, string> = {
  zomato: 'Zomato',
  swiggy: 'Swiggy',
};

/** delivered | cancelled | rejected | timed_out, or the report's own word lower-cased. */
export type SettlementOrderStatus = string;

export interface SettlementOrder {
  orderId: string;
  /** When the customer placed the order, ISO with +05:30. */
  orderedAt: string;
  status: SettlementOrderStatus;
  orderType: string;
  offer: string;
  paymentMode: string;
  cancelReason: string;
  cancelStage: string;
  refundPolicy: string;
  menuSales: number;
  packaging: number;
  /** Every restaurant-funded discount on the order (promo, freebies/BOGO, delivery-charge discount). */
  discount: number;
  gstFromCustomer: number;
  netOrderValue: number;
  commissionPct: number | null;
  commission: number;
  paymentFee: number;
  gstOnFees: number;
  tcs: number;
  tds: number;
  gstPaidByPlatform: number;
  gstDueByRestaurant: number;
  otherDeductions: number;
  additions: number;
  payout: number;
  settlementStatus: string;
  settlementDate: string | null;
  utr: string;
  unsettled: number;
  customerRef: string | null;
}

export type DeductionKind = 'ads' | 'hyperpure' | 'other' | 'adjustment' | 'addition';

export interface SettlementDeduction {
  kind: DeductionKind;
  label: string;
  ref: string;
  periodText: string;
  periodStart: string | null;
  periodEnd: string | null;
  settlementStatus: string;
  amount: number;
  settled: number;
  outstanding: number;
}

export interface ParsedSettlement {
  platform: Platform;
  restaurantRef: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  orders: SettlementOrder[];
  deductions: SettlementDeduction[];
  /** Things a person should know about this file (skipped rows, missing sheets). */
  warnings: string[];
}

/** A workbook read into plain values: sheet name → rows → cells. */
export type Sheets = Record<string, unknown[][]>;
