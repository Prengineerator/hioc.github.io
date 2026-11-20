import { describe, expect, it } from 'vitest';
import { canListProduct, parseProductPatch, productPatchListingError, productPatchNeedsV2, parseShopSettingsPatch, shopOrdersCsvTable } from '@/lib/shop/owner';
import { shopOrder } from './helpers/shopFixture';

// Owner-side pure helpers (lib/shop/owner.ts): the Products card and settings
// PATCH validation (docs/SHOP-V2-SPEC.md E1, E2, E5) and the accountant's CSV (E6).

describe('parseProductPatch', () => {
  it('accepts each field and rounds the weight to 3 dp', () => {
    expect(parseProductPatch({ price_inr: 649 })).toEqual({ ok: true, patch: { price_inr: 649 } });
    expect(parseProductPatch({ listed: true, in_stock: false })).toEqual({ ok: true, patch: { listed: true, in_stock: false } });
    expect(parseProductPatch({ ship_weight_kg: 0.5204 })).toEqual({ ok: true, patch: { ship_weight_kg: 0.52 } });
    expect(parseProductPatch({ description: '  Roasted   in\n small batches ' })).toEqual({ ok: true, patch: { description: 'Roasted in small batches' } });
  });

  it('refuses bad prices', () => {
    for (const price_inr of [0, -5, 1.5, 100001, '400', null]) {
      expect(parseProductPatch({ price_inr })).toEqual({ ok: false, error: 'Price must be whole rupees, ₹1 to ₹1,00,000' });
    }
    expect(parseProductPatch({ price_inr: 100000 }).ok).toBe(true);
  });

  it('refuses bad weights, flags and descriptions', () => {
    for (const ship_weight_kg of [0.04, 10.1, '1', Number.NaN]) {
      expect(parseProductPatch({ ship_weight_kg })).toEqual({ ok: false, error: 'Packed weight must be between 0.05 and 10 kg' });
    }
    expect(parseProductPatch({ listed: 'yes' }).ok).toBe(false);
    expect(parseProductPatch({ in_stock: 1 }).ok).toBe(false);
    expect(parseProductPatch({ description: 'x'.repeat(161) }).ok).toBe(false);
    expect(parseProductPatch({ description: 'x'.repeat(160) }).ok).toBe(true);
    expect(parseProductPatch({ description: 5 }).ok).toBe(false);
  });

  it('refuses an empty patch', () => {
    expect(parseProductPatch({})).toEqual({ ok: false, error: 'Nothing to change' });
    expect(parseProductPatch({ unknown: 1 })).toEqual({ ok: false, error: 'Nothing to change' });
  });
});

describe('canListProduct', () => {
  it('needs a price above the placeholder', () => {
    expect(canListProduct(1)).toBe(false);
    expect(canListProduct(2)).toBe(true);
    expect(canListProduct(Number.NaN)).toBe(false);
  });
});

describe('productPatchListingError', () => {
  const MSG = 'Set a real price before listing this product';
  it('refuses listing a placeholder-priced product', () => {
    expect(productPatchListingError({ listed: true }, { price_inr: 1, listed: false })).toBe(MSG);
    expect(productPatchListingError({ listed: true }, { price_inr: '1', listed: false })).toBe(MSG);
  });
  it('refuses setting the price to 1 on an already listed product', () => {
    expect(productPatchListingError({ price_inr: 1 }, { price_inr: 399, listed: true })).toBe(MSG);
  });
  it('allows a real price, and lists with the patched price', () => {
    expect(productPatchListingError({ price_inr: 450 }, { price_inr: 399, listed: true })).toBeNull();
    expect(productPatchListingError({ listed: true, price_inr: 450 }, { price_inr: 1, listed: false })).toBeNull();
  });
  it('lets an unlisted product keep the placeholder price, and unlisting always works', () => {
    expect(productPatchListingError({ price_inr: 1 }, { price_inr: 399, listed: false })).toBeNull();
    expect(productPatchListingError({ listed: false }, { price_inr: 1, listed: true })).toBeNull();
    expect(productPatchListingError({ in_stock: false } as never, { price_inr: 1, listed: false })).toBeNull();
  });
  it('flags an already listed placeholder-priced row on any patch', () => {
    expect(productPatchListingError({ description: 'x' } as never, { price_inr: 1, listed: true })).toBe(MSG);
  });
});

describe('productPatchNeedsV2', () => {
  it('is false only for the in-stock toggle', () => {
    expect(productPatchNeedsV2({ in_stock: true })).toBe(false);
    expect(productPatchNeedsV2({ in_stock: true, price_inr: 5 })).toBe(true);
    expect(productPatchNeedsV2({ listed: true })).toBe(true);
  });
});

describe('parseShopSettingsPatch', () => {
  it('keeps the offer rules', () => {
    expect(parseShopSettingsPatch({ offer_active: false, offer_name: '  Intro  offer ', offer_tier_prices: [399, 599, 749] })).toEqual({
      ok: true,
      patch: { offer_active: false, offer_name: 'Intro offer', offer_tier_prices: [399, 599, 749] },
    });
    expect(parseShopSettingsPatch({ offer_active: 'on' }).ok).toBe(false);
    expect(parseShopSettingsPatch({ offer_name: '' }).ok).toBe(false);
    expect(parseShopSettingsPatch({ offer_name: 'x'.repeat(41) }).ok).toBe(false);
    expect(parseShopSettingsPatch({ offer_tier_prices: [399] }).ok).toBe(false);
    expect(parseShopSettingsPatch({ offer_tier_prices: [599, 399] }).ok).toBe(false);
  });

  it('bounds shipping and the Beanies limit', () => {
    expect(parseShopSettingsPatch({ shipping_fee_inr: 0, free_shipping_min_inr: 100000, beanies_max_redeem_pct: 50 })).toEqual({
      ok: true,
      patch: { shipping_fee_inr: 0, free_shipping_min_inr: 100000, beanies_max_redeem_pct: 50 },
    });
    for (const body of [
      { shipping_fee_inr: 501 },
      { shipping_fee_inr: -1 },
      { shipping_fee_inr: 49.5 },
      { free_shipping_min_inr: 100001 },
      { beanies_max_redeem_pct: 51 },
      { beanies_max_redeem_pct: '5' },
    ]) {
      expect(parseShopSettingsPatch(body).ok).toBe(false);
    }
    expect(parseShopSettingsPatch({})).toEqual({ ok: false, error: 'Nothing to change' });
  });
});

describe('shopOrdersCsvTable', () => {
  const col = (t: ReturnType<typeof shopOrdersCsvTable>, name: string, row = 0) => t.rows[row][t.columns.indexOf(name)];

  it('adds channel, line, grind, discount and Beanies columns for a mixed order', () => {
    const order = shopOrder({
      jar_count: 3,
      subtotal_inr: 1497,
      discount_inr: 205,
      offer_name: 'Introductory offer',
      offer_discount_inr: 100,
      coupon_code: 'WELCOME',
      coupon_discount_inr: 75,
      beanies_redeemed: 30,
      beanies_discount_inr: 30,
      intro_offer_reused: true,
      lines: [
        { product_id: 'hazelnut', name: 'Nutty Hazelnut', sku: 'S1', unit_price_inr: 399, quantity: 2, line_total_inr: 798 },
        { product_id: 'hb', name: 'Signature Home Blend', sku: 'S2-FLT', unit_price_inr: 699, quantity: 1, line_total_inr: 699, line: 'home_blend', pack_grams: 500, grind: 'filter', grind_label: 'Pour-over / Filter' },
      ],
    });
    const t = shopOrdersCsvTable([order]);
    expect(t.rows[0]).toHaveLength(t.columns.length);
    expect(t.columns).toContain('Units');
    expect(t.columns).toContain('Goods (₹)');
    expect(t.columns).not.toContain('Jars');
    expect(col(t, 'Items')).toBe('Nutty Hazelnut × 2; Signature Home Blend (Pour-over / Filter) × 1');
    expect(col(t, 'Channel')).toBe('Shop');
    expect(col(t, 'Line(s)')).toBe('Instant; Home Blend');
    expect(col(t, 'Grind(s)')).toBe('Pour-over / Filter');
    expect(col(t, 'Units')).toBe(3);
    expect(col(t, 'Goods (₹)')).toBe(1497);
    expect(col(t, 'Offer')).toBe('Introductory offer');
    expect(col(t, 'Offer (₹)')).toBe(100);
    expect(col(t, 'Coupon code')).toBe('WELCOME');
    expect(col(t, 'Coupon (₹)')).toBe(75);
    expect(col(t, 'Beanies used')).toBe(30);
    expect(col(t, 'Beanies (₹)')).toBe(30);
    expect(col(t, 'Intro offer reused')).toBe('Yes');
  });

  it('reads a legacy v1 row: the old discount is the offer', () => {
    const t = shopOrdersCsvTable([{ ...shopOrder({ discount_inr: 199, offer_name: 'Introductory offer' }), offer_discount_inr: 0 }]);
    expect(t.rows[0]).toHaveLength(t.columns.length);
    expect(col(t, 'Offer (₹)')).toBe(199);
    expect(col(t, 'Line(s)')).toBe('Instant');
    expect(col(t, 'Grind(s)')).toBe('');
    expect(col(t, 'Coupon code')).toBe('');
    expect(col(t, 'Beanies used')).toBe(0);
    expect(col(t, 'Intro offer reused')).toBe('');
    expect(col(t, 'Items')).toBe('Signature Classic × 2');
  });

  it('adds the carrier and what the café paid Amazon for the label', () => {
    const none = shopOrdersCsvTable([shopOrder({})]);
    expect(col(none, 'Carrier')).toBe('');
    expect(col(none, 'Amazon label (₹)')).toBe('');
    const sr = shopOrdersCsvTable([shopOrder({ shiprocket_order_id: '123' })]);
    expect(col(sr, 'Carrier')).toBe('Shiprocket');
    const az = shopOrdersCsvTable([shopOrder({ carrier: 'amazon', amazon_shipment_id: 'SHP1', amazon_charge_inr: 62 })]);
    expect(az.rows[0]).toHaveLength(az.columns.length);
    expect(col(az, 'Carrier')).toBe('Amazon Shipping');
    expect(col(az, 'Amazon label (₹)')).toBe(62);
  });
});
