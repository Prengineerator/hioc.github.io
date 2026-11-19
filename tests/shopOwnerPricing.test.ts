import { describe, expect, it } from 'vitest';
import { DEFAULT_SHOP_SETTINGS, quoteShopCart, type ShopPricingInput } from '@/lib/shop/pricing';
import type { ShopCouponTerms, ShopProduct } from '@/lib/shop/types';

// Owner discount (docs/SHOP-OWNER-ORDERS-SPEC.md): a step after the offer and coupon,
// before Beanies and shipping; whole rupees; at most 50% of the goods after offers.

const inst = (id: string, name: string, sort: number, price = 399): ShopProduct => ({
  id, name, sku: `HIOC-IC-${id.toUpperCase()}-50G`, price_inr: price, net_qty: '50 g', in_stock: true, sort_order: sort,
  line: 'instant', display_name: name, pack_grams: 50, ship_weight_kg: 0.3, listed: true, requires_grind: false, description: '',
});
const hb = (id: string, grams: number, price: number, sort: number, kg: number): ShopProduct => ({
  id, name: `Home Blend ${grams}`, sku: `HIOC-HB-${grams}G`, price_inr: price, net_qty: `${grams} g`, in_stock: true, sort_order: sort,
  line: 'home_blend', display_name: `Signature Home Blend ${grams}`, pack_grams: grams, ship_weight_kg: kg, listed: true,
  requires_grind: true, description: '',
});
const PRODUCTS: ShopProduct[] = [
  inst('classic', 'Signature Classic', 1),
  inst('hazelnut', 'Nutty Hazelnut', 2),
  inst('vanilla', 'Vanilla', 3),
  hb('hb-250', 250, 525, 10, 0.3),
  hb('hb-1000', 1000, 1750, 11, 1.1),
];
const SETTINGS = { ...DEFAULT_SHOP_SETTINGS, offer: { name: 'Introductory offer', tier_prices: [399, 599, 749] } };

const run = (o: Partial<ShopPricingInput> & Pick<ShopPricingInput, 'items'>) =>
  quoteShopCart({ products: PRODUCTS, settings: SETTINGS, intro_eligible: true, coupon: null, beanies: null, ...o });
const ok = (o: Parameters<typeof run>[0]) => {
  const r = run(o);
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe('the spec’s three worked examples', () => {
  it('1. first-time customer, 2 x Home Blend 250 g + 1 jar, ₹100 owner discount -> ₹1,349', () => {
    const q = ok({
      items: [
        { product_id: 'hb-250', quantity: 2, grind: 'filter' },
        { product_id: 'classic', quantity: 1 },
      ],
      owner_discount_inr: 100,
    });
    expect(q.subtotal_inr).toBe(1449); // 2 x 525 + 399
    expect(q.offer_discount_inr).toBe(0); // one jar: 399 either way
    expect(q.owner_discount_inr).toBe(100);
    expect(q.shipping_inr).toBe(0); // goods after discounts 1,349 >= 749
    expect(q.discount_inr).toBe(100);
    expect(q.total_inr).toBe(1349);
  });

  it('2. first-time customer, Hazelnut + Vanilla: the website’s ₹648, owner discount 0', () => {
    const items = [
      { product_id: 'hazelnut', quantity: 1 },
      { product_id: 'vanilla', quantity: 1 },
    ];
    const q = ok({ items, owner_discount_inr: 0 });
    expect(q.subtotal_inr).toBe(798);
    expect(q.offer_discount_inr).toBe(199); // 2 for 599
    expect(q.shipping_inr).toBe(49); // goods after the offer 599 < 749
    expect(q.total_inr).toBe(648);
    // Exactly what the website charges (no owner discount input at all).
    expect(ok({ items }).total_inr).toBe(648);
  });

  it('3. repeat customer, 1 kg Home Blend, no offer: ₹1,750 and free shipping', () => {
    const q = ok({ items: [{ product_id: 'hb-1000', quantity: 1, grind: 'espresso' }], intro_eligible: false });
    expect(q.subtotal_inr).toBe(1750);
    expect(q.shipping_inr).toBe(0);
    expect(q.total_inr).toBe(1750);
  });
});

describe('owner discount rules', () => {
  const items = [
    { product_id: 'hazelnut', quantity: 1 },
    { product_id: 'vanilla', quantity: 1 },
  ];

  it('is taken after the offer: the cap is 50% of the goods after offers (₹599 -> ₹299)', () => {
    expect(ok({ items, owner_discount_inr: 299 }).total_inr).toBe(599 - 299 + 49); // 349
    const over = run({ items, owner_discount_inr: 300 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.error).toMatch(/at most ₹299/);
  });

  it('shipping follows the goods after ALL discounts (₹800 goods, ₹60 off -> ₹740 < ₹749 -> ₹49 shipping)', () => {
    const q = ok({ items: [{ product_id: 'hb-250', quantity: 1, grind: 'filter' }, { product_id: 'hb-250', quantity: 1, grind: 'moka' }], owner_discount_inr: 0 });
    expect(q.subtotal_inr).toBe(1050);
    const cheap = ok({ items: [{ product_id: 'hb-250', quantity: 1, grind: 'filter' }, { product_id: 'classic', quantity: 1 }], intro_eligible: false, owner_discount_inr: 200 });
    // 525 + 399 = 924; -200 = 724 < 749 -> shipping 49
    expect(cheap.goods_after_discounts_inr).toBe(724);
    expect(cheap.shipping_inr).toBe(49);
    expect(cheap.total_inr).toBe(924 - 200 + 49);
    expect(cheap.free_shipping_gap_inr).toBe(25);
  });

  it('rounds the cap down: 50% of ₹399 is ₹199, not ₹200', () => {
    expect(run({ items: [{ product_id: 'classic', quantity: 1 }], intro_eligible: false, owner_discount_inr: 199 }).ok).toBe(true);
    expect(run({ items: [{ product_id: 'classic', quantity: 1 }], intro_eligible: false, owner_discount_inr: 200 }).ok).toBe(false);
  });

  it('is a step after a coupon too: 10% coupon on ₹1,050 is ₹105, cap is 50% of ₹945 = ₹472', () => {
    const coupon: ShopCouponTerms = {
      id: 'c1', code: 'TEN', discount_type: 'percent', discount_value: 10, min_order_inr: 0, max_discount_inr: 0, shop_product_ids: [], is_auto: false,
    };
    const items = [{ product_id: 'hb-250', quantity: 2, grind: 'filter' as const }];
    const q = ok({ items, coupon, owner_discount_inr: 472 });
    expect(q.coupon_discount_inr).toBe(105);
    expect(q.discount_inr).toBe(105 + 472);
    expect(q.total_inr).toBe(1050 - 577 + 49); // goods 473 < 749
    expect(run({ items, coupon, owner_discount_inr: 473 }).ok).toBe(false);
  });

  it('refuses a negative, fractional or non-number amount', () => {
    for (const bad of [-1, 10.5, Number.NaN, '50' as unknown as number]) {
      const r = run({ items, owner_discount_inr: bad });
      expect(r.ok).toBe(false);
    }
  });

  it('never lets the total reach ₹0 (a ₹1 order at the cap still costs at least ₹1)', () => {
    const one = [inst('penny', 'Penny', 1, 1)];
    const r = quoteShopCart({ products: one, items: [{ product_id: 'penny', quantity: 1 }], settings: { ...DEFAULT_SHOP_SETTINGS, shipping_fee_inr: 0 }, intro_eligible: false, coupon: null, beanies: null, owner_discount_inr: 0 });
    expect(r.ok && r.total_inr).toBe(1);
    const capped = quoteShopCart({ products: one, items: [{ product_id: 'penny', quantity: 1 }], settings: { ...DEFAULT_SHOP_SETTINGS, shipping_fee_inr: 0 }, intro_eligible: false, coupon: null, beanies: null, owner_discount_inr: 1 });
    expect(capped.ok).toBe(false); // 50% of ₹1 rounds down to ₹0
  });

  it('absent, the website’s numbers are unchanged and owner_discount_inr is 0', () => {
    const q = ok({ items: [{ product_id: 'classic', quantity: 3 }] });
    expect(q.owner_discount_inr).toBe(0);
    expect(q.offer_discount_inr).toBe(448); // 3 x 399 = 1,197 -> 749
    expect(q.discount_inr).toBe(448);
    expect(q.total_inr).toBe(749);
  });

  it('Beanies (website only) are worked out on the goods after the owner discount', () => {
    const beanies = { signed_in: true, repeat_customer: true, balance: 500, min_redeem_points: 50, inr_per_point: 1, points_per_inr: 0.05, use: true };
    const q = ok({ items: [{ product_id: 'hb-1000', quantity: 1, grind: 'filter' }], intro_eligible: false, owner_discount_inr: 250, beanies });
    // goods 1,750 - 250 = 1,500; 5% = 75 Beanies
    expect(q.beanies_discount_inr).toBe(75);
    expect(q.discount_inr).toBe(250 + 75);
    expect(q.total_inr).toBe(1750 - 325);
  });
});
