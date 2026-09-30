// Pure rules for the prepaid coffee pass ("HIOC Ritual", docs/COFFEE-PASS-SPEC.md).
//
// No database, no Supabase, no server-only import: the order route, the quote
// route, the checkout and the POS all price a pass with THE SAME functions, so
// the number on the screen is the number the server charges. The database
// re-checks every rule under a row lock (supabase/2026-10-coffee-pass.sql
// coffee_pass_redeem); this module decides what to ASK it for.
//
// All money is integer rupees. All calendar reasoning is Asia/Kolkata (IST,
// UTC+05:30, no daylight saving), matching the SQL.

import { computeBill, type BillBreakdown } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';
import { cupsLabel, PASS_PROGRAM_NAME } from '@/lib/passes/brand';
import type {
  AllocationResult,
  CoffeePassPlan,
  PassAllocation,
  PassLine,
  PassRedeemCode,
  PassShortfall,
  PassState,
  UsablePass,
} from '@/lib/passes/types';

// ---------------------------------------------------------------------------
// Time: IST calendar days
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;
/** IST = UTC+05:30, all year. */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * The instant a pass expires (CP-D5). A pass bought on IST day D is valid
 * through the end of day D + validityDays - 1, so it expires at the START of
 * day D + validityDays, 00:00 IST. A Weekly bought Monday 10:00 is good through
 * Sunday 23:59 and expires Monday 00:00.
 *
 * Mirrors the SQL exactly:
 *   ((now() at time zone 'Asia/Kolkata')::date + validity_days)::timestamp
 *     at time zone 'Asia/Kolkata'
 * so 2026-10-05T18:29Z (23:59 IST on the 5th) and 2026-10-05T18:31Z (00:01 IST
 * on the 6th) land a day apart.
 */
export function passExpiresAt(startsAt: Date, validityDays: number): Date {
  const istDay = Math.floor((startsAt.getTime() + IST_OFFSET_MS) / MS_PER_DAY);
  return new Date((istDay + Math.trunc(validityDays)) * MS_PER_DAY - IST_OFFSET_MS);
}

function asTime(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}

/**
 * Where a pass stands (mirrors v_coffee_pass_balances.state): a refunded or
 * void pass says so; otherwise expired once `now` reaches expires_at; otherwise
 * used_up when no cups are left; otherwise active. An unreadable expires_at is
 * treated as expired: a pass whose window cannot be read must not be spent.
 */
export function passState(
  pass: { status: 'active' | 'refunded' | 'void'; expires_at: string | Date; drinks_remaining: number },
  now: Date,
): PassState {
  if (pass.status === 'refunded') return 'refunded';
  if (pass.status === 'void') return 'void';
  const expires = asTime(pass.expires_at);
  if (Number.isNaN(expires) || now.getTime() >= expires) return 'expired';
  if (pass.drinks_remaining <= 0) return 'used_up';
  return 'active';
}

// ---------------------------------------------------------------------------
// Allocation (CP-D9)
// ---------------------------------------------------------------------------

/**
 * How many cups this pass can pay for right now: nothing once it has expired,
 * otherwise the cups left, held down by what is left of today's daily cap.
 */
export function passCapacity(pass: UsablePass, now: Date): number {
  const expires = asTime(pass.expires_at);
  if (Number.isNaN(expires) || now.getTime() >= expires) return 0;
  const remaining = Math.max(0, Math.trunc(pass.drinks_remaining));
  if (pass.max_per_day == null) return remaining;
  return Math.min(remaining, Math.max(0, Math.trunc(pass.max_per_day) - Math.trunc(pass.used_today)));
}

interface Unit {
  line: number; // index into the eligible lines
  price: number;
}

/**
 * Chooses which cups pay for which drinks (CP-D9): the most expensive eligible
 * units first, from the soonest-expiring pass first. It stops at the cups asked
 * for, the eligible units in the cart, and what the passes can give today.
 *
 * - A unit is ONE drink: a line of quantity 3 is three units, so a pass can
 *   cover 1 of 3. Each cup covers min(the unit's price, the pass's drink value);
 *   anything above is left for the customer to pay as a top-up.
 * - Ties in price break by line order, so the same cart always allocates the
 *   same way. Passes order by expires_at then id (first-expiring, first-used).
 * - A unit priced at 0 is never covered: it would spend a cup for nothing.
 * - covered_taxable_inr is the covered rupees on lines that carry GST. That is
 *   what leaves the taxable base (CP-D11), so tax is never charged twice.
 * - `available` counts cups on passes still in date and ignores the daily cap,
 *   so the screen can say "5 left" even on a day the cap allows only 1.
 */
export function allocatePassDrinks(input: {
  lines: PassLine[];
  passes: UsablePass[];
  requested: number;
  now: Date;
}): AllocationResult {
  const { lines, passes, now } = input;
  const requested = Number.isFinite(input.requested) ? Math.max(0, Math.trunc(input.requested)) : 0;

  // The units a pass could pay for, dearest first.
  const eligibleLines = lines.filter((l) => l.eligible && l.quantity > 0 && l.unit_price_inr > 0);
  const units: Unit[] = [];
  eligibleLines.forEach((l, line) => {
    for (let q = 0; q < Math.trunc(l.quantity); q++) units.push({ line, price: l.unit_price_inr });
  });
  units.sort((a, b) => b.price - a.price || a.line - b.line);

  // The passes, soonest-expiring first, with a running count of cups left.
  const ordered = [...passes].sort((a, b) => {
    const byExpiry = asTime(a.expires_at) - asTime(b.expires_at);
    if (byExpiry !== 0 && !Number.isNaN(byExpiry)) return byExpiry;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const left = ordered.map((p) => passCapacity(p, now));
  const totalCapacity = left.reduce((sum, n) => sum + n, 0);
  const available = ordered.reduce((sum, p) => {
    const expires = asTime(p.expires_at);
    if (Number.isNaN(expires) || now.getTime() >= expires) return sum;
    return sum + Math.max(0, Math.trunc(p.drinks_remaining));
  }, 0);

  const applied = Math.min(requested, units.length, totalCapacity);

  const allocations: PassAllocation[] = [];
  const merged = new Map<string, PassAllocation>();
  const byLine: Record<string, { drinks: number; covered_inr: number }> = {};
  let coveredInr = 0;
  let coveredTaxableInr = 0;

  for (let i = 0; i < applied; i++) {
    const unit = units[i];
    const p = left.findIndex((n) => n > 0);
    if (p < 0) break; // unreachable: applied <= totalCapacity
    left[p] -= 1;

    const line = eligibleLines[unit.line];
    const pass = ordered[p];
    const covered = Math.min(unit.price, pass.drink_value_inr);

    const key = `${pass.id}\u0000${line.key}`;
    let alloc = merged.get(key);
    if (!alloc) {
      alloc = { pass_id: pass.id, line_key: line.key, drinks: 0, covered_inr: 0 };
      merged.set(key, alloc);
      allocations.push(alloc);
    }
    alloc.drinks += 1;
    alloc.covered_inr += covered;

    const perLine = (byLine[line.key] ??= { drinks: 0, covered_inr: 0 });
    perLine.drinks += 1;
    perLine.covered_inr += covered;

    coveredInr += covered;
    if (!line.gst_exempt) coveredTaxableInr += covered;
  }

  return {
    requested,
    applied,
    eligible_units: units.length,
    available,
    allocations,
    by_line: byLine,
    covered_inr: coveredInr,
    covered_taxable_inr: coveredTaxableInr,
    shortfall: shortfallFor({ requested, applied, units: units.length, totalCapacity, available }),
  };
}

// Why fewer cups were applied than asked for, most fundamental reason first.
function shortfallFor(a: {
  requested: number;
  applied: number;
  units: number;
  totalCapacity: number;
  available: number;
}): PassShortfall {
  if (a.applied >= a.requested) return null; // all applied, or none asked for
  if (a.available <= 0) return 'no_pass';
  if (a.units === 0) return 'no_eligible_items';
  // The daily cap is the wall: cups remain on the passes, but today's cap holds
  // them back, and adding more items to the cart would not change that.
  if (a.totalCapacity < a.available && a.totalCapacity <= a.units && a.totalCapacity < a.requested) {
    return 'daily_limit';
  }
  return 'not_enough_drinks';
}

// ---------------------------------------------------------------------------
// Money (spec §6)
// ---------------------------------------------------------------------------

/**
 * The bill for an order that uses pass cups. The cups are taken off the total
 * like a discount, but they also leave the TAXABLE base, so GST is charged once:
 * on the sale of the pass, not again on the drink it pays for (CP-D11). Then the
 * coupon and points come off what is left (CP-D12: the caller computes them on
 * subtotal - pass cover).
 *
 *   computeBill(subtotal, settings, discount + passCovered,
 *               taxableSubtotal - passCoveredTaxable)
 *
 * The result keeps the two discounts apart, as the orders table does:
 *   discount_inr      coupon + points only, what the caller passed
 *   pass_discount_inr what the pass covered
 * so total_inr = subtotal + tax + packaging - discount_inr - pass_discount_inr,
 * and reports never count a prepaid drink as a marketing discount. Packaging and
 * dine-in handling stay with the caller, as everywhere else.
 */
export function composePassBill(
  input: {
    subtotalInr: number;
    taxableSubtotalInr: number;
    /** Coupon + points. */
    discountInr: number;
    passCoveredInr: number;
    passCoveredTaxableInr: number;
  },
  settings: StoreSettings,
): BillBreakdown & { pass_discount_inr: number } {
  // A pass can never cover more than was sold, or more taxable than it covers.
  const passCovered = Math.min(Math.max(0, input.passCoveredInr), Math.max(0, input.subtotalInr));
  const passCoveredTaxable = Math.min(Math.max(0, input.passCoveredTaxableInr), passCovered);
  const bill = computeBill(
    input.subtotalInr,
    settings,
    input.discountInr + passCovered,
    input.taxableSubtotalInr - passCoveredTaxable,
  );
  return { ...bill, discount_inr: input.discountInr, pass_discount_inr: passCovered };
}

// ---------------------------------------------------------------------------
// Input validation (manual, no zod: {ok, value} | {ok, error})
// ---------------------------------------------------------------------------

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** Most pass cups one order may ask for (POST /api/orders, /api/orders/quote). */
export const MAX_PASS_DRINKS_PER_ORDER = 20;

/** `pass_drinks` on an order request: absent means 0; otherwise a whole number 0..20. */
export function parsePassDrinks(raw: unknown): Validated<number> {
  if (raw === undefined || raw === null) return { ok: true, value: 0 };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_PASS_DRINKS_PER_ORDER) {
    return { ok: false, error: `pass_drinks must be a whole number from 0 to ${MAX_PASS_DRINKS_PER_ORDER}.` };
  }
  return { ok: true, value: raw };
}

/** The editable fields of a plan (coffee_pass_plans), bounds as in spec §5.1. */
export type PlanInput = Omit<CoffeePassPlan, 'id'>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function intInRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

/**
 * Validates an owner's create (`partial: false`) or edit (`partial: true`) of a
 * plan and returns the normalised fields.
 *
 *   name 1..60 (trimmed) · description ≤ 500 · drinks_total 1..50 ·
 *   drinks_paid 1..drinks_total · validity_days 1..365 · drink_value_inr 1..5000 ·
 *   price_inr 1..100000 · max_per_day null or 1..drinks_total · gst_exempt,
 *   is_active booleans · sort_order an integer
 *
 * Create needs name, drinks_total, drinks_paid, validity_days and
 * drink_value_inr. The rest default: no description, price = drinks_paid ×
 * drink_value (CP-D2), no daily cap, GST charged, inactive, sort_order 0. An
 * edit checks only the keys present; a cross-field rule (drinks_paid ≤
 * drinks_total, max_per_day ≤ drinks_total) is checked when both sides are in
 * the request, so a route editing one of a pair re-checks it against the
 * stored row. An edit that carries no known key is refused.
 */
export function validatePlanInput(
  body: Record<string, unknown>,
  opts: { partial: boolean },
): Validated<Partial<PlanInput>> {
  if (!isRecord(body)) return { ok: false, error: 'Send the plan as a JSON object.' };
  const partial = opts.partial;
  const has = (k: string) => body[k] !== undefined;
  const out: Partial<PlanInput> = {};

  if (!partial) {
    for (const k of ['name', 'drinks_total', 'drinks_paid', 'validity_days', 'drink_value_inr']) {
      if (!has(k)) return { ok: false, error: `${k} is required.` };
    }
  }

  if (has('name')) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 60) return { ok: false, error: 'Name must be 1 to 60 characters.' };
    out.name = name;
  }
  if (has('description')) {
    if (typeof body.description !== 'string') return { ok: false, error: 'Description must be text.' };
    const description = body.description.trim();
    if (description.length > 500) return { ok: false, error: 'Description must be 500 characters or fewer.' };
    out.description = description;
  }
  if (has('drinks_total')) {
    if (!intInRange(body.drinks_total, 1, 50)) return { ok: false, error: 'Cups in the pass must be a whole number from 1 to 50.' };
    out.drinks_total = body.drinks_total;
  }
  if (has('drinks_paid')) {
    if (!intInRange(body.drinks_paid, 1, 50)) return { ok: false, error: 'Cups paid for must be a whole number from 1 to 50.' };
    out.drinks_paid = body.drinks_paid;
  }
  if (out.drinks_paid !== undefined && out.drinks_total !== undefined && out.drinks_paid > out.drinks_total) {
    return { ok: false, error: 'Cups paid for cannot be more than the cups in the pass.' };
  }
  if (has('validity_days')) {
    if (!intInRange(body.validity_days, 1, 365)) return { ok: false, error: 'Validity must be a whole number of days from 1 to 365.' };
    out.validity_days = body.validity_days;
  }
  if (has('drink_value_inr')) {
    if (!intInRange(body.drink_value_inr, 1, 5000)) return { ok: false, error: 'Cup value must be a whole number of rupees from 1 to 5000.' };
    out.drink_value_inr = body.drink_value_inr;
  }
  if (has('price_inr')) {
    if (!intInRange(body.price_inr, 1, 100000)) return { ok: false, error: 'Price must be a whole number of rupees from 1 to 100000.' };
    out.price_inr = body.price_inr;
  }
  if (has('max_per_day')) {
    if (body.max_per_day !== null) {
      const cap = body.max_per_day;
      if (!intInRange(cap, 1, 50)) return { ok: false, error: 'Daily limit must be empty or a whole number of cups from 1 up.' };
      if (out.drinks_total !== undefined && cap > out.drinks_total) {
        return { ok: false, error: 'Daily limit cannot be more than the cups in the pass.' };
      }
      out.max_per_day = cap;
    } else {
      out.max_per_day = null;
    }
  }
  if (has('gst_exempt')) {
    if (typeof body.gst_exempt !== 'boolean') return { ok: false, error: 'gst_exempt must be true or false.' };
    out.gst_exempt = body.gst_exempt;
  }
  if (has('is_active')) {
    if (typeof body.is_active !== 'boolean') return { ok: false, error: 'is_active must be true or false.' };
    out.is_active = body.is_active;
  }
  if (has('sort_order')) {
    if (typeof body.sort_order !== 'number' || !Number.isInteger(body.sort_order) || Math.abs(body.sort_order) > 1_000_000) {
      return { ok: false, error: 'Sort order must be a whole number.' };
    }
    out.sort_order = body.sort_order;
  }

  if (partial) {
    if (Object.keys(out).length === 0) return { ok: false, error: 'Nothing to update.' };
    return { ok: true, value: out };
  }

  // Create: fill the defaults, then re-check what depends on them.
  const full: PlanInput = {
    name: out.name as string,
    description: out.description ?? '',
    drinks_total: out.drinks_total as number,
    drinks_paid: out.drinks_paid as number,
    validity_days: out.validity_days as number,
    drink_value_inr: out.drink_value_inr as number,
    price_inr: out.price_inr ?? (out.drinks_paid as number) * (out.drink_value_inr as number),
    max_per_day: out.max_per_day ?? null,
    gst_exempt: out.gst_exempt ?? false,
    is_active: out.is_active ?? false,
    sort_order: out.sort_order ?? 0,
  };
  if (full.price_inr < 1 || full.price_inr > 100000) {
    return { ok: false, error: 'Price must be a whole number of rupees from 1 to 100000.' };
  }
  return { ok: true, value: full };
}

/** A manager's change to a pass, validated (CP-D16). */
export type AdjustInput =
  | { kind: 'extend'; days: number; reason: string }
  | { kind: 'credit'; drinks: number; reason: string };

/** `{kind:'extend', days 1..60, reason}` or `{kind:'credit', drinks 1..50, reason}`; reason 3..200 characters once trimmed. */
export function validateAdjustInput(body: Record<string, unknown>): Validated<AdjustInput> {
  if (!isRecord(body)) return { ok: false, error: 'Send the change as a JSON object.' };
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 200) {
    return { ok: false, error: 'Give a reason of 3 to 200 characters.' };
  }
  if (body.kind === 'extend') {
    if (!intInRange(body.days, 1, 60)) return { ok: false, error: 'Extend by a whole number of days from 1 to 60.' };
    return { ok: true, value: { kind: 'extend', days: body.days, reason } };
  }
  if (body.kind === 'credit') {
    if (!intInRange(body.drinks, 1, 50)) return { ok: false, error: `Give back a whole number of cups from 1 to 50.` };
    return { ok: true, value: { kind: 'credit', drinks: body.drinks, reason } };
  }
  return { ok: false, error: "kind must be 'extend' or 'credit'." };
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** What the customer reads when the database refused the redemption. */
export function passRedeemMessage(code: PassRedeemCode): string {
  switch (code) {
    case 'ok':
      return `Your ${PASS_PROGRAM_NAME} cups have been applied.`;
    case 'not_owner':
      return `That ${PASS_PROGRAM_NAME} is not on your account.`;
    case 'inactive':
      return `That ${PASS_PROGRAM_NAME} is no longer active.`;
    case 'expired':
      return `Your ${PASS_PROGRAM_NAME} has expired.`;
    case 'insufficient':
      return `Your ${PASS_PROGRAM_NAME} does not have enough cups left.`;
    case 'daily_limit':
      return `You have reached today's limit on your ${PASS_PROGRAM_NAME}.`;
    case 'bad_input':
      return `We could not apply your ${PASS_PROGRAM_NAME} cups to this order.`;
  }
}

/**
 * The line under the pass row when fewer cups were applied than asked for, or
 * null when there is nothing to say. For the quote's `pass.message`.
 */
export function passShortfallMessage(
  r: Pick<AllocationResult, 'requested' | 'applied' | 'eligible_units' | 'available' | 'shortfall'>,
): string | null {
  switch (r.shortfall) {
    case null:
      return null;
    case 'no_pass':
      return `You have no ${PASS_PROGRAM_NAME} cups to use right now.`;
    case 'no_eligible_items':
      return `Nothing in this order can be paid with ${PASS_PROGRAM_NAME} cups.`;
    case 'daily_limit':
      return r.applied > 0
        ? `Your ${PASS_PROGRAM_NAME} has a daily limit, so ${cupsLabel(r.applied)} can be used today.`
        : `You have already used today's limit on your ${PASS_PROGRAM_NAME}.`;
    case 'not_enough_drinks':
      return r.eligible_units < r.requested && r.available >= r.requested
        ? `Only ${cupsLabel(r.eligible_units)} in this order can use your ${PASS_PROGRAM_NAME}.`
        : `You have ${cupsLabel(r.available)} left on your ${PASS_PROGRAM_NAME}, so ${cupsLabel(r.applied)} can be used.`;
  }
}

/** "Save 29%": how much cheaper a cup is on this plan than paying for every one. */
export function planDiscountPercent(plan: Pick<CoffeePassPlan, 'drinks_total' | 'drinks_paid'>): number {
  if (plan.drinks_total <= 0) return 0;
  return Math.round(((plan.drinks_total - plan.drinks_paid) / plan.drinks_total) * 100);
}
