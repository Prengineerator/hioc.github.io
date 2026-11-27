import { describe, expect, it } from 'vitest';
import {
  describeOfferTiers,
  jarsLabel,
  MAX_UNITS_PER_ORDER,
  normalizeOfferTiers,
  offerDeals,
  parseCartItems,
  rupees,
  shopOfferFromSettings,
} from '@/lib/shop/pricing';

// The shop's price helpers that outlive the v1 pricing functions (removed in
// SV2-14; quoteShopCart is tested in tests/shopPricingV2.test.ts). Shipping,
// caps and the offer's bill are tested there.

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
    expect(parseCartItems([])).toEqual({ ok: false, error: 'Add something to your order' });
    expect(parseCartItems([{ product_id: 'classic', quantity: 0 }]).ok).toBe(false);
  });

  it(`refuses more than ${MAX_UNITS_PER_ORDER} units in all`, () => {
    expect(parseCartItems([{ product_id: 'classic', quantity: 12 }]).ok).toBe(true);
    const over = parseCartItems([
      { product_id: 'classic', quantity: 6 },
      { product_id: 'vanilla', quantity: 7 },
    ]);
    expect(over.ok).toBe(false);
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

describe('the offer helpers', () => {
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
