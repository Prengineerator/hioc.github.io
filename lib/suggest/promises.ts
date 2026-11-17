// Coffey — keeping the customer's choices (docs/COFFEY-SPEC.md, "honoured
// choices"). Four wizard choices (flavours, strength, sweetness, texture) used
// to be soft score terms, so picks routinely ignored them. Here they narrow the
// candidate pool BEFORE scoring whenever the menu can keep them, and
// `unmetChoices` says so honestly when a final pick does not.
//
// Pure: no Supabase, no 'server-only', no network.

import { addonLabel, flavourAddonFor, resolveAddonTraits } from './addonTraits';
import { flavourFamiliesOf } from './families';
import { minPriceInr, type FilteredCandidate } from './filter';
import { deliveredSweetness, isSugarAdjustable } from './sugar';
import { sweetnessLevel, sweetnessTarget } from './sweetness';
import {
  ADDON_SUGGEST_LIMITS,
  BUDGET_CAPS,
  HONOURED_CHOICES,
  INTENSITY_FROM_CAFFEINE,
  PROMISE_MIN_POOL,
  SWEETNESS_BANDS,
  SWEETNESS_SCALE,
} from './types';
import type {
  AddonPreset,
  AddonTraits,
  FlavourFamily,
  HonouredChoice,
  MadeTo,
  MenuItemTraits,
  SuggestInputs,
  TraitKind,
} from './types';
import type { AddonGroup, AddonOption, MenuItem } from '@/lib/types';

export type { MadeTo };

export interface ChoiceSubject {
  name: string;
  traits: MenuItemTraits;
  sugarAdjustable: boolean;
  /** What making the item the customer's way adds. Absent: the item as the
   * kitchen makes it. */
  made?: MadeTo;
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

/** The item's own intensity (0–3): the v2 grade, else derived from caffeine. */
export function intensityOf(traits: Pick<MenuItemTraits, 'intensity' | 'caffeine'>): number {
  return typeof traits.intensity === 'number' && Number.isFinite(traits.intensity)
    ? traits.intensity
    : (INTENSITY_FROM_CAFFEINE[traits.caffeine] ?? 0);
}

// ---------------------------------------------------------------------------
// Made your way (COFFEY-SPEC §11)
// ---------------------------------------------------------------------------

export const EMPTY_MADE: MadeTo = Object.freeze({
  presets: [],
  families: [],
  sweetnessLift: 0,
  intensityLift: 0,
  extraPriceInr: 0,
}) as MadeTo;

type MadeItem = Pick<MenuItem, 'name' | 'addon_groups' | 'variants'>;

interface Found {
  preset: AddonPreset;
  group: AddonGroup;
  option: AddonOption;
  traits: AddonTraits;
}

/** The cheapest switched-on espresso-shot option that lifts intensity, ties by
 * group then option sort order, then id. */
function shotAddonFor(item: MadeItem, overrides?: Map<string, AddonTraits>): Found | null {
  let best: Found | null = null;
  for (const group of item.addon_groups ?? []) {
    for (const option of group.options ?? []) {
      if (option.is_available === false) continue;
      if (!(option.price_inr <= ADDON_SUGGEST_LIMITS.maxPriceInr)) continue;
      const traits = resolveAddonTraits(group, option, overrides);
      if (traits.role !== 'shot' || !(traits.intensity_delta >= 1)) continue;
      const found: Found = {
        group,
        option,
        traits,
        preset: {
          groupId: group.id,
          optionId: option.id,
          label: addonLabel(group, option),
          priceInr: option.price_inr,
          purpose: 'strength',
        },
      };
      if (!best || shotOrder(found, best) < 0) best = found;
    }
  }
  return best;
}

function shotOrder(a: Found, b: Found): number {
  return (
    a.option.price_inr - b.option.price_inr ||
    a.group.sort_order - b.group.sort_order ||
    a.option.sort_order - b.option.sort_order ||
    (a.option.id < b.option.id ? -1 : a.option.id > b.option.id ? 1 : 0)
  );
}

/**
 * COFFEY-SPEC §11 — what it takes to make this item the customer's way:
 *  - FLAVOUR: they asked for flavours and the item carries none of them itself →
 *    the add-on flavourAddonFor names (reach roles, switched on, ≤ the price
 *    limit, within the sweetness ceiling), adding its sweetness;
 *  - STRENGTH: "strong" and a coffee drink at intensity exactly 2 → the cheapest
 *    espresso shot, adding its intensity;
 *  - BUDGET: presets are dropped (strength first, then flavour) until the item
 *    plus its add-ons fits the cap.
 * Never more than ADDON_SUGGEST_LIMITS.maxPresets, never throws, and an item
 * with no add-ons (or nothing asked) gets the empty result.
 */
export function madeToOrder(
  item: MadeItem,
  traits: MenuItemTraits,
  inputs: SuggestInputs,
  overrides?: Map<string, AddonTraits>,
): MadeTo {
  const wantsFlavour = inputs.flavours.length > 0 && choiceApplies('flavours', traits.kind);
  const wantsStrength = inputs.strength === 'strong' && traits.kind === 'drink' && traits.is_coffee;
  if (!wantsFlavour && !wantsStrength) return EMPTY_MADE;
  if (!item.addon_groups || item.addon_groups.length === 0) return EMPTY_MADE;

  let flavour: (Found & { families: FlavourFamily[] }) | null = null;
  if (wantsFlavour) {
    const own = flavourFamiliesOf(item.name, traits.flavor_notes ?? []);
    const ownsOne = inputs.flavours.some((f) => own.includes(f));
    // A syrup or sauce goes on a PLAIN base only: a cappuccino with hazelnut is
    // what a barista would make, a cranberry coffee with chocolate sauce is not.
    // An item that already has a flavour of its own is offered as it is, or not
    // at all for this flavour.
    const plain = own.length === 0;
    const suggestion = ownsOne || !plain ? null : flavourAddonFor(item, traits, inputs, overrides);
    if (suggestion) {
      const group = item.addon_groups.find((g) => g.id === suggestion.groupId);
      const option = group?.options.find((o) => o.id === suggestion.optionId);
      if (group && option) {
        const optionTraits = resolveAddonTraits(group, option, overrides);
        flavour = {
          group,
          option,
          traits: optionTraits,
          families: [...new Set(inputs.flavours)].filter((f) => optionTraits.flavour_families.includes(f)),
          preset: {
            groupId: group.id,
            optionId: option.id,
            label: suggestion.label,
            priceInr: suggestion.priceInr,
            purpose: 'flavour',
            family: suggestion.family,
          },
        };
      }
    }
  }

  let strength: Found | null = null;
  if (wantsStrength && intensityOf(traits) === 2) {
    strength = shotAddonFor(item, overrides);
    if (strength && flavour) {
      const sameOption = strength.option.id === flavour.option.id;
      const sameGroupFull = strength.group.id === flavour.group.id && !(strength.group.max_select >= 2);
      if (sameOption || sameGroupFull) strength = null;
    }
  }

  // Budget: keep the item plus its add-ons under the ceiling, strength dropped first.
  const cap = BUDGET_CAPS[inputs.budget];
  if (cap !== null) {
    const base = minPriceInr(item);
    const total = () => base + (flavour?.preset.priceInr ?? 0) + (strength?.preset.priceInr ?? 0);
    if (total() > cap) strength = null;
    if (total() > cap) flavour = null;
  }

  const presets = [flavour?.preset, strength?.preset].filter((p): p is AddonPreset => Boolean(p)).slice(0, ADDON_SUGGEST_LIMITS.maxPresets);
  if (presets.length === 0) return EMPTY_MADE;
  return {
    presets,
    families: flavour?.families ?? [],
    sweetnessLift: flavour?.traits.sweetness_delta ?? 0,
    intensityLift: strength?.traits.intensity_delta ?? 0,
    extraPriceInr: presets.reduce((sum, p) => sum + p.priceInr, 0),
  };
}

/** How a choice is kept: by the item as made ('own'), only once the add-ons
 * Coffey preselects are on ('made'), not at all (false), or not applicable (null). */
export type Keeps = 'own' | 'made' | false | null;

export function keepsChoice(choice: HonouredChoice, subject: ChoiceSubject, inputs: SuggestInputs): Keeps {
  const { traits, made } = subject;
  if (!isChoiceSet(choice, inputs) || !choiceApplies(choice, traits.kind)) return null;

  switch (choice) {
    case 'flavours': {
      const families = flavourFamiliesOf(subject.name, traits.flavor_notes ?? []);
      if (inputs.flavours.some((f) => families.includes(f))) return 'own';
      return made && inputs.flavours.some((f) => made.families.includes(f)) ? 'made' : false;
    }
    case 'strength': {
      if (!traits.is_coffee) return false;
      const intensity = intensityOf(traits);
      if (inputs.strength === 'strong') {
        if (intensity === 3) return 'own';
        return made && intensity + made.intensityLift >= 3 ? 'made' : false;
      }
      if (inputs.strength === 'mild') return intensity <= 2 ? 'own' : false;
      return intensity === 1 || intensity === 2 ? 'own' : false; // balanced
    }
    case 'sweetness': {
      if (inputs.sweetness === 'any') return null;
      const base = Math.min(SWEETNESS_SCALE.max, sweetnessLevel(traits) + (made?.sweetnessLift ?? 0));
      const level = deliveredSweetness(base, subject.sugarAdjustable, sweetnessTarget(inputs.sweetness));
      const band = SWEETNESS_BANDS[inputs.sweetness];
      return level >= band.min && level <= band.max ? 'own' : false;
    }
    case 'body':
      return traits.body === inputs.body ? 'own' : false;
  }
}

/** true / false when the choice is set and applies to the subject's kind; null
 * when it does not (so it can neither be kept nor broken). Kept through a
 * preselected add-on counts as kept. */
export function satisfiesChoice(choice: HonouredChoice, subject: ChoiceSubject, inputs: SuggestInputs): boolean | null {
  const keeps = keepsChoice(choice, subject, inputs);
  return keeps === null ? null : keeps !== false;
}

export interface HonouredPool {
  pool: FilteredCandidate[];
  /** Candidates that keep strictly more choices than the tier filling the rest
   * of the picks, and are too few to fill the picks alone: the engine must
   * give them a slot. Kinds in inputs.kinds order, best tier first. */
  pinnedIds: string[];
}

/**
 * Per requested kind, order candidates into tiers: first by which active
 * choices they keep at all, lexicographically (flavours outranks strength
 * outranks sweetness outranks body), then, among equals, by which they keep on
 * their own rather than with a preselected add-on. Keep the best tiers until at
 * least `need` items are in (the last tier is taken whole). Tiers before it are
 * too few to fill the picks, so they are pinned. Removes items only; relative
 * order is preserved.
 */
export function honourChoices(
  filtered: FilteredCandidate[],
  inputs: SuggestInputs,
  overrides?: Map<string, AddonTraits>,
): HonouredPool {
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
      const subject = {
        name: c.item.name,
        traits: c.traits,
        sugarAdjustable: isSugarAdjustable(c.item),
        made: madeToOrder(c.item, c.traits, inputs, overrides),
      };
      // The key is two rows of bits. First, per choice, whether it is KEPT at all
      // (on its own or with the add-ons on): that row is compared first, so an
      // item that keeps everything the customer chose always outranks one that
      // breaks a choice, however it keeps the rest. Second, per choice, whether it
      // is kept on its OWN: that only breaks ties, so among equals the drink that
      // is nutty as the kitchen makes it comes before the one that needs a syrup.
      // (Ranking 'own' above 'made' choice by choice would put a mocha that is
      // chocolatey but not strong ahead of a strong coffee with chocolate sauce,
      // which keeps both.)
      const keeps = active.map((choice) => keepsChoice(choice, subject, inputs));
      const key =
        keeps.map((k) => (k === 'own' || k === 'made' ? '1' : '0')).join('') +
        '.' +
        keeps.map((k) => (k === 'own' ? '1' : '0')).join('');
      const tier = tiers.get(key);
      if (tier) tier.push(c);
      else tiers.set(key, [c]);
    }
    // Both rows have one bit per active choice, so a descending string sort
    // compares the kept row first and the own row second.
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
