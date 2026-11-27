// Owner → Reports → Items & custom: the on-screen, build-your-own sales report.
//
// Item-wise sales used to exist only as a CSV under Downloads; nothing showed
// it on screen, and no report could be cut any other way than the fixed
// sheets. This is one engine for every cut the owner asks for: pick what the
// rows are (item, item + size, category, day, weekday, hour, staff, channel,
// order type, payment, table), optionally split them by a second dimension (a
// grid: items × hour, category × weekday …), filter, sort, keep the top N and
// compare with the period before.
//
// Pure, and built on the SAME OrderDataset the CSV downloads use
// (lib/reports/exports/orderDataServer.ts), so every number agrees with them:
// a sale is a valid order (not cancelled or rejected) dated by the IST day it
// was placed, and its lines are the ones that were not voided.
//
// Two money columns, both per line:
//   Sales      the line at menu price (line_total_inr): what the item sold
//              for before discounts — the "Gross sales" of the item-wise CSV.
//   Net sales  the line's share of what the bill actually came to: the bill
//              total (after coupons, Beanies and offers, with GST and
//              packaging) less any settle discount, shared across the bill's
//              lines by their menu value. Summed over everything, it is the
//              Overview's "Net sales" to the rupee — so an hour, a staff
//              member or a category can be read against the day's takings.

import { round2, type CsvTable } from '@/lib/reports/csv';
import type { ExportOrder, OrderDataset } from '@/lib/reports/exports/types';
import { datesBetween } from '@/lib/reports/reconcile';

// ── Dimensions and the query ────────────────────────────────────────────────

export type Dimension =
  | 'item'
  | 'variant'
  | 'category'
  | 'day'
  | 'weekday'
  | 'hour'
  | 'staff'
  | 'channel'
  | 'orderType'
  | 'payment'
  | 'table';

export const DIMENSIONS: { key: Dimension; label: string }[] = [
  { key: 'item', label: 'Item' },
  { key: 'variant', label: 'Item + size' },
  { key: 'category', label: 'Category' },
  { key: 'day', label: 'Day' },
  { key: 'weekday', label: 'Day of week' },
  { key: 'hour', label: 'Hour' },
  { key: 'staff', label: 'Staff' },
  { key: 'channel', label: 'Channel' },
  { key: 'orderType', label: 'Order type' },
  { key: 'payment', label: 'Payment' },
  { key: 'table', label: 'Table' },
];

/** Rows of things that were sold (an average is a price); the rest are slices of bills (an average is per bill). */
const ITEM_DIMENSIONS: ReadonlySet<Dimension> = new Set(['item', 'variant', 'category']);
/** Their own natural order (dates, Mon → Sun, hours) rather than biggest first. */
const TIME_DIMENSIONS: ReadonlySet<Dimension> = new Set(['day', 'weekday', 'hour']);

export type Metric = 'net' | 'sales' | 'qty' | 'orders';
export const METRICS: { key: Metric; label: string }[] = [
  { key: 'net', label: 'Net sales' },
  { key: 'sales', label: 'Sales' },
  { key: 'qty', label: 'Quantity' },
  { key: 'orders', label: 'Bills' },
];

export type SortKey = 'default' | Metric | 'avg' | 'name';
export const SORTS: { key: SortKey; label: string }[] = [
  { key: 'default', label: 'Best first (time in order)' },
  { key: 'net', label: 'Net sales' },
  { key: 'sales', label: 'Sales' },
  { key: 'qty', label: 'Quantity' },
  { key: 'orders', label: 'Bills' },
  { key: 'avg', label: 'Average' },
  { key: 'name', label: 'Name A–Z' },
];

export const TOP_CHOICES = [10, 25, 50, 100] as const;

export interface ExplorerFilters {
  categories: string[];
  channels: string[];
  orderTypes: string[];
  payments: string[];
  staff: string[];
  /** 0 = Monday … 6 = Sunday. */
  weekdays: number[];
  /** Inclusive IST hours, 0–23; null = no bound. */
  hourFrom: number | null;
  hourTo: number | null;
  /** Item name or size contains this (case-insensitive). */
  search: string;
}

export interface ExplorerQuery {
  rows: Dimension;
  split: Dimension | null;
  /** What a split grid's cells show. */
  cell: Metric;
  sort: SortKey;
  /** Rows shown; null = all. Totals always cover every row. */
  top: number | null;
  compare: boolean;
  filters: ExplorerFilters;
}

export const DEFAULT_QUERY: ExplorerQuery = {
  rows: 'item',
  split: null,
  cell: 'qty',
  sort: 'default',
  top: null,
  compare: false,
  filters: {
    categories: [],
    channels: [],
    orderTypes: [],
    payments: [],
    staff: [],
    weekdays: [],
    hourFrom: null,
    hourTo: null,
    search: '',
  },
};

type Params = Record<string, string | string[] | undefined>;

function list(v: string | string[] | undefined): string[] {
  const xs = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return [...new Set(xs.flatMap((x) => x.split(',')).map((x) => x.trim()).filter(Boolean))].slice(0, 50);
}
function one(v: string | string[] | undefined): string {
  return (Array.isArray(v) ? v[0] : v)?.trim() ?? '';
}
function hourOf(v: string | string[] | undefined): number | null {
  const s = one(v);
  if (s === '') return null;
  const n = Number(s);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}
const isDimension = (s: string): s is Dimension => DIMENSIONS.some((d) => d.key === s);
const isMetric = (s: string): s is Metric => METRICS.some((m) => m.key === s);
const isSort = (s: string): s is SortKey => SORTS.some((m) => m.key === s);

/** The query in the page's URL, every unknown or malformed value falling back to its default. */
export function parseExplorerQuery(p: Params): ExplorerQuery {
  const rows = isDimension(one(p.rows)) ? (one(p.rows) as Dimension) : DEFAULT_QUERY.rows;
  const splitRaw = one(p.split);
  // Splitting rows by themselves is just the rows again.
  const split = isDimension(splitRaw) && splitRaw !== rows ? (splitRaw as Dimension) : null;
  const topN = Number(one(p.top));
  return {
    rows,
    split,
    cell: isMetric(one(p.cell)) ? (one(p.cell) as Metric) : DEFAULT_QUERY.cell,
    sort: isSort(one(p.sort)) ? (one(p.sort) as SortKey) : 'default',
    top: (TOP_CHOICES as readonly number[]).includes(topN) ? topN : null,
    compare: one(p.compare) === '1',
    filters: {
      categories: list(p.category),
      channels: list(p.channel),
      orderTypes: list(p.type),
      payments: list(p.payment),
      staff: list(p.staff),
      weekdays: list(p.weekday)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
      hourFrom: hourOf(p.hourFrom),
      hourTo: hourOf(p.hourTo),
      search: one(p.q).slice(0, 60),
    },
  };
}

/** The query back as URL parameters (defaults left out), for links, saved views and the CSV. */
export function explorerParams(q: ExplorerQuery): URLSearchParams {
  const s = new URLSearchParams();
  if (q.rows !== DEFAULT_QUERY.rows) s.set('rows', q.rows);
  if (q.split) s.set('split', q.split);
  if (q.split && q.cell !== DEFAULT_QUERY.cell) s.set('cell', q.cell);
  if (q.sort !== 'default') s.set('sort', q.sort);
  if (q.top) s.set('top', String(q.top));
  if (q.compare) s.set('compare', '1');
  const f = q.filters;
  for (const v of f.categories) s.append('category', v);
  for (const v of f.channels) s.append('channel', v);
  for (const v of f.orderTypes) s.append('type', v);
  for (const v of f.payments) s.append('payment', v);
  for (const v of f.staff) s.append('staff', v);
  for (const v of f.weekdays) s.append('weekday', String(v));
  if (f.hourFrom !== null) s.set('hourFrom', String(f.hourFrom));
  if (f.hourTo !== null) s.set('hourTo', String(f.hourTo));
  if (f.search) s.set('q', f.search);
  return s;
}

/** How many filters are on (for the "Filters (3)" label). */
export function activeFilterCount(f: ExplorerFilters): number {
  return (
    (f.categories.length ? 1 : 0) +
    (f.channels.length ? 1 : 0) +
    (f.orderTypes.length ? 1 : 0) +
    (f.payments.length ? 1 : 0) +
    (f.staff.length ? 1 : 0) +
    (f.weekdays.length ? 1 : 0) +
    (f.hourFrom !== null || f.hourTo !== null ? 1 : 0) +
    (f.search ? 1 : 0)
  );
}

// ── Ready-made reports ──────────────────────────────────────────────────────

export interface ExplorerPreset {
  id: string;
  label: string;
  description: string;
  query: Partial<Omit<ExplorerQuery, 'filters'>> & { filters?: Partial<ExplorerFilters> };
}

export const PRESETS: ExplorerPreset[] = [
  { id: 'items', label: 'Item-wise sales', description: 'Every item, best seller first', query: { rows: 'item' } },
  { id: 'variants', label: 'Items by size', description: 'Each item and size on its own row', query: { rows: 'variant' } },
  { id: 'categories', label: 'Category-wise', description: 'Sales by menu category', query: { rows: 'category' } },
  {
    id: 'items-hour',
    label: 'Best sellers by hour',
    description: 'What sells when: top items across the hours',
    query: { rows: 'item', split: 'hour', cell: 'qty', top: 25 },
  },
  {
    id: 'items-weekday',
    label: 'Items by weekday',
    description: 'Top items, Monday to Sunday',
    query: { rows: 'item', split: 'weekday', cell: 'qty', top: 25 },
  },
  { id: 'days', label: 'Day-wise', description: 'One row per day', query: { rows: 'day' } },
  { id: 'hours', label: 'Hour-wise', description: 'The busy hours', query: { rows: 'hour' } },
  {
    id: 'weekday-category',
    label: 'Weekday × category',
    description: 'Which days each category sells',
    query: { rows: 'weekday', split: 'category', cell: 'net' },
  },
  { id: 'staff', label: 'Staff-wise', description: 'Bills rung up by each person', query: { rows: 'staff' } },
  {
    id: 'channels',
    label: 'Channel & order type',
    description: 'Counter, website and table QR; dine-in vs takeaway',
    query: { rows: 'channel', split: 'orderType', cell: 'net' },
  },
  { id: 'payments', label: 'Payment mix', description: 'Cash, UPI, card, apps', query: { rows: 'payment' } },
  {
    id: 'tables',
    label: 'Table-wise',
    description: 'Dine-in sales by table',
    query: { rows: 'table', filters: { orderTypes: ['dine_in'] } },
  },
];

export function presetQuery(p: ExplorerPreset): ExplorerQuery {
  return { ...DEFAULT_QUERY, ...p.query, filters: { ...DEFAULT_QUERY.filters, ...(p.query.filters ?? {}) } };
}

/** The preset this query is exactly, if any (to highlight its chip). */
export function matchingPreset(q: ExplorerQuery): string | null {
  const key = explorerParams(q).toString();
  return PRESETS.find((p) => explorerParams(presetQuery(p)).toString() === key)?.id ?? null;
}

// ── Labels ──────────────────────────────────────────────────────────────────

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export const WEEKDAY_LABELS: readonly string[] = WEEKDAYS;

const CHANNEL_LABEL: Record<string, string> = {
  staff_pos: 'Counter (POS)',
  customer_web: 'Website',
  table_qr: 'Table QR',
};
const ORDER_TYPE_LABEL: Record<string, string> = { dine_in: 'Dine-in', takeaway: 'Takeaway', delivery: 'Delivery' };
const PAYMENT_LABEL: Record<string, string> = {
  cash: 'Cash',
  upi: 'UPI',
  card: 'Card',
  online: 'Online (website)',
  swiggy_dineout: 'Swiggy Dineout',
  zomato_district: 'Zomato District',
  split: 'Split payment',
  unpaid: 'Unpaid',
};
export const channelLabel = (c: string) => CHANNEL_LABEL[c] ?? c;
export const orderTypeLabel = (t: string) => ORDER_TYPE_LABEL[t] ?? t;
export const paymentLabel = (p: string) => PAYMENT_LABEL[p] ?? p;

/** '9 am', '12 pm', '1 pm' … for an IST hour. */
export function hourLabel(h: number): string {
  const suffix = h < 12 ? 'am' : 'pm';
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return `${twelve} ${suffix}`;
}

function shortDay(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return `${WEEKDAYS[(dt.getUTCDay() + 6) % 7]} ${dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' })}`;
}

/** 0 = Monday … 6 = Sunday, for an IST date. */
export function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

// ── Facts: one row per sold line, with its bill's details ───────────────────

export interface Fact {
  orderId: string;
  date: string;
  weekday: number;
  hour: number;
  staff: string;
  channel: string;
  orderType: string;
  payment: string;
  table: string;
  item: string;
  variant: string;
  category: string;
  qty: number;
  salesInr: number;
  netInr: number;
}

const ONLINE_STAFF = 'Online / customer';
const NO_TABLE = 'No table';

function paymentOf(o: ExportOrder): string {
  if (o.paymentMethods.length === 0) return 'unpaid';
  return o.paymentMethods.length > 1 ? 'split' : o.paymentMethods[0];
}

/**
 * Every valid order's lines as facts. The bill's net (total − settle discount)
 * is shared across its lines by menu value, so the facts' net adds back up to
 * the bill — and over a range, to the Overview's Net sales. A bill whose lines
 * are all ₹0 shares it by quantity; a bill with no lines left (every line
 * voided) keeps its net on one "(no items)" fact so no rupee goes missing.
 */
export function factsOf(ds: OrderDataset): Fact[] {
  const out: Fact[] = [];
  for (const o of ds.orders) {
    if (!o.valid) continue;
    const net = o.totalInr - (o.settleDiscountInr ?? 0);
    const base = {
      orderId: o.id,
      date: o.date,
      weekday: weekdayOf(o.date),
      hour: o.hour,
      staff: o.createdByName || ONLINE_STAFF,
      channel: o.channel,
      orderType: o.orderType,
      payment: paymentOf(o),
      table: o.tableLabel?.trim() || NO_TABLE,
    };
    if (o.lines.length === 0) {
      out.push({ ...base, item: '(no items)', variant: '', category: 'Uncategorised', qty: 0, salesInr: 0, netInr: net });
      continue;
    }
    const value = o.lines.reduce((s, l) => s + l.lineTotalInr, 0);
    const units = o.lines.reduce((s, l) => s + l.quantity, 0);
    for (const l of o.lines) {
      const weight = value > 0 ? l.lineTotalInr / value : units > 0 ? l.quantity / units : 1 / o.lines.length;
      out.push({
        ...base,
        item: l.name,
        variant: l.variant,
        category: l.category,
        qty: l.quantity,
        salesInr: l.lineTotalInr,
        netInr: net * weight,
      });
    }
  }
  return out;
}

function passes(f: Fact, q: ExplorerFilters): boolean {
  if (q.categories.length && !q.categories.includes(f.category)) return false;
  if (q.channels.length && !q.channels.includes(f.channel)) return false;
  if (q.orderTypes.length && !q.orderTypes.includes(f.orderType)) return false;
  if (q.payments.length && !q.payments.includes(f.payment)) return false;
  if (q.staff.length && !q.staff.includes(f.staff)) return false;
  if (q.weekdays.length && !q.weekdays.includes(f.weekday)) return false;
  if (q.hourFrom !== null && f.hour < q.hourFrom) return false;
  if (q.hourTo !== null && f.hour > q.hourTo) return false;
  if (q.search) {
    const needle = q.search.toLowerCase();
    if (!f.item.toLowerCase().includes(needle) && !f.variant.toLowerCase().includes(needle)) return false;
  }
  return true;
}

/** The group a fact falls in for a dimension: a stable key, its label, and its natural order. */
function keyOf(f: Fact, d: Dimension): { key: string; label: string; order: number | string } {
  switch (d) {
    case 'item':
      return { key: f.item, label: f.item, order: f.item };
    case 'variant': {
      const label = f.variant ? `${f.item} (${f.variant})` : f.item;
      return { key: `${f.item}\u0001${f.variant}`, label, order: label };
    }
    case 'category':
      return { key: f.category, label: f.category, order: f.category };
    case 'day':
      return { key: f.date, label: shortDay(f.date), order: f.date };
    case 'weekday':
      return { key: String(f.weekday), label: WEEKDAYS[f.weekday], order: f.weekday };
    case 'hour':
      return { key: String(f.hour), label: `${hourLabel(f.hour)}–${hourLabel((f.hour + 1) % 24)}`, order: f.hour };
    case 'staff':
      return { key: f.staff, label: f.staff, order: f.staff };
    case 'channel':
      return { key: f.channel, label: channelLabel(f.channel), order: f.channel };
    case 'orderType':
      return { key: f.orderType, label: orderTypeLabel(f.orderType), order: f.orderType };
    case 'payment':
      return { key: f.payment, label: paymentLabel(f.payment), order: f.payment };
    case 'table':
      return { key: f.table, label: f.table, order: f.table };
  }
}

/** A short header for a split column ('9 am' rather than '9 am–10 am'). */
function columnLabel(f: Fact, d: Dimension): string {
  if (d === 'hour') return hourLabel(f.hour);
  if (d === 'day') return `${Number(f.date.slice(8))}/${Number(f.date.slice(5, 7))}`;
  return keyOf(f, d).label;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

export interface Totals {
  qty: number;
  salesInr: number;
  netInr: number;
  orders: number;
}

export interface ExplorerRow extends Totals {
  key: string;
  label: string;
  /** Sales ÷ quantity for item rows; net ÷ bills for every other kind of row. */
  avgInr: number;
  /** Share of the filtered net sales, 0–100 to 1 dp. */
  sharePct: number;
  /** Same row in the period before, when comparing (and the rows can be matched). */
  prev?: Totals;
  /** Split grid cells by column key. */
  cells?: Record<string, number>;
}

export interface ExplorerColumn {
  key: string;
  label: string;
}

export interface ExplorerResult {
  query: ExplorerQuery;
  rows: ExplorerRow[];
  /** Rows there are in all, before `top`. */
  rowCount: number;
  totals: Totals & { avgBillInr: number };
  prevTotals?: Totals & { avgBillInr: number };
  /** Split grid columns, in order; the last may be "Other". */
  columns: ExplorerColumn[];
  /** Largest cell in the grid, for shading. */
  maxCell: number;
  /** The average column means a price (item rows) or a bill (others). */
  avgKind: 'price' | 'bill';
}

interface Acc {
  key: string;
  label: string;
  order: number | string;
  qty: number;
  salesInr: number;
  netInr: number;
  orderIds: Set<string>;
  cells: Map<string, { qty: number; salesInr: number; netInr: number; orderIds: Set<string> }>;
}

function metricOf(a: { qty: number; salesInr: number; netInr: number; orderIds: Set<string> }, m: Metric): number {
  switch (m) {
    case 'qty':
      return a.qty;
    case 'sales':
      return a.salesInr;
    case 'net':
      return a.netInr;
    case 'orders':
      return a.orderIds.size;
  }
}

function totalsOf(facts: readonly Fact[]): Totals & { avgBillInr: number } {
  const orders = new Set(facts.map((f) => f.orderId)).size;
  const netInr = facts.reduce((s, f) => s + f.netInr, 0);
  return {
    qty: facts.reduce((s, f) => s + f.qty, 0),
    salesInr: round2(facts.reduce((s, f) => s + f.salesInr, 0)),
    netInr: round2(netInr),
    orders,
    avgBillInr: orders > 0 ? round2(netInr / orders) : 0,
  };
}

function group(facts: readonly Fact[], d: Dimension, split: Dimension | null): Map<string, Acc> {
  const accs = new Map<string, Acc>();
  for (const f of facts) {
    const k = keyOf(f, d);
    let a = accs.get(k.key);
    if (!a) {
      a = { ...k, qty: 0, salesInr: 0, netInr: 0, orderIds: new Set(), cells: new Map() };
      accs.set(k.key, a);
    }
    a.qty += f.qty;
    a.salesInr += f.salesInr;
    a.netInr += f.netInr;
    a.orderIds.add(f.orderId);
    if (split) {
      const ck = keyOf(f, split).key;
      let c = a.cells.get(ck);
      if (!c) {
        c = { qty: 0, salesInr: 0, netInr: 0, orderIds: new Set() };
        a.cells.set(ck, c);
      }
      c.qty += f.qty;
      c.salesInr += f.salesInr;
      c.netInr += f.netInr;
      c.orderIds.add(f.orderId);
    }
  }
  return accs;
}

const compareOrder = (a: number | string, b: number | string) =>
  typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));

/** Split columns: time in its own order; anything else biggest first, past 12 the rest folded into "Other". */
const MAX_COLUMNS = 12;
const OTHER = '\u0000other';

function splitColumns(facts: readonly Fact[], split: Dimension, cell: Metric): { columns: ExplorerColumn[]; fold: Map<string, string> } {
  const byKey = new Map<string, { label: string; order: number | string; acc: { qty: number; salesInr: number; netInr: number; orderIds: Set<string> } }>();
  for (const f of facts) {
    const k = keyOf(f, split);
    let c = byKey.get(k.key);
    if (!c) {
      c = { label: columnLabel(f, split), order: k.order, acc: { qty: 0, salesInr: 0, netInr: 0, orderIds: new Set() } };
      byKey.set(k.key, c);
    }
    c.acc.qty += f.qty;
    c.acc.salesInr += f.salesInr;
    c.acc.netInr += f.netInr;
    c.acc.orderIds.add(f.orderId);
  }
  const entries = [...byKey.entries()];
  const timeLike = TIME_DIMENSIONS.has(split);
  entries.sort(timeLike ? (a, b) => compareOrder(a[1].order, b[1].order) : (a, b) => metricOf(b[1].acc, cell) - metricOf(a[1].acc, cell));
  // Days and hours are never folded: a grid with a gap in the middle of the
  // week would mislead. Anything else keeps its biggest 11 and an "Other".
  const keep = timeLike || entries.length <= MAX_COLUMNS ? entries : entries.slice(0, MAX_COLUMNS - 1);
  const fold = new Map<string, string>();
  const columns: ExplorerColumn[] = keep.map(([key, c]) => {
    fold.set(key, key);
    return { key, label: c.label };
  });
  if (keep.length < entries.length) {
    for (const [key] of entries.slice(keep.length)) fold.set(key, OTHER);
    columns.push({ key: OTHER, label: 'Other' });
  }
  return { columns, fold };
}

/**
 * The report: filter the facts, group them into rows (and grid cells), sort,
 * keep the top N, and — given the period before — attach its numbers.
 */
export function runExplorer(ds: OrderDataset, q: ExplorerQuery, previous?: OrderDataset | null): ExplorerResult {
  const facts = factsOf(ds).filter((f) => passes(f, q.filters));
  const totals = totalsOf(facts);
  const accs = group(facts, q.rows, q.split);
  const avgKind: 'price' | 'bill' = ITEM_DIMENSIONS.has(q.rows) ? 'price' : 'bill';

  const { columns, fold } = q.split ? splitColumns(facts, q.split, q.cell) : { columns: [], fold: new Map<string, string>() };

  let rows: ExplorerRow[] = [...accs.values()].map((a) => {
    const orders = a.orderIds.size;
    const row: ExplorerRow = {
      key: a.key,
      label: a.label,
      qty: a.qty,
      salesInr: round2(a.salesInr),
      netInr: round2(a.netInr),
      orders,
      avgInr: avgKind === 'price' ? (a.qty > 0 ? round2(a.salesInr / a.qty) : 0) : orders > 0 ? round2(a.netInr / orders) : 0,
      sharePct: totals.netInr > 0 ? Math.round((a.netInr / totals.netInr) * 1000) / 10 : 0,
    };
    if (q.split) {
      const cells: Record<string, number> = {};
      const folded = new Map<string, { qty: number; salesInr: number; netInr: number; orderIds: Set<string> }>();
      for (const [ck, c] of a.cells) {
        const target = fold.get(ck) ?? OTHER;
        const f = folded.get(target) ?? { qty: 0, salesInr: 0, netInr: 0, orderIds: new Set<string>() };
        f.qty += c.qty;
        f.salesInr += c.salesInr;
        f.netInr += c.netInr;
        for (const id of c.orderIds) f.orderIds.add(id);
        folded.set(target, f);
      }
      for (const [ck, c] of folded) cells[ck] = round2(metricOf(c, q.cell));
      row.cells = cells;
    }
    return row;
  });

  const order = new Map([...accs.values()].map((a) => [a.key, a.order]));
  const sortKey: SortKey =
    q.sort !== 'default' ? q.sort : TIME_DIMENSIONS.has(q.rows) ? 'name' : ITEM_DIMENSIONS.has(q.rows) ? 'sales' : 'net';
  rows.sort((a, b) => {
    switch (sortKey) {
      case 'name':
        return compareOrder(order.get(a.key)!, order.get(b.key)!);
      case 'avg':
        return b.avgInr - a.avgInr || a.label.localeCompare(b.label);
      case 'qty':
        return b.qty - a.qty || b.salesInr - a.salesInr || a.label.localeCompare(b.label);
      case 'orders':
        return b.orders - a.orders || b.netInr - a.netInr || a.label.localeCompare(b.label);
      case 'sales':
        return b.salesInr - a.salesInr || b.qty - a.qty || a.label.localeCompare(b.label);
      default:
        return b.netInr - a.netInr || a.label.localeCompare(b.label);
    }
  });
  const rowCount = rows.length;
  if (q.top) rows = rows.slice(0, q.top);

  let prevTotals: ExplorerResult['prevTotals'];
  if (previous) {
    const prevFacts = factsOf(previous).filter((f) => passes(f, q.filters));
    prevTotals = totalsOf(prevFacts);
    // Rows by date can't be matched across periods (different dates); every
    // other kind of row is matched by its key.
    if (q.rows !== 'day') {
      const prevAccs = group(prevFacts, q.rows, null);
      for (const r of rows) {
        const p = prevAccs.get(r.key);
        r.prev = p
          ? { qty: p.qty, salesInr: round2(p.salesInr), netInr: round2(p.netInr), orders: p.orderIds.size }
          : { qty: 0, salesInr: 0, netInr: 0, orders: 0 };
      }
    }
  }

  const maxCell = rows.reduce((m, r) => Math.max(m, ...Object.values(r.cells ?? {})), 0);
  return { query: q, rows, rowCount, totals, prevTotals, columns, maxCell, avgKind };
}

/** Change from `prev` to `now` in %, 1 dp; null when there was nothing before. */
export function changePct(now: number, prev: number): number | null {
  if (prev === 0) return now === 0 ? 0 : null;
  return Math.round(((now - prev) / Math.abs(prev)) * 1000) / 10;
}

/** The period of the same length that ends the day before `from`. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const days = datesBetween(from, to).length;
  const shift = (iso: string, n: number) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
  };
  return { from: shift(from, days), to: shift(from, 1) };
}

// ── Filter choices: what this range actually has ────────────────────────────

export interface FilterOptions {
  categories: string[];
  channels: { key: string; label: string }[];
  orderTypes: { key: string; label: string }[];
  payments: { key: string; label: string }[];
  staff: string[];
}

export function filterOptions(ds: OrderDataset, selected: ExplorerFilters): FilterOptions {
  const facts = factsOf(ds);
  const uniq = (xs: string[], keep: string[]) => [...new Set([...xs, ...keep])].sort((a, b) => a.localeCompare(b));
  const labelled = (xs: string[], keep: string[], label: (k: string) => string) =>
    uniq(xs, keep).map((key) => ({ key, label: label(key) }));
  return {
    categories: uniq(facts.map((f) => f.category), selected.categories),
    channels: labelled(facts.map((f) => f.channel), selected.channels, channelLabel),
    orderTypes: labelled(facts.map((f) => f.orderType), selected.orderTypes, orderTypeLabel),
    payments: labelled(facts.map((f) => f.payment), selected.payments, paymentLabel),
    staff: uniq(facts.map((f) => f.staff), selected.staff),
  };
}

// ── CSV of exactly what is on screen ────────────────────────────────────────

export function explorerCsv(r: ExplorerResult): CsvTable {
  const dim = DIMENSIONS.find((d) => d.key === r.query.rows)!.label;
  const avgHeader = r.avgKind === 'price' ? 'Avg price (INR)' : 'Avg per bill (INR)';
  const metricLabel = METRICS.find((m) => m.key === r.query.cell)!.label;
  const columns = [
    dim,
    'Quantity',
    'Bills',
    'Sales (INR)',
    'Net sales (INR)',
    avgHeader,
    'Share of net %',
    ...(r.prevTotals && r.query.rows !== 'day' ? ['Net sales before (INR)', 'Change %'] : []),
    ...r.columns.map((c) => `${c.label} · ${metricLabel}`),
  ];
  const rows = r.rows.map((row) => [
    row.label,
    row.qty,
    row.orders,
    row.salesInr,
    row.netInr,
    row.avgInr,
    row.sharePct,
    ...(r.prevTotals && r.query.rows !== 'day' ? [row.prev?.netInr ?? 0, changePct(row.netInr, row.prev?.netInr ?? 0) ?? ''] : []),
    ...r.columns.map((c) => row.cells?.[c.key] ?? 0),
  ]);
  const t = r.totals;
  const totalRow = [
    r.rowCount > r.rows.length ? `TOTAL (all ${r.rowCount} rows)` : 'TOTAL',
    t.qty,
    t.orders,
    t.salesInr,
    t.netInr,
    r.avgKind === 'price' ? (t.qty > 0 ? round2(t.salesInr / t.qty) : 0) : t.avgBillInr,
    t.netInr > 0 ? 100 : 0,
    ...(r.prevTotals && r.query.rows !== 'day' ? [r.prevTotals.netInr, changePct(t.netInr, r.prevTotals.netInr) ?? ''] : []),
    ...r.columns.map(() => ''),
  ];
  return { columns, rows: [...rows, totalRow] };
}

