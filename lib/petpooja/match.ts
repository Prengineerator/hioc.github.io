import type { MenuSnapshotItem } from './types';
import { ITEM_ALIASES } from './aliases';

// Matches a legacy bill line's item name + variant label to the live menu.
// Deliberately conservative: only the rules below are ever applied, in this
// order, and a wrong match is worse than an unmatched item — no fuzzy /
// distance-based matching. See aliases.ts for how ITEM_ALIASES was built.

const WAFFLE_SUFFIX = ' waffle';

/** lowercase; turn ’/'/-/+/./` into spaces; collapse whitespace; trim. Both
 * sides of every comparison go through this, so quote-character drift
 * between the POS export and the menu snapshot (curly vs straight
 * apostrophe) and stray hyphenation never block an otherwise-exact match. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’'\-+.`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findVariant(
  item: MenuSnapshotItem,
  variantLabel: string,
): { id?: string; label: string } | undefined {
  const wanted = variantLabel.trim().toLowerCase();
  if (wanted) {
    return item.variants.find((v) => v.label.trim().toLowerCase() === wanted);
  }
  // Petpooja recorded no variant at all — safe to assume the item's only
  // variant when there is exactly one; otherwise we can't guess which.
  return item.variants.length === 1 ? item.variants[0] : undefined;
}

export function matchMenuItem(
  itemName: string,
  variantLabel: string,
  menu: MenuSnapshotItem[],
): { menu_item_id: string | null; variant_id: string | null; matched_menu_name: string | null } {
  const byNorm = new Map<string, MenuSnapshotItem>();
  for (const item of menu) {
    byNorm.set(normalize(item.name), item);
  }

  const n = normalize(itemName);

  let match = byNorm.get(n);

  if (!match) {
    const aliasTarget = ITEM_ALIASES[n];
    if (aliasTarget) match = byNorm.get(normalize(aliasTarget));
  }

  if (!match && n.endsWith(WAFFLE_SUFFIX)) {
    match = byNorm.get(n.slice(0, -WAFFLE_SUFFIX.length));
  }

  if (!match) {
    if (n.endsWith('s')) match = byNorm.get(n.slice(0, -1));
    if (!match) match = byNorm.get(`${n}s`);
  }

  if (!match) {
    return { menu_item_id: null, variant_id: null, matched_menu_name: null };
  }

  const variant = findVariant(match, variantLabel);

  return {
    menu_item_id: match.id ?? null,
    variant_id: variant?.id ?? null,
    matched_menu_name: match.name,
  };
}
