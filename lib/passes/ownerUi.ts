// Pure helpers behind the owner's HIOC Ritual screen (app/owner/passes,
// components/owner/passes, docs/COFFEE-PASS-SPEC.md §8 "Owner", §13).
//
// No React, no fetch, no clock of its own ("today" and "now" are arguments): the
// screen only holds state and draws, and every rule the owner relies on lives
// here where a table-driven test can pin it. That covers what the plan form shows
// live (the discount, and worked examples of what customers would pay), what must
// be confirmed before a plan changes (CP-D1: activating a plan puts it in front of
// paying customers), how the menu is grouped for the eligible-drinks picker
// (CP-D3), the setup checklist (§9 B), the date presets for the summary, and the
// rows the Reports page adds (CP-D21).
//
// PER-DRINK PRICING (§13, CP-D22..D24): a plan has no price and no cup value. The
// customer picks a drink and a size when buying, the price is cups paid × that
// size's menu price, and each cup covers up to that same price. So the plan form
// has no price box: it shows the discount (which does not depend on the drink) and
// worked examples ("Cappuccino Large ₹120 → ₹600") taken from the live menu.
//
// Money is integer rupees. The one exception is the price per cup, which is
// price / cups and is shown to two decimals (₹107.14), never used to charge.

import { PASS_PROGRAM_NAME, PASS_SHORT_NAME, cupsLabel } from '@/lib/passes/brand';
import { planDiscountPercent, ritualPriceFor, validatePlanInput } from '@/lib/passes/rules';
import { parseSummaryRange, type PassProgramSummary } from '@/lib/passes/summary';
import type { CoffeePassPlan, PassState, RitualDrink } from '@/lib/passes/types';

// ---------------------------------------------------------------------------
// Words and small formats
// ---------------------------------------------------------------------------

/** Shown under the liability figure: what the number means, in one line. */
export const LIABILITY_EXPLAINER = 'Cups still owed × what customers paid per cup.';

/**
 * The GST rule the owner has settled for HIOC Ritual (CP-D11, §9 B4): tax is
 * charged when a Ritual is sold, and a redeemed cup carries none because the
 * sale already paid it. Words only; the maths is lib/passes/rules.ts
 * composePassBill, which takes the covered amount out of the taxable base.
 */
export const GST_RULE = 'GST: 5% when a Ritual is sold · 0% on redeemed cups';

/** ₹ with Indian digit grouping; up to two decimals (a per-cup price), none when whole. "—" for anything that is not a number. */
export function formatRupees(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

/** A count with Indian grouping ("1,234"). */
export function formatCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString('en-IN') : '—';
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/**
 * "5 Oct" for a timestamp, on the IST calendar day, with the year added when it
 * is not the current IST year ("5 Oct 2025"). `now` is an argument so it tests.
 */
export function formatIstDay(iso: string, now: Date = new Date()): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const sameYear = new Date(ms + IST_OFFSET_MS).getUTCFullYear() === new Date(now.getTime() + IST_OFFSET_MS).getUTCFullYear();
  return new Date(ms).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : ({ year: 'numeric' } as const)),
    timeZone: 'Asia/Kolkata',
  });
}

/**
 * The LAST day a pass can be used, as an instant on that day. `expires_at` is
 * the moment the next IST day starts (CP-D5), so a Weekly bought Monday shows
 * "valid till Sunday", not Monday: one millisecond back is still Sunday.
 */
export function passValidTillIso(expiresIso: string): string {
  const ms = Date.parse(expiresIso);
  return Number.isNaN(ms) ? expiresIso : new Date(ms - 1).toISOString();
}

/** "12 Oct": the last day a pass works (see passValidTillIso). */
export function formatValidTill(expiresIso: string, now: Date = new Date()): string {
  return formatIstDay(passValidTillIso(expiresIso), now);
}

/** "3 of 7". */
export function cupsLeftLabel(remaining: number, total: number): string {
  return `${remaining} of ${total}`;
}

/** "No limit" / "1 a day" / "2 a day". */
export function dailyCapLabel(maxPerDay: number | null): string {
  return maxPerDay === null ? 'No limit' : `${maxPerDay} a day`;
}

/** "7 days" / "1 day". */
export function validityLabel(days: number): string {
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/** What a pass's state reads as. Words as well as a colour, so the state is never colour alone. */
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

/** The Badge variant for a state (components/ui/Badge). */
export function passStateTone(state: PassState): 'success' | 'neutral' | 'outline' | 'danger' {
  switch (state) {
    case 'active':
      return 'success';
    case 'used_up':
      return 'neutral';
    case 'expired':
      return 'outline';
    case 'refunded':
    case 'void':
      return 'danger';
  }
}

// ---------------------------------------------------------------------------
// Price maths (what the plan form shows live)
// ---------------------------------------------------------------------------

/** What one cup costs the customer for a given price: price ÷ cups given, to two decimals. Null when it cannot be worked out. */
export function perCupPriceInr(priceInr: number, drinksTotal: number): number | null {
  if (!Number.isFinite(priceInr) || !Number.isFinite(drinksTotal)) return null;
  if (priceInr < 1 || drinksTotal < 1) return null;
  return round2(priceInr / drinksTotal);
}

/** One worked example of what a Ritual costs for a real drink on the menu. */
export interface PriceExample {
  /** "Cappuccino". */
  drink: string;
  /** "Large" ('' when the size has no name). */
  size: string;
  /** The size's menu price: what each cup covers. */
  cup_price_inr: number;
  /** What the customer pays for the Ritual before GST: cups paid × cup_price_inr. */
  price_inr: number;
  /** What one cup costs them: price ÷ cups given, two decimals. */
  per_cup_inr: number | null;
  /** "Cappuccino Large ₹120 → ₹600". */
  text: string;
}

/**
 * Worked examples for the plan form and the plans table, so the owner sees what
 * customers would actually pay now that a plan has no price: for each of the first
 * `limit` drinks, its DEAREST size (the one a customer is most likely to be quoting,
 * "Cappuccino Large"), priced with the very function the server prices a sale
 * with (ritualPriceFor: cups paid × the size's menu price, CP-D22).
 *
 * `drinks` is the shape GET /api/passes/plans returns as `eligible`, in its order.
 * A drink that is off the menu today (`is_available` false) is skipped unless
 * nothing else is left, a size at ₹0 never counts, and a drink with no usable size
 * gives no example. `plan` needs only cups paid and cups given, so a half-typed
 * form works as soon as both boxes read as numbers. Empty when there is nothing to
 * show (no drink is ticked yet).
 */
export function examplePrices(
  plan: Pick<CoffeePassPlan, 'drinks_paid' | 'drinks_total'>,
  drinks: readonly RitualDrink[],
  limit = 3,
): PriceExample[] {
  if (!Number.isInteger(plan.drinks_paid) || plan.drinks_paid < 1) return [];
  const usable = drinks.filter((d) => d.sizes.some((sz) => sz.price_inr >= 1));
  const preferred = usable.filter((d) => d.is_available);
  const pool = preferred.length > 0 ? preferred : usable;
  return pool.slice(0, Math.max(0, Math.trunc(limit))).map((drink) => {
    const dearest = drink.sizes.filter((sz) => sz.price_inr >= 1).reduce((a, b) => (b.price_inr > a.price_inr ? b : a));
    const price = ritualPriceFor(plan, dearest.price_inr);
    const size = dearest.label.trim();
    return {
      drink: drink.name,
      size,
      cup_price_inr: dearest.price_inr,
      price_inr: price,
      per_cup_inr: perCupPriceInr(price, plan.drinks_total),
      text: `${drink.name}${size ? ` ${size}` : ''} ${formatRupees(dearest.price_inr)} → ${formatRupees(price)}`,
    };
  });
}

/** "Price: 5 × the drink": the whole pricing rule of a plan, in words (CP-D22, CP-D24). */
export function priceRuleLabel(plan: Pick<CoffeePassPlan, 'drinks_paid'>): string {
  return `Price: ${plan.drinks_paid} × the drink`;
}

/** The drinks the owner is shown worked examples for first (by name, compared without case). */
const EXAMPLE_FAVOURITES = ['cappuccino', 'latte'] as const;

/**
 * Which drinks the worked examples are about: Cappuccino and Latte when the menu
 * has them (the two an owner thinks in), otherwise the first few by price, cheapest
 * first (by the same size the example quotes: the dearest). One favourite found is
 * topped up with the cheapest others, so there are two or three examples whenever
 * the menu has that many drinks. A drink that is off the menu today is passed over
 * unless nothing else is left, and a drink with no size priced at ₹1 or more never
 * counts. Returned in the order the examples should read.
 */
export function exampleDrinks(drinks: readonly RitualDrink[], limit = 3): RitualDrink[] {
  const cap = Math.max(0, Math.trunc(limit));
  const usable = drinks.filter((d) => d.sizes.some((sz) => sz.price_inr >= 1));
  const onMenu = usable.filter((d) => d.is_available);
  const pool = onMenu.length > 0 ? onMenu : usable;
  const nameOf = (d: RitualDrink) => d.name.trim().toLowerCase();
  const favourites = EXAMPLE_FAVOURITES.map((fav) => pool.find((d) => nameOf(d) === fav)).filter(
    (d): d is RitualDrink => d !== undefined,
  );
  if (favourites.length >= 2) return favourites.slice(0, cap);
  const dearest = (d: RitualDrink) => Math.max(...d.sizes.filter((sz) => sz.price_inr >= 1).map((sz) => sz.price_inr));
  const others = pool
    .filter((d) => !favourites.includes(d))
    .sort((a, b) => dearest(a) - dearest(b) || a.name.localeCompare(b.name));
  return [...favourites, ...others].slice(0, cap);
}

/**
 * The worked examples the plans table and the plan form show: what a customer
 * would pay for this plan on the drinks exampleDrinks picks. Empty until some drink
 * is ticked (there is nothing real to quote).
 */
export function planExamples(
  plan: Pick<CoffeePassPlan, 'drinks_paid' | 'drinks_total'>,
  drinks: readonly RitualDrink[],
  limit = 3,
): PriceExample[] {
  return examplePrices(plan, exampleDrinks(drinks, limit), limit);
}

// ---------------------------------------------------------------------------
// The plan form
// ---------------------------------------------------------------------------

/** The plan form as typed: numbers stay text until saved. There is no price or cup value (CP-D24). */
export interface PlanForm {
  name: string;
  description: string;
  drinks_total: string;
  drinks_paid: string;
  validity_days: string;
  /** Empty = no daily limit. */
  max_per_day: string;
  gst_exempt: boolean;
  is_active: boolean;
}

/** A whole number from a form box ("1,050" and "₹750" are read too); null for anything else, blank included. */
export function parseWholeNumber(raw: string): number | null {
  const cleaned = raw.replace(/[₹,\s]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isSafeInteger(n) ? n : null;
}

/** A blank form for a new plan: a Weekly-shaped start the owner edits. Switched OFF until the owner says otherwise. */
export function emptyPlanForm(): PlanForm {
  return {
    name: '',
    description: '',
    drinks_total: '7',
    drinks_paid: '5',
    validity_days: '7',
    max_per_day: '',
    gst_exempt: false,
    is_active: false,
  };
}

/** The form for editing a plan. */
export function planToForm(plan: CoffeePassPlan): PlanForm {
  return {
    name: plan.name,
    description: plan.description,
    drinks_total: String(plan.drinks_total),
    drinks_paid: String(plan.drinks_paid),
    validity_days: String(plan.validity_days),
    max_per_day: plan.max_per_day === null ? '' : String(plan.max_per_day),
    gst_exempt: plan.gst_exempt,
    is_active: plan.is_active,
  };
}

export interface PlanPreview {
  /** Cups given free: cups given − cups paid for. Null while either box is unreadable. */
  freeCups: number | null;
  /** The saving on every cup, whole percent: free cups ÷ cups given. The same whatever the drink. */
  discountPercent: number | null;
  /** Cups paid for, readable as a number (what examplePrices multiplies). Null while unreadable. */
  drinksPaid: number | null;
  /** Cups given, readable as a number. Null while unreadable. */
  drinksTotal: number | null;
}

/**
 * Everything the form shows live under the cups boxes. Every field is null while
 * the boxes are unreadable. The discount needs no drink: paying for 5 of 7 cups is
 * 29% off whichever size is bought, so the screen shows it with the worked
 * examples (examplePrices) that put rupees to it.
 */
export function planPreview(form: PlanForm): PlanPreview {
  const total = parseWholeNumber(form.drinks_total);
  const paid = parseWholeNumber(form.drinks_paid);
  const readable = total !== null && paid !== null && total >= 1 && paid >= 1 && paid <= total;
  return {
    freeCups: readable ? total - paid : null,
    discountPercent: readable ? planDiscountPercent({ drinks_total: total, drinks_paid: paid }) : null,
    drinksPaid: paid !== null && paid >= 1 ? paid : null,
    drinksTotal: total !== null && total >= 1 ? total : null,
  };
}

/** The plan fields the form sets. */
const EDITABLE_KEYS = [
  'name',
  'description',
  'drinks_total',
  'drinks_paid',
  'validity_days',
  'max_per_day',
  'gst_exempt',
  'is_active',
] as const;
export type PlanEditableKey = (typeof EDITABLE_KEYS)[number];

/** The keys that change what a customer buys or pays (as opposed to the name or the wording). */
const TERMS_KEYS: readonly PlanEditableKey[] = [
  'drinks_total',
  'drinks_paid',
  'validity_days',
  'max_per_day',
  'gst_exempt',
];

export type PlanPayload =
  | { ok: true; body: Partial<Record<PlanEditableKey | 'sort_order', unknown>>; changed: boolean }
  | { ok: false; error: string };

/**
 * Turns the form into the request body, after the SAME checks the server makes
 * (lib/passes/rules.ts validatePlanInput), so a mistake is caught in the form
 * with the server's own wording. The body never carries a price or a cup value:
 * the server refuses both (CP-D24).
 *
 *   create (`existing` null): the whole plan, with `sortOrder` so the new plan
 *     lands after the others rather than at 0.
 *   edit: ONLY the fields that changed (the server merges them onto the stored
 *     plan and re-checks the pairs), and never the sort order. `changed` is
 *     false when nothing differs, so the screen can close without a request.
 */
export function buildPlanPayload(form: PlanForm, existing: CoffeePassPlan | null, sortOrder?: number): PlanPayload {
  const num = (raw: string) => parseWholeNumber(raw) ?? Number.NaN;
  const cap = form.max_per_day.trim() === '' ? null : num(form.max_per_day);
  const checked = validatePlanInput(
    {
      name: form.name,
      description: form.description,
      drinks_total: num(form.drinks_total),
      drinks_paid: num(form.drinks_paid),
      validity_days: num(form.validity_days),
      max_per_day: cap,
      gst_exempt: form.gst_exempt,
      is_active: form.is_active,
    },
    { partial: false },
  );
  if (!checked.ok) return { ok: false, error: checked.error };
  const value = checked.value as Record<PlanEditableKey, unknown>;

  if (existing === null) {
    const body: Partial<Record<PlanEditableKey | 'sort_order', unknown>> = {};
    for (const key of EDITABLE_KEYS) body[key] = value[key];
    if (sortOrder !== undefined) body.sort_order = sortOrder;
    return { ok: true, body, changed: true };
  }

  const body: Partial<Record<PlanEditableKey, unknown>> = {};
  for (const key of EDITABLE_KEYS) {
    if (value[key] !== existing[key]) body[key] = value[key];
  }
  return { ok: true, body, changed: Object.keys(body).length > 0 };
}

/** Where a new plan sorts: after the plans that exist, in steps of 10 (the seeded plans are 10 and 20). */
export function nextSortOrder(plans: Pick<CoffeePassPlan, 'sort_order'>[]): number {
  return plans.length === 0 ? 10 : Math.max(...plans.map((p) => p.sort_order)) + 10;
}

/** The order the server lists plans in (sort_order, then name), so a saved plan lands where a reload would put it. */
export function sortPlans<T extends Pick<CoffeePassPlan, 'sort_order' | 'name'>>(plans: T[]): T[] {
  return [...plans].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

export interface PlanConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  /** True for a change that stops customers buying, so the button is drawn as a risk. */
  danger: boolean;
}

/**
 * What the owner must confirm before a plan change is sent, or null when it
 * needs none (a rename, new wording, a new plan left switched off).
 *
 *   switching a plan ON       "Customers will be able to buy this now."
 *   switching a plan OFF      customers can no longer buy it; Rituals already sold keep working
 *   changing a live plan's    the new terms apply to new sales straight away
 *   cups, validity or cap
 *
 * `body` is the request body (buildPlanPayload's), or `{ is_active }` for the
 * switch in the table. `existing` is null for a new plan.
 */
export function planSaveConfirmation(
  existing: CoffeePassPlan | null,
  body: Partial<Record<PlanEditableKey, unknown>>,
): PlanConfirmation | null {
  const wasActive = existing?.is_active === true;
  const willBeActive = body.is_active === undefined ? wasActive : body.is_active === true;

  if (!wasActive && willBeActive) {
    return {
      title: 'Make this plan available?',
      message: 'Customers will be able to buy this now.',
      confirmLabel: 'Yes, activate',
      danger: false,
    };
  }
  if (wasActive && !willBeActive) {
    return {
      title: 'Switch this plan off?',
      message: `Customers will no longer be able to buy this. ${PASS_SHORT_NAME}s already sold keep working until they run out or expire.`,
      confirmLabel: 'Switch off',
      danger: true,
    };
  }
  if (wasActive && TERMS_KEYS.some((key) => body[key] !== undefined && body[key] !== existing?.[key])) {
    return {
      title: 'Change a live plan?',
      message: `This plan is on sale. The new terms apply to every sale from now on. ${PASS_SHORT_NAME}s already sold keep the terms they were sold with.`,
      confirmLabel: 'Save changes',
      danger: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Table cells for the plans list
// ---------------------------------------------------------------------------

/**
 * The plan's row as the table shows it, so the screen does no arithmetic of its
 * own. There is no price column: what a customer pays depends on the drink they
 * pick (CP-D22), so the table shows the saving, and examplePrices puts rupees to it.
 */
export function planRow(plan: CoffeePassPlan): {
  freeCups: number;
  discountPercent: number;
  validity: string;
  cap: string;
} {
  return {
    freeCups: Math.max(0, plan.drinks_total - plan.drinks_paid),
    discountPercent: planDiscountPercent(plan),
    validity: validityLabel(plan.validity_days),
    cap: dailyCapLabel(plan.max_per_day),
  };
}

// ---------------------------------------------------------------------------
// Setup checklist (spec §9 B)
// ---------------------------------------------------------------------------

export interface ChecklistItem {
  id: 'live' | 'plan' | 'drinks' | 'gst';
  /**
   * todo  derived from the data; done when the owner has done it
   * info  already true or already decided (the feature flag, the GST rule), nothing to do
   */
  kind: 'todo' | 'info';
  done: boolean;
  label: string;
  detail: string;
  /** In-page anchor to the section that does it. */
  href?: string;
}

/**
 * What is left before HIOC Ritual is ready, read from the data: a plan that is
 * switched on, and drinks chosen. The GST rule is already decided by the owner,
 * so it is listed as a settled `info` item, not a step. `todo` counts only the
 * derived steps still open. The feature flag is on by definition (the page does
 * not render otherwise), so it is shown as done too.
 */
export function setupChecklist(input: {
  plans: Pick<CoffeePassPlan, 'is_active'>[];
  eligibleCount: number;
}): { items: ChecklistItem[]; todo: number } {
  const active = input.plans.filter((p) => p.is_active).length;
  const items: ChecklistItem[] = [
    {
      id: 'live',
      kind: 'info',
      done: true,
      label: `${PASS_PROGRAM_NAME} is switched on`,
      detail: 'The feature flag is live for this site, so there is nothing to do here.',
    },
    {
      id: 'plan',
      kind: 'todo',
      done: active > 0,
      label: input.plans.length === 0 ? 'Create a plan and switch it on' : 'Check the plans, then switch one on',
      detail:
        input.plans.length === 0
          ? 'No plans yet.'
          : active > 0
            ? `${active} of ${input.plans.length} ${input.plans.length === 1 ? 'plan is' : 'plans are'} on sale.`
            : 'No plan is on sale yet, so customers cannot buy anything.',
      href: '#ritual-plans',
    },
    {
      id: 'drinks',
      kind: 'todo',
      done: input.eligibleCount > 0,
      label: `Choose the drinks a ${PASS_SHORT_NAME} can be bought for`,
      detail:
        input.eligibleCount > 0
          ? `${input.eligibleCount} ${input.eligibleCount === 1 ? 'drink' : 'drinks'} chosen.`
          : 'No drink is chosen yet, so customers have nothing to buy.',
      href: '#ritual-drinks',
    },
    {
      id: 'gst',
      kind: 'info',
      done: true,
      label: GST_RULE,
      detail:
        'Decided by the owner on 30 Sep 2026. Cups are paid for when the Ritual is sold, so a redeemed cup carries no GST; a top-up above the cup value is taxed like any sale.',
      href: '#ritual-plans',
    },
  ];
  return { items, todo: items.filter((i) => i.kind === 'todo' && !i.done).length };
}

// ---------------------------------------------------------------------------
// Eligible drinks (CP-D3)
// ---------------------------------------------------------------------------

/** One menu item as GET /api/owner/passes lists it for the picker (no prices). */
export interface PickerItem {
  id: string;
  name: string;
  category: string;
  is_available: boolean;
}

export interface CategoryGroup {
  category: string;
  items: PickerItem[];
}

/**
 * Groups the menu by category for the picker. Categories keep the order they
 * first appear in (the server sorts by category, then the menu's own order), and
 * so do the items in each. A blank category reads "Other".
 */
export function groupMenuByCategory(menu: PickerItem[]): CategoryGroup[] {
  const groups = new Map<string, CategoryGroup>();
  for (const item of menu) {
    const category = item.category.trim() || 'Other';
    let group = groups.get(category);
    if (!group) {
      group = { category, items: [] };
      groups.set(category, group);
    }
    group.items.push(item);
  }
  return [...groups.values()];
}

/** How much of one category is ticked: 'none', 'some' or 'all' (a category with no items is 'none'). */
export function categorySelection(
  group: CategoryGroup,
  selected: ReadonlySet<string>,
): { selected: number; total: number; state: 'none' | 'some' | 'all' } {
  const total = group.items.length;
  const picked = group.items.filter((i) => selected.has(i.id)).length;
  return { selected: picked, total, state: picked === 0 ? 'none' : picked === total ? 'all' : 'some' };
}

/** A new selection with `ids` ticked (on) or unticked (off). The input is not changed. */
export function withSelection(selected: ReadonlySet<string>, ids: readonly string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** Ticks a whole category, or unticks it: "select all" for one group. */
export function setCategorySelected(selected: ReadonlySet<string>, group: CategoryGroup, on: boolean): Set<string> {
  return withSelection(
    selected,
    group.items.map((i) => i.id),
    on,
  );
}

/** The one-tap shortcuts, in the order the owner asked for them (CP-D3). */
export const QUICK_CATEGORIES = ['Coffee', 'Creme Coffee', 'Iced Coffee', 'Cold Brews'] as const;

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/** The groups the quick buttons apply to: those of QUICK_CATEGORIES that are on the menu, in that order. */
export function quickCategories(groups: CategoryGroup[]): CategoryGroup[] {
  const out: CategoryGroup[] = [];
  for (const name of QUICK_CATEGORIES) {
    const found = groups.find((g) => normalise(g.category) === normalise(name));
    if (found) out.push(found);
  }
  return out;
}

/** Same set of ids, whatever the order. */
export function sameSelection(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/** How many of the menu's items are ticked (ids that are no longer on the menu do not count). */
export function countSelected(menu: PickerItem[], selected: ReadonlySet<string>): number {
  return menu.filter((i) => selected.has(i.id)).length;
}

/**
 * What to say before saving an empty set while a plan is on sale: customers
 * choose their drink from this set when they buy (CP-D22), so with nothing in it
 * a plan on sale cannot be bought. Null when there is nothing to warn about.
 */
export function eligibleSaveWarning(input: { selectedCount: number; hasActivePlan: boolean }): string | null {
  if (input.selectedCount > 0 || !input.hasActivePlan) return null;
  return `No drink is chosen, so nobody could buy a ${PASS_SHORT_NAME} while a plan is on sale.`;
}

// ---------------------------------------------------------------------------
// Summary: date presets and the stat cards
// ---------------------------------------------------------------------------

export type SummaryPreset = 'today' | '7d' | '30d' | 'custom';

export const SUMMARY_PRESETS: { id: SummaryPreset; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'custom', label: 'Custom' },
];

export interface DateRange {
  from: string;
  to: string;
}

function daysBefore(isoDate: string, n: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}

/** The IST days a preset covers, ending today (both ends included): Today, the last 7, the last 30. */
export function presetRange(preset: Exclude<SummaryPreset, 'custom'>, today: string): DateRange {
  const back = preset === 'today' ? 0 : preset === '7d' ? 6 : 29;
  return { from: daysBefore(today, back), to: today };
}

/** The query string for GET /api/owner/passes/summary. */
export function summaryQuery(range: DateRange): string {
  return `from=${encodeURIComponent(range.from)}&to=${encodeURIComponent(range.to)}`;
}

/**
 * Checks a custom range before asking for it, with the server's own wording
 * (parseSummaryRange): real dates, start not after end, no future end, at most
 * a year. `today` is the IST date now.
 */
export function checkCustomRange(from: string, to: string, today: string): { ok: true; range: DateRange } | { ok: false; message: string } {
  if (!from || !to) return { ok: false, message: 'Pick both dates.' };
  // Noon IST on `today`: any instant of the day reads back as the same IST date.
  const parsed = parseSummaryRange(from, to, new Date(`${today}T12:00:00+05:30`));
  return parsed.ok ? { ok: true, range: { from: parsed.from, to: parsed.to } } : { ok: false, message: parsed.message };
}

export interface SummaryCard {
  id: 'sold' | 'refunded' | 'active' | 'cups' | 'liability' | 'redeemed' | 'expired';
  label: string;
  value: string;
  sub: string;
  /** Live totals as of now, not for the chosen dates. */
  live: boolean;
  /** The card that matters most: what the cafe still owes. */
  emphasis?: boolean;
}

/** The seven stat cards for a summary, worded once here. Money is whole rupees, cups say "cups". */
export function summaryCards(s: PassProgramSummary): SummaryCard[] {
  return [
    {
      id: 'sold',
      label: `${PASS_SHORT_NAME}s sold`,
      value: formatCount(s.sold.count),
      sub: formatRupees(s.sold.inr),
      live: false,
    },
    {
      id: 'refunded',
      label: 'Refunded',
      value: formatCount(s.refunded.count),
      sub: formatRupees(s.refunded.inr),
      live: false,
    },
    {
      id: 'active',
      label: `Active ${PASS_SHORT_NAME}s`,
      value: formatCount(s.active.passes),
      sub: 'in date, with cups left',
      live: true,
    },
    {
      id: 'cups',
      label: 'Cups outstanding',
      value: formatCount(s.active.cups_outstanding),
      sub: 'left on active Rituals',
      live: true,
    },
    {
      id: 'liability',
      label: 'Liability',
      value: formatRupees(s.active.liability_inr),
      sub: LIABILITY_EXPLAINER,
      live: true,
      emphasis: true,
    },
    {
      id: 'redeemed',
      label: 'Cups redeemed',
      value: formatCount(s.redeemed.cups),
      sub: `${formatRupees(s.redeemed.covered_inr)} covered`,
      live: false,
    },
    {
      id: 'expired',
      label: 'Expired unused',
      value: `${formatCount(s.expired_unused.cups)} ${s.expired_unused.cups === 1 ? 'cup' : 'cups'}`,
      sub: formatRupees(s.expired_unused.inr),
      live: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// Reports: the two informational rows (CP-D21)
// ---------------------------------------------------------------------------

export interface ReportPassRow {
  label: string;
  value: string;
}

/**
 * The rows the owner Reports page adds under Sales. Neither changes Gross or
 * Net: pass sales are already inside gross sales, and the cover on a redeemed
 * cup is not a discount. Each is null when the feature is off or its numbers
 * are zero, so a cafe not using HIOC Ritual sees nothing new.
 */
export function reportPassRows(
  totals: { passSales?: { count: number; inr: number } | null; passRedemptions?: { drinks: number; inr: number } | null },
  enabled: boolean,
): { sales: ReportPassRow | null; cups: ReportPassRow | null } {
  if (!enabled) return { sales: null, cups: null };
  const sales = totals.passSales;
  const cups = totals.passRedemptions;
  return {
    sales:
      sales && (sales.count > 0 || sales.inr > 0)
        ? { label: `of which ${PASS_PROGRAM_NAME} sales`, value: `${formatCount(sales.count)} · ${formatRupees(sales.inr)}` }
        : null,
    cups:
      cups && (cups.drinks > 0 || cups.inr > 0)
        ? { label: `Cups served on ${PASS_PROGRAM_NAME}`, value: `${cupsLabel(cups.drinks)} · ${formatRupees(cups.inr)} covered` }
        : null,
  };
}
