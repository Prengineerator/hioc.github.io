// Sell by weight (supabase/2026-10-sell-by-weight.sql): coffee beans sold by
// the gram. Pure helpers shared by the server pricing (lib/orders/lines.ts),
// the customer and POS customise modals, the cart and every order display, so
// the price a customer sees and the price the server charges come from ONE
// formula and cannot drift.
//
// A sold-by-weight item's variant price is the price PER KG. A line carries
// `weight_grams` — the grams in one unit (one bag) — and its unit price is
// that weight's share of the per-kg price, rounded to the rupee, plus add-ons.

import type { MenuItem } from '@/lib/types';

/** Smallest and largest bag the menu and the API accept, in grams. */
export const WEIGHT_MIN_GRAMS = 10;
export const WEIGHT_MAX_GRAMS = 10_000;

/** One-tap weights offered in the customise modals. Any whole number of grams
 * in range can also be typed. */
export const WEIGHT_PRESETS_GRAMS: readonly number[] = [100, 250, 500, 1000];

/** The weight a customise modal opens on. */
export const DEFAULT_WEIGHT_GRAMS = 250;

/** Is this item priced per kg and sold by the gram? Absent (a row read before
 * the migration) = no. */
export function isSoldByWeight(item: Pick<MenuItem, 'sold_by_weight'>): boolean {
  return item.sold_by_weight === true;
}

/** A valid weight in grams: a whole number in [WEIGHT_MIN_GRAMS,
 * WEIGHT_MAX_GRAMS]. */
export function isValidWeightGrams(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= WEIGHT_MIN_GRAMS &&
    value <= WEIGHT_MAX_GRAMS
  );
}

/** Parses what a person typed into the grams box; null when it isn't a valid
 * weight. */
export function parseWeightInput(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const grams = Number(trimmed);
  return isValidWeightGrams(grams) ? grams : null;
}

/** What `grams` cost at `pricePerKgInr`, rounded to the nearest rupee:
 * 250 g at ₹2400/kg = ₹600. Integer maths up to the one division. */
export function weightPriceInr(pricePerKgInr: number, grams: number): number {
  return Math.round((pricePerKgInr * grams) / 1000);
}

/** "250 g", "1 kg", "1500 g". Whole kilos read as kilos; anything else stays
 * in grams — the unit the scale shows. */
export function formatWeight(grams: number): string {
  if (grams >= 1000 && grams % 1000 === 0) return `${grams / 1000} kg`;
  return `${grams} g`;
}

/** "₹2400/kg" — how a per-kg price is shown on menus and in the editor. */
export function formatPerKg(pricePerKgInr: number): string {
  return `₹${pricePerKgInr}/kg`;
}

/** Labels that mean "no real choice of size" and add nothing beside a weight. */
const PLAIN_LABEL_RE = /^(regular|standard|default)$/i;

/**
 * The size text shown for an order or cart line. A by-the-unit line shows its
 * variant label exactly as before. A weighed line shows the weight, after the
 * variant label when that says something ("Ground · 250 g"), alone when the
 * label is a placeholder like "Regular" ("250 g").
 */
export function lineSizeLabel(variantLabel: string | null | undefined, weightGrams?: number | null): string {
  const label = (variantLabel ?? '').trim();
  if (weightGrams == null) return label;
  const weight = formatWeight(weightGrams);
  return label && !PLAIN_LABEL_RE.test(label) ? `${label} · ${weight}` : weight;
}

/** lineSizeLabel in brackets after an item name — " (Large)", " (250 g)" — or
 * '' when there is no size to show. */
export function lineSizeSuffix(variantLabel: string | null | undefined, weightGrams?: number | null): string {
  const size = lineSizeLabel(variantLabel, weightGrams);
  return size ? ` (${size})` : '';
}

/** A line's price before add-ons: the variant's price, or — for a weighed line
 * — that weight's share of the variant's per-kg price. */
export function basePriceInr(variantPriceInr: number, weightGrams?: number | null): number {
  return weightGrams == null ? variantPriceInr : weightPriceInr(variantPriceInr, weightGrams);
}

export type RepeatWeight = { ok: true; weightGrams: number | null } | { ok: false; reason: string };

/**
 * Repeating a past line on today's menu (website "Order again", POS "Repeat"):
 * the grams the new line carries, or why it can't be repeated as ordered. A
 * weighed line keeps its weight. A line from before the item changed how it is
 * sold is skipped, not guessed — there is no weight to give a unit line, and a
 * weight means nothing on a unit item.
 */
export function repeatWeight(
  item: Pick<MenuItem, 'sold_by_weight'>,
  pastWeightGrams: number | null | undefined,
): RepeatWeight {
  const past = pastWeightGrams ?? null;
  if (isSoldByWeight(item)) {
    return past !== null && isValidWeightGrams(past)
      ? { ok: true, weightGrams: past }
      : { ok: false, reason: 'Now sold by weight — add it from the menu' };
  }
  return past === null
    ? { ok: true, weightGrams: null }
    : { ok: false, reason: 'No longer sold by weight — add it from the menu' };
}

/** What the menu API answers when an item is switched to sold by weight before
 * the database has the column for it. */
export const SELL_BY_WEIGHT_MIGRATION_HINT =
  'Selling by weight needs a database update first: run supabase/2026-10-sell-by-weight.sql in the Supabase SQL editor, then save again.';
