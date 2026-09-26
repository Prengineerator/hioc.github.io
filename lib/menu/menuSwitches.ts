// Menu switches (POS → Menu → Switches): parts of the menu turned off for now,
// without deleting anything. Switching back on restores them exactly.
//
//   categories  store_settings.hidden_categories — the whole category is off
//   sizes       store_settings.hidden_variant_labels — e.g. "Extra Large",
//               matched by size NAME (not variant id: editing an item
//               re-creates its variants, and one switch covers every drink)
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

export function isHiddenSize(label: string, hidden: readonly string[] | null | undefined): boolean {
  if (!hidden || hidden.length === 0) return false;
  const key = norm(label);
  return hidden.some((h) => norm(h) === key);
}

/** The item with its hidden sizes removed (unchanged if that would leave none). */
export function withoutHiddenSizes<T extends Pick<MenuItem, 'variants'>>(
  item: T,
  hidden: readonly string[] | null | undefined,
): T {
  if (!hidden || hidden.length === 0) return item;
  const variants = item.variants.filter((v) => !isHiddenSize(v.label, hidden));
  if (variants.length === 0 || variants.length === item.variants.length) return item;
  return { ...item, variants };
}

/** Every size name on the menu, most-used first — the switches the owner sees. */
export function sizeLabels(items: Pick<MenuItem, 'variants'>[]): { label: string; count: number }[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const item of items) {
    for (const v of item.variants) {
      const key = norm(v.label);
      const entry = counts.get(key) ?? { label: v.label.trim(), count: 0 };
      entry.count += 1;
      counts.set(key, entry);
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Validates a PATCH value: a short list of short size names. */
export function parseHiddenSizes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 30) return null;
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    if (!t || t.length > 40) return null;
    if (!out.some((o) => norm(o) === norm(t))) out.push(t);
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
export function applyMenuSwitches<T extends Pick<MenuItem, 'variants' | 'addon_groups'>>(
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
