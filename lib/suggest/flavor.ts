// Coffey v2 — flavour-family matching (docs/COFFEY-SPEC.md §1 "Flavours you
// love", §4.2 preference term, §4.4 similarity, §4.6 reasons and match tags).
//
// The step-2 chips are SOFT scoring preferences (lib/suggest/score.ts's
// preference term), never hard filters (lib/suggest/filter.ts) — a chocolatey
// request with no chocolate drink left over must still get good picks, just not
// a boosted score for this term. The families, their labels and the pattern
// each one matches live in lib/suggest/traitVocabulary.ts; this file only
// applies them.
//
// Pure: no Supabase, no 'server-only'.

import { isMenuItemAvailable } from '@/lib/menu/availability';
import type { MenuItem } from '@/lib/types';
import { reachableAddonFamilies } from './addonTraits';
import { flavourFamiliesOf } from './families';
import { FLAVOUR_FAMILIES, type AddonTraits, type FlavourCounts, type MenuItemTraits } from './types';

export { flavourFamiliesOf };

/**
 * COFFEY-SPEC §10, §11 — per kind, how many orderable, tagged items can be had
 * with each flavour family: the item carries it itself, or (drinks and desserts)
 * a reachable add-on can supply it within the price limit and the sweetness
 * guard ("Cappucino + Hazelnut syrup" counts as nutty). The wizard uses this to
 * offer only the flavour chips the menu can serve for the kinds the customer
 * ticked (FLAVOUR_OFFER_MIN): "Floral" is not offered to someone who only wants
 * something sweet to eat when no dessert can be floral.
 */
export function flavourCountsByKind(
  items: MenuItem[],
  traitsById: Map<string, MenuItemTraits>,
  overrides?: Map<string, AddonTraits>,
): FlavourCounts {
  const counts: FlavourCounts = { drink: {}, dessert: {}, food: {} };
  for (const item of items) {
    const traits = traitsById.get(item.id);
    if (!traits || !isMenuItemAvailable(item)) continue;
    const own = flavourFamiliesOf(item.name, traits.flavor_notes ?? []);
    for (const family of FLAVOUR_FAMILIES) {
      // Through an add-on only on a plain base (nothing of its own), the same
      // rule madeToOrder applies (lib/suggest/promises.ts).
      const viaAddon =
        traits.kind !== 'food' &&
        own.length === 0 &&
        reachableAddonFamilies(item, traits, { flavours: [family], sweetness: 'any' }, overrides).length > 0;
      if (own.includes(family) || viaAddon) counts[traits.kind][family] = (counts[traits.kind][family] ?? 0) + 1;
    }
  }
  return counts;
}
