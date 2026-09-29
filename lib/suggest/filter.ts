// Phase 7 · SUG-3 — the hard filter (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.2,
// as amended by docs/COFFEY-SPEC.md §4.1).
//
// This is the ONLY thing standing between a customer's explicit ask and an
// unavailable/over-budget/wrong-temperature/caffeinated/too-sweet item — it
// must hold 100% of the time (§0 DoD, §6.1). Nothing here is a model call;
// every rule is deterministic and covered by the exhaustive hard-constraint
// suite in tests/suggestFilter.test.ts.
//
// Pure: no Supabase, no 'server-only'.

import { isMenuItemAvailable } from '@/lib/menu/availability';
import type { MenuItem } from '@/lib/types';
import { sweetnessLevel, sweetnessTarget } from './sweetness';
import type {
  Budget,
  BasePref,
  MenuItemTraits,
  RelaxHint,
  SuggestInputs,
  SweetnessPref,
  TemperaturePref,
} from './types';
import { BUDGET_CAPS, SWEETNESS_SCALE } from './types';

/** Cheapest variant price (§5.2.4). An item with no variants can never be
 * confirmed affordable, so it prices as +Infinity rather than 0 — failing
 * every budget check instead of silently passing one (fail closed, not
 * open; mirrors the F1 "no traits row = never a candidate" posture). */
export function minPriceInr(item: Pick<MenuItem, 'variants'>): number {
  if (!item.variants || item.variants.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...item.variants.map((v) => v.price_inr));
}

/**
 * COFFEY-SPEC §4.1, all six rules. `traits` is `undefined` when the item has
 * no traits row at all — rule 1 — which is why this takes `MenuItemTraits |
 * undefined` rather than requiring a Candidate: it also gets reused directly by
 * lib/suggest/profile.ts's `pickUsual` to re-check a "usual" item against
 * today's inputs.
 */
export function passesHardConstraints(
  item: MenuItem,
  traits: MenuItemTraits | undefined,
  inputs: SuggestInputs,
  excludeIds: string[],
): boolean {
  // §4.1.1 — no traits row, or not currently orderable: never a candidate.
  if (!traits) return false;
  if (!isMenuItemAvailable(item)) return false;

  // Already shown in this refine chain.
  if (excludeIds.includes(item.id)) return false;

  // §4.1.2 — composition. The customer says what they want ("a drink", "something
  // sweet to eat", "something savoury"); an item is a candidate only when its kind
  // is one of them. This replaces v1's eat/sweet/filling/celebrate rule, which now
  // lives only in upgradeV1Inputs (root cause of the production sessions that were
  // shown food/dessert for plain drink requests). A flavour steer or a mood never
  // admits a kind on its own.
  if (!inputs.kinds.includes(traits.kind)) return false;

  // §4.1.3 — temperature. DRINKS ONLY: a hot food item (garlic bread, say)
  // must never be excluded just because the customer wants an iced drink —
  // temperature is a drink-serving concept, not a food one. 'either' (served
  // either way) drinks satisfy both Hot and Iced chip values by not equalling
  // the excluded temperature; food/dessert are exempt outright.
  if (traits.kind === 'drink') {
    if (inputs.temperature === 'hot' && traits.temperature === 'iced') return false;
    if (inputs.temperature === 'iced' && traits.temperature === 'hot') return false;
  }

  // §4.1.4 — base + caffeine need. "Coffee" only restricts drinks; food and
  // dessert pass regardless of is_coffee, per the spec text verbatim.
  if (inputs.base === 'no_coffee' && traits.is_coffee) return false;
  if (inputs.base === 'coffee' && traits.kind === 'drink' && !traits.is_coffee) return false;
  if (inputs.needs.includes('no_caffeine') && traits.caffeine !== 'none') return false;

  // §4.1.5 — the sweetness ceiling. The item's INHERENT sweetness can be raised
  // by optional table sugar but never lowered, so the only thing the customer's
  // choice rules out is an item already sweeter than they want by more than the
  // tolerance. Legacy rows read through sweetnessLevel() (0→0, 1→3, 2→6, 3→9),
  // which reproduces v1's "less sugar excludes sweetness 3" exactly.
  const target = sweetnessTarget(inputs.sweetness);
  if (target !== null && sweetnessLevel(traits) > target + SWEETNESS_SCALE.tolerance) return false;

  // §4.1.6 — budget: a CEILING on the cheapest size (BUDGET_CAPS; 'any' has no
  // cap). v1's "₹150–₹300" was a band that hid every item under ₹150; a ceiling
  // never does. An item with no priced size can't be confirmed affordable, so it
  // prices as +Infinity and fails every ceiling (minPriceInr).
  const cap = BUDGET_CAPS[inputs.budget];
  if (cap !== null && minPriceInr(item) > cap) return false;

  return true;
}

/** An item paired with its (guaranteed-present) traits row, post-filter. */
export interface FilteredCandidate {
  item: MenuItem;
  traits: MenuItemTraits;
}

export function filterCandidates(
  items: MenuItem[],
  traitsById: Map<string, MenuItemTraits>,
  inputs: SuggestInputs,
  excludeIds: string[],
): FilteredCandidate[] {
  const out: FilteredCandidate[] = [];
  for (const item of items) {
    const traits = traitsById.get(item.id);
    if (passesHardConstraints(item, traits, inputs, excludeIds)) {
      // traits is defined here — passesHardConstraints returned false above otherwise.
      out.push({ item, traits: traits as MenuItemTraits });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// §5.2 last paragraph, as amended by COFFEY-SPEC §4.1 — "the response carries
// relaxHint naming the single constraint whose removal adds the most
// candidates". RELAX_ORDER below only ever names one of the customer's own
// choices — budget, temperature, sweetness, base, needs — never a derived rule
// the customer didn't directly set. In particular `kinds` (what they want to
// have: a drink, something sweet, something savoury) is deliberately NEVER
// offered: silently turning ON food the customer never asked for is exactly the
// v1 bug the composition rule exists to fix. Turning off "no caffeine" or
// letting the sweetness ceiling go is a sensible thing to offer; adding a kind
// is not.
//
// Order: budget, temperature, sweetness, base, needs — used both as the
// relaxation order and as the tie-break when two relaxations would add the same
// number of candidates.
// ---------------------------------------------------------------------------

type RelaxableConstraint = 'budget' | 'temperature' | 'sweetness' | 'base' | 'needs';

const RELAX_ORDER: RelaxableConstraint[] = ['budget', 'temperature', 'sweetness', 'base', 'needs'];

/** True when this choice is currently doing something a relax could undo. */
function isRestrictive(constraint: RelaxableConstraint, inputs: SuggestInputs): boolean {
  switch (constraint) {
    case 'budget':
      return BUDGET_CAPS[inputs.budget] !== null;
    case 'temperature':
      return inputs.temperature !== 'either';
    case 'sweetness': {
      // Anything but 'any' — with one honest exception: 'sweet' and 'very' set a
      // ceiling (target + tolerance) at or above the top of the scale, so they can
      // never exclude an item. Offering to relax a choice that is excluding
      // nothing would blame the wrong constraint for a short list.
      const target = sweetnessTarget(inputs.sweetness);
      return target !== null && target + SWEETNESS_SCALE.tolerance < SWEETNESS_SCALE.max;
    }
    case 'base':
      return inputs.base !== 'either';
    case 'needs':
      return inputs.needs.length > 0;
  }
}

function relax(constraint: RelaxableConstraint, inputs: SuggestInputs): SuggestInputs {
  switch (constraint) {
    case 'budget':
      return { ...inputs, budget: 'any' as Budget };
    case 'temperature':
      return { ...inputs, temperature: 'either' as TemperaturePref };
    case 'sweetness':
      return { ...inputs, sweetness: 'any' as SweetnessPref };
    case 'base':
      return { ...inputs, base: 'either' as BasePref };
    case 'needs':
      return { ...inputs, needs: [] };
  }
}

/** "up to ₹150" — the customer's own ceiling, in the words the budget chips use. */
function budgetLabel(budget: Budget): string {
  const cap = BUDGET_CAPS[budget];
  return cap === null ? 'your budget' : `up to ₹${cap}`;
}

/** Best-effort natural-language fragment for the currently-set temperature +
 * base, used to make the budget relax message read naturally, e.g. "Nothing
 * iced up to ₹150 right now…" (§5.2's own example, reworded for ceilings). */
function describeTemperatureAndBase(inputs: SuggestInputs): string {
  const bits: string[] = [];
  if (inputs.temperature !== 'either') bits.push(inputs.temperature);
  if (inputs.base === 'coffee') bits.push('coffee');
  if (inputs.base === 'no_coffee') bits.push('non-coffee');
  return bits.join(' ');
}

function messageFor(constraint: RelaxableConstraint, inputs: SuggestInputs): string {
  switch (constraint) {
    case 'budget': {
      const descriptor = describeTemperatureAndBase(inputs);
      const within = budgetLabel(inputs.budget);
      return descriptor
        ? `Nothing ${descriptor} ${within} right now — shall we look a little wider?`
        : `Nothing quite fits ${within} right now — shall we look a little wider?`;
    }
    case 'temperature':
      return inputs.temperature === 'hot'
        ? "We're short on hot options that fit everything else — want to see iced too?"
        : "We're short on iced options that fit everything else — want to see hot too?";
    case 'sweetness':
      return 'Nothing quite that light on sugar fits right now — want to see a little sweeter options?';
    case 'base':
      return inputs.base === 'coffee'
        ? "We're short on coffee options that fit everything else — want to see non-coffee picks too?"
        : "We're short on non-coffee options that fit everything else — want to see coffee picks too?";
    case 'needs':
      return "Nothing quite fits all of that right now — want to see a few more options?";
  }
}

/**
 * §5.2 — when fewer than 3 candidates pass the filter, name the single
 * constraint whose removal would add the most candidates (ties broken by
 * RELAX_ORDER). Returns null once there are ≥3 candidates, or when nothing
 * is currently restrictive (the shortage is inherent to the menu itself,
 * e.g. too few available items have traits rows — relaxing a chip that's
 * already at its most permissive value would be a no-op and a misleading
 * thing to offer).
 */
export function relaxHintFor(
  items: MenuItem[],
  traitsById: Map<string, MenuItemTraits>,
  inputs: SuggestInputs,
  excludeIds: string[],
): RelaxHint | null {
  const baseline = filterCandidates(items, traitsById, inputs, excludeIds).length;
  if (baseline >= 3) return null;

  let best: { constraint: RelaxableConstraint; gain: number } | null = null;
  for (const constraint of RELAX_ORDER) {
    if (!isRestrictive(constraint, inputs)) continue;
    const relaxedInputs = relax(constraint, inputs);
    const count = filterCandidates(items, traitsById, relaxedInputs, excludeIds).length;
    const gain = count - baseline;
    if (!best || gain > best.gain) {
      best = { constraint, gain };
    }
  }

  if (!best) return null;
  return { constraint: best.constraint, message: messageFor(best.constraint, inputs) };
}
