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
// corrected value. Only this one contradiction is corrected: a row that says
// `hot` under a name that says "Iced". "Hot" in a name is not trusted the other
// way round (it also appears in names of things that are not a serving style),
// and a drink tagged `either` is left alone.
//
// Pure: no Supabase, no 'server-only'.

import type { MenuItem } from '@/lib/types';
import type { MenuItemTraits } from './types';

// "Iced" as a word of its own: at the start or after a space or bracket, and
// followed by the end, a space or a bracket. Not "Spiced", not "Un-iced".
const SAYS_ICED = /(?:^|[\s(])iced(?:$|[\s)])/i;
const SAYS_HOT = /(?:^|[\s(/])hot(?:$|[\s)/])/i;

/**
 * True when the row says `hot` and the name says "Iced" (and does not also say
 * "Hot"). Only that exact contradiction is corrected: a drink tagged `either`
 * is served both ways and must stay available for a hot request, and a name
 * like "Americano (Hot/Iced)" says both.
 */
export function isMistaggedIced(item: Pick<MenuItem, 'name'>, traits: Pick<MenuItemTraits, 'kind' | 'temperature'>): boolean {
  const name = item.name ?? '';
  return traits.kind === 'drink' && traits.temperature === 'hot' && SAYS_ICED.test(name) && !SAYS_HOT.test(name);
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
