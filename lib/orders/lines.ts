// Shared order-line parsing, validation and server-authoritative pricing.
//
// Extracted from POST /api/orders (FND3-3) so the TAB-1 "add lines to an open
// order" path can reuse the EXACT same rules rather than reimplement them. Line
// pricing is money math: two copies would eventually disagree, and the one that
// drifts would be the one a customer is charged by. There is one copy, and it
// lives here.
//
// Guardrails preserved verbatim from the create route:
//  * Prices come from the menu row, never from the client — a submitted price is
//    ignored entirely.
//  * 86'd items are rejected at resolve time, so an item that went unavailable
//    while sitting in a cart can't be punched through.
//  * Variant must belong to the item; every addon option must belong to the
//    item's groups; each group's min/max_select is enforced.
//  * Name/label/price are SNAPSHOT onto the line, so later menu edits never
//    rewrite history on an existing order.

import { isUuid } from '@/lib/api/constants';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import type { AddonGroup, MenuItem } from '@/lib/types';

export const MAX_INSTRUCTION_LENGTH = 200;

/** Embed used everywhere a menu item is loaded for pricing. */
export const MENU_ITEM_SELECT = `
  *,
  menu_item_variants(*),
  menu_item_addon_groups(
    addon_groups(*, options:addon_options(*))
  )
`;

export type MenuItemRow = Omit<MenuItem, 'variants' | 'addon_groups'> & {
  menu_item_variants: MenuItem['variants'];
  menu_item_addon_groups: { addon_groups: AddonGroup | null }[];
};

/** Flattens the nested select into the MenuItem shape, in display order. */
export function shapeMenuItem(row: MenuItemRow): MenuItem {
  const { menu_item_variants, menu_item_addon_groups, ...rest } = row;
  const variants = [...(menu_item_variants ?? [])].sort((a, b) => a.sort_order - b.sort_order);
  const addon_groups = (menu_item_addon_groups ?? [])
    .map((link) => link.addon_groups)
    .filter((g): g is AddonGroup => g !== null)
    .map((g) => ({
      ...g,
      options: [...(g.options ?? [])].sort((a, b) => a.sort_order - b.sort_order),
    }))
    .sort((a, b) => a.sort_order - b.sort_order);
  return { ...rest, variants, addon_groups } as MenuItem;
}

export type IncomingOrderItem = {
  menu_item_id: string;
  variant_id: string;
  quantity: number;
  addon_option_ids: string[];
  special_instructions: string;
};

export type ResolvedLine = {
  menu_item_id: string;
  variant_id: string;
  name_snapshot: string;
  variant_label_snapshot: string;
  price_inr_snapshot: number;
  quantity: number;
  line_total_inr: number;
  special_instructions: string;
  addons: {
    addon_option_id: string;
    group_name_snapshot: string;
    option_name_snapshot: string;
    price_inr_snapshot: number;
  }[];
};

/**
 * Validates the raw `items` payload. Returns the parsed lines, or a single
 * human-readable error string naming the offending index (the caller turns that
 * into a 400).
 */
export function parseItems(rawItems: unknown): IncomingOrderItem[] | string {
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return 'items is required and must be a non-empty array';
  }

  const parsed: IncomingOrderItem[] = [];
  for (let i = 0; i < rawItems.length; i++) {
    const entry = rawItems[i];
    if (typeof entry !== 'object' || entry === null) {
      return `items[${i}] must be an object`;
    }
    const { menu_item_id, variant_id, quantity, addon_option_ids, special_instructions } =
      entry as Record<string, unknown>;
    if (!isUuid(menu_item_id)) {
      return `items[${i}].menu_item_id must be a valid uuid`;
    }
    if (!isUuid(variant_id)) {
      return `items[${i}].variant_id must be a valid uuid`;
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1) {
      return `items[${i}].quantity must be an integer >= 1`;
    }
    let addonIds: string[] = [];
    if (addon_option_ids !== undefined) {
      if (!Array.isArray(addon_option_ids) || addon_option_ids.some((v) => !isUuid(v))) {
        return `items[${i}].addon_option_ids must be an array of valid uuids`;
      }
      addonIds = addon_option_ids as string[];
    }
    let instructions = '';
    if (special_instructions !== undefined) {
      if (typeof special_instructions !== 'string') {
        return `items[${i}].special_instructions must be a string`;
      }
      instructions = special_instructions.trim().slice(0, MAX_INSTRUCTION_LENGTH);
    }
    parsed.push({
      menu_item_id,
      variant_id,
      quantity,
      addon_option_ids: addonIds,
      special_instructions: instructions,
    });
  }
  return parsed;
}

export type ResolveResult =
  | { ok: true; lines: ResolvedLine[]; subtotalInr: number }
  | { ok: false; error: string };

/**
 * Turns validated input lines into priced, snapshot-bearing order lines using
 * the live menu. Every price is derived here from the menu row — the client's
 * numbers are never read.
 *
 * `menuById` is supplied by the caller (both call sites already load the menu
 * rows they need), keeping this function pure and directly unit-testable.
 */
export function resolveOrderLines(
  items: IncomingOrderItem[],
  menuById: Map<string, MenuItem>,
): ResolveResult {
  const lines: ResolvedLine[] = [];
  let subtotalInr = 0;

  for (const item of items) {
    const menuItem = menuById.get(item.menu_item_id);
    if (!menuItem) {
      return { ok: false, error: `Menu item ${item.menu_item_id} does not exist` };
    }
    // Effective availability includes 86/snooze (unavailable_until), so an item
    // 86'd while sitting in the cart is rejected here with a clear message (C3).
    if (!isMenuItemAvailable(menuItem)) {
      return { ok: false, error: `"${menuItem.name}" is currently unavailable` };
    }

    const variant = menuItem.variants.find((v) => v.id === item.variant_id);
    if (!variant) {
      return { ok: false, error: `"${menuItem.name}" has no such variant` };
    }

    const optionById = new Map<string, { option: AddonGroup['options'][number]; group: AddonGroup }>();
    for (const group of menuItem.addon_groups) {
      for (const option of group.options) {
        optionById.set(option.id, { option, group });
      }
    }

    const selectedByGroup = new Map<string, AddonGroup['options'][number][]>();
    for (const optionId of item.addon_option_ids) {
      const found = optionById.get(optionId);
      if (!found) {
        return { ok: false, error: `"${menuItem.name}" has no such addon option` };
      }
      const list = selectedByGroup.get(found.group.id) ?? [];
      list.push(found.option);
      selectedByGroup.set(found.group.id, list);
    }

    for (const group of menuItem.addon_groups) {
      const count = selectedByGroup.get(group.id)?.length ?? 0;
      if (count < group.min_select || count > group.max_select) {
        return {
          ok: false,
          error: `"${menuItem.name}": "${group.display_name}" requires ${
            group.min_select === group.max_select
              ? `exactly ${group.min_select}`
              : `between ${group.min_select} and ${group.max_select}`
          } selection(s), got ${count}`,
        };
      }
    }

    const addonsFlat = [...selectedByGroup.entries()].flatMap(([groupId, options]) => {
      const group = menuItem.addon_groups.find((g) => g.id === groupId)!;
      return options.map((option) => ({
        addon_option_id: option.id,
        group_name_snapshot: group.display_name,
        option_name_snapshot: option.name,
        price_inr_snapshot: option.price_inr,
      }));
    });

    const addonsTotal = addonsFlat.reduce((sum, a) => sum + a.price_inr_snapshot, 0);
    const unitPrice = variant.price_inr + addonsTotal;
    const line_total_inr = unitPrice * item.quantity;
    subtotalInr += line_total_inr;

    lines.push({
      menu_item_id: menuItem.id,
      variant_id: variant.id,
      name_snapshot: menuItem.name,
      variant_label_snapshot: variant.label,
      price_inr_snapshot: unitPrice,
      quantity: item.quantity,
      line_total_inr,
      special_instructions: item.special_instructions,
      addons: addonsFlat,
    });
  }

  return { ok: true, lines, subtotalInr };
}
