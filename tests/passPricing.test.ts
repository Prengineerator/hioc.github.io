import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { makeFakeAdmin, type Row } from './helpers/fakeAdmin';
import { computeBill, FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';
import type { ResolvedLine } from '@/lib/orders/lines';
import { afterPass, allocateOrderPass, composeOrderBill, passLinesFor } from '@/lib/orders/passPricing';
import { loadUsablePasses, loadUsablePassSummaries, toUsablePass } from '@/lib/passes/server';

// lib/orders/passPricing.ts: the one copy of "which cups pay for which lines"
// and "what is the bill once they have", shared by POST /api/orders and
// POST /api/orders/quote (docs/COFFEE-PASS-SPEC.md §6, CP-D11, CP-D12), plus the
// small server.ts addition it rests on (loadUsablePassSummaries / toUsablePass).

const settings: StoreSettings = {
  ...FALLBACK_STORE_SETTINGS,
  gst_percent: 5,
  gst_inclusive: false,
  packaging_charge_inr: 0,
};

describe('composeOrderBill — spec §6 examples A-D', () => {
  const bill = (over: Partial<Parameters<typeof composeOrderBill>[0]>) =>
    composeOrderBill({
      settings,
      subtotalInr: 0,
      taxableSubtotalInr: 0,
      couponDiscountInr: 0,
      pointsDiscountInr: 0,
      passCoveredInr: 0,
      passCoveredTaxableInr: 0,
      isDineIn: false,
      ...over,
    });

  it('A: one cup on a ₹120 drink is ₹0', () => {
    expect(bill({ subtotalInr: 120, taxableSubtotalInr: 120, passCoveredInr: 120, passCoveredTaxableInr: 120 })).toMatchObject({
      tax_inr: 0,
      discount_inr: 0,
      pass_discount_inr: 120,
      total_inr: 0,
    });
  });

  it('B: two cups on ₹335 cover ₹270, tax on ₹65: ₹68', () => {
    expect(bill({ subtotalInr: 335, taxableSubtotalInr: 335, passCoveredInr: 270, passCoveredTaxableInr: 270 })).toMatchObject({
      tax_inr: 3,
      pass_discount_inr: 270,
      total_inr: 68,
    });
  });

  it('C: a 10% coupon on the ₹180 left after the cup: ₹171', () => {
    expect(
      bill({ subtotalInr: 320, taxableSubtotalInr: 320, passCoveredInr: 140, passCoveredTaxableInr: 140, couponDiscountInr: 18 }),
    ).toMatchObject({ tax_inr: 9, discount_inr: 18, pass_discount_inr: 140, total_inr: 171 });
  });

  it('D: one cup of three Cappuccinos: ₹252', () => {
    expect(bill({ subtotalInr: 360, taxableSubtotalInr: 360, passCoveredInr: 120, passCoveredTaxableInr: 120 })).toMatchObject({
      tax_inr: 12,
      total_inr: 252,
    });
  });

  it('keeps the identity total = subtotal + tax + packaging - discount - pass cover', () => {
    const b = bill({
      settings: { ...settings, packaging_charge_inr: 20 },
      subtotalInr: 320,
      taxableSubtotalInr: 320,
      passCoveredInr: 140,
      passCoveredTaxableInr: 140,
      couponDiscountInr: 18,
      pointsDiscountInr: 30,
    });
    expect(b.total_inr).toBe(b.subtotal_inr + b.tax_inr + b.packaging_inr - b.discount_inr - b.pass_discount_inr);
  });

  it('clamps coupon + Beanies to what the pass leaves, so nothing can take the bill below zero', () => {
    const b = bill({
      subtotalInr: 320,
      taxableSubtotalInr: 320,
      passCoveredInr: 140,
      passCoveredTaxableInr: 140,
      couponDiscountInr: 500,
      pointsDiscountInr: 500,
    });
    expect(b.discount_inr).toBe(180);
    expect(b.total_inr).toBe(0 + b.tax_inr); // only the tax on the ₹180 taxable base remains
    expect(b.total_inr).toBeGreaterThanOrEqual(0);
  });

  it('takes GST-exempt cover out of nothing: only covered rupees on taxable lines leave the taxable base', () => {
    // A ₹140 exempt drink (covered) + a ₹200 taxable item.
    const b = bill({ subtotalInr: 340, taxableSubtotalInr: 200, passCoveredInr: 140, passCoveredTaxableInr: 0 });
    expect(b.tax_inr).toBe(10);
    expect(b.total_inr).toBe(340 + 10 - 140);
  });

  it('dine-in drops packaging from the total; takeaway keeps it', () => {
    const withPackaging = { ...settings, packaging_charge_inr: 20 };
    const args = { settings: withPackaging, subtotalInr: 140, taxableSubtotalInr: 140, passCoveredInr: 140, passCoveredTaxableInr: 140 };
    expect(bill({ ...args, isDineIn: true })).toMatchObject({ packaging_inr: 0, total_inr: 0 });
    expect(bill({ ...args, isDineIn: false })).toMatchObject({ packaging_inr: 20, total_inr: 20 });
  });

  it('with no pass it is exactly computeBill, whatever the settings (GST inclusive too)', () => {
    for (const s of [settings, { ...settings, gst_inclusive: true }, { ...settings, packaging_charge_inr: 15 }]) {
      for (const [subtotal, taxable, coupon, points] of [
        [320, 320, 0, 0],
        [320, 180, 18, 30],
        [100, 100, 500, 500],
        [0, 0, 0, 0],
      ]) {
        const discount = Math.min(coupon + points, subtotal);
        const expected = computeBill(subtotal, s, discount, taxable);
        const got = bill({
          settings: s,
          subtotalInr: subtotal,
          taxableSubtotalInr: taxable,
          couponDiscountInr: coupon,
          pointsDiscountInr: points,
        });
        expect(got).toEqual({ ...expected, pass_discount_inr: 0 });
      }
    }
  });
});

describe('afterPass', () => {
  it('is the subtotal less the cover, never below zero', () => {
    expect(afterPass(320, 140)).toBe(180);
    expect(afterPass(100, 100)).toBe(0);
    expect(afterPass(100, 400)).toBe(0);
    expect(afterPass(320, 0)).toBe(320);
  });
});

// ── the database half ─────────────────────────────────────────────────────

const NOW = new Date('2026-10-05T06:00:00Z');
const FUTURE = '2026-10-12T18:30:00.000Z';

function balance(over: Row = {}): Row {
  return {
    id: 'p1',
    user_id: 'u1',
    plan_id: 'plan-weekly',
    plan_name: 'Weekly Ritual',
    drinks_total: 7,
    drinks_used: 2,
    drinks_credited: 0,
    drinks_remaining: 5,
    drink_value_inr: 150,
    max_per_day: null,
    used_today: 0,
    price_inr: 750,
    starts_at: '2026-10-05T04:30:00.000Z',
    expires_at: FUTURE,
    status: 'active',
    state: 'active',
    order_id: 'order-1',
    created_at: '2026-10-05T04:30:00.000Z',
    ...over,
  };
}
const adminWith = (tables: Record<string, Row[]>) =>
  makeFakeAdmin(tables, { startMs: NOW.getTime() }) as unknown as SupabaseClient;

const line = (id: string, price: number, quantity = 1, gst_exempt = false): ResolvedLine => ({
  menu_item_id: id,
  variant_id: `${id}-v`,
  name_snapshot: id,
  variant_label_snapshot: 'L',
  price_inr_snapshot: price,
  quantity,
  line_total_inr: price * quantity,
  special_instructions: '',
  gst_exempt,
  addons: [],
});

describe('loadUsablePassSummaries / toUsablePass', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  const rows = () => [
    balance({ id: 'later', expires_at: '2026-10-30T18:30:00.000Z' }),
    balance({ id: 'sooner', expires_at: '2026-10-08T18:30:00.000Z', drinks_remaining: 1 }),
    balance({ id: 'used', state: 'used_up', drinks_remaining: 0 }),
    balance({ id: 'expired', state: 'expired' }),
    balance({ id: 'just-expired', expires_at: '2026-10-05T05:59:59.000Z' }), // the view still says active; `now` disagrees
    balance({ id: 'someone-elses', user_id: 'u2' }),
  ];

  it('returns the full summaries of the passes that can be spent now, soonest-expiring first', async () => {
    const list = await loadUsablePassSummaries(adminWith({ v_coffee_pass_balances: rows() }), 'u1', NOW);
    expect(list.map((p) => p.id)).toEqual(['sooner', 'later']);
    expect(list[0]).toMatchObject({ plan_name: 'Weekly Ritual', drinks_remaining: 1, order_id: 'order-1' });
    expect(list[0]).not.toHaveProperty('user_id');
  });

  it('loadUsablePasses is the same list in the allocator\'s shape', async () => {
    const admin = adminWith({ v_coffee_pass_balances: rows() });
    const summaries = await loadUsablePassSummaries(admin, 'u1', NOW);
    const usable = await loadUsablePasses(admin, 'u1', NOW);
    expect(usable).toEqual(summaries.map(toUsablePass));
    expect(usable[0]).toEqual({
      id: 'sooner',
      drinks_remaining: 1,
      drink_value_inr: 150,
      expires_at: '2026-10-08T18:30:00.000Z',
      max_per_day: null,
      used_today: 0,
    });
  });
});

describe('allocateOrderPass', () => {
  const menuTables = () => ({
    v_coffee_pass_balances: [balance()],
    menu_items: [
      { id: 'capp', pass_eligible: true },
      { id: 'lotus', pass_eligible: true },
      { id: 'sandwich', pass_eligible: false },
    ],
  });

  it('allocates the dearest eligible units first, names lines by the keys it was given, and lists the passes', async () => {
    const lines = [line('capp', 120), line('lotus', 215), line('sandwich', 180)];
    const r = await allocateOrderPass(adminWith(menuTables()), {
      userId: 'u1',
      lines,
      keys: ['k-capp', 'k-lotus', 'k-sandwich'],
      requested: 2,
      now: NOW,
    });
    expect(r.allocation).toMatchObject({ requested: 2, applied: 2, covered_inr: 270, covered_taxable_inr: 270, shortfall: null });
    expect(r.allocation.by_line).toEqual({
      'k-lotus': { drinks: 1, covered_inr: 150 },
      'k-capp': { drinks: 1, covered_inr: 120 },
    });
    expect(r.allocation.allocations.every((a) => a.pass_id === 'p1')).toBe(true);
    expect(r.passes.map((p) => p.id)).toEqual(['p1']);
    expect(r.maxUsable).toBe(2); // two eligible units in the cart
  });

  it('with 0 asked for it allocates nothing but still reports what could be used', async () => {
    const r = await allocateOrderPass(adminWith(menuTables()), {
      userId: 'u1',
      lines: [line('capp', 120, 3)],
      keys: ['k'],
      requested: 0,
      now: NOW,
    });
    expect(r.allocation).toMatchObject({ requested: 0, applied: 0, covered_inr: 0, eligible_units: 3, available: 5, shortfall: null });
    expect(r.maxUsable).toBe(3);
  });

  it("maxUsable is held down by a daily limit that `available` ignores", async () => {
    const tables = menuTables();
    tables.v_coffee_pass_balances = [balance({ max_per_day: 1, used_today: 0 })];
    const r = await allocateOrderPass(adminWith(tables), { userId: 'u1', lines: [line('capp', 120, 3)], keys: ['k'], requested: 0, now: NOW });
    expect(r.allocation.available).toBe(5);
    expect(r.maxUsable).toBe(1);
  });

  it('never allocates against another customer\'s pass', async () => {
    const r = await allocateOrderPass(adminWith(menuTables()), {
      userId: 'someone-else',
      lines: [line('capp', 120)],
      keys: ['k'],
      requested: 1,
      now: NOW,
    });
    expect(r.allocation).toMatchObject({ applied: 0, shortfall: 'no_pass' });
    expect(r.passes).toEqual([]);
  });

  it('fails closed: an unreadable eligibility table means nothing is eligible, never that everything is', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const admin = {
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        const rows = table === 'v_coffee_pass_balances' ? [balance()] : null;
        for (const m of ['select', 'eq', 'in', 'order', 'limit']) chain[m] = () => chain;
        chain.then = (resolve: (v: unknown) => void) =>
          resolve(rows ? { data: rows, error: null } : { data: null, error: { code: '42703', message: 'column pass_eligible does not exist' } });
        return chain;
      },
    } as unknown as SupabaseClient;
    const r = await allocateOrderPass(admin, { userId: 'u1', lines: [line('capp', 120)], keys: ['k'], requested: 1, now: NOW });
    expect(r.allocation).toMatchObject({ applied: 0, eligible_units: 0, shortfall: 'no_eligible_items' });
  });

  it('skips the eligibility query when there is no usable pass at all', async () => {
    const admin = adminWith({ v_coffee_pass_balances: [], menu_items: [{ id: 'capp', pass_eligible: true }] });
    const spy = vi.spyOn(admin, 'from' as never);
    await allocateOrderPass(admin, { userId: 'u1', lines: [line('capp', 120)], keys: ['k'], requested: 1, now: NOW });
    expect((spy.mock.calls as unknown as string[][]).map((c) => c[0])).toEqual(['v_coffee_pass_balances']);
  });
});

describe('passLinesFor', () => {
  it('maps resolved lines to what the allocator sees: unit price with add-ons, GST flag, eligibility', () => {
    const lines = passLinesFor(
      [line('capp', 135, 2), line('water', 20, 1, true)],
      ['a', 'b'],
      new Set(['capp']),
    );
    expect(lines).toEqual([
      { key: 'a', menu_item_id: 'capp', unit_price_inr: 135, quantity: 2, eligible: true, gst_exempt: false },
      { key: 'b', menu_item_id: 'water', unit_price_inr: 20, quantity: 1, eligible: false, gst_exempt: true },
    ]);
  });
});
