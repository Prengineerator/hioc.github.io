import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { getAuthUser, getStaffUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isOrderStatus, isOrderType, isUuid, ORDER_STATUSES } from '@/lib/api/constants';
import { startOfTodayIstIso } from '@/lib/api/date';
import { normalizeIndianMobile } from '@/lib/phone';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import { isMenuItemAvailable } from '@/lib/menu/availability';
import { getStoreSettings } from '@/lib/store/settings';
import { computeBill, computeStoreOpenState } from '@/lib/store/hours';
import { validateAndComputeCoupon } from '@/lib/promotions/coupons';
import { quoteRedemption, redeemForOrder } from '@/lib/loyalty/ledger';
import { createPaymentIntent, type CreatedPaymentIntent } from '@/lib/payments/gateway';
import type { AddonGroup, Coupon, MenuItem, OrderStatus, OrderType, PaymentMethod, PaymentStatus } from '@/lib/types';

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
    payment_mode: rawPaymentMode,
    coupon_code,
    redeem_points,
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

  // Online vs pay-at-counter (PAY-1). Default preserves Phase-1 behavior.
  let paymentMode: 'online' | 'counter' = 'counter';
  if (rawPaymentMode !== undefined) {
    if (rawPaymentMode !== 'online' && rawPaymentMode !== 'counter') {
      return errorResponse(400, 'payment_mode must be "online" or "counter"');
    }
    paymentMode = rawPaymentMode;
  }

  // user_id is ALWAYS derived from the verified session, never trusted from
  // the request body — a client-supplied user_id would let a guest redeem
  // someone else's loyalty points or attribute an order to any account.
  // Guest checkout (no session) keeps working exactly as in Phase 1.
  const sessionUser = await getAuthUser();
  const userId = sessionUser?.id ?? null;

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

  // Coupon (FND-3) — validated + computed server-side (authoritative); the
  // checkout preview (POST /api/orders/quote) shows the same numbers ahead of
  // submit, but this is what actually gets applied.
  let couponDiscountInr = 0;
  let appliedCoupon: Coupon | null = null;
  if (typeof coupon_code === 'string' && coupon_code.trim().length > 0) {
    const categories = [
      ...new Set(
        resolvedLines
          .map((l) => menuById.get(l.menu_item_id)?.category)
          .filter((c): c is string => Boolean(c)),
      ),
    ];
    const couponResult = await validateAndComputeCoupon(coupon_code.trim(), {
      subtotalInr: subtotal_inr,
      userId,
      itemIds: resolvedLines.map((l) => l.menu_item_id),
      categories,
    });
    if (!couponResult.ok) {
      return errorResponse(400, couponResult.reason ?? 'Coupon is not valid for this order');
    }
    couponDiscountInr = Math.min(couponResult.discountInr, subtotal_inr);
    appliedCoupon = couponResult.coupon ?? null;
  }

  // Points redemption (FND-4) — validated + computed server-side. Applied
  // against whatever remains after the coupon discount (coupon-then-points
  // precedence per FND-3's stacking edge case).
  let pointsDiscountInr = 0;
  let pointsToRedeem = 0;
  if (redeem_points !== undefined) {
    if (typeof redeem_points !== 'number' || !Number.isInteger(redeem_points) || redeem_points < 0) {
      return errorResponse(400, 'redeem_points must be a non-negative integer');
    }
    if (redeem_points > 0) {
      if (!userId) {
        return errorResponse(400, 'You must be logged in to redeem points');
      }
      const remaining = Math.max(0, subtotal_inr - couponDiscountInr);
      const quote = await quoteRedemption(userId, redeem_points, remaining);
      if (!quote.ok) {
        return errorResponse(400, quote.reason ?? 'Points could not be redeemed');
      }
      pointsDiscountInr = quote.discountInr;
      pointsToRedeem = quote.points;
    }
  }

  const discount_inr = Math.min(couponDiscountInr + pointsDiscountInr, subtotal_inr);

  // Authoritative bill snapshot (C5/CUS-031): GST + packaging + discount + grand total.
  const bill = computeBill(subtotal_inr, settings, discount_inr);

  // Online payment (PAY-1/FND-1) gates the order at 'placed' — kept OUT of
  // the staff queue until the gateway confirms it (webhook/reconcile). A
  // fully-discounted order ("free" via coupon/points) has nothing to charge,
  // so it goes straight to the counter flow regardless of payment_mode.
  const needsOnlinePayment = paymentMode === 'online' && bill.total_inr > 0;
  const initialStatus: OrderStatus = needsOnlinePayment ? 'placed' : 'received';
  // A fully-discounted (₹0) order has nothing to collect — mark it paid so staff
  // don't see "unpaid" + a "mark payment" prompt on an already-settled order (M7).
  const initialPaymentStatus: PaymentStatus = needsOnlinePayment
    ? 'payment_pending'
    : bill.total_inr === 0
      ? 'paid'
      : 'unpaid';
  const initialPaymentMethod: PaymentMethod | null = needsOnlinePayment ? 'online' : null;

  const { data: orderRow, error: orderError } = await admin
    .from('orders')
    .insert({
      customer_name: trimmedName,
      customer_phone: trimmedPhone,
      pickup_time: slotLabel, // legacy column kept in sync with the slot label
      pickup_slot_start: slotStartIso,
      pickup_slot_label: slotLabel,
      order_type: orderType,
      status: initialStatus,
      subtotal_inr: bill.subtotal_inr,
      tax_inr: bill.tax_inr,
      packaging_inr: bill.packaging_inr,
      discount_inr: bill.discount_inr,
      total_inr: bill.total_inr,
      pickup_code: generatePickupCode(),
      notes: notes ?? '',
      user_id: userId,
      payment_status: initialPaymentStatus,
      payment_method: initialPaymentMethod,
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
  // SLA metrics have an anchor for every order — 'received' for the normal/
  // pay-at-counter path, 'placed' when it's gated on online payment (PAY-1).
  await admin.from('order_status_events').insert({
    order_id: orderRow.id,
    from_status: null,
    to_status: initialStatus,
    actor_id: null,
    actor_role: 'system',
    reason: '',
  });

  // Snapshot the coupon redemption ATOMICALLY (FND-3 / H1): try_redeem_coupon
  // re-checks usage_limit/per_user_limit under a per-coupon lock and inserts in
  // one step, closing the last-use race. If the coupon just hit its limit
  // (race lost), roll the order back (cascade cleans items) and ask for a retry.
  // Falls back to the plain insert when the RPC isn't deployed yet, so checkout
  // keeps working until supabase/phase2-hardening.sql is applied.
  if (appliedCoupon && couponDiscountInr > 0) {
    const { data: ok, error: rpcError } = await admin.rpc('try_redeem_coupon', {
      p_coupon_id: appliedCoupon.id,
      p_order_id: orderRow.id,
      p_user_id: userId,
      p_discount: couponDiscountInr,
      p_usage_limit: appliedCoupon.usage_limit,
      p_per_user_limit: appliedCoupon.per_user_limit,
    });
    if (rpcError) {
      console.error('try_redeem_coupon rpc unavailable; falling back to insert', rpcError);
      await admin.from('coupon_redemptions').insert({
        coupon_id: appliedCoupon.id,
        order_id: orderRow.id,
        user_id: userId,
        discount_inr: couponDiscountInr,
      });
    } else if (ok === false) {
      await admin.from('orders').delete().eq('id', orderRow.id);
      return errorResponse(409, 'This coupon just reached its usage limit — please try again.');
    }
  }

  // Record the points redemption ATOMICALLY (FND-4 / H1): try_redeem_points
  // re-checks the balance under a per-user lock. userId is non-null here
  // (redemption requires login). Same rollback-on-race + RPC fallback.
  if (pointsToRedeem > 0 && userId) {
    const { data: ok, error: rpcError } = await admin.rpc('try_redeem_points', {
      p_user_id: userId,
      p_order_id: orderRow.id,
      p_points: pointsToRedeem,
      p_discount: pointsDiscountInr,
    });
    if (rpcError) {
      console.error('try_redeem_points rpc unavailable; falling back', rpcError);
      await redeemForOrder(userId, orderRow.id, pointsToRedeem, pointsDiscountInr);
    } else if (ok === false) {
      await admin.from('orders').delete().eq('id', orderRow.id);
      return errorResponse(409, 'Your points balance changed — please review and try again.');
    }
  }

  // Create the gateway payment intent now that the order + items are fully
  // committed. If the gateway is unconfigured/unavailable, fall back to
  // pay-at-counter rather than stranding the order at 'placed' with no way
  // to pay (FND-1 edge case: "partial gateway outage").
  let paymentIntent: CreatedPaymentIntent | null = null;
  if (needsOnlinePayment) {
    paymentIntent = await createPaymentIntent(orderRow.id, bill.total_inr);
    if (!paymentIntent) {
      const { error: fallbackError } = await admin
        .from('orders')
        .update({ status: 'received', payment_status: 'unpaid', payment_method: null })
        .eq('id', orderRow.id);
      if (fallbackError) {
        console.error('orders fallback-to-counter update failed', fallbackError);
      } else {
        await admin.from('order_status_events').insert({
          order_id: orderRow.id,
          from_status: 'placed',
          to_status: 'received',
          actor_id: null,
          actor_role: 'system',
          reason: 'Payment gateway unavailable — switched to pay at counter',
        });
      }
    }
  }

  const { data: fullOrder, error: fetchError } = await admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))')
    .eq('id', orderRow.id)
    .single();

  if (fetchError || !fullOrder) {
    return errorResponse(500, 'Created order but failed to load it back');
  }

  const response = toOrderResponse(fullOrder as OrderRowWithItems);

  return NextResponse.json({ order: response, payment: paymentIntent }, { status: 201 });
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
