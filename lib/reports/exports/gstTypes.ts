// The month's GST working, as one object: what the owner sees on Owner →
// Reports → GST, what the CA's Excel workbook holds, and what the GST CSVs are
// cut from. Built by lib/reports/exports/gstComputation.ts from the
// OrderDataset, so every view shows the same figures. Money is in rupees,
// rounded to paise.

/** The business the return is for (lib/legal.ts BUSINESS). */
export interface GstBusiness {
  legalName: string;
  tradeName: string;
  gstin: string;
  /** '09' — the first two digits of the GSTIN. */
  stateCode: string;
  stateName: string;
  address: string;
}

export interface GstPeriod {
  from: string;
  to: string;
  /** 'October 2026', or '1 Oct – 15 Oct 2026' for custom dates. */
  label: string;
  isWholeMonth: boolean;
  /** The portal's return period, MMYYYY ('102026'); null for custom dates. */
  returnPeriod: string | null;
  /** Indian financial year, April to March: '2026-27'. */
  financialYear: string;
  /** Monthly filer due dates (ISO), null for custom dates. */
  gstr1DueDate: string | null;
  gstr3bDueDate: string | null;
}

export interface TaxAmounts {
  taxableValueInr: number;
  igstInr: number;
  cgstInr: number;
  sgstInr: number;
  cessInr: number;
}

/** One row of GSTR-3B Table 3.1, labelled as on the portal. */
export interface Gstr3bRow {
  /** '3.1(a)' … '3.1(e)', '3.1.1(i)', '3.1.1(ii)' */
  code: string;
  label: string;
  amounts: TaxAmounts;
  /** False when the row cannot apply to this café (zero rated, reverse charge …): shown as nil. */
  applies: boolean;
  /** One plain sentence: what is in the row, or why it is nil. */
  note: string;
}

/** GSTR-1 Table 7, one row per rate (the offline tool's b2cs columns, plus the tax for reading). */
export interface B2csRow {
  type: string;
  placeOfSupply: string;
  applicablePercent: string;
  rate: number;
  taxableValueInr: number;
  cessInr: number;
  ecommerceGstin: string;
  cgstInr: number;
  sgstInr: number;
}

/** GSTR-1 Table 8, one row per description. */
export interface NilExemptRow {
  description: string;
  nilRatedInr: number;
  exemptedInr: number;
  nonGstInr: number;
}

/** GSTR-1 Table 12, B2C tab. */
export interface HsnRow {
  hsn: string;
  description: string;
  uqc: string;
  quantity: number;
  totalValueInr: number;
  rate: number;
  taxableValueInr: number;
  igstInr: number;
  cgstInr: number;
  sgstInr: number;
  cessInr: number;
  kind: 'service' | 'goods';
}

/** GSTR-1 Table 13. */
export interface DocsRow {
  nature: string;
  fromNo: string;
  toNo: string;
  totalNumber: number;
  cancelled: number;
  netIssued: number;
}

/** One step of a reconciliation; the steps add up, top to bottom, to the last 'total' line. */
export interface ReconLine {
  label: string;
  amountInr: number;
  kind: 'start' | 'add' | 'less' | 'subtotal' | 'total';
  note?: string;
}

export interface GstDayRow {
  date: string;
  firstInvoice: string;
  lastInvoice: string;
  bills: number;
  cancelled: number;
  taxableValueInr: number;
  cgstInr: number;
  sgstInr: number;
  exemptValueInr: number;
  invoiceValueInr: number;
}

export interface GstInvoiceRow {
  invoiceNo: string;
  date: string;
  time: string;
  status: 'Issued' | 'Cancelled' | 'Rejected';
  /** How GST was worked out on this bill. */
  gstBasis: 'Before discount' | 'After discount';
  taxableValueInr: number;
  cgstInr: number;
  sgstInr: number;
  exemptValueInr: number;
  packagingInr: number;
  discountInr: number;
  invoiceValueInr: number;
  paymentMode: string;
}

export interface GstCheck {
  status: 'ok' | 'warn' | 'info';
  title: string;
  detail: string;
}

export interface GstComputation {
  business: GstBusiness;
  period: GstPeriod;
  ratePercent: number;
  pricesIncludeGst: boolean;
  /** What the month's GSTR-3B asks the café to pay. A restaurant at 5% takes no input tax credit, so all of it is paid in cash. */
  taxPayable: { igstInr: number; cgstInr: number; sgstInr: number; cessInr: number; totalInr: number };
  gstr3b: Gstr3bRow[];
  gstr1: { b2cs: B2csRow[]; nilExempt: NilExemptRow[]; hsn: HsnRow[]; docs: DocsRow[] };
  /** Gross item sales → taxable value. */
  toTaxableValue: ReconLine[];
  /** Taxable value → total invoice value of the bills issued. */
  toInvoiceValue: ReconLine[];
  dayRegister: GstDayRow[];
  invoiceRegister: GstInvoiceRow[];
  checks: GstCheck[];
  /** Short notes for the CA, one fact each. */
  notes: string[];
  glossary: { term: string; meaning: string }[];
  counts: { issuedBills: number; cancelledBills: number; afterDiscountBills: number; beforeDiscountBills: number };
  /** ISO timestamp the working was built. */
  generatedAt: string;
}
