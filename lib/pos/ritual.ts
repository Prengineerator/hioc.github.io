// HIOC Ritual at the counter — the pure half (docs/COFFEE-PASS-SPEC.md §8).
//
// The same split as lib/pos/loyalty.ts, for the same reason: what the counter
// is told about a customer's Ritual, how many cups the stepper may reach, which
// orders belong on the kitchen board and what a sale reads like on screen are
// RULES, and a rule buried in a component is one nobody can pin down with a
// test. Screens (New order, Ritual passes, Settle, Orders) and the print model
// all read from here so they cannot drift.
//
// The hard line from loyalty.ts holds: nothing here decides a payable amount.
// Every rupee that is charged comes from the server (POST /api/orders/quote,
// the order row). The one preview computed here, `salePreview`, reuses
// computeBill — the single copy of GST maths — and is labelled a preview; the
// payment step always shows the order's own total.

import { computeBill, type BillBreakdown } from '@/lib/store/hours';
import { PASS_PROGRAM_NAME, cupsLabel } from '@/lib/passes/brand';
import { MAX_PASS_DRINKS_PER_ORDER, planDiscountPercent } from '@/lib/passes/rules';
import type { CoffeePassPlan, PassRedemptionEntry, PassState, PassSummary } from '@/lib/passes/types';
import type { QuotedPass } from '@/lib/pos/loyalty';
import type { StoreSettings } from '@/lib/types';

// ---------------------------------------------------------------------------
// Shapes the Ritual passes screen reads (the API's own, restated client-side:
// lib/passes/sale.ts is server-only and cannot be imported into a component).
// ---------------------------------------------------------------------------

/** A pass sale as GET /api/passes/holder lists it (order_kind 'coffee_pass'). */
export interface RitualSale {
  order_id: string;
  order_number: number | null;
  plan_name: string;
  total_inr: number;
  created_at: string;
}

/** A pass with its redemption history, as GET /api/passes/holder returns it. */
export type HolderPass = PassSummary & { history: PassRedemptionEntry[] };

export type HolderResponse =
  | { found: false }
  | { found: true; name: string; passes: HolderPass[]; unpaid_sales: RitualSale[] };

/** The store's GST setting, as GET /api/passes/plans reports it. */
export interface PlanGst {
  percent: number;
  inclusive: boolean;
}

/** A bill as the counter shows it: the quote's breakdown plus the pass cover. */
export type PosBill = BillBreakdown & {
  /** What HIOC Ritual cups cover on this order. Absent before the migration = 0. */
  pass_discount_inr?: number;
};

// ---------------------------------------------------------------------------
// Which orders are a Ritual sale, and which belong to the kitchen
// ---------------------------------------------------------------------------

/** What a pass sale is called on every staff list, badge and title. */
export const RITUAL_SALE_LABEL = `${PASS_PROGRAM_NAME} sale`;

/**
 * True for the SALE of a pass (order_kind 'coffee_pass'). `order_kind` is absent
 * on rows read before supabase/2026-10-coffee-pass.sql, which reads as a menu
 * order.
 */
export function isRitualSale(order: { order_kind?: string | null } | null | undefined): boolean {
  return order?.order_kind === 'coffee_pass';
}

/**
 * Orders that go through the kitchen. A pass sale is a payment, not food: it has
 * no ticket, no prep and no pickup, so it never sits in the live board's lanes
 * and never rings the new-order alarm (the API refuses its status moves too).
 */
export function kitchenOrders<T extends { order_kind?: string | null }>(orders: readonly T[]): T[] {
  return orders.filter((o) => !isRitualSale(o));
}

/** Cups a pass paid for on an order: the sum over lines that are not voided. */
export function cupsOnOrder(items: readonly { pass_drinks?: number | null; voided?: boolean }[] | null | undefined): number {
  return (items ?? []).reduce((sum, i) => (i.voided ? sum : sum + Math.max(0, Math.trunc(i.pass_drinks ?? 0))), 0);
}

/** "HIOC Ritual (2 cups)"; just "HIOC Ritual" when the count isn't known. */
export function ritualBillLabel(cups: number): string {
  return cups > 0 ? `${PASS_PROGRAM_NAME} (${cupsLabel(cups)})` : PASS_PROGRAM_NAME;
}

/**
 * The bill row for what the cups cover, or null when they covered nothing. The
 * value is negative (it comes off the total) and is the server's own figure.
 */
export function ritualBillRow(
  bill: { pass_discount_inr?: number | null } | null | undefined,
  cups: number,
): { label: string; value: number } | null {
  const covered = Math.trunc(bill?.pass_discount_inr ?? 0);
  if (covered <= 0) return null;
  return { label: ritualBillLabel(cups), value: -covered };
}

// ---------------------------------------------------------------------------
// Dates (IST calendar days, CP-D5)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function istText(ms: number, withYear: boolean): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
    }).formatToParts(new Date(ms));
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return [get('weekday'), get('day'), get('month'), withYear ? get('year') : '']
      .filter((part) => part !== '')
      .join(' ');
  } catch {
    return '';
  }
}

/**
 * "Mon 5 Oct": the LAST day a pass can be used. A pass stores the instant its
 * validity ends (the start of the next IST day), so the day printed is the one
 * just before that instant. '' when the timestamp cannot be read.
 */
export function validTillLabel(expiresAtIso: string | null | undefined, opts: { year?: boolean } = {}): string {
  const ms = Date.parse(expiresAtIso ?? '');
  if (Number.isNaN(ms)) return '';
  return istText(ms - 1, opts.year === true);
}

/** Where an extension would leave the pass: the same day, `days` later. */
export function extendedTillLabel(expiresAtIso: string, days: number): string {
  const ms = Date.parse(expiresAtIso);
  if (Number.isNaN(ms)) return '';
  return istText(ms + Math.trunc(days) * MS_PER_DAY - 1, false);
}

/** "5:04 pm, 3 Oct" — a history line's time, in IST. */
export function historyTimeLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  try {
    const time = new Date(ms).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
    const day = new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
    return `${time}, ${day}`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// New order: the Ritual row in "Coupon & Beanies"
// ---------------------------------------------------------------------------

/** What the row says about an attached customer's usable passes. */
export interface RitualSummary {
  cupsLeft: number;
  /** The soonest-expiring pass's expiry (cups come off that one first, CP-D9). */
  tillIso: string;
  /** "HIOC Ritual · 5 cups left · till Mon 5 Oct". */
  label: string;
}

/** Null when there is nothing to offer: no pass, or none with cups left in date. */
export function ritualSummary(passes: readonly PassSummary[] | null | undefined): RitualSummary | null {
  const usable = (passes ?? []).filter((p) => p.state === 'active' && p.drinks_remaining > 0);
  if (usable.length === 0) return null;
  const cupsLeft = usable.reduce((sum, p) => sum + p.drinks_remaining, 0);
  const soonest = usable.reduce((a, b) => (Date.parse(b.expires_at) < Date.parse(a.expires_at) ? b : a));
  const till = validTillLabel(soonest.expires_at);
  return {
    cupsLeft,
    tillIso: soonest.expires_at,
    label: `${PASS_PROGRAM_NAME} · ${cupsLabel(cupsLeft)} left${till ? ` · till ${till}` : ''}`,
  };
}

/**
 * The most cups the stepper may reach: what this exact cart can use now
 * (`max_usable` from the quote) but never more than the customer holds or one
 * order may carry. Before the first quote lands the customer's own count stands
 * in, so the counter can ask for a cup straight away and let the quote judge it.
 */
export function ritualStepperMax(quote: QuotedPass | null | undefined, cupsLeft: number): number {
  const held = Math.min(MAX_PASS_DRINKS_PER_ORDER, Math.max(0, Math.trunc(Number.isFinite(cupsLeft) ? cupsLeft : 0)));
  if (!quote) return held;
  const usable = Number.isFinite(quote.max_usable) ? Math.max(0, Math.trunc(quote.max_usable)) : 0;
  return Math.min(held, usable);
}

/** A stepper value kept whole and inside 0..max. */
export function clampCups(value: number, max: number): number {
  const n = Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.min(Math.max(0, n), Math.max(0, Math.trunc(max)));
}

/**
 * Whether the latest quote agreed to exactly the cups asked for. The rule for
 * sending `pass_drinks` with the order, like a coupon's (it is only sent once the
 * server has approved it): POST /api/orders answers 400 when fewer cups can be
 * applied than were asked for, so an unapproved count must not go.
 */
export function ritualApproved(quote: QuotedPass | null | undefined, requested: number): boolean {
  if (requested <= 0 || !quote) return false;
  return quote.requested === requested && quote.applied === requested;
}

/**
 * A quiet line for when no cup has been asked for yet and the cart cannot use
 * one, so the counter is not left wondering why "+" does nothing. Says nothing
 * while cups are requested (passFeedback speaks then) or the cart could use them.
 */
export function ritualIdleHint(quote: QuotedPass | null | undefined, requested: number): string | null {
  if (!quote || requested > 0 || quote.max_usable > 0) return null;
  if (quote.eligible_units <= 0) return `Nothing in this order can be paid with a ${PASS_PROGRAM_NAME} cup.`;
  if (quote.available > 0) return `Today's limit on this ${PASS_PROGRAM_NAME} has been used.`;
  return null;
}

/**
 * How a bill that came to ₹0 reads on the placement confirmation ("₹0 · paid in
 * full by HIOC Ritual"). The server creates such an order already paid, so no
 * payment is recorded and the counter has nothing to collect.
 */
export function freeBillPaidAs(cups: number): string {
  return cups > 0 ? `in full by ${PASS_PROGRAM_NAME}` : 'nothing due';
}

/**
 * What to do after POST /api/orders answers with an error while a Ritual (or a
 * coupon, or Beanies) was in play. A 409 means the order was created and rolled
 * back because something changed between the quote and the order (a cup spent on
 * another device, a coupon's last use): re-quote and look up the customer again,
 * and use a fresh idempotency key — the old one was claimed by an order that no
 * longer exists. The one 409 that must NOT rotate the key is "already being
 * placed": that says the first attempt is still running, and a second key would
 * make a second order.
 *
 * A 400 that carries cups is the "fewer could be applied" refusal: re-quote so
 * the screen shows the truth, but the key was never claimed, so it stays.
 */
export function orderConflictAction(
  status: number,
  message: string | undefined,
  sentPassDrinks: boolean,
): { requote: boolean; rotateKey: boolean } {
  if (status === 409) {
    const inFlight = /already being placed/i.test(message ?? '');
    return inFlight ? { requote: false, rotateKey: false } : { requote: true, rotateKey: true };
  }
  if (status === 400 && sentPassDrinks) return { requote: true, rotateKey: false };
  return { requote: false, rotateKey: false };
}

// ---------------------------------------------------------------------------
// Ritual passes screen: plans
// ---------------------------------------------------------------------------

/** "7 cups · 7 days": the second line of a plan, and of the sale line on a bill. */
export function planSummaryLabel(plan: Pick<CoffeePassPlan, 'drinks_total' | 'validity_days'>): string {
  const days = plan.validity_days;
  return `${cupsLabel(plan.drinks_total)} · ${days} ${days === 1 ? 'day' : 'days'}`;
}

/** What one cup costs on the plan, to the nearest rupee (display only). */
export function planPerCupInr(plan: Pick<CoffeePassPlan, 'price_inr' | 'drinks_total'>): number {
  return plan.drinks_total > 0 ? Math.round(plan.price_inr / plan.drinks_total) : plan.price_inr;
}

/** "Save 29%" — how much cheaper a cup is than paying for every one; null when nothing is saved. */
export function planSaveLabel(plan: Pick<CoffeePassPlan, 'drinks_total' | 'drinks_paid'>): string | null {
  const pct = planDiscountPercent(plan);
  return pct > 0 ? `Save ${pct}%` : null;
}

/** "+ GST" when tax is added on top of the price (exclusive pricing, plan not exempt). */
export function planPriceNote(plan: Pick<CoffeePassPlan, 'gst_exempt'>, gst: PlanGst | null | undefined): string {
  if (!gst || gst.inclusive || gst.percent <= 0 || plan.gst_exempt) return '';
  return '+ GST';
}

/**
 * What the sale should come to, for the confirm sheet only. The same bill the
 * server builds for a pass sale (price as subtotal, GST unless the plan is
 * exempt, no packaging, no discount) via the one computeBill; the payment step
 * that follows always shows the order's own total, which is what is charged.
 */
export function salePreview(
  plan: Pick<CoffeePassPlan, 'price_inr' | 'gst_exempt'>,
  gst: PlanGst | null | undefined,
): BillBreakdown {
  const settings = {
    gst_percent: gst?.percent ?? 0,
    gst_inclusive: gst?.inclusive ?? true,
    packaging_charge_inr: 0,
  } as StoreSettings;
  return computeBill(plan.price_inr, settings, 0, plan.gst_exempt ? 0 : plan.price_inr);
}

// ---------------------------------------------------------------------------
// Ritual passes screen: who is being sold to
// ---------------------------------------------------------------------------

/**
 * Why Sell is off, or null when it can go ahead. Phone first, because it is the
 * field that finds the account; a name is what the new account is opened under.
 */
export function sellBlockedReason(input: {
  canSell: boolean;
  blockedMessage?: string | null;
  phoneValid: boolean;
  name: string;
}): string | null {
  if (!input.canSell) return input.blockedMessage ?? `You can't sell ${PASS_PROGRAM_NAME} from this screen.`;
  if (!input.phoneValid) return 'Enter the customer’s 10-digit mobile number first.';
  if (input.name.trim().length < 1) return 'Add the customer’s name.';
  return null;
}

/** The names the server takes: 1 to 60 characters once trimmed (POST /api/passes/sell). */
export const MAX_SALE_NAME_LENGTH = 60;

/** A per-attempt key for POST /api/passes/sell; the timestamp fallback keeps an old tablet working. */
export function newSaleKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `pass-sale-${crypto.randomUUID()}`;
  }
  return `pass-sale-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * One sale attempt's idempotency key, kept across a retry of the SAME sale
 * (same customer, same plan) and replaced for any other. Held by the caller in a
 * ref; a successful sale clears it. A lost response is retried with the same key
 * and returns the first sale, never a second one.
 */
export function saleAttemptKey(
  current: { fingerprint: string; key: string } | null,
  fingerprint: string,
  make: () => string = newSaleKey,
): { fingerprint: string; key: string } {
  return current && current.fingerprint === fingerprint ? current : { fingerprint, key: make() };
}

/** "Weekly Ritual active — 7 cups, valid till Mon 5 Oct". */
export function saleActiveMessage(pass: Pick<PassSummary, 'plan_name' | 'drinks_remaining' | 'expires_at'>): string {
  const till = validTillLabel(pass.expires_at);
  return `${pass.plan_name} active — ${cupsLabel(pass.drinks_remaining)}${till ? `, valid till ${till}` : ''}`;
}

/** When the pass isn't visible yet after a paid sale (the read failed): honest, not a false success. */
export function salePaidFallbackMessage(planName: string): string {
  return `Payment recorded for ${planName}. The ${PASS_PROGRAM_NAME} should show under the customer's passes — refresh if it doesn't.`;
}

// ---------------------------------------------------------------------------
// Ritual passes screen: a pass card
// ---------------------------------------------------------------------------

export function passStateLabel(state: PassState): string {
  switch (state) {
    case 'active':
      return 'Active';
    case 'used_up':
      return 'Used up';
    case 'expired':
      return 'Expired';
    case 'refunded':
      return 'Refunded';
    case 'void':
      return 'Void';
  }
}

/** The cups-left dots: `total` cups the pass can give (bought + given back), `filled` still to use. */
export function cupDots(pass: Pick<PassSummary, 'drinks_total' | 'drinks_credited' | 'drinks_remaining'>): {
  total: number;
  filled: number;
} {
  const total = Math.max(0, pass.drinks_total + pass.drinks_credited);
  return { total, filled: Math.min(total, Math.max(0, pass.drinks_remaining)) };
}

/** "5 of 7 cups left" — the dots' text twin, so colour is never the only signal. */
export function cupsLeftLabel(pass: Pick<PassSummary, 'drinks_total' | 'drinks_credited' | 'drinks_remaining'>): string {
  const { total, filled } = cupDots(pass);
  return `${filled} of ${total} ${total === 1 ? 'cup' : 'cups'} left`;
}

/** "Valid till Mon 5 Oct" for a live pass; "Expired Mon 5 Oct" once it has lapsed. */
export function passValidityLabel(pass: Pick<PassSummary, 'state' | 'expires_at'>): string {
  const day = validTillLabel(pass.expires_at);
  if (!day) return '';
  return pass.state === 'expired' ? `Expired ${day}` : `Valid till ${day}`;
}

/** One history line: "#1042 · 2 cups · ₹270 covered" (a reversed use says the cups came back). */
export function historyLine(entry: PassRedemptionEntry): string {
  const order = entry.order_number != null ? `#${entry.order_number}` : 'Order';
  const base = `${order} · ${cupsLabel(entry.drinks)} · ₹${entry.covered_inr} covered`;
  return entry.reversed ? `${base} · cups returned` : base;
}

// ---------------------------------------------------------------------------
// Manager actions (CP-D16): the same bounds POST /api/passes/[id]/adjust checks
// ---------------------------------------------------------------------------

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

export const MAX_EXTEND_DAYS = 60;
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 200;

function parseWhole(raw: string): number | null {
  const digits = (raw ?? '').trim();
  if (!/^\d{1,4}$/.test(digits)) return null;
  return Number.parseInt(digits, 10);
}

function checkReason(reason: string): Validated<string> {
  const trimmed = (reason ?? '').trim();
  if (trimmed.length < MIN_REASON_LENGTH || trimmed.length > MAX_REASON_LENGTH) {
    return { ok: false, error: `Give a reason of ${MIN_REASON_LENGTH} to ${MAX_REASON_LENGTH} characters.` };
  }
  return { ok: true, value: trimmed };
}

/** Days typed for an extension: a whole number from 1 to 60, else null. */
export function parseExtendDays(raw: string): number | null {
  const days = parseWhole(raw);
  return days !== null && days >= 1 && days <= MAX_EXTEND_DAYS ? days : null;
}

/** Cups typed to give back: a whole number from 1 to `maxCups`, else null. */
export function parseCreditCups(raw: string, maxCups: number): number | null {
  const cups = parseWhole(raw);
  return cups !== null && cups >= 1 && cups <= Math.max(1, Math.trunc(maxCups)) ? cups : null;
}

/** The body for `{kind:'extend'}`: 1 to 60 whole days and a reason. */
export function validateExtend(daysRaw: string, reasonRaw: string): Validated<{ kind: 'extend'; days: number; reason: string }> {
  const days = parseExtendDays(daysRaw);
  if (days === null) {
    return { ok: false, error: `Extend by a whole number of days from 1 to ${MAX_EXTEND_DAYS}.` };
  }
  const reason = checkReason(reasonRaw);
  if (!reason.ok) return reason;
  return { ok: true, value: { kind: 'extend', days, reason: reason.value } };
}

/** The body for `{kind:'credit'}`: 1 to `maxCups` whole cups (the plan's cups) and a reason. */
export function validateCredit(
  cupsRaw: string,
  reasonRaw: string,
  maxCups: number,
): Validated<{ kind: 'credit'; drinks: number; reason: string }> {
  const cups = parseCreditCups(cupsRaw, maxCups);
  const max = Math.max(1, Math.trunc(maxCups));
  if (cups === null) {
    return { ok: false, error: `Give back a whole number of cups from 1 to ${max}.` };
  }
  const reason = checkReason(reasonRaw);
  if (!reason.ok) return reason;
  return { ok: true, value: { kind: 'credit', drinks: cups, reason: reason.value } };
}

/** Quick reasons a counter actually gives; "Other" leaves the field for the manager to type. */
export const EXTEND_REASON_CHIPS = ['Closed for a day', 'Customer was away', 'Goodwill'];
export const CREDIT_REASON_CHIPS = ['Spilt drink', 'Wrong drink made', 'Goodwill'];

// ---------------------------------------------------------------------------
// The phone the screen was opened with (?phone= from New order)
// ---------------------------------------------------------------------------

/** Digits only, at most 10 (the number as the field should first show it). '' for anything unusable. */
export function initialPhoneFromQuery(raw: string | string[] | undefined | null): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== 'string') return '';
  let digits = value.replace(/\D/g, '');
  if (digits.length > 10 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length > 10 && digits.startsWith('0')) digits = digits.slice(1);
  return digits.length === 10 ? digits : '';
}
