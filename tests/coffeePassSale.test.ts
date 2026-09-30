import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  buildPassSaleRows,
  createPassSaleOrder,
  passLineLabel,
  passSaleBill,
  passSaleTerms,
  resolveRitualCup,
  ritualDrinkLabel,
  ritualLineName,
  ritualPriceFor,
  RITUAL_NOT_ELIGIBLE_MESSAGE,
  toPassSaleSummaries,
  type PassSaleInput,
  type RitualCup,
} from '@/lib/passes/sale';
import { FALLBACK_STORE_SETTINGS } from '@/lib/store/hours';
import type { CoffeePassPlan } from '@/lib/passes/types';
import type { StoreSettings } from '@/lib/types';
import { makePassAdmin, type Row } from './helpers/passAdmin';

// lib/passes/sale.ts: the one place a HIOC Ritual sale order is built, for both
// the website (checkout) and the counter (sell). Three layers:
//  1. the pure part (price, fields, bill, labels, terms) with no database;
//  2. resolveRitualCup against the in-memory fake: the chosen drink is priced from
//     the live menu by the order rules;
//  3. createPassSaleOrder against the fake: what it inserts, and that a failed
//     line takes the order back out.
//
// Per-drink pricing (spec §13): a plan has no price. The Ritual costs drinks_paid
// × the chosen size's menu price, and each cup covers that same price.

const PLAN: CoffeePassPlan = {
  id: '00000000-0000-4000-8000-0000000000a1',
  name: 'Weekly Ritual',
  description: '7 cups for the price of 5',
  drinks_total: 7,
  drinks_paid: 5,
  validity_days: 7,
  drink_value_inr: null,
  price_inr: null,
  max_per_day: null,
  gst_exempt: false,
  is_active: true,
  sort_order: 10,
};
const MONTHLY: CoffeePassPlan = {
  ...PLAN,
  id: '00000000-0000-4000-8000-0000000000a2',
  name: 'Monthly Ritual',
  drinks_paid: 6,
  validity_days: 30,
  sort_order: 20,
};
const ACCOUNT = '00000000-0000-4000-8000-0000000000c1';
const STAFF = '00000000-0000-4000-8000-0000000000d1';

const CAPPUCCINO = '00000000-0000-4000-8000-0000000000e1';
const LATTE = '00000000-0000-4000-8000-0000000000e2';
/** Cappuccino, Large, ₹120 (the spec's example). */
const CAPPUCCINO_L: RitualCup = {
  menu_item_id: CAPPUCCINO,
  variant_id: '00000000-0000-4000-8000-0000000000f1',
  name: 'Cappuccino',
  size_label: 'Large',
  price_inr: 120,
};
/** Latte, Large, ₹140. */
const LATTE_L: RitualCup = {
  menu_item_id: LATTE,
  variant_id: '00000000-0000-4000-8000-0000000000f2',
  name: 'Latte',
  size_label: 'Large',
  price_inr: 140,
};

const settings = (over: Partial<StoreSettings> = {}): StoreSettings => ({ ...FALLBACK_STORE_SETTINGS, ...over });

function counterSale(over: Partial<PassSaleInput> = {}): PassSaleInput {
  return {
    plan: PLAN,
    cup: CAPPUCCINO_L,
    channel: 'staff_pos',
    status: 'accepted',
    paymentStatus: 'unpaid',
    paymentMethod: null,
    customerName: 'Asha',
    customerPhone: '+919876543210',
    userId: null,
    customerUserId: ACCOUNT,
    createdBy: STAFF,
    settings: settings(),
    ...over,
  };
}

describe('ritualPriceFor (CP-D22)', () => {
  it('is the cups paid for × the size price: Weekly 5 ×, Monthly 6 ×', () => {
    expect(ritualPriceFor(PLAN, 120)).toBe(600);
    expect(ritualPriceFor(MONTHLY, 140)).toBe(840);
    expect(ritualPriceFor(PLAN, 215)).toBe(1075);
  });

  it('is integer rupees, always', () => {
    for (const cup of [1, 49, 99, 120, 215]) {
      expect(Number.isInteger(ritualPriceFor(PLAN, cup))).toBe(true);
      expect(Number.isInteger(ritualPriceFor(MONTHLY, cup))).toBe(true);
    }
  });
});

describe('ritualDrinkLabel / ritualLineName', () => {
  it('are re-exported from the sale module (one place to read them)', () => {
    expect(ritualDrinkLabel(CAPPUCCINO_L)).toBe('Cappuccino · Large');
    expect(ritualLineName(PLAN, CAPPUCCINO_L)).toBe('Weekly Ritual — Cappuccino (Large)');
    expect(ritualLineName(MONTHLY, LATTE_L)).toBe('Monthly Ritual — Latte (Large)');
  });
});

describe('passSaleTerms', () => {
  it('reads the things a pass is issued with: the recipe from the plan, the cup value and the drink from the cup', () => {
    expect(passSaleTerms(PLAN, CAPPUCCINO_L)).toEqual({
      plan_name: 'Weekly Ritual',
      drinks_total: 7,
      drink_value_inr: 120, // the chosen size's menu price, not anything on the plan
      validity_days: 7,
      max_per_day: null,
      drink_menu_item_id: CAPPUCCINO,
      drink_label: 'Cappuccino · Large',
    });
  });

  it('the cup value follows the chosen size, plan for plan', () => {
    expect(passSaleTerms(MONTHLY, LATTE_L)).toMatchObject({ plan_name: 'Monthly Ritual', validity_days: 30, drink_value_inr: 140, drink_label: 'Latte · Large' });
    expect(passSaleTerms(PLAN, { ...CAPPUCCINO_L, size_label: 'Small', price_inr: 90 })).toMatchObject({ drink_value_inr: 90, drink_label: 'Cappuccino · Small' });
  });

  it('a size with no name gives just the drink as its label', () => {
    expect(passSaleTerms(PLAN, { ...CAPPUCCINO_L, size_label: '' }).drink_label).toBe('Cappuccino');
  });
});

describe('passLineLabel', () => {
  it('reads "7 cups · 7 days" and uses the singular where it should', () => {
    expect(passLineLabel(PLAN)).toBe('7 cups · 7 days');
    expect(passLineLabel({ drinks_total: 1, validity_days: 1 })).toBe('1 cup · 1 day');
    expect(passLineLabel({ drinks_total: 7, validity_days: 30 })).toBe('7 cups · 30 days');
  });
});

describe('passSaleBill', () => {
  const weekly = { price_inr: ritualPriceFor(PLAN, 120), gst_exempt: false }; // ₹600

  it('charges GST on top of the price when the store is GST-exclusive (spec §13: ₹600 -> ₹630)', () => {
    expect(passSaleBill(weekly, settings({ gst_percent: 5, gst_inclusive: false }))).toMatchObject({
      subtotal_inr: 600,
      tax_inr: 30,
      packaging_inr: 0,
      discount_inr: 0,
      total_inr: 630,
    });
  });

  it('Monthly Latte Large: ₹840 + ₹42 GST = ₹882', () => {
    const monthly = { price_inr: ritualPriceFor(MONTHLY, 140), gst_exempt: false };
    expect(passSaleBill(monthly, settings({ gst_percent: 5, gst_inclusive: false }))).toMatchObject({
      subtotal_inr: 840,
      tax_inr: 42,
      total_inr: 882,
    });
  });

  it('extracts GST from the price when the store is GST-inclusive (₹600 stays ₹600, ₹29 of it GST)', () => {
    expect(passSaleBill(weekly, settings({ gst_percent: 5, gst_inclusive: true }))).toMatchObject({
      subtotal_inr: 600,
      tax_inr: 29, // 600 × 5 / 105 = 28.57
      total_inr: 600,
    });
  });

  it('charges no GST on a GST-exempt plan, either way', () => {
    const exempt = { ...weekly, gst_exempt: true };
    expect(passSaleBill(exempt, settings({ gst_inclusive: false }))).toMatchObject({ tax_inr: 0, total_inr: 600 });
    expect(passSaleBill(exempt, settings({ gst_inclusive: true }))).toMatchObject({ tax_inr: 0, total_inr: 600 });
  });

  it("never adds the store's packaging charge: there is nothing to pack", () => {
    const bill = passSaleBill(weekly, settings({ packaging_charge_inr: 10, gst_percent: 5, gst_inclusive: false }));
    expect(bill.packaging_inr).toBe(0);
    expect(bill.total_inr).toBe(630);
  });
});

describe('buildPassSaleRows', () => {
  it('builds a counter sale of a Weekly Cappuccino Large: 5 × ₹120 = ₹600 + ₹30 GST = ₹630, staff_pos, accepted, unpaid, filed under the account', () => {
    const { order, item, bill } = buildPassSaleRows(counterSale({ settings: settings({ gst_percent: 5, gst_inclusive: false }) }));
    expect(order).toMatchObject({
      order_kind: 'coffee_pass',
      channel: 'staff_pos',
      status: 'accepted',
      payment_status: 'unpaid',
      payment_method: null,
      created_by: STAFF,
      user_id: null,
      customer_user_id: ACCOUNT,
      customer_name: 'Asha',
      customer_phone: '+919876543210',
      subtotal_inr: 600,
      tax_inr: 30,
      packaging_inr: 0,
      discount_inr: 0,
      total_inr: 630,
    });
    expect(bill.total_inr).toBe(630);
    expect(item).toMatchObject({
      menu_item_id: null,
      variant_id: null,
      name_snapshot: 'Weekly Ritual — Cappuccino (Large)',
      variant_label_snapshot: '7 cups · 7 days',
      price_inr_snapshot: 600,
      quantity: 1,
      line_total_inr: 600,
      gst_exempt: false,
      coffee_pass_plan_id: PLAN.id,
    });
  });

  it('builds a Monthly Latte Large: 6 × ₹140 = ₹840 + ₹42 GST = ₹882, "7 cups · 30 days"', () => {
    const { order, item } = buildPassSaleRows(
      counterSale({ plan: MONTHLY, cup: LATTE_L, settings: settings({ gst_percent: 5, gst_inclusive: false }) }),
    );
    expect(order).toMatchObject({ subtotal_inr: 840, tax_inr: 42, total_inr: 882 });
    expect(item).toMatchObject({
      name_snapshot: 'Monthly Ritual — Latte (Large)',
      variant_label_snapshot: '7 cups · 30 days',
      price_inr_snapshot: 840,
      line_total_inr: 840,
      coffee_pass_plan_id: MONTHLY.id,
    });
  });

  it('GST-inclusive: the order total is the price itself (₹600), with ₹29 of it GST', () => {
    const { order } = buildPassSaleRows(counterSale({ settings: settings({ gst_percent: 5, gst_inclusive: true }) }));
    expect(order).toMatchObject({ subtotal_inr: 600, tax_inr: 29, total_inr: 600 });
  });

  it('GST-exempt plan: no tax, the line is marked exempt', () => {
    const { order, item } = buildPassSaleRows(
      counterSale({ plan: { ...PLAN, gst_exempt: true }, settings: settings({ gst_percent: 5, gst_inclusive: false }) }),
    );
    expect(order).toMatchObject({ subtotal_inr: 600, tax_inr: 0, total_inr: 600 });
    expect(item).toMatchObject({ gst_exempt: true });
  });

  it('a size with no name reads "Weekly Ritual — Cold Brew" (no empty brackets)', () => {
    const { item } = buildPassSaleRows(counterSale({ cup: { ...CAPPUCCINO_L, name: 'Cold Brew', size_label: '' } }));
    expect(item.name_snapshot).toBe('Weekly Ritual — Cold Brew');
    expect((item.coffee_pass_terms as { drink_label: string }).drink_label).toBe('Cold Brew');
  });

  it('freezes the terms it is SOLD with on the line: the plan recipe, the cup value (the size price) and the drink (the trigger issues from these)', () => {
    const { item } = buildPassSaleRows(counterSale());
    expect(item.coffee_pass_terms).toEqual({
      plan_name: 'Weekly Ritual',
      drinks_total: 7,
      drink_value_inr: 120,
      validity_days: 7,
      max_per_day: null,
      drink_menu_item_id: CAPPUCCINO,
      drink_label: 'Cappuccino · Large',
    });
  });

  it('carries a daily cap through, and writes an uncapped plan as an explicit null (the trigger needs all five base keys)', () => {
    const capped = buildPassSaleRows(counterSale({ plan: { ...PLAN, max_per_day: 1 } })).item;
    expect((capped.coffee_pass_terms as { max_per_day: unknown }).max_per_day).toBe(1);
    const open = buildPassSaleRows(counterSale()).item.coffee_pass_terms as Record<string, unknown>;
    expect(Object.keys(open).sort()).toEqual(
      ['drink_label', 'drink_menu_item_id', 'drink_value_inr', 'drinks_total', 'max_per_day', 'plan_name', 'validity_days'],
    );
    expect(open).toHaveProperty('max_per_day', null);
  });

  it('is a copy taken at sale time: editing the plan or the menu afterwards cannot reach the terms already built', () => {
    const plan = { ...PLAN };
    const cup = { ...CAPPUCCINO_L };
    const { item } = buildPassSaleRows(counterSale({ plan, cup }));
    plan.drinks_total = 20;
    plan.validity_days = 60;
    plan.name = 'Renamed';
    cup.price_inr = 400; // the menu price changes after the sale
    cup.name = 'Something else';
    expect(item.coffee_pass_terms).toMatchObject({
      plan_name: 'Weekly Ritual',
      drinks_total: 7,
      validity_days: 7,
      drink_value_inr: 120,
      drink_label: 'Cappuccino · Large',
    });
  });

  it('keeps the price on the line, not in the terms (the pass records the line total as paid)', () => {
    const { item } = buildPassSaleRows(counterSale());
    expect(item.line_total_inr).toBe(600);
    expect(item.coffee_pass_terms).not.toHaveProperty('price_inr');
  });

  it('ignores anything a plan still carries in its legacy price columns (CP-D24)', () => {
    const { order, item } = buildPassSaleRows(
      counterSale({ plan: { ...PLAN, price_inr: 750, drink_value_inr: 150 }, settings: settings({ gst_percent: 5, gst_inclusive: false }) }),
    );
    expect(item).toMatchObject({ line_total_inr: 600 });
    expect(item.coffee_pass_terms).toMatchObject({ drink_value_inr: 120 });
    expect(order).toMatchObject({ total_inr: 630 });
  });

  it('fills every NOT NULL column of orders with a sensible value and leaves the pickup ones empty', () => {
    const { order } = buildPassSaleRows(counterSale());
    // NOT NULL text columns are '' (not undefined), nullable pickup columns are null.
    expect(order).toMatchObject({
      pickup_time: '',
      pickup_slot_label: '',
      table_label: '',
      notes: '',
      order_type: 'takeaway',
      pickup_slot_start: null,
      table_id: null,
      pickup_code: null,
    });
    // pass_discount_inr is for cups a pass COVERED on a menu order, never for selling one.
    expect(order).not.toHaveProperty('pass_discount_inr');
  });

  it('builds a website sale: customer_web, placed, payment_pending/online, the session as both user and account', () => {
    const { order } = buildPassSaleRows(
      counterSale({
        channel: 'customer_web',
        status: 'placed',
        paymentStatus: 'payment_pending',
        paymentMethod: 'online',
        userId: ACCOUNT,
        customerUserId: ACCOUNT,
        createdBy: null,
      }),
    );
    expect(order).toMatchObject({
      channel: 'customer_web',
      status: 'placed',
      payment_status: 'payment_pending',
      payment_method: 'online',
      user_id: ACCOUNT,
      customer_user_id: ACCOUNT,
      created_by: null,
    });
  });

  it('omits customer_user_id when there is no account, so the row never depends on that column', () => {
    expect(buildPassSaleRows(counterSale({ customerUserId: null })).order).not.toHaveProperty('customer_user_id');
  });

  it('marks the line GST-exempt when the plan is', () => {
    expect(buildPassSaleRows(counterSale({ plan: { ...PLAN, gst_exempt: true } })).item).toMatchObject({ gst_exempt: true });
  });
});

describe('toPassSaleSummaries', () => {
  it('names the sale by its one line and tolerates missing pieces', () => {
    expect(
      toPassSaleSummaries([
        { id: 'o1', order_number: 42, total_inr: 630, created_at: 'T1', order_items: [{ name_snapshot: 'Weekly Ritual — Cappuccino (Large)' }] },
        { id: 'o2', created_at: 'T2', order_items: null },
      ]),
    ).toEqual([
      { order_id: 'o1', order_number: 42, plan_name: 'Weekly Ritual — Cappuccino (Large)', total_inr: 630, created_at: 'T1' },
      { order_id: 'o2', order_number: null, plan_name: '', total_inr: 0, created_at: 'T2' },
    ]);
    expect(toPassSaleSummaries(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveRitualCup: the drink the customer picked, priced from the live menu by
// the order rules
// ---------------------------------------------------------------------------

describe('resolveRitualCup', () => {
  const SMALL = '00000000-0000-4000-8000-0000000000f0';
  const LARGE = CAPPUCCINO_L.variant_id;
  const ONLY = '00000000-0000-4000-8000-0000000000f3';
  const FREEBIE = '00000000-0000-4000-8000-0000000000f4';
  const SANDWICH = '00000000-0000-4000-8000-0000000000e3';
  const WATER = '00000000-0000-4000-8000-0000000000e4';
  const MISSING_COLUMN = '00000000-0000-4000-8000-0000000000e5';
  const SUGAR_GROUP = '00000000-0000-4000-8000-0000000000b1';

  const item = (over: Row): Row => ({
    name: 'Cappuccino',
    description: '',
    category: 'Coffee',
    parent_category: 'Hot',
    is_veg: true,
    is_available: true,
    sort_order: 1,
    unavailable_until: null,
    short_code: null,
    in_store_only: false,
    gst_exempt: false,
    pass_eligible: true,
    ...over,
  });

  const tables = (): Record<string, Row[]> => ({
    menu_items: [
      item({ id: CAPPUCCINO }),
      item({ id: LATTE, name: 'Latte' }),
      item({ id: SANDWICH, name: 'Sandwich', category: 'Eatery', pass_eligible: false }),
      item({ id: WATER, name: 'Water Bottle', category: 'In-store', in_store_only: true }),
      item({ id: MISSING_COLUMN, name: 'Old Row', pass_eligible: undefined }),
    ],
    menu_item_variants: [
      { id: SMALL, menu_item_id: CAPPUCCINO, label: 'Small', price_inr: 90, sort_order: 0 },
      { id: LARGE, menu_item_id: CAPPUCCINO, label: 'Large', price_inr: 120, sort_order: 10 },
      { id: LATTE_L.variant_id, menu_item_id: LATTE, label: 'Large', price_inr: 140, sort_order: 0 },
      { id: ONLY, menu_item_id: SANDWICH, label: 'Regular', price_inr: 180, sort_order: 0 },
      { id: '00000000-0000-4000-8000-0000000000f5', menu_item_id: WATER, label: 'Regular', price_inr: 20, sort_order: 0 },
      { id: '00000000-0000-4000-8000-0000000000f6', menu_item_id: MISSING_COLUMN, label: 'Regular', price_inr: 100, sort_order: 0 },
    ],
    // The real menu has REQUIRED groups on coffee ("Choice of Sugar", min_select 1).
    menu_item_addon_groups: [{ menu_item_id: CAPPUCCINO, addon_group_id: SUGAR_GROUP }],
    addon_groups: [
      { id: SUGAR_GROUP, name: 'Sugar', display_name: 'Choice of Sugar', selection_type: 'single', min_select: 1, max_select: 1, sort_order: 0 },
    ],
    addon_options: [
      { id: '00000000-0000-4000-8000-0000000000b2', addon_group_id: SUGAR_GROUP, name: 'Less sugar', price_inr: 5, sort_order: 0 },
    ],
  });

  const resolve = (
    over: Partial<{ menuItemId: string; variantId: string; channel: 'customer_web' | 'staff_pos' | 'table_qr'; settings: StoreSettings }> = {},
    db: Record<string, Row[]> = tables(),
  ) => {
    const admin = makePassAdmin(db);
    return resolveRitualCup(admin as unknown as SupabaseClient, {
      menuItemId: CAPPUCCINO,
      variantId: LARGE,
      settings: settings(),
      channel: 'customer_web',
      ...over,
    }).then((result) => ({ result, admin }));
  };

  afterEach(() => vi.restoreAllMocks());

  it('prices the chosen size from the menu: Cappuccino Large = ₹120', async () => {
    const { result } = await resolve();
    expect(result).toEqual({
      ok: true,
      cup: { menu_item_id: CAPPUCCINO, variant_id: LARGE, name: 'Cappuccino', size_label: 'Large', price_inr: 120 },
    });
  });

  it('prices the size actually chosen, not the dearest or the first', async () => {
    const small = await resolve({ variantId: SMALL });
    expect(small.result).toMatchObject({ ok: true, cup: { size_label: 'Small', price_inr: 90 } });
    const latte = await resolve({ menuItemId: LATTE, variantId: LATTE_L.variant_id });
    expect(latte.result).toMatchObject({ ok: true, cup: { name: 'Latte', price_inr: 140 } });
  });

  it('reads only ids from the caller: one lookup of the one item, nothing written', async () => {
    const { admin } = await resolve();
    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0]).toMatchObject({ table: 'menu_items', op: 'select', filters: [{ op: 'eq', col: 'id', val: CAPPUCCINO }] });
  });

  it('does NOT refuse a drink for its required add-on group ("Choice of Sugar"), and never prices add-ons in: the cup is the size price', async () => {
    const { result } = await resolve();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.cup.price_inr).toBe(120); // not 125
  });

  it('refuses a drink that is not pass_eligible (400 "That drink isn\'t part of HIOC Ritual.")', async () => {
    const { result } = await resolve({ menuItemId: SANDWICH, variantId: ONLY });
    expect(result).toEqual({ ok: false, status: 400, error: "That drink isn't part of HIOC Ritual." });
    expect(RITUAL_NOT_ELIGIBLE_MESSAGE).toBe("That drink isn't part of HIOC Ritual.");
  });

  it('reads a row with no pass_eligible column at all as "no"', async () => {
    const { result } = await resolve({ menuItemId: MISSING_COLUMN, variantId: '00000000-0000-4000-8000-0000000000f6' });
    expect(result).toEqual({ ok: false, status: 400, error: RITUAL_NOT_ELIGIBLE_MESSAGE });
  });

  it('refuses an item that does not exist with the same message (nobody can probe which ids exist)', async () => {
    const { result } = await resolve({ menuItemId: '00000000-0000-4000-8000-00000000dead' });
    expect(result).toEqual({ ok: false, status: 400, error: RITUAL_NOT_ELIGIBLE_MESSAGE });
  });

  it("refuses a size that is not this drink's (another item's variant)", async () => {
    const { result } = await resolve({ variantId: LATTE_L.variant_id });
    expect(result).toEqual({ ok: false, status: 400, error: '"Cappuccino" has no such variant' });
  });

  it('refuses a size the owner has switched off (hidden_variant_labels), everywhere or in that category', async () => {
    for (const hidden of [['Large'], ['large'], ['Large|Coffee']]) {
      const { result } = await resolve({ settings: settings({ hidden_variant_labels: hidden }) });
      expect(result).toEqual({ ok: false, status: 400, error: '"Cappuccino" in Large isn\'t available right now' });
    }
    // ...but the same label switched off in ANOTHER category leaves this one alone,
    const other = await resolve({ settings: settings({ hidden_variant_labels: ['Large|Iced Coffee'] }) });
    expect(other.result.ok).toBe(true);
    // ...and the other size of the same drink is still on sale.
    const small = await resolve({ variantId: SMALL, settings: settings({ hidden_variant_labels: ['Large'] }) });
    expect(small.result.ok).toBe(true);
  });

  it("keeps the menu's own safety rule: an item whose only size is switched off still sells that size", async () => {
    const db = tables();
    // Large is now the Cappuccino's ONLY size.
    db.menu_item_variants = db.menu_item_variants.filter((v) => v.menu_item_id !== CAPPUCCINO);
    db.menu_item_variants.push({ id: LARGE, menu_item_id: CAPPUCCINO, label: 'Large', price_inr: 120, sort_order: 0 });
    const { result } = await resolve({ settings: settings({ hidden_variant_labels: ['Large'] }) }, db);
    expect(result).toMatchObject({ ok: true, cup: { size_label: 'Large', price_inr: 120 } });
  });

  it('refuses a drink in a switched-off category', async () => {
    const { result } = await resolve({ settings: settings({ hidden_categories: ['Coffee'] }) });
    expect(result).toEqual({ ok: false, status: 400, error: '"Cappuccino" isn\'t available right now' });
  });

  it('refuses a drink that is unavailable (86\'d)', async () => {
    const db = tables();
    db.menu_items[0].is_available = false;
    const { result } = await resolve({}, db);
    expect(result).toEqual({ ok: false, status: 400, error: '"Cappuccino" is currently unavailable' });
  });

  it('refuses a drink that is snoozed until later, and accepts one whose snooze has ended', async () => {
    const snoozed = tables();
    snoozed.menu_items[0].unavailable_until = new Date(Date.now() + 3_600_000).toISOString();
    expect((await resolve({}, snoozed)).result).toEqual({ ok: false, status: 400, error: '"Cappuccino" is currently unavailable' });

    const over = tables();
    over.menu_items[0].unavailable_until = new Date(Date.now() - 3_600_000).toISOString();
    expect((await resolve({}, over)).result.ok).toBe(true);
  });

  it('refuses an in-store-only drink on the website and the table QR, as POST /api/orders does (400)', async () => {
    const water = { menuItemId: WATER, variantId: '00000000-0000-4000-8000-0000000000f5' };
    for (const channel of ['customer_web', 'table_qr'] as const) {
      const { result } = await resolve({ ...water, channel });
      expect(result).toEqual({ ok: false, status: 400, error: 'Water Bottle is only available at the café counter' });
    }
  });

  it('lets the counter sell an in-store-only drink', async () => {
    const { result } = await resolve({ menuItemId: WATER, variantId: '00000000-0000-4000-8000-0000000000f5', channel: 'staff_pos' });
    expect(result).toMatchObject({ ok: true, cup: { name: 'Water Bottle', price_inr: 20 } });
  });

  it('refuses a size priced at ₹0: there is nothing to sell and a pass needs a cup value of at least ₹1', async () => {
    const db = tables();
    db.menu_item_variants.push({ id: FREEBIE, menu_item_id: CAPPUCCINO, label: 'Taster', price_inr: 0, sort_order: 20 });
    const { result } = await resolve({ variantId: FREEBIE }, db);
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(result.ok === false && result.error).toContain('Taster');
  });

  it('answers 500 (never a guess) when the menu cannot be read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const admin = makePassAdmin(tables(), { fail: (c) => (c.table === 'menu_items' ? { message: 'db down' } : null) });
    const result = await resolveRitualCup(admin as unknown as SupabaseClient, {
      menuItemId: CAPPUCCINO,
      variantId: LARGE,
      settings: settings(),
      channel: 'customer_web',
    });
    expect(result).toMatchObject({ ok: false, status: 500 });
    expect(errorSpy).toHaveBeenCalled();
  });

  it('feeds the price straight into the sale: Large Cappuccino → Weekly ₹600, Monthly ₹720 before GST', async () => {
    const { result } = await resolve();
    if (!result.ok) throw new Error('expected a cup');
    expect(ritualPriceFor(PLAN, result.cup.price_inr)).toBe(600);
    expect(ritualPriceFor(MONTHLY, result.cup.price_inr)).toBe(720);
  });
});

describe('createPassSaleOrder', () => {
  const defaults = (table: string, row: Row): Row => (table === 'orders' ? { order_number: 7, version: 0, ...row } : row);

  it('inserts the order, its single line and the first status event, and returns the row with items', async () => {
    const admin = makePassAdmin({}, { defaults });
    const result = await createPassSaleOrder(admin as unknown as SupabaseClient, counterSale());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const orders = admin.tables.orders;
    const items = admin.tables.order_items;
    const events = admin.tables.order_status_events;
    expect(orders).toHaveLength(1);
    expect(items).toEqual([
      expect.objectContaining({
        order_id: orders[0].id,
        name_snapshot: 'Weekly Ritual — Cappuccino (Large)',
        quantity: 1,
        line_total_inr: 600,
      }),
    ]);
    expect(orders[0]).toMatchObject({ subtotal_inr: 600, tax_inr: 30, total_inr: 630 });
    expect(events).toEqual([
      expect.objectContaining({
        order_id: orders[0].id,
        from_status: null,
        to_status: 'accepted',
        actor_id: STAFF,
        actor_role: 'staff',
      }),
    ]);
    expect(result.order.id).toBe(orders[0].id);
    expect(result.order.order_items).toHaveLength(1);
    expect(result.order.order_items?.[0]).toMatchObject({ name_snapshot: 'Weekly Ritual — Cappuccino (Large)', coffee_pass_plan_id: PLAN.id });
    // The line stored the terms it was sold with, the drink included.
    expect(items[0].coffee_pass_terms).toEqual({
      plan_name: 'Weekly Ritual',
      drinks_total: 7,
      drink_value_inr: 120,
      validity_days: 7,
      max_per_day: null,
      drink_menu_item_id: CAPPUCCINO,
      drink_label: 'Cappuccino · Large',
    });
  });

  it('attributes an online sale to the system, not to a person', async () => {
    const admin = makePassAdmin({}, { defaults });
    await createPassSaleOrder(
      admin as unknown as SupabaseClient,
      counterSale({ channel: 'customer_web', status: 'placed', paymentStatus: 'payment_pending', paymentMethod: 'online', createdBy: null, userId: ACCOUNT }),
    );
    expect(admin.tables.order_status_events[0]).toMatchObject({ to_status: 'placed', actor_id: null, actor_role: 'system' });
  });

  it('honours an explicit actor role (a manager or owner selling)', async () => {
    const admin = makePassAdmin({}, { defaults });
    await createPassSaleOrder(admin as unknown as SupabaseClient, counterSale({ actorRole: 'owner' }));
    expect(admin.tables.order_status_events[0]).toMatchObject({ actor_role: 'owner' });
  });

  it('deletes the order again when its line cannot be written', async () => {
    const admin = makePassAdmin({}, {
      defaults,
      fail: (c) => (c.table === 'order_items' && c.op === 'insert' ? { message: 'boom' } : null),
    });
    const result = await createPassSaleOrder(admin as unknown as SupabaseClient, counterSale());
    expect(result).toMatchObject({ ok: false, missingSchema: false });
    expect(result.ok === false && result.message).toContain('boom');
    expect(admin.tables.orders).toEqual([]);
  });

  it('reports a database without the migration so the route can say which file to apply', async () => {
    const admin = makePassAdmin({}, {
      fail: (c) => (c.table === 'orders' && c.op === 'insert' ? { code: '42703', message: 'column "order_kind" does not exist' } : null),
    });
    const result = await createPassSaleOrder(admin as unknown as SupabaseClient, counterSale());
    expect(result).toMatchObject({ ok: false, missingSchema: true });
    expect(admin.tables.order_items ?? []).toEqual([]);
  });

  it('still succeeds when only the status event is lost (an SLA anchor, not the sale)', async () => {
    const admin = makePassAdmin({}, {
      defaults,
      fail: (c) => (c.table === 'order_status_events' ? { message: 'events down' } : null),
    });
    const result = await createPassSaleOrder(admin as unknown as SupabaseClient, counterSale());
    expect(result.ok).toBe(true);
    expect(admin.tables.orders).toHaveLength(1);
  });
});
