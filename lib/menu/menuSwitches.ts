// Menu switches (POS → Menu → Switches): parts of the menu turned off for now,
// without deleting anything. Switching back on restores them exactly.
//
//   categories  store_settings.hidden_categories — the whole category is off
//   sizes       store_settings.hidden_variant_labels — e.g. "Extra Large",
//               matched by size NAME (not variant id: editing an item
//               re-creates its variants, and one switch covers every drink),
//               everywhere or per category ("Extra Large|Iced Coffee")
//   add-ons     addon_options.is_available — e.g. out of oat milk
//
// Whatever is off is left off the customer menu, the table QR and the POS, and
// the server refuses an order for it (lib/orders/lines.ts). Two safety rules:
// an item whose ONLY sizes are hidden keeps them, and an add-on group with
// every option off is dropped — a switch must never make an item impossible
// to order through a required choice with nothing left to choose.

import type { MenuItem } from '@/lib/types';

export interface MenuSwitches {
  hiddenCategories?: readonly string[] | null;
  hiddenSizes?: readonly string[] | null;
}

const norm = (label: string) => label.trim().toLowerCase();

// A size switch is stored as the size name ("Extra Large" — off everywhere)
// or the name and one category ("Extra Large|Iced Coffee" — off only there,
// e.g. out of large cold glasses but not hot cups).
const SCOPE = '|';

export function sizeEntry(label: string, category?: string | null): string {
  return category ? `${label.trim()}${SCOPE}${category}` : label.trim();
}

export function parseSizeEntry(entry: string): { label: string; category: string | null } {
  const at = entry.indexOf(SCOPE);
  if (at < 0) return { label: entry.trim(), category: null };
  return { label: entry.slice(0, at).trim(), category: entry.slice(at + 1).trim() || null };
}

/** Is this size off — everywhere, or (given a category) in that category? */
export function isHiddenSize(
  label: string,
  hidden: readonly string[] | null | undefined,
  category?: string | null,
): boolean {
  if (!hidden || hidden.length === 0) return false;
  const key = norm(label);
  return hidden.some((h) => {
    const e = parseSizeEntry(h);
    return norm(e.label) === key && (e.category === null || e.category === category);
  });
}

/** Is this size switched off everywhere (not just in some categories)? */
export function isSizeOffEverywhere(label: string, hidden: readonly string[] | null | undefined): boolean {
  return isHiddenSize(label, (hidden ?? []).filter((h) => parseSizeEntry(h).category === null));
}

/** The item with its hidden sizes removed (unchanged if that would leave none). */
export function withoutHiddenSizes<T extends Pick<MenuItem, 'variants'> & { category?: string }>(
  item: T,
  hidden: readonly string[] | null | undefined,
): T {
  if (!hidden || hidden.length === 0) return item;
  const variants = item.variants.filter((v) => !isHiddenSize(v.label, hidden, item.category));
  if (variants.length === 0 || variants.length === item.variants.length) return item;
  return { ...item, variants };
}

export interface SizeUsage {
  label: string;
  count: number;
  /** Categories that have this size, most items first. */
  categories: { slug: string; count: number }[];
}

/** Every size name on the menu, most-used first — the switches the owner sees. */
export function sizeLabels(items: (Pick<MenuItem, 'variants'> & { category?: string })[]): SizeUsage[] {
  const bySize = new Map<string, { label: string; count: number; cats: Map<string, number> }>();
  for (const item of items) {
    for (const v of item.variants) {
      const key = norm(v.label);
      const entry = bySize.get(key) ?? { label: v.label.trim(), count: 0, cats: new Map<string, number>() };
      entry.count += 1;
      if (item.category) entry.cats.set(item.category, (entry.cats.get(item.category) ?? 0) + 1);
      bySize.set(key, entry);
    }
  }
  return [...bySize.values()]
    .map(({ label, count, cats }) => ({
      label,
      count,
      categories: [...cats.entries()]
        .map(([slug, n]) => ({ slug, count: n }))
        .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug)),
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/**
 * The hidden-sizes list after switching one size on or off — everywhere
 * (category null) or in one category. Switching a size back on everywhere
 * also clears its per-category switches, so "on" means on.
 */
export function toggleSizeEntry(
  hidden: readonly string[],
  label: string,
  category: string | null,
  on: boolean,
): string[] {
  const key = norm(label);
  const sameSize = (h: string) => norm(parseSizeEntry(h).label) === key;
  if (category === null) {
    const others = hidden.filter((h) => !sameSize(h));
    if (on) return others;
    return [...hidden.filter((h) => !(sameSize(h) && parseSizeEntry(h).category === null)), sizeEntry(label)];
  }
  const rest = hidden.filter((h) => !(sameSize(h) && parseSizeEntry(h).category === category));
  return on ? rest : [...rest, sizeEntry(label, category)];
}

/**
 * Validates a PATCH value: a short list of size switches ("Name" or
 * "Name|Category", the category one of `knownCategories`).
 */
export function parseHiddenSizes(value: unknown, knownCategories?: readonly string[]): string[] | null {
  if (!Array.isArray(value) || value.length > 60) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') return null;
    const { label, category } = parseSizeEntry(v);
    if (!label || label.length > 40) return null;
    if (category !== null && knownCategories && !knownCategories.includes(category)) return null;
    const entry = sizeEntry(label, category);
    const dup = out.some((o) => {
      const e = parseSizeEntry(o);
      return norm(e.label) === norm(label) && e.category === category;
    });
    if (!dup) out.push(entry);
  }
  return out;
}

export function isCategoryHidden(category: string, hidden: readonly string[] | null | undefined): boolean {
  return Boolean(hidden && hidden.includes(category));
}

/** The item without its switched-off add-on options (and groups left empty). */
export function withoutOffAddons<T extends Pick<MenuItem, 'addon_groups'>>(item: T): T {
  const anyOff = item.addon_groups.some((g) => g.options.some((o) => o.is_available === false));
  if (!anyOff) return item;
  const addon_groups = item.addon_groups
    .map((g) => ({ ...g, options: g.options.filter((o) => o.is_available !== false) }))
    .filter((g) => g.options.length > 0);
  return { ...item, addon_groups };
}

/** The item as customers and the POS see it: hidden sizes and off add-ons removed. */
export function applyMenuSwitches<T extends Pick<MenuItem, 'variants' | 'addon_groups'> & { category?: string }>(
  item: T,
  switches: MenuSwitches,
): T {
  return withoutOffAddons(withoutHiddenSizes(item, switches.hiddenSizes));
}

/** The switches as the store settings row holds them. */
export function switchesFromSettings(settings: {
  hidden_categories?: string[] | null;
  hidden_variant_labels?: string[] | null;
}): MenuSwitches {
  return { hiddenCategories: settings.hidden_categories ?? [], hiddenSizes: settings.hidden_variant_labels ?? [] };
}

/** Validates a PATCH value for hidden_categories: known category slugs only. */
export function parseHiddenCategories(value: unknown, known: readonly string[]): string[] | null {
  if (!Array.isArray(value) || value.length > known.length) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string' || !known.includes(v)) return null;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}
