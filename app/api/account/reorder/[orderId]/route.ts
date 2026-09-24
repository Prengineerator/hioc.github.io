import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser } from '@/lib/api/auth';
import { errorResponse, notFound, unauthorized } from '@/lib/api/http';
import { isUuid } from '@/lib/api/constants';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { ownsOrder, verifiedEmailOf } from '@/lib/account/history';
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

  // customer_user_id (or customer_email) may not exist yet on a pending
  // deploy — degrades to treating every order as unlinked and skipping the
  // email match (same tolerance as app/api/account/history/route.ts) rather
  // than failing the request.
  type OrderRow = {
    id: string;
    user_id: string | null;
    customer_user_id?: string | null;
    customer_phone: string | null;
    customer_email?: string | null;
    order_items: (OrderItem & { order_item_addons: OrderItemAddon[] | null })[] | null;
  };
  let orderRow: OrderRow | null = null;
  const linked = await admin
    .from('orders')
    .select(
      'id, user_id, customer_user_id, customer_phone, customer_email, order_items(*, order_item_addons(*))',
    )
    .eq('id', params.orderId)
    .maybeSingle();
  if (linked.error) {
    if (!isMissingColumnError(linked.error)) {
      return errorResponse(500, 'Failed to load order');
    }
    const fallback = await admin
      .from('orders')
      .select('id, user_id, customer_phone, order_items(*, order_item_addons(*))')
      .eq('id', params.orderId)
      .maybeSingle();
    if (fallback.error) {
      return errorResponse(500, 'Failed to load order');
    }
    orderRow = fallback.data as OrderRow | null;
  } else {
    orderRow = linked.data as OrderRow | null;
  }

  if (!orderRow) {
    return notFound();
  }

  // Ownership check doubles as the 404 — never reveal that an order id
  // belongs to someone else. Matches GET /api/account/history's rules
  // (ACC-2/ACC-4): own web order, staff-linked counter order, or an
  // unclaimed guest order matched by the CALLER's own verified phone or
  // verified login email. The profiles lookup only runs when the cheap
  // checks above didn't already settle it, and only for an order that could
  // possibly be an unclaimed guest order (user_id null) — never for one
  // plainly owned by someone else.
  let owns = orderRow.user_id === user.id || orderRow.customer_user_id === user.id;
  if (!owns && !orderRow.user_id) {
    const { data: profile } = await admin
      .from('profiles')
      .select('phone, phone_verified')
      .eq('id', user.id)
      .maybeSingle();
    owns = ownsOrder(orderRow, user.id, profile, verifiedEmailOf(user));
  }
  if (!owns) {
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
