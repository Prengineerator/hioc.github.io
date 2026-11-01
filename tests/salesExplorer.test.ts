import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUERY,
  PRESETS,
  changePct,
  explorerCsv,
  explorerParams,
  factsOf,
  filterOptions,
  matchingPreset,
  parseExplorerQuery,
  presetQuery,
  previousPeriod,
  runExplorer,
  weekdayOf,
  type ExplorerQuery,
} from '@/lib/reports/salesExplorer';
import type { ExportLine, ExportOrder, OrderDataset } from '@/lib/reports/exports/types';

// Owner → Reports → Items & custom. Same dataset as the CSV downloads; the net
// column must add back up to the Overview's Net sales (bill totals less settle
// discounts), whatever the rows are.

let seq = 0;
function line(name: string, variant: string, qty: number, lineTotal: number, category = 'Coffee'): ExportLine {
  return {
    id: `l${++seq}`,
    menuItemId: name,
    name,
    variant,
    category,
    quantity: qty,
    weightGrams: null,
    lineTotalInr: lineTotal,
    passCoveredInr: 0,
    passDrinks: 0,
    gstExempt: false,
    gstCode: { code: '996331', description: '', uqc: 'NA', kind: 'service' },
    taxableInr: lineTotal,
    exemptValueInr: 0,
    cgstInr: 0,
    sgstInr: 0,
  };
}

function order(over: Partial<ExportOrder> & { lines: ExportLine[] }): ExportOrder {
  return {
    id: `o${++seq}`,
    orderNumber: seq,
    invoiceNo: `HIOC-${seq}`,
    createdAt: '2026-10-27T05:00:00Z',
    date: '2026-10-27', // a Tuesday
    time: '10:30',
    hour: 10,
    status: 'completed',
    valid: true,
    rejectReason: null,
    paymentStatus: 'paid',
    paymentMethods: ['cash'],
    channel: 'staff_pos',
    orderType: 'takeaway',
    orderKind: 'menu',
    tableLabel: null,
    createdById: 's1',
    createdByName: 'Asha',
    subtotalInr: 0,
    taxInr: 0,
    packagingInr: 0,
    discountInr: 0,
    passDiscountInr: 0,
    totalInr: 0,
    settleDiscountInr: 0,
    tipInr: 0,
    couponCodes: [],
    couponDiscountInr: 0,
    beaniesDiscountInr: 0,
    refundedInr: 0,
    gstRule: 'net_of_discount',
    taxableValueInr: 0,
    exemptValueInr: 0,
    cgstInr: 0,
    sgstInr: 0,
    packagingTaxableInr: 0,
    packagingCgstInr: 0,
    packagingSgstInr: 0,
    voidedLines: [],
    ...over,
  };
}

function dataset(orders: ExportOrder[], from = '2026-10-27', to = '2026-10-27'): OrderDataset {
  return { from, to, gstRatePercent: 5, gstInclusive: false, orders, refunds: [] };
}

/** URLSearchParams as Next hands searchParams over: repeated keys become arrays. */
function record(sp: URLSearchParams): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of sp) {
    const cur = out[k];
    out[k] = cur === undefined ? v : Array.isArray(cur) ? [...cur, v] : [cur, v];
  }
  return out;
}

const q = (over: Partial<ExplorerQuery> = {}, filters: Partial<ExplorerQuery['filters']> = {}): ExplorerQuery => ({
  ...DEFAULT_QUERY,
  ...over,
  filters: { ...DEFAULT_QUERY.filters, ...filters },
});

// A morning takeaway with a coupon (₹420 of menu value billed ₹399 + GST + packaging),
// a lunchtime dine-in with a settle discount, an evening website order, and a cancelled bill.
const morning = order({
  hour: 9,
  totalInr: 440,
  lines: [line('Latte', 'Regular', 2, 360), line('Cookie', '', 1, 60, 'Bakery')],
});
const lunch = order({
  hour: 13,
  orderType: 'dine_in',
  tableLabel: 'T4',
  createdByName: 'Ravi',
  paymentMethods: ['upi', 'cash'],
  totalInr: 500,
  settleDiscountInr: 50,
  lines: [line('Latte', 'Large', 1, 220), line('Sandwich', '', 1, 260, 'Food')],
});
const evening = order({
  date: '2026-11-01', // a Sunday
  hour: 19,
  channel: 'customer_web',
  createdByName: '',
  paymentMethods: ['online'],
  totalInr: 189,
  lines: [line('Latte', 'Regular', 1, 180)],
});
const cancelled = order({ valid: false, status: 'cancelled', totalInr: 999, lines: [line('Latte', 'Regular', 5, 900)] });
const ds = dataset([morning, lunch, evening, cancelled], '2026-10-27', '2026-11-01');

describe('factsOf — net sales tie to the Overview', () => {
  it('shares each bill across its lines and adds back up to Σ (total − settle) over valid bills', () => {
    const facts = factsOf(ds);
    const net = facts.reduce((s, f) => s + f.netInr, 0);
    expect(net).toBeCloseTo(440 + (500 - 50) + 189, 6);
    // The cancelled bill counts nowhere.
    expect(facts.some((f) => f.qty === 5)).toBe(false);
  });

  it('a line gets the bill in proportion to its menu value', () => {
    const facts = factsOf(dataset([morning]));
    const latte = facts.find((f) => f.item === 'Latte')!;
    expect(latte.netInr).toBeCloseTo((440 * 360) / 420, 6);
  });

  it('keeps a bill whose lines were all voided on a "(no items)" fact, so no rupee goes missing', () => {
    const facts = factsOf(dataset([order({ totalInr: 100, lines: [] })]));
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ item: '(no items)', netInr: 100, qty: 0 });
  });

  it('labels payment as split when a bill was paid two ways, unpaid when not at all', () => {
    const facts = factsOf(dataset([lunch, order({ paymentMethods: [], totalInr: 10, lines: [line('Tea', '', 1, 10)] })]));
    expect(new Set(facts.map((f) => f.payment))).toEqual(new Set(['split', 'unpaid']));
  });
});

describe('runExplorer — rows', () => {
  it('item-wise: sizes together, best seller first, with quantity, bills, sales and average price', () => {
    const r = runExplorer(ds, q());
    expect(r.rows.map((x) => x.label)).toEqual(['Latte', 'Sandwich', 'Cookie']);
    const latte = r.rows[0];
    expect(latte).toMatchObject({ qty: 4, orders: 3, salesInr: 760, avgInr: 190 });
    expect(r.avgKind).toBe('price');
    expect(r.totals).toMatchObject({ qty: 6, orders: 3, salesInr: 1080, netInr: 1079 });
  });

  it('item + size puts each size on its own row', () => {
    const r = runExplorer(ds, q({ rows: 'variant' }));
    expect(r.rows.map((x) => x.label)).toContain('Latte (Large)');
    expect(r.rows.map((x) => x.label)).toContain('Latte (Regular)');
  });

  it('time rows keep their own order; bill rows average per bill', () => {
    const hours = runExplorer(ds, q({ rows: 'hour' }));
    expect(hours.rows.map((x) => x.key)).toEqual(['9', '13', '19']);
    expect(hours.rows[0].label).toBe('9 am–10 am');
    expect(hours.avgKind).toBe('bill');
    expect(hours.rows[1].avgInr).toBe(450); // one bill, 500 − 50
    const days = runExplorer(ds, q({ rows: 'weekday' }));
    expect(days.rows.map((x) => x.label)).toEqual(['Tue', 'Sun']);
  });

  it('shares add up to 100 and every dimension groups', () => {
    for (const rows of ['category', 'staff', 'channel', 'orderType', 'payment', 'table', 'day'] as const) {
      const r = runExplorer(ds, q({ rows }));
      expect(r.rows.reduce((s, x) => s + x.netInr, 0)).toBeCloseTo(r.totals.netInr, 1);
      expect(r.rows.reduce((s, x) => s + x.sharePct, 0)).toBeCloseTo(100, 0);
    }
    expect(runExplorer(ds, q({ rows: 'staff' })).rows.map((x) => x.label)).toContain('Online / customer');
    expect(runExplorer(ds, q({ rows: 'table' })).rows.map((x) => x.label)).toEqual(expect.arrayContaining(['T4', 'No table']));
  });

  it('sorts by what is asked, and top N keeps totals over every row', () => {
    const byQty = runExplorer(ds, q({ sort: 'qty' }));
    expect(byQty.rows[0].label).toBe('Latte');
    const byName = runExplorer(ds, q({ sort: 'name' }));
    expect(byName.rows.map((x) => x.label)).toEqual(['Cookie', 'Latte', 'Sandwich']);
    const top = runExplorer(ds, q({ top: 10, rows: 'variant', sort: 'net' }));
    expect(top.rowCount).toBe(4);
    const top1 = runExplorer(ds, { ...q(), top: 1 as never });
    expect(top1.rows).toHaveLength(1);
    expect(top1.rowCount).toBe(3);
    expect(top1.totals.salesInr).toBe(1080);
  });
});

describe('runExplorer — filters', () => {
  it('category, channel, order type, payment, staff, weekday, hours and search', () => {
    expect(runExplorer(ds, q({}, { categories: ['Food'] })).rows.map((x) => x.label)).toEqual(['Sandwich']);
    expect(runExplorer(ds, q({}, { channels: ['customer_web'] })).totals.orders).toBe(1);
    expect(runExplorer(ds, q({}, { orderTypes: ['dine_in'] })).totals.netInr).toBe(450);
    expect(runExplorer(ds, q({}, { payments: ['split'] })).totals.orders).toBe(1);
    expect(runExplorer(ds, q({}, { staff: ['Asha'] })).totals.orders).toBe(1);
    expect(runExplorer(ds, q({}, { weekdays: [6] })).totals.orders).toBe(1); // Sunday
    expect(runExplorer(ds, q({}, { hourFrom: 12, hourTo: 18 })).totals.orders).toBe(1);
    expect(runExplorer(ds, q({}, { search: 'lar' })).rows.map((x) => x.label)).toEqual(['Latte']);
  });

  it('offers only the choices this range has (plus whatever is already picked)', () => {
    const o = filterOptions(ds, { ...DEFAULT_QUERY.filters, staff: ['Gone'] });
    expect(o.categories).toEqual(['Bakery', 'Coffee', 'Food']);
    expect(o.staff).toEqual(['Asha', 'Gone', 'Online / customer', 'Ravi']);
    expect(o.payments.map((p) => p.label)).toContain('Split payment');
  });
});

describe('runExplorer — split grid', () => {
  it('items × hour: one column per hour, cells add up to the row', () => {
    const r = runExplorer(ds, q({ split: 'hour', cell: 'qty' }));
    expect(r.columns.map((c) => c.label)).toEqual(['9 am', '1 pm', '7 pm']);
    const latte = r.rows.find((x) => x.label === 'Latte')!;
    expect(Object.values(latte.cells!).reduce((s, n) => s + n, 0)).toBe(latte.qty);
    expect(r.maxCell).toBe(2);
  });

  it('folds anything past 12 columns into "Other" (never days or hours)', () => {
    const many = dataset(
      Array.from({ length: 15 }, (_, i) => order({ totalInr: 10, lines: [line(`Item ${i}`, '', 1, 10, `Cat ${String(i).padStart(2, '0')}`)] })),
    );
    const r = runExplorer(many, q({ rows: 'channel', split: 'category', cell: 'qty' }));
    expect(r.columns).toHaveLength(12);
    expect(r.columns.at(-1)!.label).toBe('Other');
    expect(Object.values(r.rows[0].cells!).reduce((s, n) => s + n, 0)).toBe(15);
  });
});

describe('runExplorer — compare with the period before', () => {
  const before = dataset([order({ totalInr: 200, lines: [line('Latte', 'Regular', 1, 180)] })], '2026-10-21', '2026-10-26');

  it('matches rows by key and totals', () => {
    const r = runExplorer(ds, q(), before);
    expect(r.prevTotals?.netInr).toBe(200);
    expect(r.rows.find((x) => x.label === 'Latte')!.prev?.qty).toBe(1);
    expect(r.rows.find((x) => x.label === 'Cookie')!.prev).toEqual({ qty: 0, salesInr: 0, netInr: 0, orders: 0 });
  });

  it('does not pair dates across periods', () => {
    const r = runExplorer(ds, q({ rows: 'day' }), before);
    expect(r.rows.every((x) => x.prev === undefined)).toBe(true);
    expect(r.prevTotals).toBeDefined();
  });

  it('changePct and previousPeriod', () => {
    expect(changePct(150, 100)).toBe(50);
    expect(changePct(0, 0)).toBe(0);
    expect(changePct(10, 0)).toBeNull();
    expect(previousPeriod('2026-10-27', '2026-11-01')).toEqual({ from: '2026-10-21', to: '2026-10-26' });
    expect(previousPeriod('2026-11-01', '2026-11-01')).toEqual({ from: '2026-10-31', to: '2026-10-31' });
  });
});

describe('query in the URL', () => {
  it('parses, falls back on junk, and round-trips', () => {
    const parsed = parseExplorerQuery({
      rows: 'category',
      split: 'hour',
      cell: 'net',
      sort: 'qty',
      top: '25',
      compare: '1',
      category: ['Coffee', 'Food'],
      weekday: ['5', '6', '9'],
      hourFrom: '8',
      hourTo: '30',
      q: 'latte',
    });
    expect(parsed).toMatchObject({ rows: 'category', split: 'hour', cell: 'net', sort: 'qty', top: 25, compare: true });
    expect(parsed.filters).toMatchObject({ categories: ['Coffee', 'Food'], weekdays: [5, 6], hourFrom: 8, hourTo: null, search: 'latte' });
    expect(parseExplorerQuery(record(explorerParams(parsed)))).toEqual(parsed);
    expect(parseExplorerQuery({ rows: 'nope', top: '7', split: 'item' })).toEqual(DEFAULT_QUERY);
    expect(parseExplorerQuery({ rows: 'hour', split: 'hour' }).split).toBeNull();
  });

  it('every preset round-trips and is recognised', () => {
    for (const p of PRESETS) {
      const pq = presetQuery(p);
      expect(matchingPreset(parseExplorerQuery(record(explorerParams(pq))))).toBe(p.id);
    }
    expect(matchingPreset(DEFAULT_QUERY)).toBe('items');
  });

  it('weekdayOf counts Monday as 0', () => {
    expect(weekdayOf('2026-10-26')).toBe(0);
    expect(weekdayOf('2026-11-01')).toBe(6);
  });
});

describe('explorerCsv', () => {
  it('writes exactly what is on screen, with a TOTAL row over every row', () => {
    const r = runExplorer(ds, { ...q({ split: 'hour', cell: 'qty' }), top: 1 as never }, null);
    const csv = explorerCsv(r);
    expect(csv.columns.slice(0, 7)).toEqual([
      'Item',
      'Quantity',
      'Bills',
      'Sales (INR)',
      'Net sales (INR)',
      'Avg price (INR)',
      'Share of net %',
    ]);
    expect(csv.columns.slice(7)).toEqual(['9 am · Quantity', '1 pm · Quantity', '7 pm · Quantity']);
    expect(csv.rows).toHaveLength(2);
    expect(csv.rows[1][0]).toBe('TOTAL (all 3 rows)');
    expect(csv.rows[1][4]).toBe(1079);
  });
});
