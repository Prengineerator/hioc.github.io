import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import type { AddonGroup, MenuItem, OrderItem, OrderItemAddon } from '@/lib/types';
import type { CartAddonSelection, CartItem } from '@/lib/cart/CartContext';

export const dynamic = 'force-dynamic';

const MENU_ITEM_SELECT = `
  *,
  menu_item_variants(*),
  menu_item_addon_groups(
    addon_groups(*, options:addon_options(*))
  )
`;

type MenuItemRow = Omit<MenuItem, 'variants' | 'addon_groups'> & {
  menu_item_variants: MenuItem['variants'];
  menu_item_addon_groups: { addon_groups: AddonGroup | null }[];
};

function shapeMenuItem(row: MenuItemRow): MenuItem {
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

// A cart-ready line — everything CartContext's addItem() needs except the
// derived `key` (computed client-side from menuItemId/variantId/addons/notes).
export type ReorderLine = Omit<CartItem, 'key'>;

interface ReorderNotice {
  name: string;
  reason: string;
}

export interface ReorderResponse {
  items: ReorderLine[];
  skipped: ReorderNotice[]; // whole lines dropped (item/variant no longer available)
  modified: ReorderNotice[]; // lines kept, but an addon was dropped
}

// GET /api/account/reorder/[orderId] — resolves a past order's lines against
// the CURRENT menu (ACC-4): current prices, skips items no longer available
// or whose variant is gone, and drops individual addons no longer offered
// (keeping the line). Returns a ready-to-addItem() cart payload; the caller
// (app/account/orders) feeds each `items[]` entry into useCart().addItem().
export async function GET(_request: Request, { params }: { params: { orderId: string } }) {
  const user = await getAuthUser();
  if (!user) {
    return unauthorized();
  }

  if (!isUuid(params.orderId)) {
    return errorResponse(400, 'orderId must be a valid uuid');
  }

  const admin = createAdminSupabaseClient();

  const { data: orderRow, error: orderError } = await admin
    .from('orders')
    .select('id, user_id, order_items(*, order_item_addons(*))')
    .eq('id', params.orderId)
    .maybeSingle();

  if (orderError) {
    return errorResponse(500, 'Failed to load order');
  }
  // Ownership check doubles as the 404 — never reveal that an order id
  // belongs to someone else.
  if (!orderRow || orderRow.user_id !== user.id) {
    return notFound();
  }

  const orderItems = (orderRow.order_items ?? []) as (OrderItem & {
    order_item_addons: OrderItemAddon[] | null;
  })[];

  const menuItemIds = [
    ...new Set(orderItems.map((i) => i.menu_item_id).filter((id): id is string => Boolean(id))),
  ];

  const menuById = new Map<string, MenuItem>();
  if (menuItemIds.length > 0) {
    const { data: menuRows, error: menuError } = await admin
      .from('menu_items')
      .select(MENU_ITEM_SELECT)
      .in('id', menuItemIds);
    if (menuError) {
      return errorResponse(500, 'Failed to load current menu');
    }
    for (const row of menuRows ?? []) {
      const shaped = shapeMenuItem(row as unknown as MenuItemRow);
      menuById.set(shaped.id, shaped);
    }
  }

  const items: ReorderLine[] = [];
  const skipped: ReorderNotice[] = [];
  const modified: ReorderNotice[] = [];

  for (const oi of orderItems) {
    const displayName = oi.name_snapshot;

    if (!oi.menu_item_id) {
      skipped.push({ name: displayName, reason: 'No longer on the menu' });
      continue;
    }
    const menuItem = menuById.get(oi.menu_item_id);
    if (!menuItem || !isMenuItemAvailable(menuItem)) {
      skipped.push({ name: displayName, reason: 'Currently unavailable' });
      continue;
    }
    const variant = oi.variant_id
      ? menuItem.variants.find((v) => v.id === oi.variant_id)
      : undefined;
    if (!variant) {
      skipped.push({ name: displayName, reason: 'This option is no longer offered' });
      continue;
    }

    const optionById = new Map<string, { option: AddonGroup['options'][number]; group: AddonGroup }>();
    for (const group of menuItem.addon_groups) {
      for (const option of group.options) {
        optionById.set(option.id, { option, group });
      }
    }

    const kept: CartAddonSelection[] = [];
    let droppedAddon = false;
    for (const a of oi.order_item_addons ?? []) {
      const found = a.addon_option_id ? optionById.get(a.addon_option_id) : undefined;
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

    items.push({
      menuItemId: menuItem.id,
      variantId: variant.id,
      name: menuItem.name,
      variantLabel: variant.label,
      unitPriceInr,
      addons: kept,
      specialInstructions: oi.special_instructions ?? '',
      qty: oi.quantity,
    });
  }

  if (items.length === 0) {
    return errorResponse(409, 'None of the items in this order are available to reorder right now.');
  }

  const response: ReorderResponse = { items, skipped, modified };
  return NextResponse.json(response);
}
