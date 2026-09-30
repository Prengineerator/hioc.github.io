import { beforeEach, describe, expect, it, vi } from 'vitest';

// HIOC Ritual on order corrections (docs/COFFEE-PASS-SPEC.md §6, §7):
// recomputeOrderTotals derives the pass cover from the lines that REMAIN, clamps
// the coupon/Beanies discount to what is left after it, and the amend route
// writes pass_discount_inr back only when it changed (so an order that never used
// a pass, and a database without 2026-10-coffee-pass.sql, are untouched).

import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';
import { recomputeOrderTotals } from '@/lib/orders/amend';

const state: {
  actor: { user: { id: string }; role: string; via: 'session' | 'device' } | null;
  current: Record<string, unknown> | null;
  updated: Record<string, unknown> | null;
  menuRows: Record<string, unknown>[];
  orderPatch?: Record<string, unknown>;
  itemUpdate?: Record<string, unknown>;
  selectArgs: string[];
  /** Every table an insert went to (order_items lines, order_amendments audit, status events). */
  inserts: string[];
} = { actor: null, current: null, updated: null, menuRows: [], selectArgs: [], inserts: [] };

vi.mock('@/lib/supabase-server', () => ({
  createServerSupabaseClient: () => ({}),
  createAdminSupabaseClient: () => ({
    from: (table: string) => {
      const ctx = { isUpdate: false, isInsert: false };
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        select: (cols: string) => {
          if (table === 'orders') state.selectArgs.push(cols);
          return chain;
        },
        update: (p: Record<string, unknown>) => {
          ctx.isUpdate = true;
          if (table === 'orders') state.orderPatch = p;
          if (table === 'order_items') state.itemUpdate = p;
          return chain;
        },
        insert: () => {
          ctx.isInsert = true;
          state.inserts.push(table);
          return table === 'order_items' ? chain : Promise.resolve({ error: null });
        },
        eq: () => chain,
        in: () =>
          table === 'menu_items'
            ? Promise.resolve({ data: state.menuRows, error: null })
            : Promise.resolve({ data: null, error: null }),
        maybeSingle: () =>
          Promise.resolve(ctx.isUpdate ? { data: state.updated, error: null } : { data: state.current, error: null }),
        single: () =>
          Promise.resolve(
            ctx.isInsert
              ? { data: { id: 'new-item-1' }, error: null }
              : { data: { ...(state.current ?? {}), order_items: [] }, error: null },
          ),
        then: (resolve: (v: unknown) => void) => resolve({ data: null, error: null }),
      });
      return chain;
    },
  }),
}));
vi.mock('@/lib/api/auth', () => ({
  getCounterActor: () => Promise.resolve(state.actor),
  actorRoleFor: () => 'staff',
}));
vi.mock('@/lib/permissions', () => ({ hasPermission: () => Promise.resolve(true) }));
vi.mock('@/lib/staff/surface', () => ({ getStaffSurface: () => Promise.resolve('pos') }));
vi.mock('@/lib/store/settings', () => ({
  getStoreSettings: () => Promise.resolve({ gst_percent: 5, gst_inclusive: false, packaging_charge_inr: 20 }),
}));
vi.mock('@/lib/realtime/broadcast', () => ({ broadcastOrderEvent: () => Promise.resolve() }));

const { POST } = await import('@/app/api/orders/[id]/amend/route');

const ORDER_ID = '44444444-4444-4444-8444-444444444444';
const LATTE_LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'; // Latte L ₹140, one cup of the pass on it
const SANDWICH_LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'; // Sandwich ₹180, paid in full
const params = { params: { id: ORDER_ID } };
const req = (body: unknown) =>
  new Request(`http://t/api/orders/${ORDER_ID}/amend`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

// ---------------------------------------------------------------------------
// 1. Pure recompute (no mocks)
// ---------------------------------------------------------------------------
describe('recomputeOrderTotals with HIOC Ritual cover', () => {
  const settings: StoreSettings = { ...FALLBACK_STORE_SETTINGS, gst_percent: 5, packaging_charge_inr: 0, gst_inclusive: false };

  // Spec example C's order: Latte ₹140 (covered) + Sandwich ₹180, 18 off by a coupon.
  const exampleC = [
    { voided: false, line_total_inr: 140, pass_covered_inr: 140 },
    { voided: false, line_total_inr: 180 },
  ];

  it('reproduces the create-path bill for a covered order (spec example C: ₹171)', () => {
    const bill = recomputeOrderTotals({ items: exampleC, settings, orderType: 'takeaway', discountInr: 18 });
    expect(bill).toMatchObject({
      subtotal_inr: 320,
      tax_inr: 9,
      discount_inr: 18,
      pass_discount_inr: 140,
      total_inr: 171,
    });
  });

  it('voiding the covered line takes its cover with it', () => {
    const items = [{ ...exampleC[0], voided: true }, exampleC[1]];
    const bill = recomputeOrderTotals({ items, settings, orderType: 'takeaway', discountInr: 18 });
    expect(bill).toMatchObject({ subtotal_inr: 180, pass_discount_inr: 0, tax_inr: 9, discount_inr: 18, total_inr: 171 });
  });

  it("voiding the OTHER line keeps the cover and clamps the discount to what is left after it", () => {
    const items = [exampleC[0], { ...exampleC[1], voided: true }];
    const bill = recomputeOrderTotals({ items, settings, orderType: 'takeaway', discountInr: 18 });
    // Subtotal 140, all of it covered: nothing left for the coupon to take.
    expect(bill).toMatchObject({ subtotal_inr: 140, pass_discount_inr: 140, discount_inr: 0, tax_inr: 0, total_inr: 0 });
  });

  it('never lets coupon + cover exceed the subtotal, and the total never goes negative', () => {
    for (const discountInr of [0, 30, 500, 100000]) {
      const bill = recomputeOrderTotals({ items: exampleC, settings, orderType: 'dine_in', discountInr });
      expect(bill.discount_inr).toBe(Math.min(discountInr, 320 - 140));
      expect(bill.discount_inr + bill.pass_discount_inr).toBeLessThanOrEqual(bill.subtotal_inr);
      expect(bill.total_inr).toBeGreaterThanOrEqual(0);
    }
  });

  it('takes cover on a GST-exempt line out of neither the taxable base nor the tax', () => {
    const items = [
      { voided: false, line_total_inr: 140, pass_covered_inr: 140, gst_exempt: true },
      { voided: false, line_total_inr: 200 },
    ];
    const bill = recomputeOrderTotals({ items, settings, orderType: 'takeaway', discountInr: 0 });
    // Taxable base is the ₹200 line alone (the exempt cover was never in it).
    expect(bill).toMatchObject({ subtotal_inr: 340, tax_inr: 10, pass_discount_inr: 140, total_inr: 340 + 10 - 140 });
  });

  it('a covered line whose cover exceeds its total (a bad row) cannot push the bill below zero', () => {
    const bill = recomputeOrderTotals({
      items: [{ voided: false, line_total_inr: 100, pass_covered_inr: 400 }],
      settings,
      orderType: 'takeaway',
      discountInr: 0,
    });
    expect(bill.pass_discount_inr).toBe(100);
    expect(bill.total_inr).toBe(0);
  });

  it('is the recompute it always was for orders with no cover (byte-for-byte)', () => {
    const items = [
      { voided: false, line_total_inr: 200 },
      { voided: true, line_total_inr: 99 },
      { voided: false, line_total_inr: 100, gst_exempt: true },
    ];
    const withPackaging: StoreSettings = { ...settings, packaging_charge_inr: 20 };
    const bill = recomputeOrderTotals({ items, settings: withPackaging, orderType: 'takeaway', discountInr: 50 });
    expect(bill).toEqual({
      subtotal_inr: 300,
      tax_inr: 10,
      packaging_inr: 20,
      discount_inr: 50,
      total_inr: 300 + 10 + 20 - 50,
      pass_discount_inr: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The routes
// ---------------------------------------------------------------------------
describe('POST /api/orders/[id]/amend with HIOC Ritual cover', () => {
  beforeEach(() => {
    state.actor = { user: { id: 'mgr-1' }, role: 'manager', via: 'session' };
    state.updated = { id: ORDER_ID };
    state.orderPatch = undefined;
    state.itemUpdate = undefined;
    state.selectArgs = [];
    state.inserts = [];
    state.menuRows = [];
    // Example C's order: takeaway, ₹18 coupon, ₹140 covered by the pass.
    state.current = {
      id: ORDER_ID,
      status: 'accepted',
      version: 3,
      order_type: 'takeaway',
      payment_status: 'unpaid',
      discount_inr: 18,
      pass_discount_inr: 140,
      order_items: [
        { id: LATTE_LINE, voided: false, line_total_inr: 140, pass_drinks: 1, pass_covered_inr: 140 },
        { id: SANDWICH_LINE, voided: false, line_total_inr: 180, pass_drinks: 0, pass_covered_inr: 0 },
      ],
    };
  });

  it('voiding the covered line recomputes the bill and writes the smaller pass_discount_inr back', async () => {
    const res = await POST(req({ item_id: LATTE_LINE, reason: 'customer changed their mind' }), params);
    expect(res.status).toBe(200);
    expect(state.itemUpdate?.voided).toBe(true);
    // Sandwich ₹180 + 5% GST + ₹20 packaging, less the ₹18 coupon, and no cover any more.
    expect(state.orderPatch).toMatchObject({
      subtotal_inr: 180,
      tax_inr: 9,
      packaging_inr: 20,
      discount_inr: 18,
      pass_discount_inr: 0,
      total_inr: 180 + 9 + 20 - 18,
      version: 4,
    });
  });

  it('voiding an uncovered line keeps the cover, and does not rewrite pass_discount_inr (unchanged)', async () => {
    const res = await POST(req({ item_id: SANDWICH_LINE, reason: 'wrong item' }), params);
    expect(res.status).toBe(200);
    // Latte ₹140 fully covered: nothing left to pay but packaging; the coupon has nothing to bite on.
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 140, discount_inr: 0, total_inr: 20, tax_inr: 0 });
    expect(state.orderPatch).not.toHaveProperty('pass_discount_inr');
  });

  it('reads the order and its lines with `*`, so a database without the pass columns still answers', async () => {
    await POST(req({ item_id: SANDWICH_LINE, reason: 'wrong item' }), params);
    expect(state.selectArgs[0]).toBe('*, order_items(*)');
  });

  it('an order that never used a pass (no pass columns at all) is amended exactly as before: no pass column is sent', async () => {
    state.current = {
      id: ORDER_ID,
      status: 'accepted',
      version: 3,
      order_type: 'takeaway',
      payment_status: 'unpaid',
      discount_inr: 0,
      // No pass_discount_inr on the order, no pass_covered_inr on the lines: the
      // shape a database that has not had 2026-10-coffee-pass.sql returns.
      order_items: [
        { id: LATTE_LINE, voided: false, line_total_inr: 140 },
        { id: SANDWICH_LINE, voided: false, line_total_inr: 180 },
      ],
    };
    const res = await POST(req({ item_id: LATTE_LINE, reason: 'wrong item' }), params);
    expect(res.status).toBe(200);
    expect(state.orderPatch).toMatchObject({ subtotal_inr: 180, tax_inr: 9, total_inr: 209 });
    expect(state.orderPatch).not.toHaveProperty('pass_discount_inr');
  });

  it('adding a line to a tab keeps the existing cover and adds the new line uncovered', async () => {
    const LATTE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const LATTE_VARIANT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    state.menuRows = [
      {
        id: LATTE,
        name: 'Latte',
        category: 'coffee',
        is_available: true,
        unavailable_until: null,
        menu_item_variants: [{ id: LATTE_VARIANT, label: 'Regular', price_inr: 150, sort_order: 0 }],
        menu_item_addon_groups: [],
      },
    ];
    const res = await POST(
      req({ op: 'add', items: [{ menu_item_id: LATTE, variant_id: LATTE_VARIANT, quantity: 1 }] }),
      params,
    );
    expect(res.status).toBe(200);
    // 140 + 180 + 150 = 470; the cover stays 140; coupon 18 stays; GST on 470 - 140.
    expect(state.orderPatch).toMatchObject({
      subtotal_inr: 470,
      tax_inr: 17, // 5% of 330 = 16.5, rounded
      discount_inr: 18,
      total_inr: 470 + 17 + 20 - 18 - 140,
    });
    expect(state.orderPatch).not.toHaveProperty('pass_discount_inr'); // unchanged, so not rewritten
  });
});

// ---------------------------------------------------------------------------
// 3. The SALE of a HIOC Ritual can't be amended (docs/COFFEE-PASS-SPEC.md CP-D6):
//    one line, one price, issued as a pass when paid. Both paths refuse it (409),
//    before any write.
// ---------------------------------------------------------------------------
describe('POST /api/orders/[id]/amend on a HIOC Ritual sale', () => {
  const PLAN_LINE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
  const REFUSAL = "A HIOC Ritual sale can't be changed — cancel it instead.";
  const LATTE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const LATTE_VARIANT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

  // The shape POST /api/passes/sell makes: takeaway, accepted, unpaid, ONE line.
  const passSale = (over: Record<string, unknown> = {}) => ({
    id: ORDER_ID,
    order_kind: 'coffee_pass',
    status: 'accepted',
    version: 1,
    order_type: 'takeaway',
    payment_status: 'unpaid',
    discount_inr: 0,
    order_items: [{ id: PLAN_LINE, voided: false, line_total_inr: 750, coffee_pass_plan_id: 'plan-1' }],
    ...over,
  });

  const addLatte = () =>
    POST(req({ op: 'add', items: [{ menu_item_id: LATTE, variant_id: LATTE_VARIANT, quantity: 1 }] }), params);

  beforeEach(() => {
    state.actor = { user: { id: 'mgr-1' }, role: 'manager', via: 'session' };
    state.updated = { id: ORDER_ID };
    state.orderPatch = undefined;
    state.itemUpdate = undefined;
    state.selectArgs = [];
    state.inserts = [];
    state.menuRows = [
      {
        id: LATTE,
        name: 'Latte',
        category: 'coffee',
        is_available: true,
        unavailable_until: null,
        menu_item_variants: [{ id: LATTE_VARIANT, label: 'Regular', price_inr: 150, sort_order: 0 }],
        menu_item_addon_groups: [],
      },
    ];
    state.current = passSale();
  });

  const wroteNothing = () => {
    expect(state.orderPatch).toBeUndefined();
    expect(state.itemUpdate).toBeUndefined();
    expect(state.inserts).toEqual([]);
  };

  it('refuses a void with a 409 that says why (not the "would empty the order" of its one line)', async () => {
    const res = await POST(req({ item_id: PLAN_LINE, reason: 'wrong plan' }), params);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(REFUSAL);
    wroteNothing();
  });

  it('refuses adding a line with the same 409', async () => {
    const res = await addLatte();
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(REFUSAL);
    wroteNothing();
  });

  it.each([
    ['still open, unpaid', {}],
    ['already paid (issued, completed)', { payment_status: 'paid', status: 'completed' }],
    ['placed, waiting on the gateway', { payment_status: 'payment_pending', status: 'placed' }],
    ['cancelled', { status: 'cancelled' }],
  ])('refuses both paths whatever the sale is up to: %s', async (_label, over) => {
    state.current = passSale(over);
    for (const res of [await POST(req({ item_id: PLAN_LINE, reason: 'wrong plan' }), params), await addLatte()]) {
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe(REFUSAL);
    }
    wroteNothing();
  });

  it('even a sale that (wrongly) has two lines is refused, so the guard is the kind, not the line count', async () => {
    state.current = passSale({
      order_items: [
        { id: PLAN_LINE, voided: false, line_total_inr: 750 },
        { id: SANDWICH_LINE, voided: false, line_total_inr: 180 },
      ],
    });
    const res = await POST(req({ item_id: SANDWICH_LINE, reason: 'wrong item' }), params);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(REFUSAL);
    wroteNothing();
  });

  it('a menu order is amended as before (void and add), and so is one from before the migration (no order_kind)', async () => {
    for (const kind of ['menu', undefined]) {
      state.orderPatch = undefined;
      state.itemUpdate = undefined;
      state.current = {
        id: ORDER_ID,
        order_kind: kind,
        status: 'accepted',
        version: 3,
        order_type: 'takeaway',
        payment_status: 'unpaid',
        discount_inr: 0,
        order_items: [
          { id: LATTE_LINE, voided: false, line_total_inr: 140 },
          { id: SANDWICH_LINE, voided: false, line_total_inr: 180 },
        ],
      };
      const voided = await POST(req({ item_id: LATTE_LINE, reason: 'wrong item' }), params);
      expect(voided.status).toBe(200);
      expect((state.itemUpdate as Record<string, unknown> | undefined)?.voided).toBe(true);
      const added = await addLatte();
      expect(added.status).toBe(200);
    }
  });
});
