// Shared in-memory pieces for the owner-entered shop order tests
// (tests/shopOwnerOrders*.test.ts): products, a fake database with the RPCs capture
// calls, and a serverQuote that runs the REAL quoteShopCart over those products.

import { makeFakeAdmin, type Row } from './fakeAdmin';
import { DEFAULT_SHOP_SETTINGS, quoteShopCart, type CartItem } from '@/lib/shop/pricing';
import type { ShopCouponTerms, ShopProduct } from '@/lib/shop/types';

const inst = (id: string, name: string, sort: number, price = 399): ShopProduct => ({
  id, name, sku: `HIOC-IC-${id.toUpperCase()}-50G`, price_inr: price, net_qty: '50 g', in_stock: true, sort_order: sort,
  line: 'instant', display_name: name, pack_grams: 50, ship_weight_kg: 0.3, listed: true, requires_grind: false, description: '',
});
const hb = (id: string, grams: number, price: number, sort: number, kg: number): ShopProduct => ({
  id, name: `Home Blend ${grams}`, sku: `HIOC-HB-${grams}G`, price_inr: price, net_qty: `${grams} g`, in_stock: true, sort_order: sort,
  line: 'home_blend', display_name: `Signature Home Blend ${grams}`, pack_grams: grams, ship_weight_kg: kg, listed: true,
  requires_grind: true, description: '',
});
export const PRODUCTS: ShopProduct[] = [
  inst('classic', 'Signature Classic', 1),
  inst('hazelnut', 'Nutty Hazelnut', 2),
  inst('vanilla', 'Vanilla', 3),
  hb('hb-250', 250, 525, 10, 0.3),
  hb('hb-1000', 1000, 1750, 11, 1.1),
];
export const SETTINGS = { ...DEFAULT_SHOP_SETTINGS, offer: { name: 'Introductory offer', tier_prices: [399, 599, 749] } };

export interface HarnessState {
  tables: Record<string, Row[]>;
  admin: unknown;
  rpcCalls: { fn: string; args: Record<string, unknown> }[];
  introEligible: boolean;
  coupons: Record<string, ShopCouponTerms>;
  linkedUserId: string | null;
}

/** The fake database, plus rpc() and a shop_orders default order number (the DB sequence). */
export function makeAdmin(state: HarnessState) {
  const base = makeFakeAdmin(state.tables, {
    startMs: Date.parse('2026-11-19T08:00:00Z'),
    defaults: (table, row) => (table === 'shop_orders' ? { order_number: 1042, ...row } : row),
  });
  return {
    ...base,
    rpc: (fn: string, args: Record<string, unknown>) => {
      state.rpcCalls.push({ fn, args });
      return Promise.resolve({ data: fn === 'claim_shop_intro_offer' ? 'claimed' : fn === 'record_shop_coupon_redemption' ? 'recorded' : null, error: null });
    },
  };
}

/** serverQuote over the fixture products: the real quoteShopCart, with the state's eligibility and coupons. */
export function fakeServerQuote(state: HarnessState) {
  return (_admin: unknown, req: { items: CartItem[]; coupon_code: string | null; owner_discount_inr?: number }) => {
    const code = req.coupon_code?.toUpperCase() ?? null;
    const coupon = code ? state.coupons[code] ?? null : null;
    const r = quoteShopCart({
      products: PRODUCTS,
      items: req.items,
      settings: SETTINGS,
      intro_eligible: state.introEligible,
      coupon,
      beanies: null,
      owner_discount_inr: req.owner_discount_inr,
    });
    if (!r.ok) return Promise.resolve({ ok: false, status: 400, error: r.error });
    const { ok: _ok, ...quote } = r;
    void _ok;
    return Promise.resolve({
      ok: true,
      quote,
      coupon_error: code && !coupon ? 'That code is not valid' : null,
      settings: SETTINGS,
      products: PRODUCTS,
    });
  };
}

export const KEY = '6f1c2a4e-8b3d-4c5e-9a7f-1d2e3f4a5b6c';

/** A valid owner-order body: 2 x Home Blend 250 g (Filter) + 1 jar, goods ₹1,449. */
export function ownerBody(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotency_key: KEY,
    address: {
      customer_name: 'Test Customer',
      phone: '9876543210',
      email: '',
      address_line1: '12 Test Street, Sample Colony',
      address_line2: '',
      landmark: '',
      city: 'Jaipur',
      state: 'Rajasthan',
      pincode: '302001',
    },
    items: [
      { product_id: 'hb-250', quantity: 2, grind: 'filter' },
      { product_id: 'classic', quantity: 1 },
    ],
    payment: { kind: 'link' },
    expected_total_inr: 1449,
    ...patch,
  };
}
