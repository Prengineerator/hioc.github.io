// Coffey — a guard against one kind of tagging mistake that customers can see
// at a glance (docs/COFFEY-SPEC.md §11.5).
//
// The hard filter (lib/suggest/filter.ts) keeps a hot request away from iced
// drinks by reading `menu_item_traits.temperature`. That tag is written by a
// model and confirmed in bulk, and on the live menu (2026-11) "Tiramisu Latte
// Iced" was tagged `hot`, so it was offered to customers who asked for a hot
// drink. A name the customer can read always beats a tag they cannot: a drink
// whose own name says "Iced" is iced, whatever its row says.
//
// It is applied once, where items and traits are paired (runSuggest, menuFacets),
// so the filter, the score, the tags and the decider brief all read the same,
// corrected value. Only this one direction is corrected: "Iced" in a name is a
// serving style here, while "Hot" also appears in names of things that are not
// (a combo, a sauce).
//
// Pure: no Supabase, no 'server-only'.

import type { MenuItem } from '@/lib/types';
import type { MenuItemTraits } from './types';

const SAYS_ICED = /\biced\b/i;

/** True when the row's temperature contradicts a name that says "Iced". */
export function isMistaggedIced(item: Pick<MenuItem, 'name'>, traits: Pick<MenuItemTraits, 'kind' | 'temperature'>): boolean {
  return traits.kind === 'drink' && traits.temperature !== 'iced' && SAYS_ICED.test(item.name ?? '');
}

/**
 * The traits map with every such row corrected to `iced`. Returns the SAME map
 * when nothing needs correcting, so the common case costs one pass and no copy.
 */
export function guardTraits(
  items: readonly Pick<MenuItem, 'id' | 'name'>[],
  traitsById: Map<string, MenuItemTraits>,
): Map<string, MenuItemTraits> {
  let out: Map<string, MenuItemTraits> | null = null;
  for (const item of items) {
    const traits = traitsById.get(item.id);
    if (!traits || !isMistaggedIced(item, traits)) continue;
    out ??= new Map(traitsById);
    out.set(item.id, { ...traits, temperature: 'iced' });
  }
  return out ?? traitsById;
}
