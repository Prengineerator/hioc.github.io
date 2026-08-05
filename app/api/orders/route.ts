import { NextResponse } from 'next/server';
import { createAdminSupabaseClient } from '@/lib/supabase-server';
import { actorRoleFor, getAuthUser, getStaffOrOwner, getStaffUser } from '@/lib/api/auth';
import { errorResponse, parseJsonBody, unauthorized } from '@/lib/api/http';
import { isOrderStatus, isOrderType, isUuid, ORDER_STATUSES } from '@/lib/api/constants';
import { isMissingColumnError } from '@/lib/api/postgrest';
import { startOfTodayIstIso } from '@/lib/api/date';
import { normalizeIndianMobile } from '@/lib/phone';
import { normalizeEmail } from '@/lib/email';
import { sendBillNotification } from '@/lib/notifications/engine';
import { toOrderResponse, type OrderRowWithItems } from '@/lib/api/orders';
import {
  MENU_ITEM_SELECT,
  parseItems,
  resolveOrderLines,
  shapeMenuItem,
  type MenuItemRow,
} from '@/lib/orders/lines';
import {
  claimIdempotencyKey,
  completeIdempotencyKey,
  readIdempotencyKey,
  releaseIdempotencyKey,
} from '@/lib/orders/idempotency';
import { getStoreSettings } from '@/lib/store/settings';
import { computeBill, computeStoreOpenState } from '@/lib/store/hours';
import { validateAndComputeCoupon } from '@/lib/promotions/coupons';
import { quoteRedemption, redeemForOrder } from '@/lib/loyalty/ledger';
import { findVerifiedCustomerByPhone } from '@/lib/loyalty/customerLink';
import { createPaymentIntent, type CreatedPaymentIntent } from '@/lib/payments/gateway';
import type { AddonGroup, Coupon, MenuItem, OrderStatus, OrderType, PaymentMethod, PaymentStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

const MAX_CUSTOMER_NAME_LENGTH = 100;
const MAX_ALL_ORDERS_ROWS = 200;

// Line parsing / shaping / pricing now lives in lib/orders/lines.ts so the
// TAB-1 add-to-open-order path prices lines by the exact same rules (money math
// gets one copy, not two).

// 4-digit counter pickup code shown to the customer and verified at pickup
// (CUS-056). Not a security token — the opaque order id is the access control;
// this is just a short human-readable confirmation number.
function generatePickupCode(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

// POST /api/orders — public (guest checkout).
//
// POS4-2: honors an optional `Idempotency-Key` header. A replay of a key whose
// order already exists returns THAT order instead of creating a second one —
// the fix for a timed-out submit being retried into a duplicate (and, on the
// POS settle path, a double charge).
export async function POST(request: Request) {
  const body = await parseJsonBody(request);
  if (!body) {
    return errorResponse(400, 'Request body must be a JSON object');
  }

  const idempotencyKey = readIdempotencyKey(request);

  const {
    customer_name,
    customer_phone,
    customer_email,
    pickup_time,
    pickup_slot_start,
    pickup_slot_label,
    order_type: rawOrderType,
    table_id: rawTableId,
    qr_token: rawQrToken,
    notes,
    items: rawItems,
    payment_mode: rawPaymentMode,
    coupon_code,
    redeem_points,
  } = body;

  // Phase-3 (FND3-2/3): a request carrying an authenticated staff/manager/owner
  // session is the second order-entry channel (POS-lite). It reuses this whole
  // pricing/validation stack but relaxes the guest-checkout guards (name/phone
  // optional, no pickup slot for dine-in, store-open bypassed) and attributes the
  // order to the acting staff member. A plain guest checkout leaves `actor` null
  // and behaves exactly as in Phase 1/2.
  const actor = await getStaffOrOwner();
  const isStaff = actor !== null;

  // Phase-3 (QR-1/D6): a NON-staff request carrying a `qr_token` is the third
  // order-entry channel — a seated customer who scanned the table QR. The token
  // is the *proof of table presence* and is resolved server-side below (never
  // trusted from the client for anything else). A QR customer may be anonymous
  // or a logged-in account, so name/phone are optional (like a staff order), the
  // order is forced dine-in, and it pays online first (nothing enters the queue
  // unpaid). Guarded by `!isStaff` so a staff session never takes this branch.
  const isTableQr = !isStaff && typeof rawQrToken === 'string' && rawQrToken.trim().length > 0;

  // Customer name — mandatory for guest checkout, optional for a staff-created
  // order (anonymous walk-in allowed, FND3-3). Stored '' when absent (NOT NULL).
  let trimmedName = '';
  if (typeof customer_name === 'string' && customer_name.trim().length > 0) {
    trimmedName = customer_name.trim();
  } else if (!isStaff && !isTableQr) {
    return errorResponse(400, 'customer_name is required and must be a non-empty string');
  }
  if (trimmedName.length > MAX_CUSTOMER_NAME_LENGTH) {
    return errorResponse(400, `customer_name must be at most ${MAX_CUSTOMER_NAME_LENGTH} characters`);
  }

  // Customer phone — mandatory for guest checkout, optional for a staff-created
  // order (FND3-3). When present it's validated + stored E.164 so the order stays
  // claimable/loyalty-eligible; a staff order without one stores '' so the
  // notification engine skips cleanly (no_phone). NOT NULL column.
  let trimmedPhone = '';
  const phoneProvided = typeof customer_phone === 'string' && customer_phone.trim().length > 0;
  if (phoneProvided) {
    const normalizedPhone = normalizeIndianMobile(customer_phone as string);
    if (!normalizedPhone) {
      return errorResponse(400, 'customer_phone must be a valid 10-digit Indian mobile number');
    }
    // Stored in E.164 form (see components/staff/OrderCard.tsx tel: link).
    trimmedPhone = `+91${normalizedPhone}`;
  } else if (!isStaff && !isTableQr) {
    return errorResponse(400, 'customer_phone is required and must be a string');
  }

  // Optional customer email (RCT-2 e-bill). Blank/absent is fine; when present
  // it must be a plausibly-valid address. Stored normalized (trimmed+lowercased).
  let customerEmail: string | null = null;
  if (customer_email !== undefined && customer_email !== null && String(customer_email).trim().length > 0) {
    if (typeof customer_email !== 'string') {
      return errorResponse(400, 'customer_email must be a string');
    }
    const normalizedEmail = normalizeEmail(customer_email);
    if (!normalizedEmail) {
      return errorResponse(400, 'customer_email must be a valid email address');
    }
    customerEmail = normalizedEmail;
  }

  // Order type first — the pickup-slot rules below depend on it (a staff dine-in
  // order needs no slot; a walk-in takeaway still uses the token/pickup flow).
  let orderType: OrderType = 'takeaway';
  if (rawOrderType !== undefined) {
    if (!isOrderType(rawOrderType)) {
      return errorResponse(400, 'order_type must be takeaway, dine_in, or delivery');
    }
    orderType = rawOrderType;
  }
  // A table-QR order is dine-in by definition (QR-1) — the table context comes
  // from the scanned token, not a client-chosen order_type.
  if (isTableQr) orderType = 'dine_in';
  const isDineIn = orderType === 'dine_in';

  // Structured pickup slot (C4/CUS-026) with legacy free-text fallback. The
  // label is what surfaces on the confirmation + staff card; the ISO start (if
  // any) drives per-slot capacity and owner slot analytics. Required for guest
  // checkout and staff walk-in takeaway; skipped for a staff dine-in order.
  const slotLabel =
    typeof pickup_slot_label === 'string' && pickup_slot_label.trim().length > 0
      ? pickup_slot_label.trim()
      : typeof pickup_time === 'string'
        ? pickup_time.trim()
        : '';
  if (slotLabel.length === 0 && !(isDineIn && (isStaff || isTableQr))) {
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
  // For a guest/customer checkout this is the verified customer session (or null
  // for an anonymous guest). For a STAFF-created order the session belongs to the
  // staff member, not the customer, so user_id stays null — attribution is
  // captured separately in created_by. Never trust a client-supplied user_id.
  const sessionUser = await getAuthUser();
  const userId = isStaff ? null : (sessionUser?.id ?? null);

  const admin = createAdminSupabaseClient();

  // Dine-in requires a valid, active table (FND3-3). Its label is snapshotted
  // onto the order (FND3-2) so it survives later renames — same philosophy as
  // menu-price snapshots.
  let tableId: string | null = null;
  let tableLabel = '';
  if (isTableQr) {
    // QR self-order (QR-1): the table is resolved from the scanned qr_token
    // server-side — the token IS the proof of table presence (§5.2), never a
    // client-supplied table_id. A regenerated/unknown token fails closed with a
    // friendly "ask staff" message rather than a broken order.
    const { data: t, error: tErr } = await admin
      .from('tables')
      .select('id, label, is_active')
      .eq('qr_token', (rawQrToken as string).trim())
      .maybeSingle();
    if (tErr) {
      return errorResponse(500, 'Failed to resolve the table');
    }
    if (!t || !t.is_active) {
      return errorResponse(400, 'This table QR is no longer active — please ask our staff.');
    }
    tableId = t.id as string;
    tableLabel = t.label as string;
  } else if (isDineIn) {
    // Staff dine-in path: only staff create a dine-in order by table_id in v1.
    if (!isStaff) {
      return errorResponse(400, 'Dine-in orders can only be created by staff');
    }
    if (!isUuid(rawTableId)) {
      return errorResponse(400, 'A table is required for dine-in orders');
    }
    const { data: tableRow, error: tableError } = await admin
      .from('tables')
      .select('id, label, is_active')
      .eq('id', rawTableId)
      .maybeSingle();
    if (tableError) {
      return errorResponse(500, 'Failed to validate the table');
    }
    if (!tableRow || !tableRow.is_active) {
      return errorResponse(400, 'That table does not exist or is inactive');
    }
    tableId = tableRow.id as string;
    tableLabel = tableRow.label as string;
  }

  // Store-state gate (C3/S7): reject a guest checkout when we're not accepting
  // orders (closed, paused, past last-order cutoff). Staff presence implies the
  // store is open, so a staff-created order bypasses this (FND3-3) — logged, not
  // blocked. Staff accept existing orders via a separate flow anyway.
  const settings = await getStoreSettings();
  const openState = computeStoreOpenState(settings);
  if (!openState.acceptingOrders) {
    if (isStaff) {
      console.info('staff order created while not accepting online orders', {
        reason: openState.reason,
      });
    } else {
      const msg =
        openState.reason === 'paused'
          ? 'We are not accepting online orders right now.'
          : openState.reason === 'after_cutoff'
            ? 'Online orders for today are closed. Please try again tomorrow.'
            : 'The store is currently closed. Please order during opening hours.';
      return errorResponse(409, msg);
    }
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
  // never trust a client-submitted price. Shared with the TAB-1 add path.
  const resolved = resolveOrderLines(items, menuById);
  if (!resolved.ok) {
    return errorResponse(400, resolved.error);
  }
  const resolvedLines = resolved.lines;
  let subtotal_inr = resolved.subtotalInr;

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

  // VAL-2 (D4-3) — link a counter order to the regular standing at the counter.
  //
  // Derived HERE, from the phone the staffer typed, exactly like user_id is
  // derived from the session and for exactly the same reason: a body field
  // naming the beneficiary would let a client spend any customer's points.
  // Staff orders only — a walk-in is physically in front of a staffer who sees
  // the matched name, whereas letting a web or table-QR customer link by typing
  // a number would hand them a stranger's balance.
  //
  // No match ⇒ the order proceeds unlinked and no account is ever created.
  const linkedCustomer = isStaff ? await findVerifiedCustomerByPhone(admin, trimmedPhone) : null;
  const customerUserId = linkedCustomer?.userId ?? null;

  // Whose promotions and points this order draws on. For a web checkout that is
  // the session (unchanged); for a counter order it is the linked customer, and
  // `userId` is null there — every coupon and points check below must use THIS,
  // or a staff order silently behaves like a guest with no history and no
  // balance (F9).
  const loyaltyUserId = customerUserId ?? userId;

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
      userId: loyaltyUserId,
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
      if (!loyaltyUserId) {
        // Two different dead ends, and a staffer can act on only one of them:
        // the counter one is fixable in a second by typing the right number.
        return errorResponse(
          400,
          isStaff
            ? 'No customer account is linked to this number, so there are no points to redeem. Check the number, or ask the customer to verify it in the app.'
            : 'You must be logged in to redeem points',
        );
      }
      const remaining = Math.max(0, subtotal_inr - couponDiscountInr);
      const quote = await quoteRedemption(loyaltyUserId, redeem_points, remaining);
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

  // Dine-in has no packaging charge (D5): force packaging to 0 and drop it from
  // the total, regardless of the store's packaging setting. GST/discount unchanged.
  if (isDineIn && bill.packaging_inr !== 0) {
    bill.total_inr -= bill.packaging_inr;
    bill.packaging_inr = 0;
  }

  // Online payment (PAY-1/FND-1) gates the order at 'placed' — kept OUT of
  // the staff queue until the gateway confirms it (webhook/reconcile). A
  // fully-discounted order ("free" via coupon/points) has nothing to charge,
  // so it goes straight to the counter flow regardless of payment_mode.
  // Staff-created orders (FND3-3): staff placing the order IS acceptance, so it
  // starts at 'accepted' and never enters the online-payment 'placed' gate.
  // Normally settled at entry (POS-2), but an unpaid staff order still enters the
  // flow — unlike web online orders which gate on payment. A ₹0 order is paid.
  // Table-QR orders (QR-1/D6) always pay online first — like a web online order,
  // they start 'placed' and go through the gateway/payment-intent flow so nothing
  // enters the queue unpaid, regardless of any client-sent payment_mode.
  const needsOnlinePayment = !isStaff && (isTableQr || paymentMode === 'online') && bill.total_inr > 0;
  const initialStatus: OrderStatus = isStaff
    ? 'accepted'
    : needsOnlinePayment
      ? 'placed'
      : 'received';
  // A fully-discounted (₹0) order has nothing to collect — mark it paid so staff
  // don't see "unpaid" + a "mark payment" prompt on an already-settled order (M7).
  const initialPaymentStatus: PaymentStatus = needsOnlinePayment
    ? 'payment_pending'
    : bill.total_inr === 0
      ? 'paid'
      : 'unpaid';
  const initialPaymentMethod: PaymentMethod | null = needsOnlinePayment ? 'online' : null;

  // POS4-2: claim the idempotency key immediately before creating. Claiming here
  // rather than at the top of the handler means the many validation early-returns
  // above don't burn a key the staffer will legitimately retry with.
  if (idempotencyKey) {
    const claim = await claimIdempotencyKey(admin, idempotencyKey, userId);
    if (claim.state === 'replay') {
      // The original request DID succeed — the response just never arrived.
      // Return its order so the retry is a no-op instead of a duplicate.
      const { data: prior } = await admin
        .from('orders')
        .select('*, order_items(*, order_item_addons(*))')
        .eq('id', claim.orderId)
        .single();
      if (prior) {
        return NextResponse.json(
          { order: toOrderResponse(prior as OrderRowWithItems), payment: null, replayed: true },
          { status: 201 },
        );
      }
    } else if (claim.state === 'in_flight') {
      return errorResponse(409, 'This order is already being placed — please wait a moment.');
    }
    // 'unavailable' (migration not applied) falls through: taking the order
    // matters more than the guard, and claimIdempotencyKey logged it.
  }

  const orderFields: Record<string, unknown> = {
    customer_name: trimmedName,
    customer_phone: trimmedPhone,
    // Only sent when provided so order creation doesn't require the
    // customer_email column until the 2026-07-order-email migration is applied.
    ...(customerEmail ? { customer_email: customerEmail } : {}),
    pickup_time: slotLabel, // legacy column kept in sync with the slot label
    pickup_slot_start: slotStartIso,
    pickup_slot_label: slotLabel,
    order_type: orderType,
    channel: isStaff ? 'staff_pos' : isTableQr ? 'table_qr' : 'customer_web',
    table_id: tableId,
    table_label: tableLabel,
    created_by: actor ? actor.user.id : null,
    status: initialStatus,
    subtotal_inr: bill.subtotal_inr,
    tax_inr: bill.tax_inr,
    packaging_inr: bill.packaging_inr,
    discount_inr: bill.discount_inr,
    total_inr: bill.total_inr,
    pickup_code: isDineIn ? null : generatePickupCode(),
    notes: notes ?? '',
    // The session that placed it — null for a staff order by design (D4-3).
    // Who the order BELONGS to, when that's a different person, is
    // customer_user_id below.
    user_id: userId,
    payment_status: initialPaymentStatus,
    payment_method: initialPaymentMethod,
  };

  // VAL-2: the link is sent only when there IS one, so an unlinked order never
  // depends on the column existing.
  const linkedFields: Record<string, unknown> = customerUserId
    ? { ...orderFields, customer_user_id: customerUserId }
    : orderFields;

  let { data: orderRow, error: orderError } = await admin
    .from('orders')
    .insert(linkedFields)
    .select()
    .single();

  // The column isn't there yet. Losing the loyalty link costs a regular some
  // points; refusing to take a paying customer's order because a migration is
  // pending closes the counter. So this fails OPEN — unlinked, loudly, and
  // naming the file to apply (same posture as the idempotency claim).
  if (customerUserId && isMissingColumnError(orderError)) {
    console.error(
      'orders.customer_user_id is missing — creating this order UNLINKED, so it will not earn. ' +
        'Is supabase/2026-08-counter-loyalty.sql applied?',
      orderError,
    );
    ({ data: orderRow, error: orderError } = await admin
      .from('orders')
      .insert(orderFields)
      .select()
      .single());
  }

  if (orderError || !orderRow) {
    // Surface the underlying Postgres message (e.g. a missing column when the
    // migration hasn't been applied) so the failure is diagnosable rather than
    // an opaque 500 — this app has no PII in the error path.
    console.error('orders insert failed', orderError);
    // Release the claim: no order exists, so the staffer's retry must not be
    // rejected as a duplicate of something that never happened.
    if (idempotencyKey) await releaseIdempotencyKey(admin, idempotencyKey);
    return errorResponse(500, orderError?.message ? `Failed to create order: ${orderError.message}` : 'Failed to create order');
  }

  // Point the claim at the order the moment it exists, so a retry arriving from
  // here on replays instead of racing.
  if (idempotencyKey) await completeIdempotencyKey(admin, idempotencyKey, orderRow.id as string);

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

  // Seed the lifecycle event log with the initial transition (F1) so SLA metrics
  // have an anchor for every order — 'received'/'placed' for the guest/web path
  // (system actor), or 'accepted' attributed to the staff member who punched a
  // staff_pos order (null → accepted, FND3-3).
  await admin.from('order_status_events').insert({
    order_id: orderRow.id,
    from_status: null,
    to_status: initialStatus,
    actor_id: actor ? actor.user.id : null,
    actor_role: actor ? actorRoleFor(actor.role) : 'system',
    reason: '',
  });

  // Snapshot the coupon redemption ATOMICALLY (FND-3 / H1): try_redeem_coupon
  // re-checks usage_limit/per_user_limit under a per-coupon lock and inserts in
  // one step, closing the last-use race. If the coupon just hit its limit
  // (race lost), roll the order back (cascade cleans items) and ask for a retry.
  // Falls back to the plain insert when the RPC isn't deployed yet, so checkout
  // keeps working until supabase/phase2-hardening.sql is applied.
  // The redemption is recorded against loyaltyUserId — at the counter that's the
  // linked customer, and it's what the per-user-limit above counted, so the
  // check and the record it produces are about the same person.
  if (appliedCoupon && couponDiscountInr > 0) {
    const { data: ok, error: rpcError } = await admin.rpc('try_redeem_coupon', {
      p_coupon_id: appliedCoupon.id,
      p_order_id: orderRow.id,
      p_user_id: loyaltyUserId,
      p_discount: couponDiscountInr,
      p_usage_limit: appliedCoupon.usage_limit,
      p_per_user_limit: appliedCoupon.per_user_limit,
    });
    if (rpcError) {
      console.error('try_redeem_coupon rpc unavailable; falling back to insert', rpcError);
      await admin.from('coupon_redemptions').insert({
        coupon_id: appliedCoupon.id,
        order_id: orderRow.id,
        user_id: loyaltyUserId,
        discount_inr: couponDiscountInr,
      });
    } else if (ok === false) {
      await admin.from('orders').delete().eq('id', orderRow.id);
      return errorResponse(409, 'This coupon just reached its usage limit — please try again.');
    }
  }

  // Record the points redemption ATOMICALLY (FND-4 / H1): try_redeem_points
  // re-checks the balance under a per-user lock. loyaltyUserId is non-null here
  // — the quote above refuses to redeem without an account. Same rollback-on-race
  // + RPC fallback. The fallback resolves the beneficiary from the order itself,
  // so both paths debit the same person.
  if (pointsToRedeem > 0 && loyaltyUserId) {
    const { data: ok, error: rpcError } = await admin.rpc('try_redeem_points', {
      p_user_id: loyaltyUserId,
      p_order_id: orderRow.id,
      p_points: pointsToRedeem,
      p_discount: pointsDiscountInr,
    });
    if (rpcError) {
      console.error('try_redeem_points rpc unavailable; falling back', rpcError);
      await redeemForOrder(orderRow.id, pointsToRedeem, pointsDiscountInr);
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

  // Send the link-based e-bill (RCT-1/2) on email + WhatsApp, logged + idempotent
  // via the notification engine. Best-effort and never throws — a slow or
  // unconfigured provider can't block or fail order creation. Each channel is
  // dormant until configured. Online orders send at placement too; the linked
  // bill page always reflects live payment status when opened.
  // A staff-created order is settled later (POS-2); its bill fires at settle
  // (RCT-1), so we don't send an unpaid bill at creation time. A web or table-QR
  // customer (both `!isStaff`) gets the live bill link now; the linked page
  // reflects real payment status once the online payment (D6) confirms.
  if (!isStaff) {
    await sendBillNotification(response);
  }

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
