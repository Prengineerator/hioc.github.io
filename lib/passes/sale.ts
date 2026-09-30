// Selling a HIOC Ritual pass = creating an order (docs/COFFEE-PASS-SPEC.md §2, §7).
//
// One builder for both ways a pass is sold, so the two can never drift:
//   POST /api/passes/checkout   the customer on the website (customer_web, 'placed',
//                               payment_pending, then Razorpay)
//   POST /api/passes/sell       a staffer at the counter (staff_pos, 'accepted',
//                               unpaid, then the payment panel)
//
// The order is an ordinary orders row with order_kind = 'coffee_pass' and ONE
// order_items row that names the plan (menu_item_id null, coffee_pass_plan_id
// set). Nothing here issues the pass: a database trigger does that the moment the
// order's payment_status becomes 'paid', by whichever path gets it there
// (supabase/2026-10-coffee-pass.sql, CP-D6). So this module never touches
// coffee_passes.
//
// Two halves, deliberately apart:
//   buildPassSaleRows()   pure — the row fields and the bill. Unit-tested.
//   createPassSaleOrder() the inserts, with a rollback, like POST /api/orders.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrderRowWithItems } from '@/lib/api/orders';
import { isMissingPassSchema } from '@/lib/passes/api';
import { cupsLabel } from '@/lib/passes/brand';
import type { CoffeePassPlan } from '@/lib/passes/types';
import { computeBill, type BillBreakdown } from '@/lib/store/hours';
import type { ActorRole, OrderChannel, OrderStatus, PaymentMethod, PaymentStatus, StoreSettings } from '@/lib/types';

export interface PassSaleInput {
  plan: CoffeePassPlan;
  channel: OrderChannel;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  customerName: string;
  /** Stored E.164 form ("+919876543210"): orders.customer_phone is NOT NULL. */
  customerPhone: string;
  /** The session that placed it: the customer online, null for a counter sale (as POST /api/orders). */
  userId: string | null;
  /** The account the pass will be issued to. The issuing trigger reads this (else userId). */
  customerUserId: string | null;
  /** The staffer who sold it (orders.created_by); null online. */
  createdBy: string | null;
  /** Who the first status event is attributed to. Default: 'staff' for a staffer, else 'system'. */
  actorRole?: ActorRole;
  settings: StoreSettings;
}

/** "7 cups · 7 days": the second line of the pass on a bill, receipt and order page. */
export function passLineLabel(plan: Pick<CoffeePassPlan, 'drinks_total' | 'validity_days'>): string {
  const days = plan.validity_days;
  return `${cupsLabel(plan.drinks_total)} · ${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * The bill for a pass sale: the plan price is the subtotal; GST follows the
 * store's settings unless the plan is GST-exempt (CP-D11, charged when the pass
 * is SOLD); no packaging (there is nothing to pack); no discount, coupon or
 * points (CP-D13: a pass is already the discount).
 */
export function passSaleBill(plan: Pick<CoffeePassPlan, 'price_inr' | 'gst_exempt'>, settings: StoreSettings): BillBreakdown {
  return computeBill(
    plan.price_inr,
    { ...settings, packaging_charge_inr: 0 },
    0,
    plan.gst_exempt ? 0 : plan.price_inr,
  );
}

/**
 * The orders row and the single order_items row of a pass sale, plus the bill,
 * as plain data (no database). The order_items row lacks order_id: the caller
 * knows it only after the insert.
 *
 * Column choices, from the schema's NOT NULL / CHECK columns:
 *  - order_type 'takeaway': the enum has no "not a food order" value, and
 *    'dine_in' would want a table. Nothing shows it as a pickup: the order is
 *    completed the moment it is paid, and every screen labels it by order_kind.
 *  - pickup_time / pickup_slot_label '' (NOT NULL text), pickup_slot_start,
 *    table_id and pickup_code null (nullable): a pass has no pickup, and no
 *    counter code to read out.
 *  - pass_discount_inr is left at its default 0: that column is for cups a pass
 *    COVERED on a menu order, never for the sale of one.
 */
export function buildPassSaleRows(input: PassSaleInput): {
  order: Record<string, unknown>;
  item: Record<string, unknown>;
  bill: BillBreakdown;
} {
  const { plan } = input;
  const bill = passSaleBill(plan, input.settings);
  const order: Record<string, unknown> = {
    order_kind: 'coffee_pass',
    customer_name: input.customerName,
    customer_phone: input.customerPhone,
    pickup_time: '',
    pickup_slot_start: null,
    pickup_slot_label: '',
    order_type: 'takeaway',
    channel: input.channel,
    table_id: null,
    table_label: '',
    created_by: input.createdBy,
    status: input.status,
    subtotal_inr: bill.subtotal_inr,
    tax_inr: bill.tax_inr,
    packaging_inr: 0,
    discount_inr: 0,
    total_inr: bill.total_inr,
    pickup_code: null,
    notes: '',
    user_id: input.userId,
    payment_status: input.paymentStatus,
    payment_method: input.paymentMethod,
  };
  // Sent only when there IS an account, like POST /api/orders, so an unlinked
  // order never depends on the column existing.
  if (input.customerUserId) order.customer_user_id = input.customerUserId;

  const item: Record<string, unknown> = {
    menu_item_id: null,
    variant_id: null,
    name_snapshot: plan.name,
    variant_label_snapshot: passLineLabel(plan),
    price_inr_snapshot: plan.price_inr,
    quantity: 1,
    line_total_inr: plan.price_inr,
    special_instructions: '',
    gst_exempt: plan.gst_exempt,
    coffee_pass_plan_id: plan.id,
  };
  return { order, item, bill };
}

/** A pass purchase as a screen lists it: "Weekly Ritual, ₹788, order #42". */
export interface PassSaleSummary {
  order_id: string;
  order_number: number | null;
  plan_name: string;
  total_inr: number;
  created_at: string;
}

/** The orders columns (with the one line embedded) that toPassSaleSummaries() reads. */
export const PASS_SALE_SUMMARY_SELECT = 'id, order_number, total_inr, created_at, order_items(name_snapshot)';

/**
 * Order rows selected with PASS_SALE_SUMMARY_SELECT -> summaries. The plan's
 * name is the order's one line (name_snapshot), so a renamed plan still reads as
 * it was sold. Shared by GET /api/passes/mine (purchases awaiting the gateway)
 * and GET /api/passes/holder (sales still unpaid at the counter).
 */
export function toPassSaleSummaries(rows: unknown): PassSaleSummary[] {
  type Row = {
    id: string;
    order_number?: number | null;
    total_inr?: number | null;
    created_at: string;
    order_items?: { name_snapshot?: string }[] | null;
  };
  return ((rows ?? []) as Row[]).map((r) => ({
    order_id: r.id,
    order_number: r.order_number ?? null,
    plan_name: r.order_items?.[0]?.name_snapshot ?? '',
    total_inr: r.total_inr ?? 0,
    created_at: r.created_at,
  }));
}

export type PassSaleResult =
  | { ok: true; order: OrderRowWithItems }
  | { ok: false; message: string; missingSchema: boolean };

/**
 * Inserts the sale order, its one line and its first status event, and returns
 * the row with its items (`*, order_items(*, order_item_addons(*))`, the shape
 * toOrderResponse() takes).
 *
 * If the line cannot be written the order is deleted again (its events cascade)
 * so no pass-less, item-less order is left on the board. `missingSchema` says the
 * failure was a database without supabase/2026-10-coffee-pass.sql, so the route
 * can answer with the migration hint instead of an unexplained 500.
 */
export async function createPassSaleOrder(admin: SupabaseClient, input: PassSaleInput): Promise<PassSaleResult> {
  const { order, item } = buildPassSaleRows(input);

  const { data: orderRow, error: orderError } = await admin.from('orders').insert(order).select().single();
  if (orderError || !orderRow) {
    console.error('pass sale: orders insert failed', orderError);
    return {
      ok: false,
      message: orderError?.message ? `Failed to create order: ${orderError.message}` : 'Failed to create order',
      missingSchema: isMissingPassSchema(orderError),
    };
  }
  const orderId = String((orderRow as { id: unknown }).id);

  // The line and the first lifecycle event are independent (the event needs only
  // the order id), so they go in together, as POST /api/orders does. The event is
  // the anchor the SLA metrics and the order timeline expect for every order.
  const actorRole: ActorRole = input.actorRole ?? (input.createdBy ? 'staff' : 'system');
  const [itemResult, eventResult] = await Promise.all([
    admin.from('order_items').insert({ ...item, order_id: orderId }),
    admin.from('order_status_events').insert({
      order_id: orderId,
      from_status: null,
      to_status: input.status,
      actor_id: input.createdBy,
      actor_role: actorRole,
      reason: '',
    }),
  ]);
  if (itemResult.error) {
    console.error('pass sale: order_items insert failed', itemResult.error);
    await admin.from('orders').delete().eq('id', orderId);
    return {
      ok: false,
      message: itemResult.error.message
        ? `Failed to create order items: ${itemResult.error.message}`
        : 'Failed to create order items',
      missingSchema: isMissingPassSchema(itemResult.error),
    };
  }
  // A lost event costs an SLA anchor, not the sale. Log it and go on.
  if (eventResult.error) console.error('pass sale: order_status_events insert failed', eventResult.error);

  const { data: full, error: fetchError } = await admin
    .from('orders')
    .select('*, order_items(*, order_item_addons(*))')
    .eq('id', orderId)
    .single();
  if (fetchError || !full) {
    console.error('pass sale: created the order but could not load it back', fetchError);
    return { ok: false, message: 'Created order but failed to load it back', missingSchema: false };
  }
  return { ok: true, order: full as unknown as OrderRowWithItems };
}
