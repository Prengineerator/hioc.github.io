// Selling a HIOC Ritual pass = creating an order (docs/COFFEE-PASS-SPEC.md §2, §7, §13).
//
// One builder for both ways a pass is sold, so the two can never drift:
//   POST /api/passes/checkout   the customer on the website (customer_web, 'placed',
//                               payment_pending, then Razorpay)
//   POST /api/passes/sell       a staffer at the counter (staff_pos, 'accepted',
//                               unpaid, then the payment panel)
//
// PER-DRINK PRICING (§13, CP-D22..D25). The customer picks a drink and a size when
// buying, and a plan has no price of its own: the price is
//   drinks_paid × the menu price of that size     (Weekly 5 ×, Monthly 6 ×)
// and the cup value (what one cup covers when it is redeemed, CP-D23) is that same
// menu price, frozen on the sale line when it is sold. resolveRitualCup() prices
// the chosen cup from the live menu exactly as POST /api/orders would price one
// unit, and buildPassSaleRows() turns plan + cup into the rows.
//
// The order is an ordinary orders row with order_kind = 'coffee_pass' and ONE
// order_items row that names the plan (menu_item_id null, coffee_pass_plan_id
// set). Nothing here issues the pass: a database trigger does that the moment the
// order's payment_status becomes 'paid', by whichever path gets it there
// (supabase/2026-10-coffee-pass.sql, CP-D6). So this module never touches
// coffee_passes.
//
// Three parts, deliberately apart:
//   pure helpers + buildPassSaleRows()   the row fields, the labels, the price and
//                                        the bill. Unit-tested.
//   resolveRitualCup()                   reads the menu, applies the order rules.
//   createPassSaleOrder()                the inserts, with a rollback, like
//                                        POST /api/orders.

import 'server-only';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { OrderRowWithItems } from '@/lib/api/orders';
import { isMissingPassSchema } from '@/lib/passes/api';
import { cupsLabel, PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import { ritualDrinkLabel, ritualLineName, ritualPriceFor } from '@/lib/passes/rules';
import type { CoffeePassPlan, CoffeePassTerms, RitualCup } from '@/lib/passes/types';
import { firstInStoreOnlyItem } from '@/lib/menu/inStore';
import { switchesFromSettings } from '@/lib/menu/menuSwitches';
import { MENU_ITEM_SELECT, resolveOrderLines, shapeMenuItem, type MenuItemRow } from '@/lib/orders/lines';
import { computeBill, type BillBreakdown } from '@/lib/store/hours';
import type { ActorRole, OrderChannel, OrderStatus, PaymentMethod, PaymentStatus, StoreSettings } from '@/lib/types';

// The pure half lives in lib/passes/rules.ts so a screen can price a Ritual with the
// very function the server does (this module is server-only). Re-exported here so the
// sale code and its tests read from one place.
export { MAX_DRINK_LABEL_LENGTH, ritualDrinkLabel, ritualLineName, ritualPriceFor } from '@/lib/passes/rules';
export type { RitualCup } from '@/lib/passes/types';

export interface PassSaleInput {
  plan: CoffeePassPlan;
  /** The drink and size the customer chose, from resolveRitualCup. */
  cup: RitualCup;
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
 * The terms the customer is being SOLD: the plan's recipe as it reads at this
 * moment, plus the drink they chose. They are written on the sale's line and the
 * issuing trigger reads them back when the order is paid, so an owner's edit to
 * the plan in between (a Razorpay payment that lands ten minutes later, a counter
 * sale settled after a menu price change) never changes what the customer gets.
 * The price is not in here: the line's own total is what the pass records as paid.
 *
 *   drink_value_inr     the chosen size's menu price, frozen (CP-D23): what each
 *                       cup covers, whatever the menu later costs
 *   drink_menu_item_id  which drink, and
 *   drink_label         "Cappuccino · Large", for "your Cappuccino Ritual" (CP-D25)
 */
export function passSaleTerms(
  plan: Pick<CoffeePassPlan, 'name' | 'drinks_total' | 'validity_days' | 'max_per_day'>,
  cup: RitualCup,
): CoffeePassTerms {
  return {
    plan_name: plan.name,
    drinks_total: plan.drinks_total,
    drink_value_inr: cup.price_inr,
    validity_days: plan.validity_days,
    // Always written, null included: the trigger treats a missing key as unreadable.
    max_per_day: plan.max_per_day ?? null,
    drink_menu_item_id: cup.menu_item_id,
    drink_label: ritualDrinkLabel(cup),
  };
}

/**
 * The bill for a pass sale: the Ritual's price (ritualPriceFor) is the subtotal;
 * GST follows the store's settings unless the plan is GST-exempt (CP-D11, charged
 * when the pass is SOLD); no packaging (there is nothing to pack); no discount,
 * coupon or points (CP-D13: a pass is already the discount).
 */
export function passSaleBill(sale: { price_inr: number; gst_exempt: boolean }, settings: StoreSettings): BillBreakdown {
  return computeBill(
    sale.price_inr,
    { ...settings, packaging_charge_inr: 0 },
    0,
    sale.gst_exempt ? 0 : sale.price_inr,
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
 *  - the price is drinks_paid × the chosen size's price (CP-D22), so 5 × ₹120 =
 *    ₹600 for a Weekly Cappuccino Large; the bill adds GST on top like any sale.
 */
export function buildPassSaleRows(input: PassSaleInput): {
  order: Record<string, unknown>;
  item: Record<string, unknown>;
  bill: BillBreakdown;
} {
  const { plan, cup } = input;
  const price = ritualPriceFor(plan, cup.price_inr);
  const bill = passSaleBill({ price_inr: price, gst_exempt: plan.gst_exempt }, input.settings);
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
    // "Weekly Ritual — Cappuccino (Large)". menu_item_id stays null on purpose: the
    // drink is on the TERMS, and a null id keeps a Ritual sale out of the item-level
    // sales reports and the stock consumption that hang off real menu lines.
    name_snapshot: ritualLineName(plan, cup),
    variant_label_snapshot: passLineLabel(plan),
    price_inr_snapshot: price,
    quantity: 1,
    line_total_inr: price,
    special_instructions: '',
    gst_exempt: plan.gst_exempt,
    coffee_pass_plan_id: plan.id,
    // What was SOLD, frozen here: the issuing trigger reads it instead of the live plan.
    coffee_pass_terms: passSaleTerms(plan, cup),
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
 * name is the order's one line (name_snapshot: "Weekly Ritual — Cappuccino
 * (Large)" since per-drink pricing), so a renamed plan still reads as it was sold. Shared by GET /api/passes/mine (purchases awaiting the gateway)
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

// ---------------------------------------------------------------------------
// Choosing the drink (CP-D22)
// ---------------------------------------------------------------------------

/** What a customer is told for a drink that is not in the program (or does not exist: the two read the same). */
export const RITUAL_NOT_ELIGIBLE_MESSAGE = `That drink isn't part of ${PASS_PROGRAM_NAME}.`;

export type RitualCupResult =
  | { ok: true; cup: RitualCup }
  | { ok: false; status: 400 | 500; error: string };

/**
 * Prices the drink and size a customer picked for their Ritual, from the LIVE
 * menu, by the same rules an order for one of it would meet. The client's numbers
 * are never read: it sends only ids.
 *
 *   - the drink must exist and be pass_eligible (CP-D3), else 400
 *     "That drink isn't part of HIOC Ritual." (a missing drink reads the same, so
 *     nobody can probe which ids exist);
 *   - the website (and the table QR) may not sell an in-store-only item, exactly
 *     as POST /api/orders refuses one (`firstInStoreOnlyItem`); the counter may;
 *   - ONE unit goes through resolveOrderLines, the function POST /api/orders
 *     prices with, so the store's rules apply unchanged: an item that is 86'd or
 *     snoozed, a switched-off category, a size the owner has switched off, a
 *     variant that is not the item's. Its message becomes the 400.
 *
 * The item goes to resolveOrderLines WITHOUT its add-on groups, on purpose. A
 * Ritual is priced from the size alone (CP-D23), and real coffee carries required
 * groups ("Choice of Sugar", "Ice Level": min_select 1) that an order answers with
 * a choice. Left in, every such drink would be refused here with "requires exactly
 * 1 selection", and the customer has nothing to choose yet: they make those
 * choices when they redeem a cup on an order.
 *
 * A size priced at ₹0 is refused (there is nothing to sell, and the pass needs a
 * cup value of at least ₹1). A failure to read the menu is a 500, never a guess.
 */
export async function resolveRitualCup(
  admin: SupabaseClient,
  input: { menuItemId: string; variantId: string; settings: StoreSettings; channel: OrderChannel },
): Promise<RitualCupResult> {
  const { data, error } = await admin.from('menu_items').select(MENU_ITEM_SELECT).eq('id', input.menuItemId).maybeSingle();
  if (error) {
    console.error('coffee pass: could not load the chosen drink', error);
    return { ok: false, status: 500, error: 'Could not check that drink just now — please try again.' };
  }
  if (!data) return { ok: false, status: 400, error: RITUAL_NOT_ELIGIBLE_MESSAGE };

  const item = shapeMenuItem(data as unknown as MenuItemRow);
  // `=== true`: a database without pass_eligible (or a row that never had it) is "no".
  if (item.pass_eligible !== true) return { ok: false, status: 400, error: RITUAL_NOT_ELIGIBLE_MESSAGE };

  if (input.channel !== 'staff_pos') {
    const inStore = firstInStoreOnlyItem([{ menu_item_id: item.id }], new Map([[item.id, item]]));
    if (inStore) return { ok: false, status: 400, error: `${inStore.name} is only available at the café counter` };
  }

  const resolved = resolveOrderLines(
    [{ menu_item_id: item.id, variant_id: input.variantId, quantity: 1, addon_option_ids: [], special_instructions: '' }],
    new Map([[item.id, { ...item, addon_groups: [] }]]),
    switchesFromSettings(input.settings),
  );
  if (!resolved.ok) return { ok: false, status: 400, error: resolved.error };

  const line = resolved.lines[0];
  if (!(line.price_inr_snapshot >= 1)) {
    return { ok: false, status: 400, error: `${line.name_snapshot} in ${line.variant_label_snapshot} can't be bought as a ${PASS_PROGRAM_NAME}.` };
  }
  return {
    ok: true,
    cup: {
      menu_item_id: line.menu_item_id,
      variant_id: line.variant_id,
      name: line.name_snapshot,
      size_label: line.variant_label_snapshot,
      price_inr: line.price_inr_snapshot,
    },
  };
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
