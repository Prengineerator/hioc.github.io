import { describe, expect, it } from 'vitest';
import {
  describeOfferTiers,
  FREE_SHIPPING_MIN_JARS,
  jarsLabel,
  jarsToFreeShipping,
  MAX_JARS_PER_ORDER,
  normalizeOfferTiers,
  offerDeals,
  parseCartItems,
  priceShopCart,
  rupees,
  SHIPPING_FEE_INR,
  shippingForJars,
  shopOfferFromSettings,
  totalForJars,
} from '@/lib/shop/pricing';
import type { ShopProduct } from '@/lib/shop/types';

// The Instant Coffee shop's price rules (docs/INSTANT-COFFEE-SHOP.md):
// ₹399 a jar, ₹49 shipping an order below 3 jars, free from 3, at most 12 jars.

const PRODUCTS: ShopProduct[] = [
  { id: 'vanilla', name: 'French Vanilla', sku: 'HIOC-IC-VANILLA-50G', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 3 },
  { id: 'classic', name: 'Signature Classic', sku: 'HIOC-IC-CLASSIC-50G', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 1 },
  { id: 'hazelnut', name: 'Nutty Hazelnut', sku: 'HIOC-IC-HAZELNUT-50G', price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 2 },
];

describe('shipping', () => {
  it('is ₹49 for 1 and 2 jars, free from 3', () => {
    expect(SHIPPING_FEE_INR).toBe(49);
    expect(FREE_SHIPPING_MIN_JARS).toBe(3);
    expect(shippingForJars(1)).toBe(49);
    expect(shippingForJars(2)).toBe(49);
    expect(shippingForJars(3)).toBe(0);
    expect(shippingForJars(12)).toBe(0);
  });

  it('costs nothing with nothing to ship', () => {
    expect(shippingForJars(0)).toBe(0);
    expect(shippingForJars(-1)).toBe(0);
  });

  it('counts the jars left to free shipping', () => {
    expect(jarsToFreeShipping(0)).toBe(3);
    expect(jarsToFreeShipping(1)).toBe(2);
    expect(jarsToFreeShipping(2)).toBe(1);
    expect(jarsToFreeShipping(3)).toBe(0);
    expect(jarsToFreeShipping(7)).toBe(0);
  });
});

describe('parseCartItems', () => {
  it('accepts product ids with whole quantities, merging repeats and dropping zeros', () => {
    expect(
      parseCartItems([
        { product_id: 'classic', quantity: 1 },
        { product_id: 'vanilla', quantity: 0 },
        { product_id: 'classic', quantity: 2 },
      ]),
    ).toEqual({ ok: true, items: [{ product_id: 'classic', quantity: 3 }] });
  });

  it('refuses a body that is not a list, or a malformed line', () => {
    expect(parseCartItems(undefined).ok).toBe(false);
    expect(parseCartItems({ classic: 1 }).ok).toBe(false);
    expect(parseCartItems([{ product_id: 'classic', quantity: 1.5 }]).ok).toBe(false);
    expect(parseCartItems([{ product_id: 'classic', quantity: -1 }]).ok).toBe(false);
    expect(parseCartItems([{ product_id: 'Robert"); DROP', quantity: 1 }]).ok).toBe(false);
    expect(parseCartItems([null]).ok).toBe(false);
  });

  it('refuses an empty cart', () => {
    expect(parseCartItems([])).toEqual({ ok: false, error: 'Add at least one jar' });
    expect(parseCartItems([{ product_id: 'classic', quantity: 0 }]).ok).toBe(false);
  });

  it(`refuses more than ${MAX_JARS_PER_ORDER} jars in all`, () => {
    expect(parseCartItems([{ product_id: 'classic', quantity: 12 }]).ok).toBe(true);
    const over = parseCartItems([
      { product_id: 'classic', quantity: 6 },
      { product_id: 'vanilla', quantity: 7 },
    ]);
    expect(over.ok).toBe(false);
  });
});

describe('priceShopCart', () => {
  it('1 jar: ₹399 + ₹49 shipping = ₹448', () => {
    const q = priceShopCart(PRODUCTS, [{ product_id: 'hazelnut', quantity: 1 }]);
    expect(q).toMatchObject({ ok: true, jar_count: 1, subtotal_inr: 399, shipping_inr: 49, total_inr: 448 });
  });

  it('2 jars: ₹798 + ₹49 shipping = ₹847', () => {
    const q = priceShopCart(PRODUCTS, [
      { product_id: 'classic', quantity: 1 },
      { product_id: 'vanilla', quantity: 1 },
    ]);
    expect(q).toMatchObject({ ok: true, jar_count: 2, subtotal_inr: 798, shipping_inr: 49, total_inr: 847 });
  });

  it('3 jars of mixed flavours ship free: ₹1,197', () => {
    const q = priceShopCart(PRODUCTS, [
      { product_id: 'vanilla', quantity: 1 },
      { product_id: 'classic', quantity: 1 },
      { product_id: 'hazelnut', quantity: 1 },
    ]);
    expect(q).toMatchObject({ ok: true, jar_count: 3, subtotal_inr: 1197, shipping_inr: 0, total_inr: 1197 });
  });

  it('lists lines in the shop order with name, sku and line totals', () => {
    const q = priceShopCart(PRODUCTS, [
      { product_id: 'vanilla', quantity: 2 },
      { product_id: 'classic', quantity: 1 },
    ]);
    if (!q.ok) throw new Error(q.error);
    expect(q.lines).toEqual([
      { product_id: 'classic', name: 'Signature Classic', sku: 'HIOC-IC-CLASSIC-50G', unit_price_inr: 399, quantity: 1, line_total_inr: 399 },
      { product_id: 'vanilla', name: 'French Vanilla', sku: 'HIOC-IC-VANILLA-50G', unit_price_inr: 399, quantity: 2, line_total_inr: 798 },
    ]);
  });

  it('uses the price from the products, never a fixed number', () => {
    const repriced = PRODUCTS.map((p) => ({ ...p, price_inr: 450 }));
    expect(priceShopCart(repriced, [{ product_id: 'classic', quantity: 1 }])).toMatchObject({ total_inr: 499 });
  });

  it('refuses an out-of-stock flavour by name, and an unknown one', () => {
    const out = PRODUCTS.map((p) => (p.id === 'hazelnut' ? { ...p, in_stock: false } : p));
    expect(priceShopCart(out, [{ product_id: 'hazelnut', quantity: 1 }])).toEqual({
      ok: false,
      error: 'Nutty Hazelnut is out of stock right now.',
    });
    expect(priceShopCart(PRODUCTS, [{ product_id: 'mocha', quantity: 1 }]).ok).toBe(false);
  });
});

describe('labels', () => {
  it('formats rupees and jar counts', () => {
    expect(rupees(1197)).toBe('₹1,197');
    expect(rupees(49)).toBe('₹49');
    expect(jarsLabel(1)).toBe('1 jar');
    expect(jarsLabel(3)).toBe('3 jars');
  });
});

// ---------------------------------------------------------------------------
// The introductory offer: 1 for ₹399 · 2 for ₹599 · 3 for ₹749, any flavours.
// ---------------------------------------------------------------------------

const INTRO = { name: 'Introductory offer', tier_prices: [399, 599, 749] };
const jars = (n: number) => [{ product_id: 'classic', quantity: n }];

describe('priceShopCart with the introductory offer', () => {
  it('1 jar: full price, ₹49 shipping, nothing off', () => {
    expect(priceShopCart(PRODUCTS, jars(1), INTRO)).toMatchObject({
      subtotal_inr: 399,
      discount_inr: 0,
      offer_name: null,
      shipping_inr: 49,
      total_inr: 448,
    });
  });

  it('2 jars: ₹599 + ₹49 shipping = ₹648 (₹199 off)', () => {
    expect(priceShopCart(PRODUCTS, jars(2), INTRO)).toMatchObject({
      subtotal_inr: 798,
      discount_inr: 199,
      offer_name: 'Introductory offer',
      shipping_inr: 49,
      total_inr: 648,
    });
  });

  it('3 jars of mixed flavours: ₹749, shipped free (₹448 off)', () => {
    const q = priceShopCart(
      PRODUCTS,
      [
        { product_id: 'classic', quantity: 1 },
        { product_id: 'hazelnut', quantity: 1 },
        { product_id: 'vanilla', quantity: 1 },
      ],
      INTRO,
    );
    expect(q).toMatchObject({ subtotal_inr: 1197, discount_inr: 448, shipping_inr: 0, total_inr: 749 });
    if (q.ok) expect(q.lines.every((l) => l.unit_price_inr === 399)).toBe(true); // jars keep their price
  });

  it('more jars: full groups of 3, then the rest (like the café offers)', () => {
    expect(priceShopCart(PRODUCTS, jars(4), INTRO)).toMatchObject({ total_inr: 749 + 399 });
    expect(priceShopCart(PRODUCTS, jars(5), INTRO)).toMatchObject({ total_inr: 749 + 599 });
    expect(priceShopCart(PRODUCTS, jars(6), INTRO)).toMatchObject({ total_inr: 749 * 2 });
  });

  it('charges full price with the offer off', () => {
    expect(priceShopCart(PRODUCTS, jars(3), null)).toMatchObject({ discount_inr: 0, offer_name: null, total_inr: 1197 });
  });

  it('never adds: an offer dearer than the jars takes nothing off', () => {
    expect(priceShopCart(PRODUCTS, jars(2), { name: 'Odd', tier_prices: [399, 900] })).toMatchObject({
      discount_inr: 0,
      offer_name: null,
      total_inr: 847,
    });
  });
});

describe('the offer helpers', () => {
  it('totals what N jars cost, offer and shipping included', () => {
    expect([1, 2, 3, 4].map((n) => totalForJars(399, n, INTRO))).toEqual([448, 648, 749, 1148]);
    expect(totalForJars(399, 2, null)).toBe(847);
    expect(totalForJars(399, 0, INTRO)).toBe(0);
  });

  it('lists the tiers that save something', () => {
    expect(offerDeals(INTRO.tier_prices, 399)).toEqual([
      { jars: 2, price: 599, was: 798 },
      { jars: 3, price: 749, was: 1197 },
    ]);
    expect(describeOfferTiers(INTRO.tier_prices)).toBe('1 for ₹399 · 2 for ₹599 · 3 for ₹749');
  });

  it('accepts 2–6 rising whole-rupee tiers, as numbers or text', () => {
    expect(normalizeOfferTiers([399, 599, 749])).toEqual([399, 599, 749]);
    expect(normalizeOfferTiers(['399', '599'])).toEqual([399, 599]);
    expect(normalizeOfferTiers([399])).toBeNull();
    expect(normalizeOfferTiers([399, 399])).toBeNull();
    expect(normalizeOfferTiers([599, 399])).toBeNull();
    expect(normalizeOfferTiers([399, 599.5])).toBeNull();
    expect(normalizeOfferTiers([1, 2, 3, 4, 5, 6, 7])).toBeNull();
    expect(normalizeOfferTiers('399,599')).toBeNull();
  });

  it('reads the settings row: off, broken or missing means no offer', () => {
    expect(shopOfferFromSettings({ offer_active: true, offer_name: ' Introductory offer ', offer_tier_prices: [399, 599, 749] })).toEqual(INTRO);
    expect(shopOfferFromSettings({ offer_active: false, offer_name: 'x', offer_tier_prices: [399, 599] })).toBeNull();
    expect(shopOfferFromSettings({ offer_active: true, offer_name: 'x', offer_tier_prices: [599, 399] })).toBeNull();
    expect(shopOfferFromSettings({ offer_active: true, offer_name: '', offer_tier_prices: [399, 599] })?.name).toBe('Introductory offer');
    expect(shopOfferFromSettings(null)).toBeNull();
  });
});
