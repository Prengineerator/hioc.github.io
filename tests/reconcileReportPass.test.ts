import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { buildReport, type ReportInput, type SaleOrderRow } from '@/lib/reports/reconcile';
import { loadReport } from '@/lib/reports/reconcileServer';

// HIOC Ritual in the owner reconciliation report (docs/COFFEE-PASS-SPEC.md §7,
// CP-D21): revenue is counted when a pass is SOLD (a paid sale order is an
// ordinary order in every existing number and is also broken out as `passSales`),
// while what redeemed cups covered (orders.pass_discount_inr) is reported on its
// own as `passRedemptions` and is never folded into `discountInr`. Nothing about
// an order that used no pass may change.

const base = (over: Partial<ReportInput> = {}): ReportInput => ({
  from: '2026-10-05',
  to: '2026-10-06',
  orders: [],
  parts: [],
  paidOrders: [],
  ordersWithParts: new Set(),
  refunds: [],
  movements: [],
  cashDays: [],
  ...over,
});

const order = (o: Partial<SaleOrderRow> & { id: string }): SaleOrderRow => ({
  created_at: '2026-10-05T05:00:00Z', // 10:30 IST on the 5th
  status: 'completed',
  payment_status: 'paid',
  total_inr: 100,
  subtotal_inr: 100,
  tax_inr: 0,
  discount_inr: 0,
  ...o,
});

describe('buildReport — pass sales', () => {
  it('counts paid pass sales, by the day placed, inside gross sales as well', () => {
    const r = buildReport(
      base({
        orders: [
          order({ id: 's1', order_kind: 'coffee_pass', total_inr: 788, subtotal_inr: 750, tax_inr: 38 }),
          order({ id: 's2', order_kind: 'coffee_pass', total_inr: 945, subtotal_inr: 900, tax_inr: 45, created_at: '2026-10-05T18:40:00Z' }), // 00:10 IST on the 6th
          order({ id: 'm1', total_inr: 200, subtotal_inr: 200 }),
        ],
      }),
    );
    expect(r.days[0].passSales).toEqual({ count: 1, inr: 788 });
    expect(r.days[1].passSales).toEqual({ count: 1, inr: 945 });
    expect(r.totals.passSales).toEqual({ count: 2, inr: 1733 });
    // A pass sale is still an ordinary paid order in every existing number.
    expect(r.days[0]).toMatchObject({ orders: 2, grossSalesInr: 988, taxInr: 38 });
    expect(r.totals.grossSalesInr).toBe(788 + 945 + 200);
  });

  it('leaves out a sale that was never paid, was withdrawn, or was refunded', () => {
    const r = buildReport(
      base({
        orders: [
          order({ id: 'a', order_kind: 'coffee_pass', total_inr: 788, payment_status: 'unpaid', status: 'accepted' }),
          order({ id: 'b', order_kind: 'coffee_pass', total_inr: 788, payment_status: 'payment_pending', status: 'placed' }),
          order({ id: 'c', order_kind: 'coffee_pass', total_inr: 788, payment_status: 'unpaid', status: 'cancelled' }),
          order({ id: 'd', order_kind: 'coffee_pass', total_inr: 788, payment_status: 'refunded' }),
          order({ id: 'e', order_kind: 'coffee_pass', total_inr: 788 }),
        ],
      }),
    );
    expect(r.days[0].passSales).toEqual({ count: 1, inr: 788 });
    // The unpaid ones still show as unpaid money, exactly as any order would.
    expect(r.days[0].unpaidOrders).toBe(2);
  });

  it('a pass sale is never a redemption', () => {
    const r = buildReport(base({ orders: [order({ id: 's', order_kind: 'coffee_pass', total_inr: 788, pass_discount_inr: 0 })] }));
    expect(r.days[0].passRedemptions).toEqual({ drinks: 0, inr: 0 });
  });
});

describe('buildReport — pass redemptions', () => {
  // Spec example C: Latte ₹140 + Sandwich ₹180, a ₹18 coupon, ₹140 covered by one cup.
  const exampleC = order({
    id: 'c',
    subtotal_inr: 320,
    tax_inr: 9,
    discount_inr: 18,
    pass_discount_inr: 140,
    total_inr: 171,
  });

  it('reports the cups and the rupees covered, and keeps the cover OUT of discountInr', () => {
    const r = buildReport(
      base({
        orders: [exampleC, order({ id: 'b', subtotal_inr: 335, tax_inr: 3, pass_discount_inr: 270, total_inr: 68, created_at: '2026-10-05T18:40:00Z' })],
        passLines: [
          { order_id: 'c', pass_drinks: 1 },
          { order_id: 'b', pass_drinks: 1 },
          { order_id: 'b', pass_drinks: 1 },
        ],
      }),
    );
    expect(r.days[0].passRedemptions).toEqual({ drinks: 1, inr: 140 });
    expect(r.days[1].passRedemptions).toEqual({ drinks: 2, inr: 270 });
    expect(r.totals.passRedemptions).toEqual({ drinks: 3, inr: 410 });
    // discountInr is coupon + points only: a prepaid drink is not a marketing discount.
    expect(r.days[0].discountInr).toBe(18);
    expect(r.days[1].discountInr).toBe(0);
    expect(r.totals.discountInr).toBe(18);
  });

  it('leaves out cancelled and rejected orders and fully refunded ones (their cups went back to the pass)', () => {
    const r = buildReport(
      base({
        orders: [
          { ...exampleC, id: 'x1', status: 'cancelled' },
          { ...exampleC, id: 'x2', status: 'rejected' },
          { ...exampleC, id: 'x3', payment_status: 'refunded' },
          { ...exampleC, id: 'x4' },
        ],
        passLines: ['x1', 'x2', 'x3', 'x4'].map((order_id) => ({ order_id, pass_drinks: 1 })),
      }),
    );
    expect(r.days[0].passRedemptions).toEqual({ drinks: 1, inr: 140 });
  });

  it('a partial refund on a menu order does not return cups (CP-D14), so it still counts', () => {
    const r = buildReport(
      base({
        orders: [{ ...exampleC, payment_status: 'partially_refunded' }],
        passLines: [{ order_id: 'c', pass_drinks: 1 }],
      }),
    );
    expect(r.days[0].passRedemptions).toEqual({ drinks: 1, inr: 140 });
  });

  it('counts the rupees even when the cups per line are missing (an old database, or no passLines)', () => {
    const r = buildReport(base({ orders: [exampleC] }));
    expect(r.days[0].passRedemptions).toEqual({ drinks: 0, inr: 140 });
  });
});

describe('buildReport — orders without a pass are unchanged', () => {
  const plain: SaleOrderRow[] = [
    order({ id: 'a', total_inr: 300, subtotal_inr: 280, tax_inr: 20, settle_discount_inr: 10 }),
    order({ id: 'b', total_inr: 150, subtotal_inr: 150, payment_status: 'unpaid', status: 'ready' }),
    order({ id: 'c', total_inr: 999, subtotal_inr: 999, status: 'cancelled', payment_status: 'unpaid' }),
    order({ id: 'd', total_inr: 90, subtotal_inr: 100, discount_inr: 10 }),
  ];

  it('gives the same numbers as before, with zero pass rows', () => {
    const r = buildReport(base({ orders: plain }));
    expect(r.days[0]).toMatchObject({
      orders: 3,
      cancelled: 1,
      grossSalesInr: 540,
      taxInr: 20,
      discountInr: 10,
      settleDiscountInr: 10,
      netSalesInr: 530,
      unpaidOrders: 1,
      unpaidInr: 150,
      passSales: { count: 0, inr: 0 },
      passRedemptions: { drinks: 0, inr: 0 },
    });
    expect(r.totals).toMatchObject({
      grossSalesInr: 540,
      discountInr: 10,
      passSales: { count: 0, inr: 0 },
      passRedemptions: { drinks: 0, inr: 0 },
    });
  });

  it('is the same report whether the rows carry the pass columns as null, 0 or not at all', () => {
    const bare = buildReport(base({ orders: plain }));
    const nulls = buildReport(
      base({ orders: plain.map((o) => ({ ...o, order_kind: null, pass_discount_inr: null })) }),
    );
    const menu = buildReport(
      base({ orders: plain.map((o) => ({ ...o, order_kind: 'menu', pass_discount_inr: 0 })), passLines: [] }),
    );
    expect(nulls).toEqual(bare);
    expect(menu).toEqual(bare);
  });
});

// ── loadReport: what it asks the database for ─────────────────────────────

type Call = { table: string; cols: string; filters: string[] };

/** A fake admin for loadReport. With `preMigration`, a select naming a pass column fails like Postgres does. */
function fakeAdmin(opts: { preMigration: boolean; orders: Record<string, unknown>[]; passLines?: Record<string, unknown>[] }) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const call: Call = { table, cols: '', filters: [] };
      calls.push(call);
      const isSales = () => table === 'orders' && call.cols.includes('created_at');
      const result = (): { data: unknown[]; error: { code: string; message: string } | null } => {
        if (table === 'orders') {
          if (opts.preMigration && /order_kind|pass_discount_inr/.test(call.cols)) {
            return { data: [], error: { code: '42703', message: 'column orders.order_kind does not exist' } };
          }
          return { data: isSales() ? opts.orders : [], error: null };
        }
        if (table === 'order_items') return { data: opts.passLines ?? [], error: null };
        return { data: [], error: null };
      };
      const chain: Record<string, unknown> = {};
      const filter = (name: string) => (...args: unknown[]) => {
        call.filters.push(`${name}(${args.map((a) => JSON.stringify(a)).join(',')})`);
        return chain;
      };
      Object.assign(chain, {
        select: (cols: string) => {
          call.cols = cols;
          return chain;
        },
        gte: filter('gte'),
        lt: filter('lt'),
        lte: filter('lte'),
        eq: filter('eq'),
        gt: filter('gt'),
        in: filter('in'),
        order: filter('order'),
        range: () => Promise.resolve(result()),
        then: (resolve: (v: unknown) => void) => resolve(result()),
      });
      return chain;
    },
  };
  return { admin: admin as unknown as SupabaseClient, calls };
}

describe('loadReport', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const salesRows = [
    { id: 'c', created_at: '2026-10-05T05:00:00Z', status: 'completed', payment_status: 'paid', total_inr: 171, subtotal_inr: 320, tax_inr: 9, discount_inr: 18, settle_discount_inr: 0, order_kind: 'menu', pass_discount_inr: 140 },
    { id: 'p', created_at: '2026-10-05T06:00:00Z', status: 'completed', payment_status: 'paid', total_inr: 788, subtotal_inr: 750, tax_inr: 38, discount_inr: 0, settle_discount_inr: 0, order_kind: 'coffee_pass', pass_discount_inr: 0 },
    { id: 'm', created_at: '2026-10-05T07:00:00Z', status: 'completed', payment_status: 'paid', total_inr: 100, subtotal_inr: 100, tax_inr: 0, discount_inr: 0, settle_discount_inr: 0, order_kind: 'menu', pass_discount_inr: 0 },
  ];

  it('reads the pass columns, then asks for the cups only on the orders that used a pass, from lines not voided since', async () => {
    const { admin, calls } = fakeAdmin({ preMigration: false, orders: salesRows, passLines: [{ order_id: 'c', pass_drinks: 1 }] });
    const r = await loadReport(admin, '2026-10-05', '2026-10-05');

    const sales = calls.find((c) => c.table === 'orders' && c.cols.includes('created_at'));
    expect(sales?.cols).toContain('order_kind');
    expect(sales?.cols).toContain('pass_discount_inr');
    expect(sales?.cols).toContain('settle_discount_inr');

    const lines = calls.filter((c) => c.table === 'order_items');
    expect(lines).toHaveLength(1);
    expect(lines[0].cols).toBe('order_id, pass_drinks');
    expect(lines[0].filters).toContain('in("order_id",["c"])'); // only the order that used a pass
    expect(lines[0].filters).toContain('eq("voided",false)');
    expect(lines[0].filters).toContain('gt("pass_drinks",0)');

    expect(r.totals.passSales).toEqual({ count: 1, inr: 788 });
    expect(r.totals.passRedemptions).toEqual({ drinks: 1, inr: 140 });
    expect(r.totals.discountInr).toBe(18);
  });

  it('makes no order_items query when no order used a pass', async () => {
    const { admin, calls } = fakeAdmin({ preMigration: false, orders: salesRows.filter((o) => o.id === 'm') });
    await loadReport(admin, '2026-10-05', '2026-10-05');
    expect(calls.filter((c) => c.table === 'order_items')).toHaveLength(0);
  });

  it('on a database without the migration, falls back to the columns it has and reports zero pass rows', async () => {
    const legacyRows = salesRows
      .filter((o) => o.id === 'm')
      .map(({ order_kind: _k, pass_discount_inr: _p, ...rest }) => {
        void _k;
        void _p;
        return rest;
      });
    const { admin, calls } = fakeAdmin({ preMigration: true, orders: legacyRows });
    const r = await loadReport(admin, '2026-10-05', '2026-10-05');

    const salesAttempts = calls.filter((c) => c.table === 'orders' && c.cols.includes('created_at')).map((c) => c.cols);
    // Newest columns first, then the settle discount alone: the older report survives.
    expect(salesAttempts[0]).toContain('order_kind');
    expect(salesAttempts[1]).toContain('settle_discount_inr');
    expect(salesAttempts[1]).not.toContain('order_kind');
    expect(r.totals).toMatchObject({
      orders: 1,
      grossSalesInr: 100,
      passSales: { count: 0, inr: 0 },
      passRedemptions: { drinks: 0, inr: 0 },
    });
  });
});
