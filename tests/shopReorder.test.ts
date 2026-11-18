import { describe, expect, it } from 'vitest';
import { resolveShopReorder } from '@/lib/shop/reorder';
import { shopOrder } from './helpers/shopFixture';
import type { CustomerAddress, ShopLine, ShopProduct } from '@/lib/shop/types';

const product = (p: Partial<ShopProduct> & { id: string }): ShopProduct => ({
  name: p.id, sku: `SKU-${p.id}`, price_inr: 399, net_qty: '50 g', in_stock: true, sort_order: 1,
  line: 'instant', display_name: p.id, pack_grams: 50, ship_weight_kg: 0.1, listed: true, requires_grind: false, description: '',
  ...p,
});
const line = (l: Partial<ShopLine> & { product_id: string }): ShopLine => ({
  name: l.product_id, sku: 'x', unit_price_inr: 399, quantity: 1, line_total_inr: 399, ...l,
});
const order = (lines: ShopLine[]) => shopOrder({ lines });
const classic = product({ id: 'classic' });
const blend = product({ id: 'home-blend-500', line: 'home_blend', requires_grind: true, price_inr: 649 });

describe('resolveShopReorder lines', () => {
  it('keeps a sellable line', () => {
    const r = resolveShopReorder(order([line({ product_id: 'classic', quantity: 2 })]), [classic], []);
    expect(r.items).toEqual([{ product_id: 'classic', quantity: 2 }]);
    expect(r.skipped).toEqual([]);
    expect(r.modified).toEqual([]);
  });
  it('skips a missing or unlisted product', () => {
    const r = resolveShopReorder(
      order([line({ product_id: 'gone', name: 'Gone' }), line({ product_id: 'classic', name: 'Hidden' })]),
      [product({ id: 'classic', listed: false })],
      [],
    );
    expect(r.items).toEqual([]);
    expect(r.skipped).toEqual([
      { name: 'Gone', reason: 'No longer sold' },
      { name: 'Hidden', reason: 'No longer sold' },
    ]);
  });
  it('skips out of stock', () => {
    const r = resolveShopReorder(order([line({ product_id: 'classic', name: 'Classic' })]), [product({ id: 'classic', in_stock: false })], []);
    expect(r.skipped).toEqual([{ name: 'Classic', reason: 'Out of stock right now' }]);
  });
  it('lists a price change and keeps the line', () => {
    const r = resolveShopReorder(
      order([line({ product_id: 'home-blend-500', name: 'Home Blend 500 g', unit_price_inr: 599, grind: 'filter' })]),
      [blend],
      [],
    );
    expect(r.items).toEqual([{ product_id: 'home-blend-500', quantity: 1, grind: 'filter' }]);
    expect(r.modified).toEqual([{ name: 'Home Blend 500 g', old_price_inr: 599, new_price_inr: 649 }]);
  });
  it('skips a Home Blend line whose grind is missing or invalid', () => {
    const bad = { ...line({ product_id: 'home-blend-500', name: 'Home Blend' }), grind: 'turkish' } as unknown as ShopLine;
    const r = resolveShopReorder(order([bad, line({ product_id: 'home-blend-500', name: 'Home Blend', grind: null })]), [blend], []);
    expect(r.items).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['Choose a grind again', 'Choose a grind again']);
  });
  it('caps total units at 12 and says why', () => {
    const r = resolveShopReorder(
      order([line({ product_id: 'classic', name: 'Classic', quantity: 10 }), line({ product_id: 'home-blend-500', name: 'Blend', quantity: 5, grind: 'moka' })]),
      [classic, blend],
      [],
    );
    expect(r.items).toEqual([
      { product_id: 'classic', quantity: 10 },
      { product_id: 'home-blend-500', quantity: 2, grind: 'moka' },
    ]);
    expect(r.skipped).toEqual([{ name: 'Blend', reason: 'Order limit is 12 items' }]);
  });
  it('skips a whole line once the cap is reached', () => {
    const r = resolveShopReorder(
      order([line({ product_id: 'classic', quantity: 12 }), line({ product_id: 'home-blend-500', name: 'Blend', grind: 'moka' })]),
      [classic, blend],
      [],
    );
    expect(r.items).toHaveLength(1);
    expect(r.skipped).toEqual([{ name: 'Blend', reason: 'Order limit is 12 items' }]);
  });
});

describe('resolveShopReorder address', () => {
  const o = shopOrder({ lines: [line({ product_id: 'classic' })] });
  const savedAddr = (a: Partial<CustomerAddress>): CustomerAddress => ({
    id: 'addr-1', user_id: 'u1', label: 'Home', customer_name: o.customer_name, phone: o.phone,
    address_line1: o.address_line1, address_line2: o.address_line2, landmark: '', city: o.city, state: o.state,
    pincode: o.pincode, location_lat: null, location_lng: null, location_source: null, is_default: true,
    last_used_at: null, created_at: '', updated_at: '', ...a,
  });
  it('preselects a matching saved address', () => {
    const r = resolveShopReorder(o, [classic], [savedAddr({ id: 'other', pincode: '110001' }), savedAddr({ id: 'match', city: ' jaipur ' })]);
    expect(r.address_id).toBe('match');
    expect(r.address).toBeNull();
  });
  it('falls back to the frozen address, email included', () => {
    const r = resolveShopReorder(o, [classic], [savedAddr({ pincode: '110001' })]);
    expect(r.address_id).toBeNull();
    expect(r.address).toMatchObject({ email: o.email, pincode: o.pincode, address_line1: o.address_line1, customer_name: o.customer_name });
  });
});
