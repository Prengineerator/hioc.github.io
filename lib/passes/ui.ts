// Display helpers for the HIOC Ritual customer screens (docs/COFFEE-PASS-SPEC.md
// §8): the /ritual page, the checkout's "use my Ritual" row, the bill rows and
// the order status page.
//
// Pure on purpose (no React, no server-only, no fetch): this repo has no
// component tests, so anything a screen DECIDES (which wording, how many dots,
// what to send to the server) lives here where vitest can pin it, and the
// screens only lay it out. Brand words come from lib/passes/brand.ts; the rules
// (planDiscountPercent, the per-order cup cap) from lib/passes/rules.ts.
//
// All calendar reasoning is Asia/Kolkata (IST, UTC+05:30, no DST), matching the
// database and CP-D5.

import { cupsLabel, PASS_PROGRAM_NAME, PASS_SHORT_NAME } from '@/lib/passes/brand';
import { MAX_PASS_DRINKS_PER_ORDER, planDiscountPercent } from '@/lib/passes/rules';
import type { CoffeePassPlan, PassRedemptionEntry, PassShortfall, PassState, PassSummary } from '@/lib/passes/types';
import { formatOrderNumber } from '@/lib/utils/orderNumber';

// ---------------------------------------------------------------------------
// The API shapes the screens read (docs/COFFEE-PASS-SPEC.md §7)
// ---------------------------------------------------------------------------

/** GET /api/passes/plans. */
export interface RitualOffer {
  plans: CoffeePassPlan[];
  /** The drinks a Ritual cup can pay for (the chips). */
  eligible: { id: string; name: string; category: string; is_available: boolean }[];
  /** false = no Razorpay keys: the page says "Buy at the counter" instead of Buy. */
  online_purchase: boolean;
  gst: { percent: number; inclusive: boolean };
}

/** A pass with its redemption history, as GET /api/passes/mine returns it. */
export type PassWithHistory = PassSummary & { history: PassRedemptionEntry[] };

/** A purchase still waiting on the gateway. */
export interface PassPendingSale {
  order_id: string;
  order_number: number | null;
  plan_name: string;
  total_inr: number;
  created_at: string;
}

/** GET /api/passes/mine. */
export interface RitualMine {
  passes: PassWithHistory[];
  phone_verified: boolean;
  pending: PassPendingSale[];
}

// ---------------------------------------------------------------------------
// Dates (IST)
// ---------------------------------------------------------------------------

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function toMs(at: string | Date): number {
  return at instanceof Date ? at.getTime() : Date.parse(at);
}

/**
 * "Sun 5 Oct": the IST calendar day of an instant. Built by hand rather than
 * with Intl, so the wording is the same on every Node and browser (Intl's
 * abbreviation of September and its punctuation differ between locales and ICU
 * versions). An unreadable date gives ''.
 */
export function formatPassDay(at: string | Date): string {
  const ms = toMs(at);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms + IST_OFFSET_MS);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * The last day a pass can be used, as "Sun 5 Oct". `expires_at` is the instant
 * the NEXT IST day starts (CP-D5), so the last valid day is the one containing
 * the millisecond before it: a Weekly bought Monday expires Monday 00:00 and
 * reads "valid till Sunday".
 */
export function passLastDay(expiresAt: string | Date): string {
  const ms = toMs(expiresAt);
  if (Number.isNaN(ms)) return '';
  return formatPassDay(new Date(ms - 1));
}

/** "valid till Sun 5 Oct" (or '' when the date cannot be read). */
export function passValidTill(expiresAt: string | Date): string {
  const day = passLastDay(expiresAt);
  return day ? `valid till ${day}` : '';
}

// ---------------------------------------------------------------------------
// Plan cards
// ---------------------------------------------------------------------------

/**
 * The offer in a line, derived from the plan so an owner's edit changes the copy
 * with it: two or more free cups read "7 cups for the price of 5", one free cup
 * reads "Pay for 6, get 7", none reads "7 cups, prepaid".
 */
export function planHeadline(plan: Pick<CoffeePassPlan, 'drinks_total' | 'drinks_paid'>): string {
  const total = plan.drinks_total;
  const paid = plan.drinks_paid;
  const free = total - paid;
  if (free >= 2) return `${total} cups for the price of ${paid}`;
  if (free === 1) return `Pay for ${paid}, get ${total}`;
  return `${cupsLabel(total)}, prepaid`;
}

/** What one cup costs on this plan, in whole rupees (price over every cup you get). */
export function planPerCupInr(plan: Pick<CoffeePassPlan, 'price_inr' | 'drinks_total'>): number {
  if (plan.drinks_total <= 0) return plan.price_inr;
  return Math.round(plan.price_inr / plan.drinks_total);
}

/** "Save 29%", or null when the plan is no cheaper than paying for every cup. */
export function planSaveLabel(plan: Pick<CoffeePassPlan, 'drinks_total' | 'drinks_paid'>): string | null {
  const pct = planDiscountPercent(plan);
  return pct > 0 ? `Save ${pct}%` : null;
}

/**
 * "+ GST" when GST will be added on top of the price (the store prices
 * exclusive of GST and this plan is not marked GST-exempt), otherwise null: an
 * inclusive price or an exempt plan is the whole amount.
 */
export function planGstNote(
  plan: Pick<CoffeePassPlan, 'gst_exempt'>,
  gst: { percent: number; inclusive: boolean } | null | undefined,
): string | null {
  if (!gst || gst.inclusive || plan.gst_exempt || !(gst.percent > 0)) return null;
  return '+ GST';
}

/** True once at least one plan is on sale: what gates the menu chips and the checkout's "Save with" link. */
export function ritualOnSale(offer: Pick<RitualOffer, 'plans'> | null | undefined): boolean {
  return Boolean(offer && offer.plans.length > 0);
}

/** "Valid 7 days" / "Valid 1 day". */
export function planValidityLabel(plan: Pick<CoffeePassPlan, 'validity_days'>): string {
  const days = plan.validity_days;
  return `Valid ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** What a cup covers, and what happens above it (CP-D2). */
export function planCoverageLabel(plan: Pick<CoffeePassPlan, 'drink_value_inr'>): string {
  return `Covers any ${PASS_SHORT_NAME} drink up to ₹${plan.drink_value_inr} — pricier drinks just pay the difference.`;
}

/** The Buy button's words ("Buy Weekly Ritual"). */
export function planBuyLabel(plan: Pick<CoffeePassPlan, 'name'>): string {
  return `Buy ${plan.name}`;
}

/**
 * Groups the eligible drinks by category for the chips, categories in the order
 * given by `categoryOrder` (the menu's own order) and then alphabetically for
 * any it does not know, drinks in the order received. `labelFor` turns the stored
 * category into its display label.
 */
export function groupEligibleByCategory<T extends { category: string }>(
  drinks: readonly T[],
  categoryOrder: readonly string[],
  labelFor: (category: string) => string = (c) => c,
): { category: string; label: string; drinks: T[] }[] {
  const byCategory = new Map<string, T[]>();
  for (const drink of drinks) {
    const list = byCategory.get(drink.category);
    if (list) list.push(drink);
    else byCategory.set(drink.category, [drink]);
  }
  const rank = (c: string) => {
    const i = categoryOrder.indexOf(c);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...byCategory.keys()]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((category) => ({ category, label: labelFor(category), drinks: byCategory.get(category) as T[] }));
}

// ---------------------------------------------------------------------------
// Your Ritual: a pass as the customer sees it
// ---------------------------------------------------------------------------

export interface PassDot {
  /** A cup still to spend. */
  filled: boolean;
  /** A cup added by hand (a manager gave one back), past the plan's own cups. */
  extra: boolean;
}

/**
 * One dot per cup: the plan's own cups, then any the counter added, filled from
 * the left for the cups still to spend and empty for the ones used. So a Weekly
 * with 5 of 7 left is five filled and two empty dots; the same pass with one cup
 * given back is eight dots (the last marked `extra`) and six filled.
 */
export function passDots(pass: Pick<PassSummary, 'drinks_total' | 'drinks_credited' | 'drinks_remaining'>): PassDot[] {
  const total = Math.max(0, Math.trunc(pass.drinks_total));
  const count = total + Math.max(0, Math.trunc(pass.drinks_credited));
  const left = Math.min(count, Math.max(0, Math.trunc(pass.drinks_remaining)));
  return Array.from({ length: count }, (_, i) => ({ filled: i < left, extra: i >= total }));
}

/** "5 of 7 cups left" (the cups given back count in the 7). */
export function passCupsLeftLabel(
  pass: Pick<PassSummary, 'drinks_total' | 'drinks_credited' | 'drinks_remaining'>,
): string {
  const dots = passDots(pass);
  const left = dots.filter((d) => d.filled).length;
  return `${left} of ${cupsLabel(dots.length)} left`;
}

export type PassBadgeTone = 'success' | 'neutral' | 'outline';

/** The state badge on a pass card. */
export function passStateBadge(state: PassState): { label: string; tone: PassBadgeTone } {
  switch (state) {
    case 'active':
      return { label: 'Active', tone: 'success' };
    case 'used_up':
      return { label: 'Used up', tone: 'neutral' };
    case 'expired':
      return { label: 'Expired', tone: 'outline' };
    case 'refunded':
      return { label: 'Refunded', tone: 'outline' };
    case 'void':
      return { label: 'Cancelled', tone: 'outline' };
  }
}

/**
 * The date line on a pass card: "valid till Sun 5 Oct" while it can still be
 * used, "expired Sun 5 Oct" once its window has closed, and nothing for a pass
 * that was refunded or cancelled (its dates no longer mean anything).
 */
export function passValidityLine(pass: Pick<PassSummary, 'state' | 'expires_at'>): string {
  switch (pass.state) {
    case 'active':
    case 'used_up':
      return passValidTill(pass.expires_at);
    case 'expired': {
      const day = passLastDay(pass.expires_at);
      return day ? `expired ${day}` : 'expired';
    }
    default:
      return '';
  }
}

/** "Up to 1 cup a day" for a plan with a daily cap, otherwise null. */
export function passDailyLimitLabel(maxPerDay: number | null | undefined): string | null {
  if (maxPerDay == null || !(maxPerDay > 0)) return null;
  return `Up to ${cupsLabel(maxPerDay)} a day`;
}

/** One line of a pass's history: the order it was spent on, how many cups, when. */
export interface PassHistoryRow {
  orderId: string;
  /** "HIOC-001042", or "Order" when the number is not known. */
  orderLabel: string;
  cups: string;
  when: string;
  /** The cups came back (the order was cancelled or refunded, or the line voided). */
  returned: boolean;
}

export function passHistoryRow(entry: PassRedemptionEntry): PassHistoryRow {
  return {
    orderId: entry.order_id,
    orderLabel: entry.order_number != null ? formatOrderNumber(entry.order_number) : 'Order',
    cups: cupsLabel(entry.drinks),
    when: formatPassDay(entry.created_at),
    returned: entry.reversed,
  };
}

/** The collapsed history's summary line: "History (3)". */
export function passHistorySummary(count: number): string {
  return `History (${count})`;
}

/** The pass whose sale was `orderId`, once it has been issued (null while payment settles). */
export function findPassForOrder<T extends { order_id: string }>(passes: readonly T[], orderId: string): T | null {
  return passes.find((p) => p.order_id === orderId) ?? null;
}

/** "Your Weekly Ritual is ready — 7 cups, valid till Sun 5 Oct". */
export function passReadyMessage(
  pass: Pick<PassSummary, 'plan_name' | 'drinks_total' | 'expires_at'>,
): string {
  const till = passValidTill(pass.expires_at);
  return `Your ${pass.plan_name} is ready — ${cupsLabel(pass.drinks_total)}${till ? `, ${till}` : ''}`;
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

/** What the page offers to do about a failed purchase. */
export type PurchaseErrorAction = 'login' | 'profile' | 'counter' | 'retry';

/**
 * Turns a refused POST /api/passes/checkout into words and a next step. The
 * server's own message is kept where it is already customer-ready (400, 404);
 * the rest are reworded for a phone screen.
 */
export function purchaseError(status: number, serverMessage?: string | null): { message: string; action: PurchaseErrorAction } {
  const server = (serverMessage ?? '').trim();
  switch (status) {
    case 401:
      return { message: `Log in to buy your ${PASS_PROGRAM_NAME}.`, action: 'login' };
    case 400:
      // "Add your mobile number in your profile first" is the one 400 a customer can fix.
      if (/mobile number|phone/i.test(server)) {
        return { message: 'Add your mobile number in your profile first.', action: 'profile' };
      }
      return { message: server || 'That plan could not be bought. Please try again.', action: 'retry' };
    case 404:
      return { message: server || `That ${PASS_PROGRAM_NAME} plan isn't available any more.`, action: 'retry' };
    case 429:
      return { message: 'Too many attempts — please wait a few minutes and try again.', action: 'retry' };
    case 503:
      return {
        message: `Online purchase isn't available right now — buy your ${PASS_PROGRAM_NAME} at the counter.`,
        action: 'counter',
      };
    default:
      return { message: server || 'Something went wrong. Please try again.', action: 'retry' };
  }
}

/** What to say when the payment window was closed without paying. */
export function paymentDismissedMessage(lastFailure?: string): string {
  return lastFailure
    ? `Payment didn't go through: ${lastFailure}`
    : 'Payment was cancelled — no charge was made. You can try again whenever you like.';
}

/** The passes that can be spent from: active ones with cups left. */
export function usablePasses<T extends Pick<PassSummary, 'state' | 'drinks_remaining'>>(passes: readonly T[]): T[] {
  return passes.filter((p) => p.state === 'active' && p.drinks_remaining > 0);
}

// ---------------------------------------------------------------------------
// Checkout: "use my Ritual"
// ---------------------------------------------------------------------------

/** The `pass` block of POST /api/orders/quote, as far as the checkout reads it. */
export interface PassQuote {
  requested: number;
  applied: number;
  discount_inr: number;
  eligible_units: number;
  available: number;
  max_usable: number;
  shortfall: PassShortfall;
  message: string | null;
}

/**
 * How many cups to ask the quote for. Until the customer has touched the
 * stepper the answer is "as many as this cart can use", so the row opens
 * pre-filled to the most usable (CP-D10) and follows the cart if it changes;
 * once they have chosen, their number is what is sent.
 */
export function passCupsToRequest(touched: boolean, stepper: number): number {
  return touched ? clampCups(stepper, MAX_PASS_DRINKS_PER_ORDER) : MAX_PASS_DRINKS_PER_ORDER;
}

/** A whole number of cups from 0 to `max` (a non-finite input is 0). */
export function clampCups(n: number, max: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(0, Math.trunc(max)), Math.max(0, Math.trunc(n)));
}

/** The stepper after a − / + tap, held to what the cart can use. */
export function stepPassCups(current: number, delta: 1 | -1, maxUsable: number): number {
  return clampCups(current + delta, maxUsable);
}

/**
 * The cups to send with the order: only what the latest quote actually applied,
 * and only when it is what the stepper shows. Anything else is left out, so the
 * order never asks for cups the customer did not see priced (the same rule the
 * coupon and Beanies follow).
 */
export function passCupsToSend(quote: Pick<PassQuote, 'applied'> | null | undefined, stepper: number): number | undefined {
  if (!quote || quote.applied <= 0) return undefined;
  return quote.applied === stepper ? quote.applied : undefined;
}

/**
 * What the checkout's Ritual row should be:
 *   hidden    no usable cups (or no quote yet): nothing is shown, so the row never
 *             advertises an empty pass
 *   stepper   cups can be used on this cart: the − / + row
 *   unusable  the customer has cups but none can be used on THIS order (nothing
 *             eligible in the cart, or today's limit is reached): a quiet note
 */
export type PassRowMode = 'hidden' | 'stepper' | 'unusable';

export function passRowMode(quote: PassQuote | null | undefined): PassRowMode {
  if (!quote || quote.available <= 0) return 'hidden';
  return quote.max_usable > 0 ? 'stepper' : 'unusable';
}

/**
 * The line under the Ritual row, or null. The server's own message is kept for
 * the two reasons a customer needs to hear (a daily limit; nothing eligible in
 * the cart). Its other shortfall wording compares against the maximum the
 * checkout asks for before the customer has chosen, so until they have touched
 * the stepper it would only read as a puzzling caveat: "using 2 of 5 cups" already
 * says it.
 */
export function passHelperLine(quote: PassQuote | null | undefined, touched: boolean): string | null {
  if (!quote || !quote.message) return null;
  if (quote.shortfall === 'daily_limit' || quote.shortfall === 'no_eligible_items') return quote.message;
  return touched ? quote.message : null;
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

/** The bill row for a Ritual: "HIOC Ritual (2 cups)". */
export function ritualBillLabel(cups: number): string {
  return `${PASS_PROGRAM_NAME} (${cupsLabel(cups)})`;
}

/** The small tag on a covered line: "Ritual ×2". */
export function ritualTagLabel(cups: number): string {
  return `${PASS_SHORT_NAME} ×${cups}`;
}

interface OrderLineWithPass {
  pass_drinks?: number | null;
  voided?: boolean | null;
}

/**
 * Cups a Ritual paid for on an order: the sum of its lines' `pass_drinks`. A
 * voided line's cups went back to the pass (CP-D14), so it does not count. Rows
 * read before the migration have no `pass_drinks`, which is 0.
 */
export function passDrinksOnOrder(items: readonly OrderLineWithPass[] | null | undefined): number {
  let cups = 0;
  for (const item of items ?? []) {
    if (item.voided) continue;
    const n = Number(item.pass_drinks ?? 0);
    if (Number.isFinite(n) && n > 0) cups += Math.trunc(n);
  }
  return cups;
}

/**
 * The Ritual's row on an order's bill, or null when no Ritual paid for anything
 * (the usual case, and every order from before the feature).
 */
export function orderPassBill(order: {
  pass_discount_inr?: number | null;
  items?: readonly OrderLineWithPass[] | null;
}): { label: string; discountInr: number; cups: number } | null {
  const discountInr = Number(order.pass_discount_inr ?? 0);
  if (!Number.isFinite(discountInr) || discountInr <= 0) return null;
  const cups = passDrinksOnOrder(order.items);
  return { label: cups > 0 ? ritualBillLabel(cups) : PASS_PROGRAM_NAME, discountInr: Math.trunc(discountInr), cups };
}

/** The order is the SALE of a pass, not a menu order (no kitchen, no pickup). */
export function isPassSaleOrder(order: { order_kind?: string | null }): boolean {
  return order.order_kind === 'coffee_pass';
}

/**
 * What the order page tells the buyer of a Ritual. `link` says whether to point
 * them to their Ritual (only once it exists).
 */
export function passSaleNote(paymentStatus: string): { text: string; link: boolean } {
  switch (paymentStatus) {
    case 'paid':
      return { text: `Your ${PASS_PROGRAM_NAME} is active — see it in Account → ${PASS_PROGRAM_NAME}.`, link: true };
    case 'refunded':
    case 'partially_refunded':
      return { text: `This ${PASS_PROGRAM_NAME} was refunded and is no longer active.`, link: false };
    default:
      return { text: `Your ${PASS_PROGRAM_NAME} will be active as soon as your payment is confirmed.`, link: false };
  }
}
