// A realistic hand-built GstComputation for the workbook tests: October 2026,
// the month GST moves from "on the price before discount" to "on the price after
// discount" (19 October), with roasted beans and restaurant service, an exempt
// item, a packaging charge, cancelled and rejected bills, a pass-covered cup and
// a warning check. Built from a list of bills, so every total ties exactly.
// Reconciliation amounts are signed, as lib/reports/exports/gstComputation.ts makes them:
// a 'less' step is negative, so the steps add up to the 'total' line.

import { round2 } from '@/lib/reports/csv';
import type {
  GstComputation,
  GstDayRow,
  GstInvoiceRow,
  ReconLine,
} from '@/lib/reports/exports/gstTypes';

const SWITCH = '2026-10-19';
const RATE = 5;

interface Bill {
  no: number;
  date: string;
  time: string;
  status: 'Issued' | 'Cancelled' | 'Rejected';
  after: boolean;
  restaurant: number;
  beans: number;
  beansKg: number;
  exempt: number;
  exemptLitres: number;
  ritual: number;
  discount: number;
  packaging: number;
  paymentMode: string;
  // worked out below
  taxable: number;
  cgst: number;
  sgst: number;
  total: number;
  rounding: number;
}

const pad = (n: number) => String(n).padStart(2, '0');
const invoiceNo = (n: number) => `HIOC-${String(n).padStart(6, '0')}`;

function makeBills(): Bill[] {
  const bills: Bill[] = [];
  const modes = ['UPI', 'Cash', 'Card', 'UPI', 'Swiggy Dineout', 'Zomato District', 'Cash'];
  const prices = [180, 240, 320, 450, 610, 85.5, 520, 395];
  let n = 412;
  let k = 0;
  for (let day = 1; day <= 31; day++) {
    const perDay = 12 + (day % 7);
    for (let i = 0; i < perDay; i++, k++, n++) {
      const date = `2026-10-${pad(day)}`;
      const restaurant = prices[(k * 3 + day) % prices.length];
      const hasBeans = k % 7 === 3;
      const beansKg = hasBeans ? [0.25, 0.5, 1, 2][k % 4] : 0;
      const beans = round2(beansKg * 1800);
      const hasExempt = k % 17 === 5;
      const bill: Bill = {
        no: n,
        date,
        time: `${pad(10 + ((k * 5) % 13))}:${pad((k * 17) % 60)}`,
        status: 'Issued',
        after: date >= SWITCH,
        restaurant,
        beans,
        beansKg,
        exempt: hasExempt ? 60 : 0,
        exemptLitres: hasExempt ? 1 : 0,
        ritual: k % 9 === 4 ? 150 : 0,
        discount: k % 5 === 2 ? round2((restaurant + beans) * 0.1) : 0,
        packaging: k % 4 === 1 ? 10 : 0,
        paymentMode: modes[k % modes.length],
        taxable: 0,
        cgst: 0,
        sgst: 0,
        total: 0,
        rounding: 0,
      };
      bills.push(bill);
    }
  }
  // Three cancelled and one rejected bill, spread through the month.
  for (const idx of [9, 147, 288]) bills[idx].status = 'Cancelled';
  bills[160].status = 'Rejected';
  for (const b of bills) {
    const lines = b.restaurant + b.beans;
    b.taxable = b.after ? round2(lines - b.discount + b.packaging) : round2(lines);
    b.cgst = round2((b.taxable * RATE) / 200);
    b.sgst = b.cgst;
    const exact = b.after
      ? b.taxable + b.cgst + b.sgst + b.exempt
      : b.taxable + b.cgst + b.sgst + b.exempt + b.packaging - b.discount;
    b.total = Math.round(exact);
    b.rounding = round2(b.total - exact);
  }
  return bills;
}

const sum = (xs: number[]) => round2(xs.reduce((a, x) => a + x, 0));

export function gstComputationFixture(): GstComputation {
  const bills = makeBills();
  const issued = bills.filter((b) => b.status === 'Issued');
  const cancelled = bills.filter((b) => b.status !== 'Issued');
  const after = issued.filter((b) => b.after);
  const before = issued.filter((b) => !b.after);

  const taxable = sum(issued.map((b) => b.taxable));
  const cgst = sum(issued.map((b) => b.cgst));
  const sgst = sum(issued.map((b) => b.sgst));
  const exempt = sum(issued.map((b) => b.exempt));
  const invoiceTotal = sum(issued.map((b) => b.total));

  // Table 12 split: the beans' share of the discount and of the tax.
  let restaurantTaxable = 0;
  let beansTaxable = 0;
  let restaurantCgst = 0;
  let beansCgst = 0;
  for (const b of issued) {
    const lines = b.restaurant + b.beans;
    const beansDiscount = b.after && lines > 0 ? round2((b.discount * b.beans) / lines) : 0;
    const restaurantDiscount = b.after ? round2(b.discount - beansDiscount) : 0;
    const beansPart = round2(b.beans - beansDiscount);
    const restaurantPart = round2(b.restaurant - restaurantDiscount + (b.after ? b.packaging : 0));
    restaurantTaxable += restaurantPart;
    beansTaxable += beansPart;
    const bc = round2((beansPart * RATE) / 200);
    beansCgst += bc;
    restaurantCgst += round2(b.cgst - bc);
  }
  restaurantTaxable = round2(restaurantTaxable);
  beansTaxable = round2(beansTaxable);
  restaurantCgst = round2(restaurantCgst);
  beansCgst = round2(beansCgst);
  const beansKg = sum(issued.map((b) => b.beansKg));
  const litres = sum(issued.map((b) => b.exemptLitres));

  const recon1: ReconLine[] = [
    {
      label: 'Gross item sales',
      amountInr: sum(issued.map((b) => b.restaurant + b.beans + b.exempt + b.ritual)),
      kind: 'start',
      note: 'Total of the item prices on the bills issued, before any discount.',
    },
    {
      label: 'HIOC Ritual cups covered by a pass',
      amountInr: -sum(issued.map((b) => b.ritual)),
      kind: 'less',
      note: 'GST on these was charged when the pass was sold.',
    },
    { label: 'GST-exempt items', amountInr: -exempt, kind: 'less', note: 'Reported in Table 8, not Table 7.' },
    {
      label: 'Discounts deducted before GST',
      amountInr: -sum(after.map((b) => b.discount)),
      kind: 'less',
      note: 'Bills from 19 October 2026 charge GST on the price after discount.',
    },
    {
      label: 'Packaging charged with GST',
      amountInr: sum(after.map((b) => b.packaging)),
      kind: 'add',
      note: 'From 19 October 2026 packaging is taxed under SAC 996331.',
    },
    { label: 'Taxable value', amountInr: taxable, kind: 'total', note: 'Table 7 and GSTR-3B 3.1(a).' },
  ];
  const rounding = sum(issued.map((b) => b.rounding));
  const recon2: ReconLine[] = [
    { label: 'Taxable value', amountInr: taxable, kind: 'start' },
    { label: 'Central tax (CGST)', amountInr: cgst, kind: 'add' },
    { label: 'State/UT tax (SGST)', amountInr: sgst, kind: 'add' },
    { label: 'GST-exempt sales', amountInr: exempt, kind: 'add' },
    {
      label: 'Packaging billed without GST',
      amountInr: sum(before.map((b) => b.packaging)),
      kind: 'add',
      note: 'Before 19 October 2026 packaging was not taxed.',
    },
    {
      label: 'Coupon and Beanies discounts given after GST',
      amountInr: -sum(before.map((b) => b.discount)),
      kind: 'less',
      note: 'Before 19 October 2026 discounts came off after GST was worked out.',
    },
    {
      label: 'Rounding difference',
      amountInr: rounding,
      kind: rounding < 0 ? 'less' : 'add',
      note: 'Bills are rounded to the nearest rupee.',
    },
    { label: 'Total invoice value of bills issued', amountInr: invoiceTotal, kind: 'total' },
  ];

  const dayRegister: GstDayRow[] = [];
  for (let day = 1; day <= 31; day++) {
    const date = `2026-10-${pad(day)}`;
    const all = bills.filter((b) => b.date === date);
    const iss = issued.filter((b) => b.date === date);
    dayRegister.push({
      date,
      firstInvoice: all.length ? invoiceNo(all[0].no) : '',
      lastInvoice: all.length ? invoiceNo(all[all.length - 1].no) : '',
      bills: iss.length,
      cancelled: all.length - iss.length,
      taxableValueInr: sum(iss.map((b) => b.taxable)),
      cgstInr: sum(iss.map((b) => b.cgst)),
      sgstInr: sum(iss.map((b) => b.sgst)),
      exemptValueInr: sum(iss.map((b) => b.exempt)),
      invoiceValueInr: sum(iss.map((b) => b.total)),
    });
  }

  const invoiceRegister: GstInvoiceRow[] = bills.map((b) => ({
    invoiceNo: invoiceNo(b.no),
    date: b.date,
    time: b.time,
    status: b.status,
    gstBasis: b.after ? 'After discount' : 'Before discount',
    taxableValueInr: b.taxable,
    cgstInr: b.cgst,
    sgstInr: b.sgst,
    exemptValueInr: b.exempt,
    packagingInr: b.packaging,
    discountInr: b.discount,
    invoiceValueInr: b.total,
    paymentMode: b.paymentMode,
  }));

  const nil = { igstInr: 0, cgstInr: 0, sgstInr: 0, cessInr: 0, taxableValueInr: 0 };
  const first = invoiceNo(bills[0].no);
  const last = invoiceNo(bills[bills.length - 1].no);

  return {
    business: {
      legalName: 'Arry Foods',
      tradeName: 'HIOC',
      gstin: '09AGJPA9390E1Z9',
      stateCode: '09',
      stateName: 'Uttar Pradesh',
      address: 'Shop No. 1-2, E-773, E Block, Ghatwasan, Kamla Nagar, Agra, Uttar Pradesh 282005',
    },
    period: {
      from: '2026-10-01',
      to: '2026-10-31',
      label: 'October 2026',
      isWholeMonth: true,
      returnPeriod: '102026',
      financialYear: '2026-27',
      gstr1DueDate: '2026-11-11',
      gstr3bDueDate: '2026-11-20',
    },
    ratePercent: RATE,
    pricesIncludeGst: false,
    taxPayable: { igstInr: 0, cgstInr: cgst, sgstInr: sgst, cessInr: 0, totalInr: round2(cgst + sgst) },
    gstr3b: [
      {
        code: '3.1(a)',
        label: 'Outward taxable supplies (other than zero rated, nil rated and exempted)',
        amounts: { taxableValueInr: taxable, igstInr: 0, cgstInr: cgst, sgstInr: sgst, cessInr: 0 },
        applies: true,
        note: 'Café sales at 5% GST: taxable value, CGST and SGST of the bills issued.',
      },
      {
        code: '3.1(b)',
        label: 'Outward taxable supplies (zero rated)',
        amounts: nil,
        applies: false,
        note: 'Nil: the café makes no exports or supplies to an SEZ.',
      },
      {
        code: '3.1(c)',
        label: 'Other outward supplies (nil rated, exempted)',
        amounts: { ...nil, taxableValueInr: exempt },
        applies: true,
        note: 'Value of GST-exempt items sold.',
      },
      {
        code: '3.1(d)',
        label: 'Inward supplies (liable to reverse charge)',
        amounts: nil,
        applies: false,
        note: 'Nil: no purchases on which the café pays tax under reverse charge.',
      },
      {
        code: '3.1(e)',
        label: 'Non-GST outward supplies',
        amounts: nil,
        applies: false,
        note: 'Nil: every sale is a GST supply or an exempt one.',
      },
      {
        code: '3.1.1(i)',
        label: 'Taxable supplies on which electronic commerce operator pays tax u/s 9(5) [to be furnished by the ECO]',
        amounts: nil,
        applies: false,
        note: 'Nil: Swiggy Dineout and Zomato District bills are the café’s own dine-in bills paid through an app.',
      },
      {
        code: '3.1.1(ii)',
        label:
          'Taxable supplies made by the registered person through electronic commerce operator, on which ECO is liable to pay tax u/s 9(5)',
        amounts: nil,
        applies: false,
        note: 'Nil: the café does not supply through an e-commerce operator under section 9(5).',
      },
    ],
    gstr1: {
      b2cs: [
        {
          type: 'OE',
          placeOfSupply: '09-Uttar Pradesh',
          applicablePercent: '',
          rate: RATE,
          taxableValueInr: taxable,
          cessInr: 0,
          ecommerceGstin: '',
          cgstInr: cgst,
          sgstInr: sgst,
        },
      ],
      nilExempt: [
        { description: 'Inter-State supplies to registered persons', nilRatedInr: 0, exemptedInr: 0, nonGstInr: 0 },
        { description: 'Intra-State supplies to registered persons', nilRatedInr: 0, exemptedInr: 0, nonGstInr: 0 },
        { description: 'Inter-State supplies to unregistered persons', nilRatedInr: 0, exemptedInr: 0, nonGstInr: 0 },
        { description: 'Intra-State supplies to unregistered persons', nilRatedInr: 0, exemptedInr: exempt, nonGstInr: 0 },
      ],
      hsn: [
        {
          hsn: '996331',
          description: 'Restaurant service',
          uqc: 'NA',
          quantity: 0,
          totalValueInr: round2(restaurantTaxable + restaurantCgst * 2),
          rate: RATE,
          taxableValueInr: restaurantTaxable,
          igstInr: 0,
          cgstInr: restaurantCgst,
          sgstInr: restaurantCgst,
          cessInr: 0,
          kind: 'service',
        },
        {
          hsn: '0901',
          description: 'Coffee, roasted',
          uqc: 'KGS-KILOGRAMS',
          quantity: beansKg,
          totalValueInr: round2(beansTaxable + beansCgst * 2),
          rate: RATE,
          taxableValueInr: beansTaxable,
          igstInr: 0,
          cgstInr: beansCgst,
          sgstInr: beansCgst,
          cessInr: 0,
          kind: 'goods',
        },
        {
          hsn: '0401',
          description: 'Milk and cream, not concentrated',
          uqc: 'LTR-LITRES',
          quantity: litres,
          totalValueInr: exempt,
          rate: 0,
          taxableValueInr: exempt,
          igstInr: 0,
          cgstInr: 0,
          sgstInr: 0,
          cessInr: 0,
          kind: 'goods',
        },
      ],
      docs: [
        {
          nature: 'Invoices for outward supply',
          fromNo: first,
          toNo: last,
          totalNumber: bills.length,
          cancelled: cancelled.length,
          netIssued: issued.length,
        },
      ],
    },
    toTaxableValue: recon1,
    toInvoiceValue: recon2,
    dayRegister,
    invoiceRegister,
    checks: [
      { status: 'ok', title: 'GST is 5% of taxable value', detail: 'Every bill is within ₹0.50 of 5% of its taxable value.' },
      {
        status: 'ok',
        title: 'Table 12 agrees with Tables 7 and 8',
        detail: 'The HSN taxable values add up to the taxable sales plus the exempt sales.',
      },
      {
        status: 'ok',
        title: 'Invoice numbers have no gaps',
        detail: `${first} to ${last}: every number is accounted for.`,
      },
      {
        status: 'warn',
        title: 'Bills still unpaid at the end of the period',
        detail:
          '2 bills (₹1,284.00) were still unpaid on 31 October 2026. They are counted as sales; confirm they were collected.',
      },
      {
        status: 'info',
        title: 'Cancelled and rejected bills',
        detail: `${cancelled.length} bills (3 cancelled, 1 rejected) are in the register but in no total.`,
      },
      {
        status: 'info',
        title: 'Two ways of working out GST in this month',
        detail: `${before.length} bills before 19 October 2026 charge GST on the price before discount; ${after.length} bills from 19 October charge it after the discount.`,
      },
    ],
    notes: [
      'No sale is to a registered business (no customer GSTINs are captured), so GSTR-1 has no B2B table.',
      'Every sale is inside Uttar Pradesh, so GST is CGST plus SGST; there is no IGST.',
      'Swiggy Dineout and Zomato District bills are the café’s own dine-in bills paid through an app, not supplies under section 9(5).',
      'HIOC Ritual pass: GST is charged when the pass is sold; cups drunk against a pass carry no GST again.',
      'Refunds do not issue credit notes, so none appear in GSTR-1.',
      'From 19 October 2026 GST is charged on the price after discount; earlier bills charge it on the price before discount.',
      'Figures are as charged on the bills.',
    ],
    glossary: [
      { term: 'Taxable value', meaning: 'The amount GST is worked out on: the price of what was sold, after any discount given before GST.' },
      { term: 'CGST', meaning: 'Central GST: half of the 5% GST on a sale made inside the state. It goes to the Centre.' },
      { term: 'SGST', meaning: 'State GST: the other half of the 5% GST on a sale made inside the state. It goes to Uttar Pradesh.' },
      { term: 'IGST', meaning: 'Integrated GST: charged on a sale to another state. The café has none.' },
      { term: 'GSTR-1', meaning: 'The monthly statement of sales: every sale grouped the way the portal asks. Filed by the 11th of the next month.' },
      { term: 'GSTR-3B', meaning: 'The monthly summary return in which the GST is paid. Filed by the 20th of the next month.' },
      { term: 'B2CS', meaning: 'Business to consumer (small): sales to people with no GSTIN, listed once per tax rate in GSTR-1 Table 7.' },
      { term: 'HSN / SAC', meaning: 'The code for what is sold: HSN for goods (0901 is roasted coffee), SAC for services (996331 is restaurant service).' },
      { term: 'Nil rated / exempt', meaning: 'Sales that carry no GST. They are reported, but no tax is paid on them.' },
      { term: 'Documents issued', meaning: 'The range of invoice numbers used in the period, with how many were cancelled (GSTR-1 Table 13).' },
      { term: 'Input tax credit', meaning: 'GST paid on purchases that can be set against GST collected. A restaurant charging 5% cannot take it.' },
    ],
    counts: {
      issuedBills: issued.length,
      cancelledBills: cancelled.length,
      afterDiscountBills: after.length,
      beforeDiscountBills: before.length,
    },
    generatedAt: '2026-11-02T04:41:00.000Z',
  };
}
