// What a screen needs to let someone choose the DRINK a HIOC Ritual is bought for
// (docs/COFFEE-PASS-SPEC.md §13, CP-D22..D25): searching and grouping the eligible
// drinks, picking a size, the live price line ("5 × ₹120 = ₹600 + ₹30 GST = ₹630")
// and the words a pass uses for its drink.
//
// Pure on purpose (no React, no fetch, no server-only): this repo has no component
// tests, so anything the customer page (/ritual), the counter (/staff/passes) and
// the owner screen DECIDE lives here where vitest can pin it, and the screens only
// lay it out. The price is worked out with the very functions the server uses
// (ritualPriceFor in lib/passes/rules.ts, computeBill in lib/store/hours.ts), but it
// is a PREVIEW: POST /api/passes/checkout and /sell price the cup again from the
// live menu, and the order's own total is what is charged.

import { PASS_SHORT_NAME } from '@/lib/passes/brand';
import { MENU_CATEGORIES } from '@/lib/constants';
import { ritualDrinkLabel, ritualLineName, ritualPriceFor } from '@/lib/passes/rules';
import type { CoffeePassPlan, PassSummary, RitualDrink, RitualDrinkSize } from '@/lib/passes/types';
import { groupEligibleByCategory } from '@/lib/passes/ui';
import { computeBill } from '@/lib/store/hours';
import type { StoreSettings } from '@/lib/types';

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Said on every plan card: a plan has no price of its own (CP-D24). */
export const PRICE_FOLLOWS_DRINK = 'The price follows the drink you pick.';

/** "Each cup covers up to ₹120 on any Ritual coffee." (CP-D23) */
export function ritualCoverLine(cupPriceInr: number): string {
  return `Each cup covers up to ₹${cupPriceInr} on any ${PASS_SHORT_NAME} coffee.`;
}

// ---------------------------------------------------------------------------
// Sizes and the choice
// ---------------------------------------------------------------------------

/** The sizes of a drink that can be bought (a price of at least ₹1), cheapest first. The API already leaves the rest out; this keeps a stale or odd payload from offering one. */
export function sizesOnSale(drink: Pick<RitualDrink, 'sizes'>): RitualDrinkSize[] {
  return drink.sizes
    .filter((s) => Number.isFinite(s.price_inr) && s.price_inr >= 1)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.price_inr - b.s.price_inr || a.i - b.i)
    .map(({ s }) => s);
}

/** A drink can be picked while it is on the menu today and has a size on sale. Off-menu drinks stay listed, greyed (RitualDrink.is_available). */
export function drinkSelectable(drink: RitualDrink): boolean {
  return drink.is_available && sizesOnSale(drink).length > 0;
}

/** "₹90" when every size costs the same, "₹90–₹140" otherwise; '' when nothing is on sale. */
export function priceRangeLabel(drink: Pick<RitualDrink, 'sizes'>): string {
  const sizes = sizesOnSale(drink);
  if (sizes.length === 0) return '';
  const low = sizes[0].price_inr;
  const high = sizes[sizes.length - 1].price_inr;
  return low === high ? `₹${low}` : `₹${low}–₹${high}`;
}

/** What has been tapped so far: a drink, and then one of its sizes. */
export interface DrinkChoice {
  drinkId: string | null;
  variantId: string | null;
}

export const NO_CHOICE: DrinkChoice = { drinkId: null, variantId: null };

/**
 * The choice after tapping a drink. A drink with exactly one size on sale is
 * complete at once (there is nothing to ask); a drink with several waits for the
 * customer to say which. Tapping the drink already chosen keeps its size.
 */
export function chooseDrink(drink: RitualDrink, previous: DrinkChoice = NO_CHOICE): DrinkChoice {
  const sizes = sizesOnSale(drink);
  if (previous.drinkId === drink.id && sizes.some((s) => s.variant_id === previous.variantId)) return previous;
  return { drinkId: drink.id, variantId: sizes.length === 1 ? sizes[0].variant_id : null };
}

/** The choice after tapping a size of the drink already chosen. */
export function chooseSize(choice: DrinkChoice, variantId: string): DrinkChoice {
  return choice.drinkId ? { drinkId: choice.drinkId, variantId } : choice;
}

export interface ResolvedChoice {
  drink: RitualDrink;
  /** null until a size that is still on sale has been chosen. */
  size: RitualDrinkSize | null;
}

/**
 * The drink and size a choice points at, read against the list as it is NOW: a
 * drink that has left the list (the owner unticked it, the page re-read the
 * offer) or a size that is no longer on sale resolves to nothing, so a stale
 * choice can never be bought. null when no drink is chosen or it is gone.
 */
export function resolveChoice(drinks: readonly RitualDrink[], choice: DrinkChoice): ResolvedChoice | null {
  if (!choice.drinkId) return null;
  const drink = drinks.find((d) => d.id === choice.drinkId);
  if (!drink || !drinkSelectable(drink)) return null;
  const size = sizesOnSale(drink).find((s) => s.variant_id === choice.variantId) ?? null;
  return { drink, size };
}

/** A drink AND one of its sizes: what a purchase needs. */
export type CompleteChoice = { drink: RitualDrink; size: RitualDrinkSize };

/** resolveChoice, but only once a size has been chosen too. null before that. */
export function completeChoice(drinks: readonly RitualDrink[], choice: DrinkChoice): CompleteChoice | null {
  const resolved = resolveChoice(drinks, choice);
  return resolved && resolved.size ? { drink: resolved.drink, size: resolved.size } : null;
}

/** "Cappuccino · Large": the drink as a pass remembers it (the same words as the pass's own drink_label). */
export function choiceLabel(resolved: { drink: Pick<RitualDrink, 'name'>; size: Pick<RitualDrinkSize, 'label'> }): string {
  return ritualDrinkLabel({ name: resolved.drink.name, size_label: resolved.size.label });
}

/** "Weekly Ritual — Cappuccino (Large)": the sale line's name, as the bill and receipt will read it. */
export function choiceLineName(
  plan: Pick<CoffeePassPlan, 'name'>,
  resolved: { drink: Pick<RitualDrink, 'name'>; size: Pick<RitualDrinkSize, 'label'> },
): string {
  return ritualLineName(plan, { name: resolved.drink.name, size_label: resolved.size.label });
}

// ---------------------------------------------------------------------------
// Searching and grouping the list
// ---------------------------------------------------------------------------

/** The menu's own category order, for grouping the drinks the way the menu does. */
export const CATEGORY_ORDER: readonly string[] = MENU_CATEGORIES.map((c) => c.slug);

const CATEGORY_LABELS = new Map(MENU_CATEGORIES.map((c) => [c.slug, c.label]));

/** A category's display label ("Creme Coffee" → "Crème Coffee"); an unknown one reads as stored. */
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS.get(category) ?? category;
}

/** A list this long is worth a search box (the owner ticks dozens in production). */
export const PICKER_SEARCH_MIN_DRINKS = 8;

export function pickerNeedsSearch(drinkCount: number): boolean {
  return drinkCount > PICKER_SEARCH_MIN_DRINKS;
}

/** Lower case, accents dropped ("Crème" matches "creme"), spaces collapsed. */
function normalise(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The drinks a typed search matches: every word typed must appear in the drink's
 * name or its category's label, in any order ("iced latte", "latte iced"). An
 * empty search keeps everything. Order is kept.
 */
export function filterDrinks<T extends Pick<RitualDrink, 'name' | 'category'>>(
  drinks: readonly T[],
  query: string,
  categoryLabel: (category: string) => string = (c) => c,
): T[] {
  const words = normalise(query).split(' ').filter(Boolean);
  if (words.length === 0) return [...drinks];
  return drinks.filter((d) => {
    const haystack = normalise(`${d.name} ${categoryLabel(d.category)}`);
    return words.every((w) => haystack.includes(w));
  });
}

export interface PickerView<T> {
  /** One chip per category that has a match, with how many. */
  chips: { category: string; label: string; count: number }[];
  /** The groups to list: every matching category, or just the chosen one. */
  groups: { category: string; label: string; drinks: T[] }[];
  /** How many drinks the groups hold. */
  shown: number;
}

/**
 * What the picker lists for a search and a category chip, categories in the
 * menu's own order (`categoryOrder`, then alphabetical for any it does not know)
 * and drinks in the order received. The chips come from the SEARCH's matches, so
 * they never offer a category that would be empty; a chosen category that has no
 * match leaves the list empty rather than silently showing everything.
 */
export function pickerView<T extends Pick<RitualDrink, 'name' | 'category'>>(
  drinks: readonly T[],
  opts: {
    query?: string;
    /** null = every category. */
    category?: string | null;
    categoryOrder: readonly string[];
    labelFor?: (category: string) => string;
  },
): PickerView<T> {
  const labelFor = opts.labelFor ?? ((c: string) => c);
  const matches = filterDrinks(drinks, opts.query ?? '', labelFor);
  const all = groupEligibleByCategory(matches, opts.categoryOrder, labelFor);
  const groups = opts.category ? all.filter((g) => g.category === opts.category) : all;
  return {
    chips: all.map((g) => ({ category: g.category, label: g.label, count: g.drinks.length })),
    groups,
    shown: groups.reduce((n, g) => n + g.drinks.length, 0),
  };
}

// ---------------------------------------------------------------------------
// The live price
// ---------------------------------------------------------------------------

/** How GST shows on the price: not at all, added on top, or already inside. */
export type PriceGstMode = 'none' | 'added' | 'included';

export interface RitualPriceQuote {
  /** Cups paid for: what the price multiplies. */
  cups: number;
  /** The chosen size's menu price: what each cup covers (CP-D23). */
  cupPriceInr: number;
  /** cups × cupPriceInr, before any GST that is added on top. */
  subtotalInr: number;
  /** GST in rupees (added on top, or the part of the subtotal that is GST when it is included); 0 when none. */
  gstInr: number;
  gst: PriceGstMode;
  /** What the customer pays. */
  totalInr: number;
}

/**
 * The Ritual's price for a plan and a chosen size (CP-D22): cups paid × the size's
 * menu price, with GST at the store's rate unless the plan is GST-exempt (CP-D11).
 * The bill maths is the one computeBill the server bills with. `gst` is the
 * store's setting as GET /api/passes/plans reports it; unknown reads as no GST.
 */
export function ritualPriceQuote(
  plan: Pick<CoffeePassPlan, 'drinks_paid' | 'gst_exempt'>,
  cupPriceInr: number,
  gst: { percent: number; inclusive: boolean } | null | undefined,
): RitualPriceQuote {
  const subtotal = ritualPriceFor(plan, cupPriceInr);
  const settings = {
    gst_percent: gst?.percent ?? 0,
    gst_inclusive: gst?.inclusive ?? true,
    packaging_charge_inr: 0,
  } as StoreSettings;
  const bill = computeBill(subtotal, settings, 0, plan.gst_exempt ? 0 : subtotal);
  const taxed = !plan.gst_exempt && bill.tax_inr > 0;
  return {
    cups: plan.drinks_paid,
    cupPriceInr,
    subtotalInr: subtotal,
    gstInr: taxed ? bill.tax_inr : 0,
    gst: !taxed ? 'none' : gst?.inclusive ? 'included' : 'added',
    totalInr: bill.total_inr,
  };
}

/**
 * The price as one line. GST added on top: "5 × ₹120 = ₹600 + ₹30 GST = ₹630".
 * GST already inside: "5 × ₹120 = ₹600 (includes ₹29 GST)". None (an exempt plan, or a
 * store that charges none): "5 × ₹120 = ₹600".
 */
export function ritualPriceLine(q: RitualPriceQuote): string {
  const base = `${q.cups} × ₹${q.cupPriceInr} = ₹${q.subtotalInr}`;
  if (q.gst === 'added') return `${base} + ₹${q.gstInr} GST = ₹${q.totalInr}`;
  if (q.gst === 'included') return `${base} (includes ₹${q.gstInr} GST)`;
  return base;
}

/**
 * What a cup works out to against the drink's own price: "About ₹86 a cup
 * instead of ₹120". null when the plan gives no free cup (nothing to say) or the
 * sum does not come out cheaper.
 */
export function ritualPerCupLine(
  plan: Pick<CoffeePassPlan, 'drinks_paid' | 'drinks_total'>,
  cupPriceInr: number,
): string | null {
  if (!(plan.drinks_total > plan.drinks_paid) || plan.drinks_total <= 0) return null;
  const perCup = Math.round(ritualPriceFor(plan, cupPriceInr) / plan.drinks_total);
  return perCup < cupPriceInr ? `About ₹${perCup} a cup instead of ₹${cupPriceInr}` : null;
}

// ---------------------------------------------------------------------------
// A pass and its drink (CP-D25)
// ---------------------------------------------------------------------------

/**
 * A pass's title: "Weekly Ritual · Cappuccino · Large". A pass from before
 * per-drink pricing, or one whose drink was deleted, has no drink label and reads
 * as its plan's name.
 */
export function passTitle(pass: Pick<PassSummary, 'plan_name' | 'drink_label'>): string {
  const label = (pass.drink_label ?? '').trim();
  return label ? `${pass.plan_name} · ${label}` : pass.plan_name;
}

/** "Each cup covers up to ₹120", or '' when the pass has no cup value on record. */
export function passCoverLine(pass: Pick<PassSummary, 'drink_value_inr'>): string {
  return pass.drink_value_inr > 0 ? `Each cup covers up to ₹${pass.drink_value_inr}` : '';
}
