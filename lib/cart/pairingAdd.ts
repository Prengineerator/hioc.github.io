// Checkout pairings — the pure rules behind the "Pairs well with your order" card's
// Add button (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §1.2). Kept free of React so the
// rule that decides between a one-tap add and the customise modal can be
// unit-tested (tests/cartPairing.test.ts).

import type { CartItem } from '@/lib/cart/CartContext';
import { defaultOptionIds, flattenAddons, initialSelection, invalidGroups, isRequired } from '@/lib/menu/customization';
import { isSoldByWeight } from '@/lib/menu/weight';
import type { MenuItem } from '@/lib/types';

/** What CartContext.addItem takes. */
export type PairingCartLine = Omit<CartItem, 'qty' | 'key'>;

/**
 * The cart line for a one-tap add of `item` beside the cart item `anchorId`, or
 * null when the item needs the customise modal. One tap is right only when there
 * is nothing for the customer to choose and nothing that quietly costs more:
 *
 *  - exactly one variant (several sizes is a choice), and
 *  - not sold by weight (how many grams is a choice), and
 *  - every REQUIRED add-on group's default options (`defaultOptionIds`, the ones
 *    the modal itself would preselect) exist, are switched on, and cost ₹0, and
 *    together answer the group's min/max rule.
 *
 * Optional groups are left empty, exactly as the modal opens them. The line is
 * built from the same `initialSelection` + `flattenAddons` the modal uses, so it
 * is the line the modal would add if the customer tapped "Add to Cart" straight
 * away. `pairingAnchorId` rides on the line (§4.3).
 */
export function quickAddLine(item: MenuItem, anchorId: string): PairingCartLine | null {
  if (item.variants.length !== 1 || isSoldByWeight(item)) return null;
  const variant = item.variants[0];

  for (const group of item.addon_groups) {
    if (!isRequired(group)) continue;
    for (const id of defaultOptionIds(group)) {
      const option = group.options.find((o) => o.id === id);
      if (!option || option.price_inr !== 0 || option.is_available === false) return null;
    }
  }

  const selection = initialSelection(item);
  // A required group with too few options to fill (or none switched on) can't be
  // answered by default; the modal makes the customer say so.
  if (invalidGroups(item, selection).length > 0) return null;

  const addons = flattenAddons(item, selection);
  return {
    menuItemId: item.id,
    variantId: variant.id,
    name: item.name,
    variantLabel: variant.label,
    unitPriceInr: variant.price_inr + addons.reduce((sum, a) => sum + a.priceInr, 0),
    gstExempt: item.gst_exempt === true,
    addons,
    specialInstructions: '',
    pairingAnchorId: anchorId,
  };
}

/** The cheapest size's price, or null when the item has none ("from ₹min"). */
export function minVariantPriceInr(item: Pick<MenuItem, 'variants'>): number | null {
  const prices = item.variants.map((v) => v.price_inr).filter((p) => Number.isFinite(p));
  return prices.length > 0 ? Math.min(...prices) : null;
}
