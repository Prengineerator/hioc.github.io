// Pure helpers behind the owner's HIOC Ritual screen (app/owner/passes,
// components/owner/passes, docs/COFFEE-PASS-SPEC.md §8 "Owner").
//
// No React, no fetch, no clock of its own ("today" and "now" are arguments): the
// screen only holds state and draws, and every rule the owner relies on lives
// here where a table-driven test can pin it. That covers what the price form
// shows live (the suggested price, the price per cup, the discount, the
// "customers would pay more than menu price" warning), what must be confirmed
// before a plan changes (CP-D1: activating a plan puts it in front of paying
// customers), how the menu is grouped for the eligible-drinks picker (CP-D3),
// the setup checklist (§9 B), the date presets for the summary, and the rows the
// Reports page adds (CP-D21).
//
// Money is integer rupees. The one exception is the price per cup, which is
// price / cups and is shown to two decimals (₹107.14), never used to charge.

import { PASS_PROGRAM_NAME, PASS_SHORT_NAME, cupsLabel } from '@/lib/passes/brand';
import { validatePlanInput } from '@/lib/passes/rules';
import { parseSummaryRange, type PassProgramSummary } from '@/lib/passes/summary';
import type { CoffeePassPlan, PassState } from '@/lib/passes/types';

// ---------------------------------------------------------------------------
// Words and small formats
// ---------------------------------------------------------------------------

/** Shown under the liability figure: what the number means, in one line. */
export const LIABILITY_EXPLAINER = 'Cups still owed × what customers paid per cup.';

/** The reminder the owner is given until the CA has confirmed how a Ritual is taxed (CP-D11, §9 B4). */
export const GST_REMINDER = 'Confirm GST treatment with your CA (spec CP-D11).';

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

/** The default price: cups paid for × cup value (CP-D2). Null until both are positive whole numbers. */
export function suggestedPriceInr(drinksPaid: number, drinkValueInr: number): number | null {
  if (!Number.isInteger(drinksPaid) || !Number.isInteger(drinkValueInr)) return null;
  if (drinksPaid < 1 || drinkValueInr < 1) return null;
  return drinksPaid * drinkValueInr;
}

/** What one cup costs the customer on this plan: price ÷ cups given, to two decimals. Null when it cannot be worked out. */
export function perCupPriceInr(priceInr: number, drinksTotal: number): number | null {
  if (!Number.isFinite(priceInr) || !Number.isFinite(drinksTotal)) return null;
  if (priceInr < 1 || drinksTotal < 1) return null;
  return round2(priceInr / drinksTotal);
}

/** What all the cups are worth at their cup value: cups given × cup value. Null when it cannot be worked out. */
export function cupsWorthInr(drinksTotal: number, drinkValueInr: number): number | null {
  if (!Number.isFinite(drinksTotal) || !Number.isFinite(drinkValueInr)) return null;
  if (drinksTotal < 1 || drinkValueInr < 1) return null;
  return drinksTotal * drinkValueInr;
}

/**
 * How much cheaper the cups are than their cup value, as a whole percent:
 * 1 − price ÷ (cups given × cup value). 29 for 7 cups of ₹150 sold at ₹750;
 * 0 when the price equals the value; NEGATIVE when the price is above it (the
 * screen warns). Null when it cannot be worked out.
 *
 * This is the PRICE's discount, so it follows an overridden price. (The
 * customer-facing "Save 29%" in lib/passes/rules.ts planDiscountPercent counts
 * cups paid for instead; the two agree at the suggested price.)
 */
export function effectiveDiscountPercent(priceInr: number, drinksTotal: number, drinkValueInr: number): number | null {
  const worth = cupsWorthInr(drinksTotal, drinkValueInr);
  if (worth === null || !Number.isFinite(priceInr) || priceInr < 1) return null;
  const percent = Math.round((1 - priceInr / worth) * 100);
  return percent === 0 ? 0 : percent; // never -0
}

/**
 * The warning shown when the price is more than the cups are worth: customers
 * would pay more than menu price for the same drinks, so nobody should buy it.
 * Null when the price is at or under the value, or cannot be checked.
 */
export function priceWarning(priceInr: number, drinksTotal: number, drinkValueInr: number): string | null {
  const worth = cupsWorthInr(drinksTotal, drinkValueInr);
  if (worth === null || !Number.isFinite(priceInr) || priceInr < 1) return null;
  if (priceInr <= worth) return null;
  return `The price (${formatRupees(priceInr)}) is more than the cups are worth (${drinksTotal} × ${formatRupees(drinkValueInr)} = ${formatRupees(worth)}). Customers would pay more than menu price.`;
}

// ---------------------------------------------------------------------------
// The plan form
// ---------------------------------------------------------------------------

/** The plan form as typed: numbers stay text until saved. */
export interface PlanForm {
  name: string;
  description: string;
  drinks_total: string;
  drinks_paid: string;
  validity_days: string;
  drink_value_inr: string;
  /** What was typed in the price box. Ignored while price_custom is false. */
  price_inr: string;
  /** False = the price follows cups paid for × cup value; true = the owner typed their own. */
  price_custom: boolean;
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
    drink_value_inr: '150',
    price_inr: '',
    price_custom: false,
    max_per_day: '',
    gst_exempt: false,
    is_active: false,
  };
}

/** The form for editing a plan. The price counts as the owner's own when it differs from the suggestion. */
export function planToForm(plan: CoffeePassPlan): PlanForm {
  const suggested = suggestedPriceInr(plan.drinks_paid, plan.drink_value_inr);
  return {
    name: plan.name,
    description: plan.description,
    drinks_total: String(plan.drinks_total),
    drinks_paid: String(plan.drinks_paid),
    validity_days: String(plan.validity_days),
    drink_value_inr: String(plan.drink_value_inr),
    price_inr: String(plan.price_inr),
    price_custom: plan.price_inr !== suggested,
    max_per_day: plan.max_per_day === null ? '' : String(plan.max_per_day),
    gst_exempt: plan.gst_exempt,
    is_active: plan.is_active,
  };
}

/** The suggested price for what is typed now (cups paid for × cup value), or null while either is unreadable. */
export function formSuggestedPrice(form: PlanForm): number | null {
  const paid = parseWholeNumber(form.drinks_paid);
  const value = parseWholeNumber(form.drink_value_inr);
  if (paid === null || value === null) return null;
  return suggestedPriceInr(paid, value);
}

/** The price the form would save: the typed one when it is the owner's own, otherwise the suggestion. Null while unreadable. */
export function formPriceInr(form: PlanForm): number | null {
  return form.price_custom ? parseWholeNumber(form.price_inr) : formSuggestedPrice(form);
}

/** What the price box shows: the typed text when custom, otherwise the suggestion. */
export function formPriceText(form: PlanForm): string {
  if (form.price_custom) return form.price_inr;
  const suggested = formSuggestedPrice(form);
  return suggested === null ? '' : String(suggested);
}

/** The form after "Use suggested price": the price follows the suggestion again. */
export function withSuggestedPrice(form: PlanForm): PlanForm {
  return { ...form, price_custom: false, price_inr: '' };
}

/** The form after the owner types in the price box. */
export function withTypedPrice(form: PlanForm, text: string): PlanForm {
  return { ...form, price_custom: true, price_inr: text };
}

/** Whether the "Use suggested price" button makes sense: there is a suggestion and the price is not already it. */
export function canUseSuggestedPrice(form: PlanForm): boolean {
  const suggested = formSuggestedPrice(form);
  return suggested !== null && formPriceInr(form) !== suggested;
}

export interface PlanPreview {
  price: number | null;
  suggested: number | null;
  /** Price per cup, two decimals. */
  perCup: number | null;
  /** Whole percent, negative when the price is above the cups' value. */
  discountPercent: number | null;
  /** cups given × cup value. */
  worth: number | null;
  warning: string | null;
}

/** Everything the form shows live under the price box. Every field is null while the boxes are unreadable. */
export function planPreview(form: PlanForm): PlanPreview {
  const total = parseWholeNumber(form.drinks_total);
  const value = parseWholeNumber(form.drink_value_inr);
  const price = formPriceInr(form);
  return {
    price,
    suggested: formSuggestedPrice(form),
    perCup: price !== null && total !== null ? perCupPriceInr(price, total) : null,
    discountPercent: price !== null && total !== null && value !== null ? effectiveDiscountPercent(price, total, value) : null,
    worth: total !== null && value !== null ? cupsWorthInr(total, value) : null,
    warning: price !== null && total !== null && value !== null ? priceWarning(price, total, value) : null,
  };
}

/** The plan fields the form sets. */
const EDITABLE_KEYS = [
  'name',
  'description',
  'drinks_total',
  'drinks_paid',
  'validity_days',
  'drink_value_inr',
  'price_inr',
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
  'drink_value_inr',
  'price_inr',
  'max_per_day',
  'gst_exempt',
];

export type PlanPayload =
  | { ok: true; body: Partial<Record<PlanEditableKey | 'sort_order', unknown>>; changed: boolean }
  | { ok: false; error: string };

/**
 * Turns the form into the request body, after the SAME checks the server makes
 * (lib/passes/rules.ts validatePlanInput), so a mistake is caught in the form
 * with the server's own wording.
 *
 *   create (`existing` null): the whole plan, with `sortOrder` so the new plan
 *     lands after the others rather than at 0.
 *   edit: ONLY the fields that changed (the server merges them onto the stored
 *     plan and re-checks the pairs), and never the sort order. `changed` is
 *     false when nothing differs, so the screen can close without a request.
 */
export function buildPlanPayload(form: PlanForm, existing: CoffeePassPlan | null, sortOrder?: number): PlanPayload {
  const num = (raw: string) => parseWholeNumber(raw) ?? Number.NaN;
  const price = formPriceInr(form);
  const cap = form.max_per_day.trim() === '' ? null : num(form.max_per_day);
  const checked = validatePlanInput(
    {
      name: form.name,
      description: form.description,
      drinks_total: num(form.drinks_total),
      drinks_paid: num(form.drinks_paid),
      validity_days: num(form.validity_days),
      drink_value_inr: num(form.drink_value_inr),
      price_inr: price ?? Number.NaN,
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

/** The order the server lists plans in (sort_order, then price, then name), so a saved plan lands where a reload would put it. */
export function sortPlans<T extends Pick<CoffeePassPlan, 'sort_order' | 'price_inr' | 'name'>>(plans: T[]): T[] {
  return [...plans].sort((a, b) => a.sort_order - b.sort_order || a.price_inr - b.price_inr || a.name.localeCompare(b.name));
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
 *   price or terms
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
      message: `This plan is on sale. The new price and terms apply to every sale from now on. ${PASS_SHORT_NAME}s already sold keep the terms they were sold with.`,
      confirmLabel: 'Save changes',
      danger: false,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Table cells for the plans list
// ---------------------------------------------------------------------------

/** The plan's row as the table shows it, so the screen does no arithmetic of its own. */
export function planRow(plan: CoffeePassPlan): {
  perCup: number | null;
  discountPercent: number | null;
  overpriced: boolean;
  validity: string;
  cap: string;
} {
  return {
    perCup: perCupPriceInr(plan.price_inr, plan.drinks_total),
    discountPercent: effectiveDiscountPercent(plan.price_inr, plan.drinks_total, plan.drink_value_inr),
    overpriced: priceWarning(plan.price_inr, plan.drinks_total, plan.drink_value_inr) !== null,
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
   * todo      derived from the data; done when the owner has done it
   * info      already true, nothing to do
   * reminder  cannot be derived from anything (the CA's answer), so it stays until dismissed
   */
  kind: 'todo' | 'info' | 'reminder';
  done: boolean;
  label: string;
  detail: string;
  /** In-page anchor to the section that does it. */
  href?: string;
}

/**
 * What is left before HIOC Ritual is ready, read from the data: a plan that is
 * switched on, and drinks chosen. The GST reminder is static (nothing in the
 * database says the CA has answered). `todo` counts only the derived steps
 * still open. The feature flag is on by definition (the page does not render
 * otherwise), so it is shown as done.
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
      label: input.plans.length === 0 ? 'Create a plan and switch it on' : 'Check the prices, then switch a plan on',
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
      label: 'Choose the drinks a cup can pay for',
      detail:
        input.eligibleCount > 0
          ? `${input.eligibleCount} ${input.eligibleCount === 1 ? 'drink' : 'drinks'} chosen.`
          : 'No drink is chosen yet, so a cup would cover nothing.',
      href: '#ritual-drinks',
    },
    {
      id: 'gst',
      kind: 'reminder',
      done: false,
      label: GST_REMINDER,
      detail: 'GST is charged when a plan is sold. If your CA says otherwise, mark that plan GST exempt.',
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
 * What to say before saving an empty set while a plan is on sale: the cups
 * would cover nothing. Null when there is nothing to warn about.
 */
export function eligibleSaveWarning(input: { selectedCount: number; hasActivePlan: boolean }): string | null {
  if (input.selectedCount > 0 || !input.hasActivePlan) return null;
  return `No drink is chosen, so a ${PASS_SHORT_NAME} cup would cover nothing while a plan is on sale.`;
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
