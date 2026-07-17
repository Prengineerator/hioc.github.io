import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getStaffUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isOrderStatus, isOrderType, isUuid, ORDER_STATUSES } from '@/lib/api/constants';
import { startOfTodayIstIso } from '@/lib/api/date';
import { normalizeIndianMobile } from '@/lib/phone';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { getStoreSettings } from '@/lib/store/settings';
import { computeBill, computeStoreOpenState } from '@/lib/store/hours';
import type { AddonGroup, MenuItem, OrderType } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_CUSTOMER_NAME_LENGTH = 100;
const MAX_INSTRUCTION_LENGTH = 200;
const MAX_ALL_ORDERS_ROWS = 200;
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

type IncomingOrderItem = {
  menu_item_id: string;
  variant_id: string;
  quantity: number;
  addon_option_ids: string[];
  special_instructions: string;
};

function parseItems(rawItems: unknown): IncomingOrderItem[] | string {
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

// 4-digit counter pickup code shown to the customer and verified at pickup
// (CUS-056). Not a security token — the opaque order id is the access control;
// this is just a short human-readable confirmation number.
function generatePickupCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// POST /api/orders — public (guest checkout).
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const {
    customer_name,
    customer_phone,
    pickup_time,
    pickup_slot_start,
    pickup_slot_label,
    order_type: rawOrderType,
    notes,
    items: rawItems,
  } = body;

  if (typeof customer_name !== 'string' || customer_name.trim().length === 0) {
    return errorResponse(400, 'customer_name is required and must be a non-empty string');
  }
  const trimmedName = customer_name.trim();
  if (trimmedName.length > MAX_CUSTOMER_NAME_LENGTH) {
    return errorResponse(400, `customer_name must be at most ${MAX_CUSTOMER_NAME_LENGTH} characters`);
  }

  if (typeof customer_phone !== 'string') {
    return errorResponse(400, 'customer_phone is required and must be a string');
  }
  const normalizedPhone = normalizeIndianMobile(customer_phone);
  if (!normalizedPhone) {
    return errorResponse(400, 'customer_phone must be a valid 10-digit Indian mobile number');
  }
  // Stored in E.164 form (see components/staff/OrderCard.tsx tel: link).
  const trimmedPhone = `+91${normalizedPhone}`;

  // Structured pickup slot (C4/CUS-026) with legacy free-text fallback. The
  // label is what surfaces on the confirmation + staff card; the ISO start (if
  // any) drives per-slot capacity and owner slot analytics.
  const slotLabel =
    typeof pickup_slot_label === 'string' && pickup_slot_label.trim().length > 0
      ? pickup_slot_label.trim()
      : typeof pickup_time === 'string'
        ? pickup_time.trim()
        : '';
  if (slotLabel.length === 0) {
    return errorResponse(400, 'A pickup time (pickup_slot_label or pickup_time) is required');
  }
  let slotStartIso: string | null = null;
  if (typeof pickup_slot_start === 'string' && pickup_slot_start.length > 0) {
    const t = Date.parse(pickup_slot_start);
    if (Number.isNaN(t)) {
      return errorResponse(400, 'pickup_slot_start must be an ISO timestamp');
    }
    slotStartIso = new Date(t).toISOString();
  }

  let orderType: OrderType = 'takeaway';
  if (rawOrderType !== undefined) {
    if (!isOrderType(rawOrderType)) {
      return errorResponse(400, 'order_type must be takeaway, dine_in, or delivery');
    }
    orderType = rawOrderType;
  }

  if (notes !== undefined && typeof notes !== 'string') {
    return errorResponse(400, 'notes must be a string');
  }

  const items = parseItems(rawItems);
  if (typeof items === 'string') {
    return errorResponse(400, items);
  }

  const admin = createAdminSupabaseClient();

  // Store-state gate (C3/S7): reject checkout when we're not accepting orders
  // (closed, paused, past last-order cutoff). Staff accept existing orders via a
  // separate flow, so this only blocks new customer checkouts.
  const settings = await getStoreSettings();
  const openState = computeStoreOpenState(settings);
  if (!openState.acceptingOrders) {
    const msg =
      openState.reason === 'paused'
        ? 'We are not accepting online orders right now.'
        : openState.reason === 'after_cutoff'
          ? 'Online orders for today are closed. Please try again tomorrow.'
          : 'The store is currently closed. Please order during opening hours.';
    return errorResponse(409, msg);
  }

  const menuItemIds = [...new Set(items.map((item) => item.menu_item_id))];
  const { data: menuRows, error: menuError } = await admin
    .from('menu_items')
    .select(MENU_ITEM_SELECT)
    .in('id', menuItemIds);

  if (menuError) {
    return errorResponse(500, 'Failed to validate order items');
  }

  const menuById = new Map(
    (menuRows ?? []).map((row) => [row.id, shapeMenuItem(row as unknown as MenuItemRow)]),
  );

  // Validate every line and compute authoritative prices server-side —
  // never trust a client-submitted price.
  type ResolvedLine = {
    menu_item_id: string;
    variant_id: string;
    name_snapshot: string;
    variant_label_snapshot: string;
    price_inr_snapshot: number;
    quantity: number;
    line_total_inr: number;
    special_instructions: string;
    addons: { addon_option_id: string; group_name_snapshot: string; option_name_snapshot: string; price_inr_snapshot: number }[];
  };

  const resolvedLines: ResolvedLine[] = [];
  let subtotal_inr = 0;

  for (const item of items) {
    const menuItem = menuById.get(item.menu_item_id);
    if (!menuItem) {
      return errorResponse(400, `Menu item ${item.menu_item_id} does not exist`);
    }
    // Effective availability includes 86/snooze (unavailable_until), so an item
    // 86'd while sitting in the cart is rejected here with a clear message (C3).
    if (!isMenuItemAvailable(menuItem)) {
      return errorResponse(400, `"${menuItem.name}" is currently unavailable`);
    }

    const variant = menuItem.variants.find((v) => v.id === item.variant_id);
    if (!variant) {
      return errorResponse(400, `"${menuItem.name}" has no such variant`);
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
        return errorResponse(400, `"${menuItem.name}" has no such addon option`);
      }
      const list = selectedByGroup.get(found.group.id) ?? [];
      list.push(found.option);
      selectedByGroup.set(found.group.id, list);
    }

    for (const group of menuItem.addon_groups) {
      const count = selectedByGroup.get(group.id)?.length ?? 0;
      if (count < group.min_select || count > group.max_select) {
        return errorResponse(
          400,
          `"${menuItem.name}": "${group.display_name}" requires ${
            group.min_select === group.max_select
              ? `exactly ${group.min_select}`
              : `between ${group.min_select} and ${group.max_select}`
          } selection(s), got ${count}`,
        );
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
    subtotal_inr += line_total_inr;

    resolvedLines.push({
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

  // Per-slot capacity (C4 edge case): if a real slot was chosen and capacity is
  // capped, reject when it's already full (excludes rejected/cancelled orders).
  if (slotStartIso && settings.pickup_slot_capacity > 0) {
    const { count } = await admin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('pickup_slot_start', slotStartIso)
      .not('status', 'in', '("rejected","cancelled")');
    if ((count ?? 0) >= settings.pickup_slot_capacity) {
      return errorResponse(409, 'That pickup slot is full — please choose another time.');
    }
  }

  // Authoritative bill snapshot (C5/CUS-031): GST + packaging + grand total.
  const bill = computeBill(subtotal_inr, settings);

  const { data: orderRow, error: orderError } = await admin
    .from('orders')
    .insert({
      customer_name: trimmedName,
      customer_phone: trimmedPhone,
      pickup_time: slotLabel, // legacy column kept in sync with the slot label
      pickup_slot_start: slotStartIso,
      pickup_slot_label: slotLabel,
      order_type: orderType,
      status: 'received',
      subtotal_inr: bill.subtotal_inr,
      tax_inr: bill.tax_inr,
      packaging_inr: bill.packaging_inr,
      discount_inr: bill.discount_inr,
      total_inr: bill.total_inr,
      pickup_code: generatePickupCode(),
      notes: notes ?? '',
    })
    .select()
    .single();

  if (orderError || !orderRow) {
    // Surface the underlying Postgres message (e.g. a missing column when the
    // migration hasn't been applied) so the failure is diagnosable rather than
    // an opaque 500 — this app has no PII in the error path.
    console.error('orders insert failed', orderError);
    return errorResponse(500, orderError?.message ? `Failed to create order: ${orderError.message}` : 'Failed to create order');
  }

  for (const line of resolvedLines) {
    const { addons, ...lineFields } = line;
    const { data: orderItemRow, error: orderItemError } = await admin
      .from('order_items')
      .insert({ ...lineFields, order_id: orderRow.id })
      .select('id')
      .single();

    if (orderItemError || !orderItemRow) {
      console.error('order_items insert failed', orderItemError);
      await admin.from('orders').delete().eq('id', orderRow.id);
      return errorResponse(500, orderItemError?.message ? `Failed to create order items: ${orderItemError.message}` : 'Failed to create order items');
    }

    if (addons.length > 0) {
      const { error: addonsError } = await admin
        .from('order_item_addons')
        .insert(addons.map((a) => ({ ...a, order_item_id: orderItemRow.id })));

      if (addonsError) {
        console.error('order_item_addons insert failed', addonsError);
        await admin.from('orders').delete().eq('id', orderRow.id);
        return errorResponse(500, addonsError?.message ? `Failed to create order item addons: ${addonsError.message}` : 'Failed to create order item addons');
      }
    }
  }

  // Seed the lifecycle event log with the initial system transition (F1) so
  // SLA metrics have a 'received' anchor for every order.
  await admin.from('order_status_events').insert({
    order_id: orderRow.id,
    from_status: null,
    to_status: 'received',
    actor_id: null,
    actor_role: 'system',
    reason: '',
  });

  const { data: fullOrder, error: fetchError } = await admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))')
    .eq('id', orderRow.id)
    .single();

  if (fetchError || !fullOrder) {
    return errorResponse(500, 'Created order but failed to load it back');
  }

  const response = toOrderResponse(fullOrder as OrderRowWithItems);

  return NextResponse.json({ order: response }, { status: 201 });
}

// GET /api/orders — staff-only.
export async function GET(request: Request) {
  const user = await getStaffUser();
  if (!user) {
    return unauthorized();
  }

  const { searchParams } = new URL(request.url);
  const statusParam = searchParams.get('status');
  if (statusParam !== null && !isOrderStatus(statusParam)) {
    return errorResponse(400, `status must be one of: ${ORDER_STATUSES.join(', ')}`);
  }

  const all = searchParams.get('all') === 'true';

  const admin = createAdminSupabaseClient();
  let query = admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))')
    .order('created_at', { ascending: true });

  if (statusParam) {
    query = query.eq('status', statusParam);
  }
  if (!all) {
    query = query.gte('created_at', startOfTodayIstIso());
  } else {
    query = query.limit(MAX_ALL_ORDERS_ROWS);
  }

  const { data, error } = await query;

  if (error) {
    return errorResponse(500, 'Failed to load orders');
  }

  const orders = (data ?? []).map((row) => toOrderResponse(row as OrderRowWithItems));

  return NextResponse.json({ orders });
}
