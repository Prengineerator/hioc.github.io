// Phase 7 · SUG-3 — the hard filter (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.2).
//
// This is the ONLY thing standing between a customer's explicit ask and an
// unavailable/over-budget/wrong-temperature/caffeinated item — it must hold
// 100% of the time (§0 DoD, §6.1). Nothing here is a model call; every rule
// is deterministic and covered by the exhaustive hard-constraint suite in
// tests/suggestFilter.test.ts.
//
// Pure: no Supabase, no 'server-only'.

import { isMenuItemAvailable } from '@/lib/menu/availability';
import type { MenuItem } from '@/lib/types';
import type { Budget, BasePref, MenuItemTraits, RelaxHint, SuggestInputs, TemperaturePref } from './types';

/** Cheapest variant price (§5.2.4). An item with no variants can never be
 * confirmed affordable, so it prices as +Infinity rather than 0 — failing
 * every budget check instead of silently passing one (fail closed, not
 * open; mirrors the F1 "no traits row = never a candidate" posture). */
export function minPriceInr(item: Pick<MenuItem, 'variants'>): number {
  if (!item.variants || item.variants.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...item.variants.map((v) => v.price_inr));
}

/**
 * §5.2, all six rules. `traits` is `undefined` when the item has no traits
 * row at all — rule 1 — which is why this takes `MenuItemTraits | undefined`
 * rather than requiring a Candidate: it also gets reused directly by
 * lib/suggest/profile.ts's `pickUsual` to re-check a "usual" item against
 * today's inputs.
 */
export function passesHardConstraints(
  item: MenuItem,
  traits: MenuItemTraits | undefined,
  inputs: SuggestInputs,
  excludeIds: string[],
): boolean {
  // §5.2.1 — no traits row, or not currently orderable: never a candidate.
  if (!traits) return false;
  if (!isMenuItemAvailable(item)) return false;

  // §5.2.6 — already shown in this refine chain.
  if (excludeIds.includes(item.id)) return false;

  // §5.2.2b — composition: food only leaks into a "help me choose" answer
  // when the customer actually asked to eat (root cause: production sessions
  // were shown food/dessert for plain drink requests). 'eat'/'filling' admit
  // food; 'eat'/'sweet'/'filling' or a celebrating mood admit dessert.
  // Neither 'chocolatey' nor 'fruity' admits food/dessert on their own —
  // they're soft flavour steers (§5.3), not a reason to serve cake instead
  // of a drink.
  if (traits.kind === 'food' && !(inputs.extras.includes('eat') || inputs.extras.includes('filling'))) {
    return false;
  }
  if (
    traits.kind === 'dessert' &&
    !(
      inputs.extras.includes('eat') ||
      inputs.extras.includes('sweet') ||
      inputs.extras.includes('filling') ||
      inputs.mood === 'celebrate'
    )
  ) {
    return false;
  }

  // §5.2.2 — temperature. DRINKS ONLY: a hot food item (garlic bread, say)
  // must never be excluded just because the customer wants an iced drink —
  // temperature is a drink-serving concept, not a food one. 'either' (served
  // either way) drinks satisfy both Hot and Iced chip values by not equalling
  // the excluded temperature; food/dessert are exempt outright.
  if (traits.kind === 'drink') {
    if (inputs.temperature === 'hot' && traits.temperature === 'iced') return false;
    if (inputs.temperature === 'iced' && traits.temperature === 'hot') return false;
  }

  // §5.2.3 — base + caffeine need. "Coffee" only restricts drinks; food and
  // dessert pass regardless of is_coffee, per the spec text verbatim.
  if (inputs.base === 'no_coffee' && traits.is_coffee) return false;
  if (inputs.base === 'coffee' && traits.kind === 'drink' && !traits.is_coffee) return false;
  if (inputs.needs.includes('no_caffeine') && traits.caffeine !== 'none') return false;

  // §5.2.5 — less sugar excludes the top sweetness band only.
  if (inputs.needs.includes('less_sugar') && traits.sweetness === 3) return false;

  // §5.2.4 — budget, cheapest variant. 'treat' and 'any' both mean no cap.
  const price = minPriceInr(item);
  if (inputs.budget === 'under_150' && price > 150) return false;
  if (inputs.budget === '150_300' && (price < 150 || price > 300)) return false;

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
// §5.2 last paragraph — "the response carries relaxHint naming the single
// constraint whose removal adds the most candidates (budget first, then
// temperature, then extras)". RELAX_ORDER below only ever names one of the
// customer's own chips (budget/temperature/base/needs) — never a derived
// rule the customer didn't directly set. In particular: 'extras' (sweet/eat/
// light/filling/chocolatey/fruity) and mood now also gate composition
// (food/dessert eligibility, above) so they CAN be part of why a request is
// short — but they're deliberately never offered as a relaxHint. Turning off
// "less sugar" or "no caffeine" is a sensible thing to offer; silently
// turning ON "Something to eat" the customer never asked for is not — that
// would put food in front of someone who explicitly wants a drink, exactly
// the bug this composition rule exists to fix. So only budget, temperature,
// base and needs — real, offerable customer choices — can ever be named.
// Order given by this ticket's assignment (which reconciles that note):
// budget, temperature, base, needs — used both as the relaxation order and
// as the tie-break when two relaxations would add the same number of
// candidates.
// ---------------------------------------------------------------------------

type RelaxableConstraint = 'budget' | 'temperature' | 'base' | 'needs';

const RELAX_ORDER: RelaxableConstraint[] = ['budget', 'temperature', 'base', 'needs'];

/** True when this chip is currently doing something a relax could undo. */
function isRestrictive(constraint: RelaxableConstraint, inputs: SuggestInputs): boolean {
  switch (constraint) {
    case 'budget':
      return inputs.budget === 'under_150' || inputs.budget === '150_300';
    case 'temperature':
      return inputs.temperature !== 'either';
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
    case 'base':
      return { ...inputs, base: 'either' as BasePref };
    case 'needs':
      return { ...inputs, needs: [] };
  }
}

function budgetLabel(budget: Budget): string {
  if (budget === 'under_150') return '₹150';
  if (budget === '150_300') return '₹150–300';
  return 'your budget';
}

/** Best-effort natural-language fragment for the currently-set temperature +
 * base, used to make the budget relax message read naturally, e.g. "Nothing
 * iced under ₹150 right now…" (§5.2's own example). */
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
      const under = budgetLabel(inputs.budget);
      return descriptor
        ? `Nothing ${descriptor} under ${under} right now — shall we look a little wider?`
        : `Nothing quite fits under ${under} right now — shall we look a little wider?`;
    }
    case 'temperature':
      return inputs.temperature === 'hot'
        ? "We're short on hot options that fit everything else — want to see iced too?"
        : "We're short on iced options that fit everything else — want to see hot too?";
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
