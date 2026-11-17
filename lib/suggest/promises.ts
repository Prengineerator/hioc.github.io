// Coffey — keeping the customer's choices (docs/COFFEY-SPEC.md, "honoured
// choices"). Four wizard choices (flavours, strength, sweetness, texture) used
// to be soft score terms, so picks routinely ignored them. Here they narrow the
// candidate pool BEFORE scoring whenever the menu can keep them, and
// `unmetChoices` says so honestly when a final pick does not.
//
// Pure: no Supabase, no 'server-only', no network.

import { flavourFamiliesOf } from './flavor';
import type { FilteredCandidate } from './filter';
import { INTENSITY_FROM_CAFFEINE } from './score';
import { deliveredSweetness, isSugarAdjustable } from './sugar';
import { sweetnessLevel, sweetnessTarget } from './sweetness';
import { HONOURED_CHOICES, PROMISE_MIN_POOL, SWEETNESS_BANDS } from './types';
import type { HonouredChoice, MenuItemTraits, SuggestInputs, TraitKind } from './types';

export interface ChoiceSubject {
  name: string;
  traits: MenuItemTraits;
  sugarAdjustable: boolean;
}

export function isChoiceSet(choice: HonouredChoice, inputs: SuggestInputs): boolean {
  switch (choice) {
    case 'flavours':
      return inputs.flavours.length > 0;
    case 'strength':
      return inputs.strength !== 'any';
    case 'sweetness':
      return inputs.sweetness !== 'any';
    case 'body':
      return inputs.body !== 'any';
  }
}

/** Strength is about coffee drinks; flavour and sweetness never apply to food;
 * texture applies to everything. */
export function choiceApplies(choice: HonouredChoice, kind: TraitKind): boolean {
  switch (choice) {
    case 'strength':
      return kind === 'drink';
    case 'flavours':
    case 'sweetness':
      return kind === 'drink' || kind === 'dessert';
    case 'body':
      return true;
  }
}

/** true / false when the choice is set and applies to the subject's kind; null
 * when it does not (so it can neither be kept nor broken). */
export function satisfiesChoice(choice: HonouredChoice, subject: ChoiceSubject, inputs: SuggestInputs): boolean | null {
  const { traits } = subject;
  if (!isChoiceSet(choice, inputs) || !choiceApplies(choice, traits.kind)) return null;

  switch (choice) {
    case 'flavours': {
      const families = flavourFamiliesOf(subject.name, traits.flavor_notes ?? []);
      return inputs.flavours.some((f) => families.includes(f));
    }
    case 'strength': {
      if (!traits.is_coffee) return false;
      const intensity =
        typeof traits.intensity === 'number' && Number.isFinite(traits.intensity)
          ? traits.intensity
          : (INTENSITY_FROM_CAFFEINE[traits.caffeine] ?? 0);
      if (inputs.strength === 'strong') return intensity === 3;
      if (inputs.strength === 'mild') return intensity <= 2;
      return intensity === 1 || intensity === 2; // balanced
    }
    case 'sweetness': {
      if (inputs.sweetness === 'any') return null;
      const level = deliveredSweetness(
        sweetnessLevel(traits),
        subject.sugarAdjustable,
        sweetnessTarget(inputs.sweetness),
      );
      const band = SWEETNESS_BANDS[inputs.sweetness];
      return level >= band.min && level <= band.max;
    }
    case 'body':
      return traits.body === inputs.body;
  }
}

export interface HonouredPool {
  pool: FilteredCandidate[];
  /** Candidates that keep strictly more choices than the tier filling the rest
   * of the picks, and are too few to fill the picks alone: the engine must
   * give them a slot. Kinds in inputs.kinds order, best tier first. */
  pinnedIds: string[];
}

/**
 * Per requested kind, order candidates into lexicographic tiers by which active
 * choices they keep (flavours outranks strength outranks sweetness outranks
 * body), then keep the best tiers until at least `need` items are in (the last
 * tier is taken whole). Tiers before it are too few to fill the picks, so they
 * are pinned. Removes items only; relative order is preserved.
 */
export function honourChoices(filtered: FilteredCandidate[], inputs: SuggestInputs): HonouredPool {
  if (!HONOURED_CHOICES.some((c) => isChoiceSet(c, inputs))) return { pool: filtered, pinnedIds: [] };

  const withCandidates = inputs.kinds.filter((k) => filtered.some((c) => c.traits.kind === k));
  const need = withCandidates.length <= 1 ? PROMISE_MIN_POOL.singleKind : PROMISE_MIN_POOL.multiKind;
  const kept = new Set<FilteredCandidate>();
  const pinnedIds: string[] = [];

  for (const kind of inputs.kinds) {
    const pool = filtered.filter((c) => c.traits.kind === kind);
    const active = HONOURED_CHOICES.filter((c) => isChoiceSet(c, inputs) && choiceApplies(c, kind));
    if (active.length === 0) {
      pool.forEach((c) => kept.add(c));
      continue;
    }

    const tiers = new Map<string, FilteredCandidate[]>();
    for (const c of pool) {
      const subject = { name: c.item.name, traits: c.traits, sugarAdjustable: isSugarAdjustable(c.item) };
      const key = active.map((choice) => (satisfiesChoice(choice, subject, inputs) === true ? '1' : '0')).join('');
      const tier = tiers.get(key);
      if (tier) tier.push(c);
      else tiers.set(key, [c]);
    }
    // '1' sorts after '0', so a descending string sort is the lexicographic order.
    const ordered = [...tiers.entries()].sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)).map(([, list]) => list);

    let count = 0;
    const pinned: FilteredCandidate[] = [];
    let reached = false;
    for (const tier of ordered) {
      tier.forEach((c) => kept.add(c));
      if (count + tier.length >= need) {
        reached = true;
        break;
      }
      count += tier.length;
      pinned.push(...tier);
    }
    if (reached) pinned.forEach((c) => pinnedIds.push(c.item.id));
  }

  return { pool: filtered.filter((c) => kept.has(c) || !inputs.kinds.includes(c.traits.kind)), pinnedIds };
}

/** The set choices that at least one pick breaks, in HONOURED_CHOICES order. */
export function unmetChoices(picks: ChoiceSubject[], inputs: SuggestInputs): HonouredChoice[] {
  return HONOURED_CHOICES.filter(
    (choice) => isChoiceSet(choice, inputs) && picks.some((p) => satisfiesChoice(choice, p, inputs) === false),
  );
}
