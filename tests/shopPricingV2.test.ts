import { describe, expect, it } from 'vitest';
import {
  couponSavingFor,
  DEFAULT_SHOP_SETTINGS,
  jarTierNudge,
  parseCartItems,
  pickBestAutoCoupon,
  quoteShopCart,
  shopSettingsFromRow,
  unitsLabel,
  WHOLESALE_MESSAGE,
  type BeaniesContext,
  type ShopPricingInput,
} from '@/lib/shop/pricing';
import type { ShopCouponTerms, ShopProduct } from '@/lib/shop/types';

const inst = (id: string, name: string, sort: number): ShopProduct => ({
  id, name, sku: `HIOC-IC-${id.toUpperCase()}-50G`, price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: sort,
  line: 'instant', display_name: '', pack_grams: 50, ship_weight_kg: 0.3, listed: true, requires_grind: false, description: '',
});
const hb = (id: string, grams: number, price: number, sort: number, kg: number): ShopProduct => ({
  id, name: `Home Blend ${grams}`, sku: `HIOC-HB-${grams}G`, price_inr: price, net_qty: `${grams} g`, in_stock: true, sort_order: sort,
  line: 'home_blend', display_name: `Signature Home Blend ${grams === 1000 ? '1 kg' : `${grams} g`}`, pack_grams: grams,
  ship_weight_kg: kg, listed: true, requires_grind: true, description: '',
});
const PRODUCTS: ShopProduct[] = [
  inst('classic', 'Signature Classic', 1),
  inst('hazelnut', 'Nutty Hazelnut', 2),
  hb('hb-250', 250, 450, 10, 0.3),
  hb('hb-1000', 1000, 1500, 11, 1.1),
];
const OFFER = { name: 'Introductory offer', tier_prices: [399, 599, 749] };
const SETTINGS = { ...DEFAULT_SHOP_SETTINGS, offer: OFFER };

const coupon = (o: Partial<ShopCouponTerms> = {}): ShopCouponTerms => ({
  id: 'c1', code: 'WELCOME10', discount_type: 'percent', discount_value: 10, min_order_inr: 0, max_discount_inr: 0,
  shop_product_ids: [], is_auto: false, ...o,
});
const beanies = (o: Partial<BeaniesContext> = {}): BeaniesContext => ({
  signed_in: true, repeat_customer: true, balance: 500, min_redeem_points: 50, inr_per_point: 1, points_per_inr: 0.05, use: true, ...o,
});
function quote(o: Partial<ShopPricingInput> & Pick<ShopPricingInput, 'items'>) {
  const r = quoteShopCart({ products: PRODUCTS, settings: SETTINGS, intro_eligible: true, coupon: null, beanies: null, ...o });
  if (!r.ok) throw new Error(r.error);
  return r;
}
const err = (o: Partial<ShopPricingInput> & Pick<ShopPricingInput, 'items'>) => {
  const r = quoteShopCart({ products: PRODUCTS, settings: SETTINGS, intro_eligible: true, coupon: null, beanies: null, ...o });
  return r.ok ? null : r.error;
};
const jars = (n: number) => [{ product_id: 'classic', quantity: n }];

describe('parseCartItems v2', () => {
  it('merges by product and grind', () => {
    expect(
      parseCartItems([
        { product_id: 'hb-250', quantity: 1, grind: 'filter' },
        { product_id: 'hb-250', quantity: 2, grind: 'filter' },
        { product_id: 'hb-250', quantity: 1, grind: 'moka' },
        { product_id: 'classic', quantity: 0 },
      ]),
    ).toEqual({
      ok: true,
      items: [
        { product_id: 'hb-250', quantity: 3, grind: 'filter' },
        { product_id: 'hb-250', quantity: 1, grind: 'moka' },
      ],
    });
  });
  it('refuses a bad grind', () => {
    expect(parseCartItems([{ product_id: 'hb-250', quantity: 1, grind: 'turkish' }])).toEqual({ ok: false, error: 'Choose a grind from the list' });
  });
  it('accepts a null grind', () => {
    expect(parseCartItems([{ product_id: 'classic', quantity: 1, grind: null }]).ok).toBe(true);
  });
  it('refuses 13 units with the wholesale message and an empty cart', () => {
    expect(parseCartItems([{ product_id: 'classic', quantity: 13 }])).toEqual({ ok: false, error: WHOLESALE_MESSAGE });
    expect(parseCartItems([{ product_id: 'classic', quantity: 12 }]).ok).toBe(true);
    expect(parseCartItems([])).toEqual({ ok: false, error: 'Add something to your order' });
  });
});

describe('shopSettingsFromRow', () => {
  it('defaults', () => {
    expect(shopSettingsFromRow(null)).toEqual({ offer: null, shipping_fee_inr: 49, free_shipping_min_inr: 749, beanies_max_redeem_pct: 5 });
  });
  it('reads, clamps and falls back', () => {
    expect(
      shopSettingsFromRow({ offer_active: true, offer_tier_prices: [399, 599], shipping_fee_inr: 900, free_shipping_min_inr: -5, beanies_max_redeem_pct: 'x' }),
    ).toEqual({ offer: { name: 'Introductory offer', tier_prices: [399, 599] }, shipping_fee_inr: 500, free_shipping_min_inr: 0, beanies_max_redeem_pct: 5 });
    expect(shopSettingsFromRow({ beanies_max_redeem_pct: 80 }).beanies_max_redeem_pct).toBe(50);
  });
});

describe('quoteShopCart validation', () => {
  it('refuses unknown and unlisted items', () => {
    const msg = 'One of those items is no longer sold. Please refresh the page.';
    expect(err({ items: [{ product_id: 'nope', quantity: 1 }] })).toBe(msg);
    const products = PRODUCTS.map((p) => (p.id === 'classic' ? { ...p, listed: false } : p));
    expect(err({ products, items: jars(1) })).toBe(msg);
  });
  it('refuses out of stock by name', () => {
    const products = PRODUCTS.map((p) => (p.id === 'hazelnut' ? { ...p, in_stock: false } : p));
    expect(err({ products, items: [{ product_id: 'hazelnut', quantity: 1 }] })).toBe('Nutty Hazelnut is out of stock right now.');
  });
  it('needs a grind for home blend and refuses one on instant', () => {
    expect(err({ items: [{ product_id: 'hb-250', quantity: 1 }] })).toBe('Choose a grind for Signature Home Blend 250 g');
    expect(err({ items: [{ product_id: 'classic', quantity: 1, grind: 'moka' }] })).toBe("Signature Classic doesn't need a grind");
  });
  it('refuses past 12 units or 6 kg', () => {
    expect(err({ items: jars(13) })).toBe(WHOLESALE_MESSAGE);
    expect(err({ items: [{ product_id: 'hb-1000', quantity: 6, grind: 'filter' }] })).toBe(WHOLESALE_MESSAGE);
    expect(quote({ items: [{ product_id: 'hb-1000', quantity: 5, grind: 'filter' }] }).goods_weight_kg).toBe(5.5);
  });
});

describe('quoteShopCart lines', () => {
  it('orders by product then grind and freezes the line fields', () => {
    const q = quote({
      items: [
        { product_id: 'hb-250', quantity: 1, grind: 'moka' },
        { product_id: 'hb-250', quantity: 1, grind: 'whole_bean' },
        { product_id: 'classic', quantity: 1 },
      ],
      intro_eligible: false,
    });
    expect(q.lines.map((l) => l.sku)).toEqual(['HIOC-IC-CLASSIC-50G', 'HIOC-HB-250G-WB', 'HIOC-HB-250G-MOKA']);
    expect(q.lines[2]).toMatchObject({
      name: 'Signature Home Blend 250 g', base_sku: 'HIOC-HB-250G', line: 'home_blend', pack_grams: 250, grind: 'moka', grind_label: 'Moka pot', ship_weight_kg: 0.3,
    });
    expect(q.unit_count).toBe(3);
    expect(q.jar_count).toBe(3);
  });
});

describe('offer counts only instant units', () => {
  it('2 jars + 1 home blend: tier on the jars only', () => {
    const q = quote({ items: [{ product_id: 'classic', quantity: 2 }, { product_id: 'hb-250', quantity: 1, grind: 'filter' }] });
    expect(q.subtotal_inr).toBe(798 + 450);
    expect(q.offer_discount_inr).toBe(798 - 599);
    expect(q.instant_units).toBe(2);
    expect(q.intro_offer_applied).toBe(true);
    expect(q.offer_name).toBe('Introductory offer');
  });
  it('home blend alone gets no offer and no offer name', () => {
    const q = quote({ items: [{ product_id: 'hb-250', quantity: 3, grind: 'filter' }] });
    expect(q.offer_discount_inr).toBe(0);
    expect(q.offer_name).toBeNull();
    expect(q.intro_offer_applied).toBe(false);
  });
  it('no offer when not eligible or switched off', () => {
    expect(quote({ items: jars(3), intro_eligible: false }).offer_discount_inr).toBe(0);
    expect(quote({ items: jars(3), settings: DEFAULT_SHOP_SETTINGS }).offer_discount_inr).toBe(0);
  });
});

describe('offer versus coupon (no stacking)', () => {
  it('the offer wins when it saves more', () => {
    const q = quote({ items: jars(3), coupon: coupon() }); // offer 448, coupon 119
    expect(q.offer_discount_inr).toBe(448);
    expect(q.coupon_discount_inr).toBe(0);
    expect(q.coupon_code).toBeNull();
    expect(q.discount_choice_note).toBe('Introductory offer applied: it saves you more than WELCOME10');
    expect(q.total_inr).toBe(749);
  });
  it('the coupon wins when it saves more', () => {
    const q = quote({ items: jars(1), coupon: coupon({ discount_type: 'flat', discount_value: 100 }) }); // offer 0
    expect(q.coupon_discount_inr).toBe(100);
    expect(q.coupon_code).toBe('WELCOME10');
    expect(q.coupon_id).toBe('c1');
    expect(q.discount_choice_note).toBeNull();
    const big = quote({ items: jars(2), coupon: coupon({ discount_type: 'flat', discount_value: 300 }) }); // offer 199
    expect(big.coupon_discount_inr).toBe(300);
    expect(big.offer_discount_inr).toBe(0);
    expect(big.offer_name).toBeNull();
    expect(big.intro_offer_applied).toBe(false);
    expect(big.discount_choice_note).toBe('WELCOME10 applied: it saves you more than the Introductory offer');
  });
  it('a tie goes to the offer', () => {
    const q = quote({ items: jars(2), coupon: coupon({ discount_type: 'flat', discount_value: 199 }) });
    expect(q.offer_discount_inr).toBe(199);
    expect(q.coupon_discount_inr).toBe(0);
    expect(q.discount_choice_note).toContain('Introductory offer applied');
  });
  it('a failed coupon applies nothing and says why', () => {
    const q = quote({ items: jars(1), coupon: coupon({ min_order_inr: 1000 }) });
    expect(q.coupon_discount_inr).toBe(0);
    expect(q.coupon_reason).toBe('Add ₹601 more to use WELCOME10 (minimum ₹1,000)');
  });
});

describe('couponSavingFor', () => {
  const lines = quote({ items: [{ product_id: 'classic', quantity: 1 }, { product_id: 'hb-250', quantity: 1, grind: 'filter' }], intro_eligible: false }).lines; // 399 + 450
  it('percent rounds down', () => {
    expect(couponSavingFor(coupon({ discount_value: 10 }), lines)).toEqual({ ok: true, discount_inr: 84 });
  });
  it('flat', () => {
    expect(couponSavingFor(coupon({ discount_type: 'flat', discount_value: 50 }), lines)).toEqual({ ok: true, discount_inr: 50 });
  });
  it('is capped by max_discount_inr', () => {
    expect(couponSavingFor(coupon({ discount_value: 50, max_discount_inr: 100 }), lines)).toEqual({ ok: true, discount_inr: 100 });
  });
  it('percent applies to the in-scope lines only', () => {
    expect(couponSavingFor(coupon({ discount_value: 10, shop_product_ids: ['classic'] }), lines)).toEqual({ ok: true, discount_inr: 39 });
  });
  it('refuses when nothing is in scope', () => {
    expect(couponSavingFor(coupon({ shop_product_ids: ['hazelnut'] }), lines)).toEqual({ ok: false, reason: "This code isn't for the items in your order" });
  });
  it('refuses under the minimum', () => {
    expect(couponSavingFor(coupon({ min_order_inr: 1000 }), lines)).toEqual({ ok: false, reason: 'Add ₹151 more to use WELCOME10 (minimum ₹1,000)' });
  });
  it('flat is capped at the base and the total stays above ₹0', () => {
    expect(couponSavingFor(coupon({ discount_type: 'flat', discount_value: 5000 }), lines)).toEqual({ ok: true, discount_inr: 848 });
    expect(couponSavingFor(coupon({ discount_type: 'flat', discount_value: 5000, shop_product_ids: ['classic'] }), lines)).toEqual({ ok: true, discount_inr: 399 });
  });
  it('gives no discount at 0', () => {
    expect(couponSavingFor(coupon({ discount_value: 0 }), lines)).toEqual({ ok: false, reason: 'This code gives no discount on this order' });
  });
  it('a 100% coupon leaves a rupee to pay', () => {
    const q = quote({ items: jars(1), coupon: coupon({ discount_value: 100 }), settings: { ...DEFAULT_SHOP_SETTINGS, shipping_fee_inr: 0 } });
    expect(q.total_inr).toBe(1);
  });
});

describe('pickBestAutoCoupon', () => {
  const lines = quote({ items: jars(2), intro_eligible: false }).lines;
  it('picks the one that saves most, or null', () => {
    const a = coupon({ id: 'a', code: 'A', discount_value: 5 });
    const b = coupon({ id: 'b', code: 'B', discount_value: 20 });
    const c = coupon({ id: 'c', code: 'C', discount_value: 50, min_order_inr: 5000 });
    expect(pickBestAutoCoupon([a, b, c], lines)).toEqual({ terms: b, discount_inr: 159 });
    expect(pickBestAutoCoupon([c], lines)).toBeNull();
    expect(pickBestAutoCoupon([], lines)).toBeNull();
  });
});

describe('Beanies', () => {
  const items = [{ product_id: 'hb-250', quantity: 4, grind: 'filter' as const }]; // 1800
  it('applies 5% rounded down, for a repeat signed-in customer', () => {
    const q = quote({ items, beanies: beanies() });
    expect(q.beanies).toMatchObject({ state: 'applied', points: 90, discount_inr: 90, balance_after: 410, min_redeem_points: 50, max_pct: 5 });
    expect(q.beanies_redeemed).toBe(90);
    expect(q.beanies_discount_inr).toBe(90);
    expect(q.total_inr).toBe(1710);
  });
  it('rounds the 5% down', () => {
    const q = quote({ items: [{ product_id: 'hb-250', quantity: 1, grind: 'filter' }], beanies: beanies() }); // 450 -> 22.5 -> 22
    expect(q.beanies.points).toBe(22);
  });
  it('never exceeds the balance', () => {
    const q = quote({ items, beanies: beanies({ balance: 60 }) });
    expect(q.beanies).toMatchObject({ state: 'applied', points: 60, balance_after: 0 });
  });
  it('use=false reports but does not apply', () => {
    const q = quote({ items, beanies: beanies({ use: false }) });
    expect(q.beanies).toMatchObject({ state: 'available_off', points: 90, discount_inr: 90, balance_after: 500 });
    expect(q.beanies_redeemed).toBe(0);
    expect(q.beanies_discount_inr).toBe(0);
    expect(q.total_inr).toBe(1800);
  });
  it('states: unavailable, guest, first order, below minimum', () => {
    expect(quote({ items, beanies: null }).beanies.state).toBe('unavailable');
    expect(quote({ items, beanies: beanies({ signed_in: false }) }).beanies.state).toBe('guest');
    expect(quote({ items, beanies: beanies({ repeat_customer: false }) }).beanies.state).toBe('first_order');
    expect(quote({ items, beanies: beanies({ balance: 49 }) }).beanies.state).toBe('below_min');
    expect(quote({ items, beanies: beanies({ balance: 49 }) }).beanies_discount_inr).toBe(0);
  });
  it('is unavailable when 5% rounds to nothing', () => {
    const products = PRODUCTS.map((p) => (p.id === 'classic' ? { ...p, price_inr: 10 } : p));
    const q = quote({ products, items: jars(1), beanies: beanies(), intro_eligible: false });
    expect(q.beanies.state).toBe('unavailable');
  });
  it('works on goods after the offer, and stacks with a coupon', () => {
    const q = quote({ items: jars(3), beanies: beanies() }); // offer 448 -> 749 -> 5% = 37
    expect(q.beanies.points).toBe(37);
    const c = quote({ items, coupon: coupon({ discount_type: 'flat', discount_value: 200 }), beanies: beanies() }); // 1600 -> 80
    expect(c.coupon_discount_inr).toBe(200);
    expect(c.beanies_redeemed).toBe(80);
    expect(c.discount_inr).toBe(280);
    expect(c.total_inr).toBe(1800 - 280);
  });
  it('honours the configured percentage', () => {
    const q = quote({ items, beanies: beanies(), settings: { ...SETTINGS, beanies_max_redeem_pct: 10 } });
    expect(q.beanies.points).toBe(180);
  });
  it('earn estimate is on the total without shipping, 0 without a context', () => {
    const q = quote({ items, beanies: beanies() }); // 1710 * 0.05 = 85.5
    expect(q.earn_estimate_points).toBe(85);
    expect(quote({ items }).earn_estimate_points).toBe(0);
  });
});

describe('shipping', () => {
  it('is free at exactly ₹749 after discounts', () => {
    const q = quote({ items: jars(3) });
    expect(q.goods_after_discounts_inr).toBe(749);
    expect(q.shipping_inr).toBe(0);
    expect(q.free_shipping_gap_inr).toBe(0);
    expect(q.nudges.free_shipping).toBeNull();
    expect(q.total_inr).toBe(749);
  });
  it('is ₹49 at ₹748', () => {
    const products = PRODUCTS.map((p) => (p.id === 'hb-250' ? { ...p, price_inr: 748 } : p));
    const q = quote({ products, items: [{ product_id: 'hb-250', quantity: 1, grind: 'filter' }] });
    expect(q.shipping_inr).toBe(49);
    expect(q.free_shipping_gap_inr).toBe(1);
    expect(q.nudges.free_shipping).toBe('Add ₹1 more for free shipping');
    expect(q.total_inr).toBe(797);
  });
  it('counts goods after discounts, Beanies included', () => {
    const q = quote({ items: [{ product_id: 'hb-250', quantity: 2, grind: 'filter' }], beanies: beanies(), intro_eligible: false }); // 900 - 45
    expect(q.goods_after_discounts_inr).toBe(855);
    expect(q.shipping_inr).toBe(0);
    const c = quote({ items: [{ product_id: 'hb-250', quantity: 2, grind: 'filter' }], intro_eligible: false, coupon: coupon({ discount_type: 'flat', discount_value: 200 }) });
    expect(c.shipping_inr).toBe(49);
    expect(c.total_inr).toBe(900 - 200 + 49);
  });
  it('1 jar pays ₹49 and 2 jars pay ₹49 shipping', () => {
    expect(quote({ items: jars(1) }).total_inr).toBe(448);
    expect(quote({ items: jars(2) }).total_inr).toBe(599 + 49);
  });
});

describe('nudges', () => {
  it('jar tier shows only while eligible', () => {
    expect(quote({ items: jars(1) }).nudges.jar_tier).toBe('Add another jar for just ₹200 more: 2 for ₹599.');
    expect(quote({ items: jars(1), intro_eligible: false }).nudges.jar_tier).toBeNull();
    expect(quote({ items: [{ product_id: 'hb-250', quantity: 1, grind: 'filter' }] }).nudges.jar_tier).toBeNull();
  });
  it('no jar-tier nudge when the next jar would breach a cap', () => {
    // 1 jar + 11 Home Blend 250 g = 12 units, 3.6 kg: another jar is 13 units.
    const q = quote({ items: [{ product_id: 'classic', quantity: 1 }, { product_id: 'hb-250', quantity: 11, grind: 'filter' }] });
    expect(q.unit_count).toBe(12);
    expect(q.nudges.jar_tier).toBeNull();
  });
  it('no jar-tier nudge when the next jar would pass the weight cap', () => {
    // 1 jar (0.3) + 5 x 1 kg (1.1 each) = 5.8 kg; another jar makes 6.1 kg.
    const q = quote({ items: [{ product_id: 'classic', quantity: 1 }, { product_id: 'hb-1000', quantity: 5, grind: 'filter' }] });
    expect(q.ok).toBe(true);
    expect(q.nudges.jar_tier).toBeNull();
  });
  it('jar-tier weight check uses the default jar weight when a line has none, and allows exactly 6 kg', () => {
    const noKg = { ...PRODUCTS[0], ship_weight_kg: undefined } as unknown as ShopProduct;
    const products = [noKg, ...PRODUCTS.slice(1)];
    // 1 jar (0.3 by default) + 5 x 1.1 kg = 5.8 kg: another 0.3 kg jar makes 6.1 kg.
    const over = quote({ products, items: [{ product_id: 'classic', quantity: 1 }, { product_id: 'hb-1000', quantity: 5, grind: 'filter' }] });
    expect(over.nudges.jar_tier).toBeNull();
    // 1 jar (0.3) + 5 x 1.08 kg = 5.7 kg: another jar makes exactly 6 kg, which the quote allows.
    const heavy = { ...PRODUCTS[3], id: 'hb-900', ship_weight_kg: 1.08 };
    const exact = quote({
      products: [...PRODUCTS, heavy],
      items: [{ product_id: 'classic', quantity: 1 }, { product_id: 'hb-900', quantity: 5, grind: 'filter' }],
    });
    expect(exact.goods_weight_kg).toBe(5.7);
    expect(exact.nudges.jar_tier).toBe('Add another jar for just ₹200 more: 2 for ₹599.');
  });
  it('jarTierNudge', () => {
    expect(jarTierNudge(2, 399, OFFER)).toBe('Add a 3rd jar for just ₹150 more: 3 for ₹749.');
    expect(jarTierNudge(3, 399, OFFER)).toBeNull();
    expect(jarTierNudge(0, 399, OFFER)).toBeNull();
    expect(jarTierNudge(1, 399, null)).toBeNull();
  });
  it('unitsLabel', () => {
    expect(unitsLabel(1)).toBe('1 item');
    expect(unitsLabel(3)).toBe('3 items');
  });
});
