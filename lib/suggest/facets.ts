// Menu facets (Coffey wizard): for every orderable, tagged item, the compact
// record of exactly what the choice rules read — so the wizard can grey out an
// option no item can keep TOGETHER with everything else the customer selected
// ("never offer a chip that leads nowhere"), with no server round trip.
//
// With "made your way" (COFFEY-SPEC §11) the choices interact: a syrup adds
// sweetness, a shot adds price. So there are no per-option verdicts to precompute
// any more. unavailableOptions() rebuilds a minimal MenuItem + traits from each
// facet and asks the REAL engine functions (filter.ts passesHardConstraints,
// promises.ts madeToOrder and keepsChoice), so the wizard and the engine cannot
// disagree about what "fits": there is one implementation of the rules.
//
// A facet is plain data and identifies nothing: no id, no name, no label.
//
// Pure: no Supabase, no 'server-only'.

import { isMenuItemAvailable } from '@/lib/menu/availability';
import type { AddonGroup, MenuItem } from '@/lib/types';
import { flavourFamiliesOf } from './families';
import { resolveAddonTraits } from './addonTraits';
import { minPriceInr, passesHardConstraints } from './filter';
import { isMistaggedIced } from './traitsGuard';
import { HONOURED_CHOICES } from './types';
import { choiceApplies, intensityOf, isChoiceSet, keepsChoice, madeToOrder, type ChoiceSubject } from './promises';
import { isSugarAdjustable } from './sugar';
import { sweetnessLevel } from './sweetness';
import {
  ADDON_SUGGEST_LIMITS,
  FLAVOUR_FAMILIES,
  FLAVOUR_REACH_ROLES,
  type AddonRole,
  type AddonTraits,
  type FlavourFamily,
  type MenuItemTraits,
  type SuggestInputs,
  type TraitBody,
  type TraitCaffeine,
  type TraitKind,
  type TraitTemperature,
} from './types';

export const FACET_OPTIONS = [
  'temp:hot',
  'temp:iced',
  'coffee:strong',
  'coffee:mild',
  'coffee:none',
  'caffeineFree',
  'sweet:none',
  'sweet:light',
  'sweet:sweet',
  ...FLAVOUR_FAMILIES.map((f) => `flavour:${f}` as const),
  'budget:under_100',
  'budget:under_150',
  'budget:under_200',
  'body:light',
  'body:rich',
] as const;
export type FacetOption = (typeof FACET_OPTIONS)[number];

/** An add-on option that could ever become a preset: a flavour source (reach
 * role with a family) or an espresso shot. */
export interface FacetAddon {
  role: AddonRole;
  /** Flavour families it supplies (empty for a shot). */
  families: FlavourFamily[];
  /** Sweetness it adds. */
  sweetness: number;
  /** Intensity it adds. */
  intensity: number;
  priceInr: number;
  /** Index of its group within the item (menu order by sort_order). */
  group: number;
  /** That group's max_select. */
  max: number;
}

/** What the choice rules read about one item, and nothing that identifies it. */
export interface MenuFacet {
  kind: TraitKind;
  temperature: TraitTemperature;
  isCoffee: boolean;
  caffeine: TraitCaffeine;
  /** sweetnessLevel(traits): inherent, 0–10. */
  sweetness: number;
  /** The intensity (0–3), with the caffeine fallback applied. */
  intensity: number;
  body: TraitBody;
  sugarAdjustable: boolean;
  /** Cheapest size. */
  minPriceInr: number;
  /** The flavour families the item carries itself. */
  families: FlavourFamily[];
  addons: FacetAddon[];
}

/** A price no budget cap admits, for an item with no priced size (JSON cannot hold Infinity). */
const NO_PRICE = 1_000_000;

/** One facet per orderable, tagged item. */
export function menuFacets(
  items: MenuItem[],
  traitsById: Map<string, MenuItemTraits>,
  overrides?: Map<string, AddonTraits>,
): MenuFacet[] {
  const reachRoles: readonly AddonRole[] = FLAVOUR_REACH_ROLES;
  const out: MenuFacet[] = [];
  for (const item of items) {
    const traits = traitsById.get(item.id);
    if (!traits || !isMenuItemAvailable(item)) continue;

    const groups = [...(item.addon_groups ?? [])]
      .map((group, i) => ({ group, i }))
      .sort((a, b) => a.group.sort_order - b.group.sort_order || a.i - b.i);
    const addons: FacetAddon[] = [];
    groups.forEach(({ group }, rank) => {
      const options = [...(group.options ?? [])].sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1));
      for (const option of options) {
        if (option.is_available === false) continue;
        if (!(option.price_inr <= ADDON_SUGGEST_LIMITS.maxPriceInr)) continue;
        const t = resolveAddonTraits(group, option, overrides);
        const flavourSource = reachRoles.includes(t.role) && t.flavour_families.length > 0;
        const shot = t.role === 'shot' && t.intensity_delta >= 1;
        if (!flavourSource && !shot) continue;
        addons.push({
          role: t.role,
          families: flavourSource ? [...t.flavour_families] : [],
          sweetness: t.sweetness_delta,
          intensity: t.intensity_delta,
          priceInr: option.price_inr,
          group: rank,
          max: group.max_select,
        });
      }
    });

    const price = minPriceInr(item);
    out.push({
      kind: traits.kind,
      // The same correction the engine applies (lib/suggest/traitsGuard.ts), so a
      // chip is never greyed or offered on a temperature the engine does not use.
      temperature: isMistaggedIced(item, traits) ? 'iced' : traits.temperature,
      isCoffee: traits.is_coffee,
      caffeine: traits.caffeine,
      sweetness: sweetnessLevel(traits),
      intensity: intensityOf(traits),
      body: traits.body,
      sugarAdjustable: isSugarAdjustable(item),
      minPriceInr: Number.isFinite(price) ? price : NO_PRICE,
      families: flavourFamiliesOf(item.name, traits.flavor_notes ?? []),
      addons,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rebuilding real objects from a facet
// ---------------------------------------------------------------------------

/** A flavour note per family that flavourFamiliesOf reads back as exactly that
 * family (tests/suggestFacets.test.ts checks all seven). */
export const CANONICAL_NOTE: Record<FlavourFamily, string> = {
  chocolatey: 'cocoa',
  caramel: 'toffee',
  nutty: 'walnut',
  biscuit: 'wafer',
  fruity: 'citrus',
  spiced: 'clove',
  floral: 'lavender',
};

interface Rebuilt {
  facet: MenuFacet;
  item: MenuItem;
  traits: MenuItemTraits;
  overrides: Map<string, AddonTraits>;
  sugarAdjustable: boolean;
}

function rebuild(facet: MenuFacet, index: number): Rebuilt {
  const overrides = new Map<string, AddonTraits>();
  const groups = new Map<number, AddonGroup>();
  facet.addons.forEach((addon, j) => {
    let group = groups.get(addon.group);
    if (!group) {
      group = {
        id: `g${addon.group}`,
        name: 'g',
        display_name: '',
        selection_type: 'multi',
        min_select: 0,
        max_select: addon.max,
        sort_order: addon.group,
        options: [],
      };
      groups.set(addon.group, group);
    }
    const id = `${group.id}o${j}`;
    group.options.push({ id, addon_group_id: group.id, name: 'o', price_inr: addon.priceInr, sort_order: j, is_available: true });
    overrides.set(id, {
      role: addon.role,
      flavour_families: addon.families,
      sweetness_delta: addon.sweetness,
      intensity_delta: addon.intensity,
      indulgence_delta: 0,
      textures: [],
    });
  });

  const id = `facet-${index}`;
  const item = {
    id,
    name: '',
    description: '',
    category: '',
    parent_category: '',
    is_veg: true,
    is_available: true,
    unavailable_until: null,
    variants: [{ id: `${id}-v`, menu_item_id: id, label: '', price_inr: facet.minPriceInr, sort_order: 0 }],
    addon_groups: [...groups.values()].sort((a, b) => a.sort_order - b.sort_order),
  } as unknown as MenuItem;
  const traits = {
    menu_item_id: id,
    kind: facet.kind,
    temperature: facet.temperature,
    caffeine: facet.caffeine,
    is_coffee: facet.isCoffee,
    sweetness: 0,
    sweetness_level: facet.sweetness,
    intensity: facet.intensity,
    body: facet.body,
    flavor_notes: facet.families.map((f) => CANONICAL_NOTE[f]),
  } as unknown as MenuItemTraits;
  return { facet, item, traits, overrides, sugarAdjustable: facet.sugarAdjustable };
}

const REBUILT = new WeakMap<readonly MenuFacet[], Rebuilt[]>();

function rebuiltFor(facets: readonly MenuFacet[]): Rebuilt[] {
  let list = REBUILT.get(facets);
  if (!list) {
    list = facets.map(rebuild);
    REBUILT.set(facets, list);
  }
  return list;
}

// ---------------------------------------------------------------------------
// Selections → the inputs the wizard would send
// ---------------------------------------------------------------------------

function groupOf(option: FacetOption): string {
  return option.split(':')[0];
}

/** The SuggestInputs the wizard sends for these options (kinds as given). */
export function inputsForOptions(kinds: readonly TraitKind[], options: readonly FacetOption[]): SuggestInputs {
  const inputs: SuggestInputs = {
    mood: 'cosy',
    secondaryMood: null,
    kinds: [...kinds],
    temperature: 'either',
    base: 'either',
    strength: 'any',
    sweetness: 'any',
    body: 'any',
    flavours: [],
    needs: [],
    budget: 'any',
    note: '',
  };
  for (const option of options) {
    const [group, value] = option.split(':');
    switch (group) {
      case 'temp':
        inputs.temperature = value as 'hot' | 'iced';
        break;
      case 'coffee':
        if (value === 'none') {
          inputs.base = 'no_coffee';
          inputs.strength = 'any';
        } else {
          inputs.base = 'coffee';
          inputs.strength = value as 'strong' | 'mild';
        }
        break;
      case 'caffeineFree':
        inputs.needs = ['no_caffeine'];
        break;
      case 'sweet':
        inputs.sweetness = value as 'none' | 'light' | 'sweet';
        break;
      case 'flavour':
        if (!inputs.flavours.includes(value as FlavourFamily)) inputs.flavours.push(value as FlavourFamily);
        break;
      case 'budget':
        inputs.budget = value as 'under_100' | 'under_150' | 'under_200';
        break;
      case 'body':
        inputs.body = value as 'light' | 'rich';
        break;
    }
  }
  return inputs;
}

/** Does this item, made the customer's way, deliver the option being tested? */
function delivers(option: FacetOption, subject: ChoiceSubject, inputs: SuggestInputs): boolean {
  const kept = (choice: (typeof HONOURED_CHOICES)[number]) => {
    const k = keepsChoice(choice, subject, inputs);
    return k === 'own' || k === 'made';
  };
  switch (groupOf(option)) {
    case 'temp':
      return subject.traits.kind === 'drink';
    case 'coffee':
      return option === 'coffee:none' ? subject.traits.kind === 'drink' && !subject.traits.is_coffee : kept('strength');
    case 'sweet':
      return kept('sweetness');
    case 'flavour':
      return kept('flavours');
    case 'body':
      return kept('body');
    default:
      return true; // caffeineFree, budget: the hard filter and the choices are all there is
  }
}

/** Is there a rebuilt item that passes the hard filter, keeps (or can be made to
 * keep) every set choice, and delivers `option` (undefined: nothing to deliver)? */
function someItemFits(pool: readonly Rebuilt[], inputs: SuggestInputs, option: FacetOption | null): boolean {
  return pool.some((r) => {
    if (!passesHardConstraints(r.item, r.traits, inputs, [])) return false;
    const subject: ChoiceSubject = {
      name: r.item.name,
      traits: r.traits,
      sugarAdjustable: r.sugarAdjustable,
      made: madeToOrder(r.item, r.traits, inputs, r.overrides),
    };
    for (const choice of HONOURED_CHOICES) {
      if (!isChoiceSet(choice, inputs) || !choiceApplies(choice, r.traits.kind)) continue;
      if (keepsChoice(choice, subject, inputs) === false) return false;
    }
    return option === null || delivers(option, subject, inputs);
  });
}

/**
 * The options that lead nowhere given what is already chosen: no item of the
 * ticked kinds passes the hard filter, keeps every other set choice (on its own
 * or with the add-ons Coffey would preselect) AND delivers the option. A flavour
 * chip is tested alone (flavours are OR); a single-select group's value is
 * replaced by the option. Selected options are never returned, so a chip can
 * always be tapped again to clear it.
 */
export function unavailableOptions(
  selection: { kinds: readonly TraitKind[]; options: readonly FacetOption[] },
  facets: readonly MenuFacet[],
): Set<FacetOption> {
  const selected = new Set<FacetOption>(selection.options);
  const pool = rebuiltFor(facets).filter((r) => selection.kinds.includes(r.facet.kind));

  const out = new Set<FacetOption>();
  for (const option of FACET_OPTIONS) {
    if (selected.has(option)) continue;
    const g = groupOf(option);
    const others = selection.options.filter((o) => groupOf(o) !== g);
    const inputs = inputsForOptions(selection.kinds, [...others, option]);
    if (!someItemFits(pool, inputs, option)) out.add(option);
  }
  return out;
}
