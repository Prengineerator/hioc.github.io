// "Order again" for a shop order (docs/SHOP-V2-SPEC.md E4, E3). Pure: a past
// order's frozen lines are checked against TODAY's catalogue and the result is
// a cart the /shop page can open straight on its Pay step.
//
//   - a flavour that is gone or no longer listed   → skipped, 'No longer sold'
//   - out of stock                                  → skipped, 'Out of stock right now'
//   - a Home Blend line whose grind is no longer
//     valid for the product                         → skipped, 'Choose a grind again'
//   - the price moved                               → kept at today's price and
//                                                     listed in `modified`
//   - quantities are kept, but an order is 12 units at most; the excess is
//     skipped, 'Order limit is 12 items'
//
// Address (E3): the first saved address that is the same place to deliver
// (sameDeliveryAddress) is preselected by id; otherwise the order's frozen
// address, email included, comes back as an unsaved `address` for the form.
//
// Prices are shown, never trusted: checkout re-prices server-side.

import { isGrindCode } from '@/lib/shop/catalog';
import { sameDeliveryAddress } from '@/lib/shop/address';
import { MAX_UNITS_PER_ORDER, type CartItem } from '@/lib/shop/pricing';
import type { CustomerAddress, ShopAddress, ShopOrderRow, ShopProduct } from '@/lib/shop/types';

export interface ShopReorderResponse {
  items: CartItem[];
  skipped: { name: string; reason: string }[];
  modified: { name: string; old_price_inr: number; new_price_inr: number }[];
  address_id: string | null;
  address: ShopAddress | null;
}

type ReorderOrder = Pick<
  ShopOrderRow,
  'lines' | 'customer_name' | 'phone' | 'email' | 'address_line1' | 'address_line2' | 'landmark' | 'city' | 'state' | 'pincode'
>;

export function resolveShopReorder(
  order: ReorderOrder,
  products: readonly ShopProduct[],
  saved: readonly CustomerAddress[],
): ShopReorderResponse {
  const byId = new Map(products.map((p) => [p.id, p]));
  const items: CartItem[] = [];
  const skipped: ShopReorderResponse['skipped'] = [];
  const modified: ShopReorderResponse['modified'] = [];
  let units = 0;

  for (const line of order.lines ?? []) {
    const product = byId.get(line.product_id);
    if (!product || product.listed === false) {
      skipped.push({ name: line.name, reason: 'No longer sold' });
      continue;
    }
    if (!product.in_stock) {
      skipped.push({ name: line.name, reason: 'Out of stock right now' });
      continue;
    }
    // Home Blend: the grind must still be one we offer, and required where the
    // product needs one. A product with no grind drops a stale one.
    let grind: CartItem['grind'] = null;
    if (product.requires_grind) {
      if (!isGrindCode(line.grind)) {
        skipped.push({ name: line.name, reason: 'Choose a grind again' });
        continue;
      }
      grind = line.grind;
    }

    const room = MAX_UNITS_PER_ORDER - units;
    if (room <= 0) {
      skipped.push({ name: line.name, reason: `Order limit is ${MAX_UNITS_PER_ORDER} items` });
      continue;
    }
    const quantity = Math.min(line.quantity, room);
    if (quantity < line.quantity) {
      skipped.push({ name: line.name, reason: `Order limit is ${MAX_UNITS_PER_ORDER} items` });
    }
    if (quantity <= 0) continue;
    units += quantity;

    if (product.price_inr !== line.unit_price_inr) {
      modified.push({ name: line.name, old_price_inr: line.unit_price_inr, new_price_inr: product.price_inr });
    }
    const key = `${product.id}:${grind ?? ''}`;
    const had = items.find((i) => `${i.product_id}:${i.grind ?? ''}` === key);
    if (had) had.quantity += quantity;
    else items.push(grind ? { product_id: product.id, quantity, grind } : { product_id: product.id, quantity });
  }

  const match = saved.find((a) => sameDeliveryAddress(a, order));
  const address: ShopAddress | null = match
    ? null
    : {
        customer_name: order.customer_name,
        phone: order.phone,
        email: order.email,
        address_line1: order.address_line1,
        address_line2: order.address_line2,
        landmark: order.landmark ?? '',
        city: order.city,
        state: order.state,
        pincode: order.pincode,
      };
  return { items, skipped, modified, address_id: match?.id ?? null, address };
}
