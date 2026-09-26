// POS-5 — turns a past order's items (from GET /api/customers/orders) into
// cart lines for the CURRENT menu, for the "Repeat" button on the "Last
// orders" modal. Deliberately pure and Supabase-free: the POS already has the
// live menu loaded (the same `menuItems` the tap-to-add grid uses), so this
// resolves against THAT in memory instead of a second server round trip —
// the "don't slow down order placement" half of POS-5's perf goal.
//
// Mirrors GET /api/account/reorder/[orderId]'s resolution rules (current
// availability, variant still offered, addon options still offered) closely
// on purpose — a line that can't be repeated on the website can't be
// repeated at the counter either, for the same reasons. It stays a separate
// module rather than a shared one because that route resolves against
// freshly-queried `menu_items` rows (async, server-side); this resolves
// against an already-loaded `MenuItem[]` (sync, client-side) — the shapes
// converge but the fetch never should.
//
// Pricing is NOT decided here. Every added line still flows through addLine()
// and then POST /api/orders/quote exactly like a tap on the menu grid — this
// only picks WHICH item/variant/addons to add, using each variant/option's
// CURRENT price (never the order's old price_inr_snapshot).

import { isMenuItemAvailable } from '@/lib/menu/availability';
import type { CartAddonSelection, CartItem } from '@/lib/cart/CartContext';
import type { CustomerOrderItemResponse, LegacyOrderItemResponse } from '@/lib/api/customerOrders';
import type { MenuItem } from '@/lib/types';

/** A cart-ready line — everything addLine() needs, including qty (the caller
 * splits `qty` back out before calling addLine, which takes it separately). */
export type RepeatCartLine = Omit<CartItem, 'key'>;

export interface RepeatNotice {
  name: string;
  reason: string;
}

export interface RepeatOrderResult {
  lines: RepeatCartLine[];
  /** Whole lines dropped — the item, its variant, or the item itself is gone. */
  skipped: RepeatNotice[];
  /** Lines kept, but with one or more add-ons dropped (no longer offered). */
  modified: RepeatNotice[];
}

/**
 * Resolves a past order's (non-voided) items against the CURRENT menu.
 * A voided line is silently excluded — it was struck off the original order
 * and re-adding it isn't "repeating", it's undoing a correction someone made.
 */
export function mapOrderItemsToCartLines(
  orderItems: readonly CustomerOrderItemResponse[],
  menuItems: readonly MenuItem[],
): RepeatOrderResult {
  const menuById = new Map(menuItems.map((item) => [item.id, item]));

  const lines: RepeatCartLine[] = [];
  const skipped: RepeatNotice[] = [];
  const modified: RepeatNotice[] = [];

  for (const orderItem of orderItems) {
    if (orderItem.voided) continue;

    const displayName = orderItem.name_snapshot;

    if (!orderItem.menu_item_id) {
      skipped.push({ name: displayName, reason: 'No longer on the menu' });
      continue;
    }
    const menuItem = menuById.get(orderItem.menu_item_id);
    if (!menuItem || !isMenuItemAvailable(menuItem)) {
      skipped.push({ name: displayName, reason: 'Currently unavailable' });
      continue;
    }
    const variant = orderItem.variant_id
      ? menuItem.variants.find((v) => v.id === orderItem.variant_id)
      : undefined;
    if (!variant) {
      skipped.push({ name: displayName, reason: 'This option is no longer offered' });
      continue;
    }

    const optionById = new Map<string, { option: MenuItem['addon_groups'][number]['options'][number]; group: MenuItem['addon_groups'][number] }>();
    for (const group of menuItem.addon_groups) {
      for (const option of group.options) {
        optionById.set(option.id, { option, group });
      }
    }

    const kept: CartAddonSelection[] = [];
    let droppedAddon = false;
    for (const addon of orderItem.addons ?? []) {
      const found = addon.addon_option_id ? optionById.get(addon.addon_option_id) : undefined;
      if (!found) {
        droppedAddon = true;
        continue;
      }
      kept.push({
        optionId: found.option.id,
        groupName: found.group.display_name,
        optionName: found.option.name,
        priceInr: found.option.price_inr,
      });
    }
    if (droppedAddon) {
      modified.push({
        name: displayName,
        reason: 'One or more add-ons are no longer available and were dropped',
      });
    }

    const unitPriceInr = variant.price_inr + kept.reduce((sum, a) => sum + a.priceInr, 0);

    lines.push({
      menuItemId: menuItem.id,
      variantId: variant.id,
      name: menuItem.name,
      variantLabel: variant.label,
      unitPriceInr,
      addons: kept,
      specialInstructions: orderItem.special_instructions ?? '',
      qty: orderItem.quantity,
    });
  }

  return { lines, skipped, modified };
}

/**
 * Petpooja read-side sibling of `mapOrderItemsToCartLines`, for a legacy
 * bill's items (GET /api/customers/orders' `source: 'petpooja'` entries —
 * lib/legacy/history.ts). Same current-menu resolution, but two things a
 * Petpooja item never carries that a hioc one does:
 *
 *  - No quantity was ever recorded (the Petpooja export has none at all —
 *    see the shared import spec), so every kept line is added at qty 1, the
 *    same "start from one" a fresh tile tap already uses.
 *  - No add-ons and no per-item price snapshot: the cart line's price is
 *    entirely the variant's CURRENT price, same "never trust an old number"
 *    rule `mapOrderItemsToCartLines` holds for its own unitPriceInr.
 *
 * Variant resolution:
 *  - `variant_id` set → must still exist on the item; skipped otherwise
 *    (same "This option is no longer offered" as the hioc mapper).
 *  - `variant_id` null and the item currently has exactly ONE variant → that
 *    variant is the only possible choice, so it's used — this is exactly the
 *    isSimpleItem/quick-add rule (lib/pos/quickAdd.ts, commitCandidate in
 *    PosOrderEntry.tsx): with one variant there is nothing to guess.
 *  - `variant_id` null and the item currently has MORE than one variant →
 *    skipped, not guessed. Nowhere else in this app silently picks a variant
 *    for someone: PosCustomizeModal seeds `variants[0]` only as a starting
 *    point a human then confirms or changes before Add — Repeat never gets
 *    that confirmation step, so guessing here could silently charge the
 *    wrong size. Skip-and-tell matches the same call the Petpooja item
 *    matcher itself makes (lib/petpooja/match.ts: "never fuzzy-match beyond
 *    these rules — wrong matches are worse than none").
 */
export function mapLegacyBillItemsToCartLines(
  items: readonly LegacyOrderItemResponse[],
  menuItems: readonly MenuItem[],
): RepeatOrderResult {
  const menuById = new Map(menuItems.map((item) => [item.id, item]));

  const lines: RepeatCartLine[] = [];
  const skipped: RepeatNotice[] = [];

  for (const legacyItem of items) {
    const displayName = legacyItem.name_snapshot;

    if (!legacyItem.menu_item_id) {
      skipped.push({ name: displayName, reason: 'Not matched to a menu item' });
      continue;
    }
    const menuItem = menuById.get(legacyItem.menu_item_id);
    if (!menuItem || !isMenuItemAvailable(menuItem)) {
      skipped.push({ name: displayName, reason: 'Currently unavailable' });
      continue;
    }

    let variant = legacyItem.variant_id
      ? menuItem.variants.find((v) => v.id === legacyItem.variant_id)
      : undefined;
    // No recorded variant, but there's only one to pick — unambiguous.
    if (!variant && !legacyItem.variant_id && menuItem.variants.length === 1) {
      variant = menuItem.variants[0];
    }
    if (!variant) {
      skipped.push({ name: displayName, reason: 'This option is no longer offered' });
      continue;
    }

    lines.push({
      menuItemId: menuItem.id,
      variantId: variant.id,
      name: menuItem.name,
      variantLabel: variant.label,
      unitPriceInr: variant.price_inr,
      gstExempt: menuItem.gst_exempt === true,
      addons: [],
      specialInstructions: '',
      qty: 1,
    });
  }

  return { lines, skipped, modified: [] };
}
