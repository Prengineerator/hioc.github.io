import { describe, expect, it } from 'vitest';
import { checkoutFingerprintSource, isIdempotencyKey } from '@/lib/shop/checkoutKey';
import type { ShopAddress } from '@/lib/shop/types';

// The checkout's double-tap guard (lib/shop/checkoutKey.ts): what counts as a
// key, and what makes two checkouts "the same cart".

const ADDRESS: ShopAddress = {
  customer_name: 'Riya Sharma',
  phone: '+919876543210',
  email: 'riya@example.com',
  address_line1: '12, Rose Villa, MG Road',
  address_line2: '',
  landmark: '',
  city: 'Jaipur',
  state: 'Rajasthan',
  pincode: '302001',
};

const base = {
  items: [
    { product_id: 'classic', quantity: 2 },
    { product_id: 'home-blend-250', quantity: 1, grind: 'filter' as const },
  ],
  address: ADDRESS,
  address_id: null,
  coupon_code: null,
  use_beanies: true,
  save_address_label: null,
};

describe('isIdempotencyKey', () => {
  it('accepts a v4 uuid in either case', () => {
    expect(isIdempotencyKey('3f2b8c1e-5d4a-4b6f-9a7c-1e2d3c4b5a69')).toBe(true);
    expect(isIdempotencyKey('3F2B8C1E-5D4A-4B6F-9A7C-1E2D3C4B5A69')).toBe(true);
  });

  it('refuses anything else', () => {
    for (const v of ['', 'abc', '3f2b8c1e5d4a4b6f9a7c1e2d3c4b5a69', '3f2b8c1e-5d4a-1b6f-9a7c-1e2d3c4b5a69', null, undefined, 42, {}]) {
      expect(isIdempotencyKey(v)).toBe(false);
    }
    expect(isIdempotencyKey('3f2b8c1e-5d4a-4b6f-9a7c-1e2d3c4b5a69 ')).toBe(false);
  });
});

describe('checkoutFingerprintSource', () => {
  it('does not depend on item order or key order', () => {
    const a = checkoutFingerprintSource(base);
    const b = checkoutFingerprintSource({
      ...base,
      items: [{ grind: 'filter' as const, quantity: 1, product_id: 'home-blend-250' }, { quantity: 2, product_id: 'classic' }],
      address: Object.fromEntries(Object.entries(ADDRESS).reverse()) as unknown as ShopAddress,
    });
    expect(b).toBe(a);
  });

  it('changes with anything that changes the price or the parcel', () => {
    const a = checkoutFingerprintSource(base);
    const variants = [
      { ...base, items: [{ product_id: 'classic', quantity: 3 }, base.items[1]] },
      { ...base, items: [base.items[0], { ...base.items[1], grind: 'moka' as const }] },
      { ...base, address: { ...ADDRESS, pincode: '302002' } },
      { ...base, address: null, address_id: 'b3a1c2d4-0000-4000-8000-000000000001' },
      { ...base, coupon_code: 'WELCOME10' },
      { ...base, use_beanies: false },
      { ...base, save_address_label: 'Home' },
    ];
    for (const v of variants) expect(checkoutFingerprintSource(v)).not.toBe(a);
  });

  it('treats a coupon code case-insensitively and a missing grind as null', () => {
    const typed = checkoutFingerprintSource({ ...base, coupon_code: ' Welcome10 ' });
    expect(checkoutFingerprintSource({ ...base, coupon_code: 'WELCOME10' })).toBe(typed);
    expect(checkoutFingerprintSource({ ...base, items: [{ product_id: 'classic', quantity: 1, grind: null }] })).toBe(
      checkoutFingerprintSource({ ...base, items: [{ product_id: 'classic', quantity: 1 }] }),
    );
  });

  it('is valid JSON', () => {
    expect(() => JSON.parse(checkoutFingerprintSource(base))).not.toThrow();
  });
});
