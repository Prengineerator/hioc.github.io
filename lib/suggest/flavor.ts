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
