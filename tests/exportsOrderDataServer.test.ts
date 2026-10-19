import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { loadOrderDataset } from '@/lib/reports/exports/orderDataServer';

// A minimal PostgREST stand-in: per-table rows, `in` / `eq` / `gte` / `lt` applied
// (`or` is not), and per-table errors so the optional-column / optional-table
// fallbacks can be exercised.

type Row = Record<string, unknown>;
type Err = { code?: string; message?: string };

interface FakeTable {
  rows: Row[];
  /** Return an error for this select, or null to answer it. */
  fail?: (cols: string) => Err | null;
}

function fakeAdmin(tables: Record<string, FakeTable>, opts: { settingsError?: Err } = {}) {
  const log: { table: string; cols: string }[] = [];

  const from = (name: string) => {
    const t = tables[name];
    let cols = '';
    const filters: ((r: Row) => boolean)[] = [];
    const run = () => {
      if (!t) return { data: null, error: { code: '42P01', message: `relation "${name}" does not exist` } };
      const error = t.fail?.(cols) ?? null;
      if (error) return { data: null, error };
      return { data: t.rows.filter((r) => filters.every((f) => f(r))), error: null };
    };
    const b: Record<string, unknown> = {
      select(c: string) {
        cols = c;
        log.push({ table: name, cols: c });
        return b;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return b;
      },
      eq(col: string, v: unknown) {
        filters.push((r) => r[col] === v);
        return b;
      },
      gte(col: string, v: string) {
        filters.push((r) => String(r[col]) >= v);
        return b;
      },
      lt(col: string, v: string) {
        filters.push((r) => String(r[col]) < v);
        return b;
      },
      or: () => b,
      order: () => b,
      range(a: number, c: number) {
        const res = run();
        return Promise.resolve(res.data ? { data: res.data.slice(a, c + 1), error: null } : res);
      },
      maybeSingle() {
        if (name === 'store_settings' && opts.settingsError) {
          return Promise.resolve({ data: null, error: opts.settingsError });
        }
        const res = run();
        return Promise.resolve(res.data ? { data: res.data[0] ?? null, error: null } : res);
      },
    };
    return b;
  };

  const admin = {
    from,
    auth: { admin: { listUsers: async () => ({ data: { users: [{ id: 'u1', email: 'asha.rao@hioc.in' }] }, error: null }) } },
  } as unknown as SupabaseClient;
  return { admin, log };
}

const column = (log: { table: string; cols: string }[], table: string) => log.filter((l) => l.table === table).map((l) => l.cols);

const ORDERS: Row[] = [
  {
    id: 'a',
    order_number: 1001,
    created_at: '2026-09-10T06:30:00Z',
    status: 'completed',
    payment_status: 'paid',
    payment_method: 'cash',
    channel: 'staff_pos',
    order_type: 'dine_in',
    table_label: '',
    reject_reason: '',
    created_by: 'u1',
    subtotal_inr: 200,
    tax_inr: 10,
    packaging_inr: 0,
    discount_inr: 30,
    total_inr: 180,
  },
  // Outside the range: only reachable through a refund.
  { id: 'old', order_number: 990, created_at: '2026-08-20T06:30:00Z', status: 'completed', payment_status: 'refunded' },
];

const ITEMS: Row[] = [
  { id: 'i1', order_id: 'a', menu_item_id: 'm1', name_snapshot: 'Latte', variant_label_snapshot: '', quantity: 1, line_total_inr: 200 },
];

const SETTINGS: Row[] = [{ is_singleton: true, gst_percent: 12, gst_inclusive: true }];

function fullTables(): Record<string, FakeTable> {
  return {
    orders: { rows: ORDERS },
    order_items: { rows: ITEMS },
    menu_items: { rows: [{ id: 'm1', category: 'Coffee', sold_by_weight: false }] },
    order_payments: { rows: [{ id: 'p1', order_id: 'a', method: 'upi', created_at: '2026-09-10T06:31:00Z' }] },
    coupon_redemptions: { rows: [{ id: 'c1', order_id: 'a', coupon_id: 'k1', discount_inr: 20 }] },
    coupons: { rows: [{ id: 'k1', code: 'WELCOME' }] },
    refunds: {
      rows: [
        { id: 'r1', order_id: 'a', amount_inr: 15, method: 'cash', reason: 'spill', status: 'processed', processed_at: '2026-09-11T05:00:00Z', created_by: 'u1', created_at: '2026-09-11T04:50:00Z' },
        { id: 'r2', order_id: 'old', amount_inr: 50, method: 'upi', reason: '', status: 'processed', processed_at: '2026-09-12T05:00:00Z', created_by: null, created_at: '2026-09-12T04:50:00Z' },
      ],
    },
    profiles: { rows: [{ id: 'u1', name: '' }] },
    store_settings: { rows: SETTINGS },
  };
}

describe('loadOrderDataset', () => {
  it('assembles orders, lines, parts, coupons, refunds, staff names and the GST settings', async () => {
    const { admin } = fakeAdmin(fullTables());
    const ds = await loadOrderDataset(admin, '2026-09-01', '2026-09-30');

    expect(ds).toMatchObject({ from: '2026-09-01', to: '2026-09-30', gstRatePercent: 12, gstInclusive: true });
    expect(ds.orders).toHaveLength(1);
    const o = ds.orders[0];
    expect(o).toMatchObject({
      invoiceNo: 'HIOC-001001',
      createdByName: 'Asha Rao',
      paymentMethods: ['upi'],
      couponCodes: ['WELCOME'],
      couponDiscountInr: 20,
      beaniesDiscountInr: 10,
      refundedInr: 15,
    });
    expect(o.lines).toHaveLength(1);
    expect(o.lines[0].category).toBe('Coffee');
    // The refund on an August bill carries that bill's invoice number and date.
    expect(ds.refunds.map((r) => [r.id, r.invoiceNo, r.orderDate])).toEqual([
      ['r1', 'HIOC-001001', '2026-09-10'],
      ['r2', 'HIOC-000990', '2026-08-20'],
    ]);
  });

  it('falls back a migration at a time when optional columns are missing', async () => {
    const missing = (re: RegExp) => (cols: string): Err | null =>
      re.test(cols) ? { code: '42703', message: 'column does not exist' } : null;
    const tables = fullTables();
    tables.orders.fail = missing(/settle_discount_inr/);
    tables.order_items.fail = missing(/gst_exempt|pass_drinks|weight_grams/);
    tables.menu_items.fail = missing(/sold_by_weight/);
    tables.refunds.fail = missing(/\bmethod\b/);
    const { admin, log } = fakeAdmin(tables);

    const ds = await loadOrderDataset(admin, '2026-09-01', '2026-09-30');
    expect(ds.orders).toHaveLength(1);
    expect(ds.orders[0].lines[0].gstExempt).toBe(false);
    expect(column(log, 'orders').some((c) => !c.includes('settle_discount_inr'))).toBe(true);
    expect(column(log, 'order_items').some((c) => c.endsWith('voided, void_reason'))).toBe(true);
    expect(column(log, 'menu_items').at(-1)).toBe('id, category');
    expect(column(log, 'refunds').some((c) => !/\bmethod\b/.test(c))).toBe(true);
    expect(ds.refunds).toHaveLength(2);
  });

  it('treats missing optional tables as empty', async () => {
    const tables = fullTables();
    delete tables.order_payments;
    delete tables.coupon_redemptions;
    delete tables.coupons;
    delete tables.refunds;
    const { admin } = fakeAdmin(tables);

    const ds = await loadOrderDataset(admin, '2026-09-01', '2026-09-30');
    expect(ds.orders[0]).toMatchObject({ paymentMethods: ['cash'], couponCodes: [], refundedInr: 0, beaniesDiscountInr: 30 });
    expect(ds.refunds).toEqual([]);
  });

  it('uses the default rate when there is no settings row', async () => {
    const tables = fullTables();
    tables.store_settings.rows = [];
    const { admin } = fakeAdmin(tables);
    const ds = await loadOrderDataset(admin, '2026-09-01', '2026-09-30');
    expect(ds).toMatchObject({ gstRatePercent: 5, gstInclusive: false });
  });

  it('throws on a real error rather than reporting a short sheet', async () => {
    const tables = fullTables();
    tables.order_items.fail = () => ({ code: '57014', message: 'canceling statement due to statement timeout' });
    await expect(loadOrderDataset(fakeAdmin(tables).admin, '2026-09-01', '2026-09-30')).rejects.toThrow(/statement timeout/);

    await expect(
      loadOrderDataset(fakeAdmin(fullTables(), { settingsError: { code: '500', message: 'boom' } }).admin, '2026-09-01', '2026-09-30'),
    ).rejects.toThrow(/store_settings/);
  });
});
