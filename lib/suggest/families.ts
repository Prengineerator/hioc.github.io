// Coffey — which flavour families an item belongs to. Split out of flavor.ts so
// addonTraits.ts (which needs it) and flavor.ts (which needs addonTraits for the
// "made your way" counts) do not import each other.
//
// Pure: no Supabase, no 'server-only'.

import { FLAVOUR_FAMILIES, type FlavourFamily } from './types';
import { FLAVOUR_FAMILY_INFO } from './traitVocabulary';

/**
 * Every flavour family the item belongs to, in FLAVOUR_FAMILIES order. A
 * family matches when its pattern matches the item's NAME or any flavour note
 * — the patterns are written to work on both the fixed v2 note vocabulary and
 * the free-text notes older rows carry, so this is safe on either.
 *
 * An item can belong to several ("Oreo Creme" is chocolatey and biscuit), which
 * is what makes the customer's OR semantics (§1: "an item matches if it has
 * **any** picked family") work.
 */
export function flavourFamiliesOf(name: string, flavorNotes: readonly string[]): FlavourFamily[] {
  const texts = [name, ...(flavorNotes ?? [])];
  return FLAVOUR_FAMILIES.filter((family) => {
    const { pattern } = FLAVOUR_FAMILY_INFO[family];
    return texts.some((text) => pattern.test(text));
  });
}
