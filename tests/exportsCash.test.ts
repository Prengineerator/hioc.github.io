import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { CsvTable, CsvValue } from '@/lib/reports/csv';
import { buildReport } from '@/lib/reports/reconcile';
import {
  appPayments,
  cashRegister,
  expenseByCategory,
  expenseRegister,
  paymentModes,
  type AppPaymentRecord,
  type CashDayRecord,
  type ExpenseRecord,
} from '@/lib/reports/exports/cashReports';
import { CASH_REPORTS } from '@/lib/reports/exports/cashReportsServer';

// The pure builders of the cash & expense downloads (lib/reports/exports/cashReports.ts)
// on hand-built rows, the shape the server loaders return with staff names
// already resolved. Then the registry's loaders run against a small in-memory
// fake database (at the end of this file). Times are IST; 2026-10-18 09:00 IST
// is 03:30Z.

/** The cell in `row` under the column whose header is `header`. */
function cell(t: CsvTable, row: number, header: string): CsvValue {
  const i = t.columns.indexOf(header);
  if (i < 0) throw new Error(`no column ${header}`);
  return t.rows[row][i];
}

/** The index of the row whose first cell is `first` (e.g. 'TOTAL'). */
function rowNamed(t: CsvTable, first: string): number {
  return t.rows.findIndex((r) => r[0] === first);
}

const CLOSED_DAY: CashDayRecord = {
  business_date: '2026-10-18',
  status: 'closed',
  opened_at: '2026-10-18T03:30:00Z', // 09:00 IST
  closed_at: '2026-10-18T14:30:00Z', // 20:00 IST
  opened_by_name: 'Ravi Kumar',
  closed_by_name: 'Asha Verma',
  opening_total_inr: 2000,
  cash_sales_inr: 5000,
  cash_sales_count: 20,
  cash_refunds_inr: 200,
  cash_in_inr: 500,
  cash_out_inr: 1300,
  expenses_inr: 300,
  expected_cash_inr: 6000,
  counted_total_inr: 5900,
  over_short_inr: -100,
  handover_inr: 3900,
  float_left_total_inr: 2000,
  upi_inr: 900,
  card_inr: 700,
  swiggy_dineout_inr: 0,
  zomato_district_inr: 150,
  auto_ended_at: null,
  close_reason: 'Short by a note',
  notes: 'Ice bought from the drawer',
};

const OPEN_DAY: CashDayRecord = {
  business_date: '2026-10-19',
  status: 'open',
  opened_at: '2026-10-19T03:30:00Z', // 09:00 IST
  closed_at: null,
  opened_by_name: 'Meera Joshi',
  closed_by_name: '',
  opening_total_inr: 2000,
  cash_sales_inr: null,
  cash_sales_count: null,
  cash_refunds_inr: null,
  cash_in_inr: null,
  cash_out_inr: null,
  expenses_inr: null,
  expected_cash_inr: 0,
  counted_total_inr: 0,
  over_short_inr: 0,
  handover_inr: null,
  float_left_total_inr: null,
  upi_inr: null,
  card_inr: null,
  auto_ended_at: null,
  close_reason: null,
  notes: null,
};

describe('cashRegister', () => {
  it('has one row per cash day plus a TOTAL row, with money headers ending in (INR)', () => {
    const t = cashRegister([CLOSED_DAY, OPEN_DAY]);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[2][0]).toBe('TOTAL');
    for (const h of t.columns) {
      if (h.includes('(INR)')) expect(h.endsWith('(INR)')).toBe(true);
    }
    expect(t.columns).toContain('Cash out to owner (INR)');
    expect(t.columns).toContain('Auto-ended');
  });

  it('splits the cash out between expenses and the owner, and renders IST stamps', () => {
    const t = cashRegister([CLOSED_DAY]);
    expect(cell(t, 0, 'Status')).toBe('Closed');
    expect(cell(t, 0, 'Opened at (IST)')).toBe('2026-10-18 09:00');
    expect(cell(t, 0, 'Closed at (IST)')).toBe('2026-10-18 20:00');
    expect(cell(t, 0, 'Expenses (INR)')).toBe(300);
    expect(cell(t, 0, 'Cash out to owner (INR)')).toBe(1000);
    expect(cell(t, 0, 'Handover (INR)')).toBe(3900);
    expect(cell(t, 0, 'Opened by')).toBe('Ravi Kumar');
    expect(cell(t, 0, 'Closed by')).toBe('Asha Verma');
  });

  it('shows the close time in IST even when it falls on the next date, keeping the business date', () => {
    const late: CashDayRecord = { ...CLOSED_DAY, closed_at: '2026-10-18T20:00:00Z' }; // 01:30 IST on the 19th
    const t = cashRegister([late]);
    expect(cell(t, 0, 'Business date')).toBe('2026-10-18');
    expect(cell(t, 0, 'Closed at (IST)')).toBe('2026-10-19 01:30');
  });

  it('leaves an open day blank for everything frozen at the close', () => {
    const t = cashRegister([OPEN_DAY]);
    expect(cell(t, 0, 'Status')).toBe('Open');
    expect(cell(t, 0, 'Opening float (INR)')).toBe(2000);
    for (const h of [
      'Cash sales (INR)',
      'Expenses (INR)',
      'Cash out to owner (INR)',
      'Handover (INR)',
      'Expected cash (INR)',
      'Counted (INR)',
      'Over/short (INR)',
      'Float left (INR)',
      'UPI (INR)',
    ]) {
      expect(cell(t, 0, h)).toBe('');
    }
    expect(cell(t, 0, 'Closed at (IST)')).toBe('');
  });

  it('treats a legacy closed day without an expense figure as all owner cash out', () => {
    const legacy: CashDayRecord = { ...CLOSED_DAY, expenses_inr: undefined };
    const t = cashRegister([legacy]);
    expect(cell(t, 0, 'Expenses (INR)')).toBe(0);
    expect(cell(t, 0, 'Cash out to owner (INR)')).toBe(1300);
  });

  it('marks a day the 3 am job ended, and leaves the flag blank when the column is missing', () => {
    const ended: CashDayRecord = { ...CLOSED_DAY, auto_ended_at: '2026-10-19T21:30:00Z' };
    expect(cell(cashRegister([ended]), 0, 'Auto-ended')).toBe('Yes');
    expect(cell(cashRegister([CLOSED_DAY]), 0, 'Auto-ended')).toBe('No');
    const noColumn: CashDayRecord = { ...CLOSED_DAY, auto_ended_at: undefined };
    expect(cell(cashRegister([noColumn]), 0, 'Auto-ended')).toBe('');
  });

  it('sums the additive columns on the TOTAL row and leaves the balances blank', () => {
    const t = cashRegister([OPEN_DAY, CLOSED_DAY, { ...CLOSED_DAY, business_date: '2026-10-17', over_short_inr: 50, cash_sales_inr: 1000 }]);
    const total = rowNamed(t, 'TOTAL');
    expect(cell(t, total, 'Cash sales (INR)')).toBe(6000);
    expect(cell(t, total, 'Cash bills')).toBe(40);
    expect(cell(t, total, 'Expenses (INR)')).toBe(600);
    expect(cell(t, total, 'Cash out to owner (INR)')).toBe(2000);
    expect(cell(t, total, 'Over/short (INR)')).toBe(-50);
    expect(cell(t, total, 'Zomato District (INR)')).toBe(300);
    expect(cell(t, total, 'Expected cash (INR)')).toBe('');
    expect(cell(t, total, 'Counted (INR)')).toBe('');
    expect(cell(t, total, 'Opening float (INR)')).toBe('');
  });

  it('orders days by business date, then by when they were opened', () => {
    const earlier: CashDayRecord = { ...CLOSED_DAY, business_date: '2026-10-17', opened_at: '2026-10-17T04:00:00Z' };
    const t = cashRegister([CLOSED_DAY, earlier]);
    expect(t.rows[0][0]).toBe('2026-10-17');
    expect(t.rows[1][0]).toBe('2026-10-18');
  });

  it('returns the headers and a zero TOTAL for empty input', () => {
    const t = cashRegister([]);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0][0]).toBe('TOTAL');
    expect(cell(t, 0, 'Cash sales (INR)')).toBe(0);
  });
});

describe('expenseRegister', () => {
  const approved: ExpenseRecord = {
    id: 'e1',
    created_at: '2026-10-18T04:00:00Z', // 09:30 IST
    category: 'ice',
    amount_inr: 200,
    reason: 'Ice bag',
    recorded_by_name: 'Ravi Kumar',
    approved_by_name: 'Owner',
    approved_at: '2026-10-18T05:00:00Z', // 10:30 IST
    voided_at: null,
  };
  const pending: ExpenseRecord = {
    id: 'e2',
    created_at: '2026-10-18T06:00:00Z', // 11:30 IST
    category: 'water',
    amount_inr: 120,
    reason: 'Water cans',
    recorded_by_name: 'Asha Verma',
    approved_by_name: '',
    approved_at: null,
    voided_at: null,
  };
  const voided: ExpenseRecord = {
    id: 'e3',
    created_at: '2026-10-18T07:00:00Z', // 12:30 IST
    category: 'ice',
    amount_inr: 999,
    reason: 'Typed twice',
    recorded_by_name: 'Ravi Kumar',
    approved_by_name: '',
    approved_at: null,
    voided_at: '2026-10-18T07:05:00Z',
  };

  it('labels each status and blanks the approval columns when not approved', () => {
    const t = expenseRegister([approved, pending, voided]);
    expect(cell(t, 0, 'Status')).toBe('Approved');
    expect(cell(t, 0, 'Approved by')).toBe('Owner');
    expect(cell(t, 0, 'Approved at (IST)')).toBe('2026-10-18 10:30');
    expect(cell(t, 1, 'Status')).toBe('Pending approval');
    expect(cell(t, 1, 'Approved by')).toBe('');
    expect(cell(t, 1, 'Approved at (IST)')).toBe('');
    expect(cell(t, 2, 'Status')).toBe('Voided');
  });

  it('renders IST date and time and the category label', () => {
    const t = expenseRegister([approved]);
    expect(cell(t, 0, 'Date')).toBe('2026-10-18');
    expect(cell(t, 0, 'Time')).toBe('09:30');
    expect(cell(t, 0, 'Category')).toBe('Ice cubes');
    expect(cell(t, 0, 'Reason / note')).toBe('Ice bag');
  });

  it('leaves voided expenses out of the TOTAL and says so', () => {
    const t = expenseRegister([approved, pending, voided]);
    const total = rowNamed(t, 'TOTAL');
    expect(cell(t, total, 'Amount (INR)')).toBe(320);
    expect(cell(t, total, 'Status')).toBe('Non-voided only');
  });

  it('orders rows oldest first', () => {
    const t = expenseRegister([pending, approved]);
    expect(t.rows[0][1]).toBe('09:30');
    expect(t.rows[1][1]).toBe('11:30');
  });

  it('returns a zero TOTAL for empty input', () => {
    const t = expenseRegister([]);
    expect(t.rows).toHaveLength(1);
    expect(cell(t, 0, 'Amount (INR)')).toBe(0);
  });
});

describe('expenseByCategory', () => {
  const ice: ExpenseRecord = {
    id: 'e1',
    created_at: '2026-10-18T04:00:00Z',
    category: 'ice',
    amount_inr: 200,
    reason: null,
    recorded_by_name: 'Ravi Kumar',
    approved_by_name: '',
    approved_at: '2026-10-18T05:00:00Z',
    voided_at: null,
  };
  const water: ExpenseRecord = { ...ice, id: 'e2', category: 'water', amount_inr: 120, approved_at: null };
  const voidedIce: ExpenseRecord = { ...ice, id: 'e3', amount_inr: 999, approved_at: null, voided_at: '2026-10-18T07:05:00Z' };
  const voidedPacking: ExpenseRecord = { ...ice, id: 'e4', category: 'packaging', amount_inr: 80, approved_at: null, voided_at: '2026-10-18T08:00:00Z' };

  it('sums non-voided expenses by category, biggest first, with entry counts and shares', () => {
    const t = expenseByCategory([ice, water, voidedIce]);
    expect(t.columns).toEqual(['Category', 'Entries', 'Amount (INR)', 'Share %']);
    expect(t.rows[0]).toEqual(['Ice cubes', 1, 200, 62.5]);
    expect(t.rows[1]).toEqual(['Water', 1, 120, 37.5]);
  });

  it('drops a category that only has voided entries', () => {
    const t = expenseByCategory([ice, water, voidedPacking]);
    expect(t.rows.map((r) => r[0])).not.toContain('Packaging');
  });

  it('puts the non-voided count and amount on the TOTAL row', () => {
    const t = expenseByCategory([ice, water, voidedIce]);
    const total = rowNamed(t, 'TOTAL');
    expect(t.rows[total]).toEqual(['TOTAL', 2, 320, 100]);
  });

  it('returns only a zero TOTAL for empty input', () => {
    const t = expenseByCategory([]);
    expect(t.rows).toEqual([['TOTAL', 0, 0, 0]]);
  });
});

describe('appPayments', () => {
  const base = { reference: null, invoice_no: 'HIOC-001010', recorded_by_name: 'Ravi Kumar' };
  const cancelled: AppPaymentRecord = {
    ...base,
    method: 'zomato_district',
    amount_inr: 400,
    created_at: '2026-10-18T06:30:00Z', // 12:00 IST
    invoice_no: 'HIOC-001008',
    order_status: 'cancelled',
    payment_status: 'unpaid',
  };
  const swiggy: AppPaymentRecord = {
    ...base,
    method: 'swiggy_dineout',
    amount_inr: 850,
    reference: 'SWG123',
    created_at: '2026-10-18T08:00:00Z', // 13:30 IST
    order_status: 'completed',
    payment_status: 'paid',
  };
  const billWithoutTender: AppPaymentRecord = {
    ...base,
    method: 'swiggy_dineout',
    amount_inr: 300,
    invoice_no: 'HIOC-001011',
    recorded_by_name: '',
    created_at: '2026-10-18T09:00:00Z', // 14:30 IST
    order_status: 'completed',
    payment_status: 'paid',
  };
  const refunded: AppPaymentRecord = {
    ...base,
    method: 'zomato_district',
    amount_inr: 600,
    reference: 'ZD9',
    invoice_no: 'HIOC-001012',
    created_at: '2026-10-19T03:00:00Z', // 08:30 IST on the 19th
    order_status: 'completed',
    payment_status: 'refunded',
  };

  it('lists payments oldest first with IST date, time and the booking reference', () => {
    const t = appPayments([refunded, swiggy, cancelled, billWithoutTender]);
    expect(t.columns).toEqual(['Date', 'Time', 'Invoice no', 'App', 'Amount (INR)', 'Booking reference', 'Recorded by', 'Status']);
    expect(t.rows[0]).toEqual(['2026-10-18', '12:00', 'HIOC-001008', 'Zomato District', 400, '', 'Ravi Kumar', 'Order cancelled']);
    expect(t.rows[1]).toEqual(['2026-10-18', '13:30', 'HIOC-001010', 'Swiggy Dineout', 850, 'SWG123', 'Ravi Kumar', 'Counted']);
    expect(t.rows[2][1]).toBe('14:30');
    expect(t.rows[2][5]).toBe('');
  });

  it('marks cancelled, rejected and refunded payments and keeps them out of the subtotals and TOTAL', () => {
    const t = appPayments([cancelled, swiggy, billWithoutTender, refunded]);
    expect(t.rows[3]).toEqual(['2026-10-19', '08:30', 'HIOC-001012', 'Zomato District', 600, 'ZD9', 'Ravi Kumar', 'Fully refunded']);
    const swiggyRow = t.rows.findIndex((r) => r[0] === 'Subtotal' && r[3] === 'Swiggy Dineout');
    const zomatoRow = t.rows.findIndex((r) => r[0] === 'Subtotal' && r[3] === 'Zomato District');
    expect(t.rows[swiggyRow]).toEqual(['Subtotal', '', '', 'Swiggy Dineout', 1150, '', '', '2 counted']);
    expect(t.rows[zomatoRow]).toEqual(['Subtotal', '', '', 'Zomato District', 0, '', '', '0 counted']);
    expect(t.rows[rowNamed(t, 'TOTAL')][4]).toBe(1150);
  });

  it('lists a bill paid through an app with no tender row, with no booking ID', () => {
    const t = appPayments([billWithoutTender]);
    expect(t.rows[0][2]).toBe('HIOC-001011');
    expect(t.rows[0][5]).toBe('');
    expect(t.rows[0][6]).toBe('');
  });

  it('gives one subtotal per app even when there are none, then a TOTAL', () => {
    const t = appPayments([]);
    expect(t.rows).toHaveLength(3);
    expect(t.rows[0]).toEqual(['Subtotal', '', '', 'Swiggy Dineout', 0, '', '', '0 counted']);
    expect(t.rows[1]).toEqual(['Subtotal', '', '', 'Zomato District', 0, '', '', '0 counted']);
    expect(t.rows[2][0]).toBe('TOTAL');
    expect(t.rows[2][4]).toBe(0);
  });
});

describe('paymentModes', () => {
  // 18 Oct: a UPI part at 10:30 IST and a cash bill with a tip at 11:30 IST.
  // 19 Oct: a cash refund at 09:30 IST. 17 Oct has no money at all.
  const report = buildReport({
    from: '2026-10-17',
    to: '2026-10-19',
    orders: [],
    parts: [{ order_id: 'o1', method: 'upi', amount_inr: 300, created_at: '2026-10-18T05:00:00Z' }],
    paidOrders: [
      {
        id: 'o2',
        payment_method: 'cash',
        total_inr: 500,
        subtotal_inr: 500,
        paid_at: '2026-10-18T06:00:00Z',
        tip_inr: 50,
      },
    ],
    ordersWithParts: new Set(),
    refunds: [{ amount_inr: 100, method: 'cash', processed_at: '2026-10-19T04:00:00Z' }],
    movements: [],
    cashDays: [],
  });

  it('has the date, one column per payment method, then the totals, all money ending in (INR)', () => {
    const t = paymentModes(report);
    expect(t.columns).toEqual([
      'Date',
      'Cash (INR)',
      'UPI (INR)',
      'Card (INR)',
      'Online (website) (INR)',
      'Swiggy Dineout (INR)',
      'Zomato District (INR)',
      'Total received (INR)',
      'Refunds (INR)',
      'Net received (INR)',
      'Tips (INR)',
    ]);
    for (const h of t.columns.slice(1)) expect(h.endsWith('(INR)')).toBe(true);
  });

  it('has one row per date in the range, with zeros where nothing happened', () => {
    const t = paymentModes(report);
    expect(t.rows.map((r) => r[0])).toEqual(['2026-10-17', '2026-10-18', '2026-10-19', 'TOTAL']);
    expect(cell(t, 0, 'Total received (INR)')).toBe(0);
    expect(cell(t, 1, 'Cash (INR)')).toBe(500);
    expect(cell(t, 1, 'UPI (INR)')).toBe(300);
    expect(cell(t, 1, 'Net received (INR)')).toBe(800);
    expect(cell(t, 1, 'Tips (INR)')).toBe(50);
    expect(cell(t, 2, 'Refunds (INR)')).toBe(100);
    expect(cell(t, 2, 'Net received (INR)')).toBe(-100);
  });

  it('sums every money column on the TOTAL row', () => {
    const t = paymentModes(report);
    const total = rowNamed(t, 'TOTAL');
    expect(cell(t, total, 'Cash (INR)')).toBe(500);
    expect(cell(t, total, 'UPI (INR)')).toBe(300);
    expect(cell(t, total, 'Total received (INR)')).toBe(800);
    expect(cell(t, total, 'Refunds (INR)')).toBe(100);
    expect(cell(t, total, 'Net received (INR)')).toBe(700);
    expect(cell(t, total, 'Tips (INR)')).toBe(50);
  });
});

// ── The registry's loaders, over an in-memory fake database ──────────────────

type Row = Record<string, unknown>;
type QueryError = { code: string; message: string };

/** Columns each table has in the fake. A select naming one that is not here fails the way PostgREST does (42703). */
const SCHEMA: Record<string, string[]> = {
  cash_days: [
    'id', 'business_date', 'status', 'opened_by', 'opened_at', 'closed_by', 'closed_at', 'opening_total_inr',
    'cash_sales_inr', 'cash_sales_count', 'cash_refunds_inr', 'cash_in_inr', 'cash_out_inr', 'expected_cash_inr',
    'counted_total_inr', 'over_short_inr', 'handover_inr', 'float_left_total_inr', 'close_reason', 'notes',
    'upi_inr', 'card_inr', 'expenses_inr', 'auto_ended_at', 'closing_denoms', 'float_left_denoms',
  ],
  cash_movements: [
    'id', 'direction', 'amount_inr', 'reason', 'recorded_by', 'created_at', 'category', 'approved_by', 'approved_at',
    'voided_by', 'voided_at',
  ],
  order_payments: ['id', 'order_id', 'method', 'amount_inr', 'created_at', 'created_by', 'reference'],
  orders: [
    'id', 'order_number', 'created_at', 'status', 'payment_status', 'payment_method', 'paid_at', 'total_inr',
    'subtotal_inr', 'tax_inr', 'discount_inr', 'settle_discount_inr',
  ],
  refunds: ['id', 'amount_inr', 'method', 'status', 'processed_at'],
  profiles: ['id', 'name'],
};

class FakeQuery implements PromiseLike<{ data: Row[] | null; error: QueryError | null }> {
  private preds: ((r: Row) => boolean)[] = [];
  private cols: string[] = [];
  private error: QueryError | null = null;
  private orderCol: string | null = null;
  private span: [number, number] | null = null;

  constructor(
    private readonly rows: Row[],
    private readonly schema: string[],
  ) {}

  select(list: string) {
    this.cols = list.split(',').map((c) => c.trim());
    const bad = this.cols.find((c) => !this.schema.includes(c));
    if (bad) this.error = { code: '42703', message: `column "${bad}" does not exist` };
    return this;
  }
  eq(c: string, v: unknown) {
    this.preds.push((r) => r[c] === v);
    return this;
  }
  in(c: string, vals: unknown[]) {
    this.preds.push((r) => vals.includes(r[c]));
    return this;
  }
  gte(c: string, v: string) {
    this.preds.push((r) => typeof r[c] === 'string' && (r[c] as string) >= v);
    return this;
  }
  lte(c: string, v: string) {
    this.preds.push((r) => typeof r[c] === 'string' && (r[c] as string) <= v);
    return this;
  }
  lt(c: string, v: string) {
    this.preds.push((r) => typeof r[c] === 'string' && (r[c] as string) < v);
    return this;
  }
  not(c: string) {
    this.preds.push((r) => r[c] !== null && r[c] !== undefined);
    return this;
  }
  order(c: string) {
    this.orderCol = c;
    return this;
  }
  range(from: number, to: number) {
    this.span = [from, to];
    return this;
  }

  private run(): { data: Row[] | null; error: QueryError | null } {
    if (this.error) return { data: null, error: this.error };
    let rows = this.rows.filter((r) => this.preds.every((p) => p(r)));
    const col = this.orderCol;
    if (col) rows = [...rows].sort((a, b) => String(a[col] ?? '').localeCompare(String(b[col] ?? '')));
    if (this.span) rows = rows.slice(this.span[0], this.span[1] + 1);
    return { data: rows.map((r) => Object.fromEntries(this.cols.map((c) => [c, r[c] ?? null]))), error: null };
  }

  then<T1 = { data: Row[] | null; error: QueryError | null }, T2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; error: QueryError | null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }
}

function fakeDb(tables: Record<string, Row[]>): SupabaseClient {
  const db = {
    from: (table: string) => new FakeQuery(tables[table] ?? [], SCHEMA[table] ?? []),
    auth: { admin: { listUsers: async () => ({ data: { users: [] }, error: null }) } },
  };
  return db as unknown as SupabaseClient;
}

const TABLES: Record<string, Row[]> = {
  cash_days: [
    {
      id: 'd1',
      business_date: '2026-10-18',
      status: 'closed',
      opened_by: 'u-ravi',
      opened_at: '2026-10-18T03:30:00Z',
      closed_by: 'u-asha',
      closed_at: '2026-10-18T14:30:00Z',
      opening_total_inr: 2000,
      cash_sales_inr: 5000,
      cash_sales_count: 20,
      cash_refunds_inr: 200,
      cash_in_inr: 500,
      cash_out_inr: 1300,
      expenses_inr: 300,
      auto_ended_at: null,
      expected_cash_inr: 6000,
      counted_total_inr: 5900,
      over_short_inr: -100,
      handover_inr: 3900,
      float_left_total_inr: 2000,
      upi_inr: 900,
      card_inr: 700,
      close_reason: '',
      notes: '',
    },
  ],
  cash_movements: [
    // An approved expense, a pending one, a voided one, a plain cash out to the owner (no category),
    // a cash in, and an expense outside the range.
    { id: 'm1', direction: 'out', amount_inr: 200, reason: 'Ice bag', recorded_by: 'u-ravi', created_at: '2026-10-18T04:00:00Z', category: 'ice', approved_by: 'u-asha', approved_at: '2026-10-18T05:00:00Z', voided_at: null },
    { id: 'm2', direction: 'out', amount_inr: 120, reason: 'Water cans', recorded_by: 'u-asha', created_at: '2026-10-18T06:00:00Z', category: 'water', approved_by: null, approved_at: null, voided_at: null },
    { id: 'm3', direction: 'out', amount_inr: 999, reason: 'Typed twice', recorded_by: 'u-ravi', created_at: '2026-10-18T07:00:00Z', category: 'ice', approved_by: null, approved_at: null, voided_at: '2026-10-18T07:05:00Z' },
    { id: 'm4', direction: 'out', amount_inr: 1000, reason: 'Owner', recorded_by: 'u-asha', created_at: '2026-10-18T08:00:00Z', category: null, approved_by: null, approved_at: null, voided_at: null },
    { id: 'm5', direction: 'in', amount_inr: 50, reason: 'Change', recorded_by: 'u-ravi', created_at: '2026-10-18T08:30:00Z', category: null, approved_by: null, approved_at: null, voided_at: null },
    { id: 'm6', direction: 'out', amount_inr: 80, reason: 'Out of range', recorded_by: 'u-ravi', created_at: '2026-10-20T04:00:00Z', category: 'ice', approved_by: null, approved_at: null, voided_at: null },
  ],
  // A split bill (o1: 850 Swiggy + 150 cash), a Zomato booking on a cancelled bill (o4),
  // and a Swiggy bill whose tender row was never written (o3).
  order_payments: [
    { id: 'p1', order_id: 'o1', method: 'swiggy_dineout', amount_inr: 850, created_at: '2026-10-18T08:00:00Z', created_by: 'u-ravi', reference: 'SWG123' },
    { id: 'p2', order_id: 'o1', method: 'cash', amount_inr: 150, created_at: '2026-10-18T08:00:00Z', created_by: 'u-ravi', reference: null },
    { id: 'p3', order_id: 'o4', method: 'zomato_district', amount_inr: 400, created_at: '2026-10-18T09:00:00Z', created_by: 'u-asha', reference: 'ZD777' },
  ],
  orders: [
    { id: 'o1', order_number: 1010, created_at: '2026-10-18T07:50:00Z', status: 'completed', payment_status: 'paid', payment_method: 'swiggy_dineout', paid_at: '2026-10-18T08:00:00Z', total_inr: 1000, subtotal_inr: 1000, tax_inr: 0, discount_inr: 0, settle_discount_inr: 0 },
    { id: 'o3', order_number: 1011, created_at: '2026-10-18T09:55:00Z', status: 'completed', payment_status: 'paid', payment_method: 'swiggy_dineout', paid_at: '2026-10-18T10:00:00Z', total_inr: 300, subtotal_inr: 300, tax_inr: 0, discount_inr: 0, settle_discount_inr: 0 },
    { id: 'o4', order_number: 1012, created_at: '2026-10-18T09:00:00Z', status: 'cancelled', payment_status: 'unpaid', payment_method: 'zomato_district', paid_at: null, total_inr: 400, subtotal_inr: 400, tax_inr: 0, discount_inr: 0, settle_discount_inr: 0 },
  ],
  refunds: [],
  profiles: [
    { id: 'u-ravi', name: 'Ravi Kumar' },
    { id: 'u-asha', name: 'Asha Verma' },
  ],
};

function loader(key: string) {
  const def = CASH_REPORTS.find((r) => r.key === key);
  if (!def) throw new Error(`no report ${key}`);
  return (from: string, to: string) => def.load(fakeDb(TABLES), from, to);
}

describe('CASH_REPORTS loaders over the fake database', () => {
  it('registers exactly the five cash keys in the cash group', () => {
    expect(CASH_REPORTS.map((r) => r.key)).toEqual(['cash-days', 'expenses', 'expense-categories', 'app-payments', 'payment-modes']);
    expect(CASH_REPORTS.every((r) => r.group === 'cash')).toBe(true);
  });

  it('reads cash days past the columns the database lacks, with staff names and blanks for the missing ones', async () => {
    const t = await loader('cash-days')('2026-10-18', '2026-10-19');
    expect(cell(t, 0, 'Opened by')).toBe('Ravi Kumar');
    expect(cell(t, 0, 'Closed by')).toBe('Asha Verma');
    expect(cell(t, 0, 'Expenses (INR)')).toBe(300);
    expect(cell(t, 0, 'Cash out to owner (INR)')).toBe(1000);
    // swiggy_dineout_inr is not in this database yet: blank, not zero.
    expect(cell(t, 0, 'Swiggy Dineout (INR)')).toBe('');
    expect(cell(t, 0, 'Auto-ended')).toBe('No');
  });

  it('lists only categorised cash outs in the range, voided ones kept but left out of the total', async () => {
    const t = await loader('expenses')('2026-10-18', '2026-10-19');
    expect(t.rows).toHaveLength(4);
    expect(cell(t, 0, 'Recorded by')).toBe('Ravi Kumar');
    expect(cell(t, 0, 'Approved by')).toBe('Asha Verma');
    expect(cell(t, 1, 'Status')).toBe('Pending approval');
    expect(cell(t, 2, 'Status')).toBe('Voided');
    expect(cell(t, rowNamed(t, 'TOTAL'), 'Amount (INR)')).toBe(320);
  });

  it('totals expenses by category without the voided entry', async () => {
    const t = await loader('expense-categories')('2026-10-18', '2026-10-19');
    expect(t.rows[0]).toEqual(['Ice cubes', 1, 200, 62.5]);
    expect(t.rows[1]).toEqual(['Water', 1, 120, 37.5]);
  });

  it('finds app payments from tender rows and from a bill with no tender row, and leaves out cancelled bills', async () => {
    const t = await loader('app-payments')('2026-10-18', '2026-10-19');
    const payments = t.rows.filter((r) => r[0] !== 'Subtotal' && r[0] !== 'TOTAL');
    expect(payments).toHaveLength(3);
    expect(payments[0]).toEqual(['2026-10-18', '13:30', 'HIOC-001010', 'Swiggy Dineout', 850, 'SWG123', 'Ravi Kumar', 'Counted']);
    // Oldest first: the cancelled Zomato booking (09:00Z), then the bill with no tender row (10:00Z).
    expect(payments[1]).toEqual(['2026-10-18', '14:30', 'HIOC-001012', 'Zomato District', 400, 'ZD777', 'Asha Verma', 'Order cancelled']);
    expect(payments[2]).toEqual(['2026-10-18', '15:30', 'HIOC-001011', 'Swiggy Dineout', 300, '', '', 'Counted']);
    expect(t.rows[rowNamed(t, 'TOTAL')][4]).toBe(1150);
  });

  it('builds collections by payment mode from the reconciliation report', async () => {
    const t = await loader('payment-modes')('2026-10-18', '2026-10-19');
    expect(t.rows.map((r) => r[0])).toEqual(['2026-10-18', '2026-10-19', 'TOTAL']);
    expect(cell(t, 0, 'Cash (INR)')).toBe(150);
    expect(cell(t, 0, 'Swiggy Dineout (INR)')).toBe(1150);
    expect(cell(t, 0, 'Zomato District (INR)')).toBe(400);
    expect(cell(t, 0, 'Total received (INR)')).toBe(1700);
  });
});
