// Menu facets (Coffey wizard): for every orderable, tagged item, what each
// option the wizard can send would do to it — computed with the engine's OWN
// functions (filter.ts passesHardConstraints, promises.ts satisfiesChoice) so
// the wizard and the engine can never disagree about what "fits".
//
// The wizard uses the facets to grey out an option no item can satisfy together
// with the customer's other choices ("never offer a chip that leads nowhere").
// The facets are tiny (one short string per item) and cross to the client as
// plain data; unavailableOptions() is the pure client-side half.
//
// Pure: no Supabase, no 'server-only'.

import { isMenuItemAvailable } from '@/lib/menu/availability';
import type { MenuItem } from '@/lib/types';
import { passesHardConstraints } from './filter';
import { satisfiesChoice, type ChoiceSubject } from './promises';
import { isSugarAdjustable } from './sugar';
import { FLAVOUR_FAMILIES, type FlavourFamily, type MenuItemTraits, type SuggestInputs, type TraitKind } from './types';

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

/** One character per FACET_OPTIONS entry: 'k' keeps it, 'x' rules the item out,
 * 'n' the option does not apply to this kind of item. */
export interface MenuFacet {
  kind: TraitKind;
  states: string;
}

type FacetState = 'k' | 'x' | 'n';

function neutralInputs(kind: TraitKind): SuggestInputs {
  return {
    mood: 'cosy',
    secondaryMood: null,
    kinds: [kind],
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
}

function inputsFor(option: FacetOption, kind: TraitKind): SuggestInputs {
  const inputs = neutralInputs(kind);
  const [group, value] = option.split(':');
  switch (group) {
    case 'temp':
      inputs.temperature = value as 'hot' | 'iced';
      break;
    case 'coffee':
      if (value === 'none') inputs.base = 'no_coffee';
      else {
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
      inputs.flavours = [value as FlavourFamily];
      break;
    case 'budget':
      inputs.budget = value as 'under_100' | 'under_150' | 'under_200';
      break;
    case 'body':
      inputs.body = value as 'light' | 'rich';
      break;
  }
  return inputs;
}

function choiceState(result: boolean | null): FacetState {
  return result === null ? 'n' : result ? 'k' : 'x';
}

function stateOf(option: FacetOption, item: MenuItem, traits: MenuItemTraits, subject: ChoiceSubject): FacetState {
  const inputs = inputsFor(option, traits.kind);
  const passes = () => passesHardConstraints(item, traits, inputs, []);
  const group = option.split(':')[0];
  switch (group) {
    case 'temp':
      if (traits.kind !== 'drink') return 'n';
      return passes() ? 'k' : 'x';
    case 'coffee':
      if (!passes()) return 'x';
      if (option === 'coffee:none') return traits.kind === 'drink' ? 'k' : 'n';
      return choiceState(satisfiesChoice('strength', subject, inputs));
    case 'caffeineFree':
    case 'budget':
      return passes() ? 'k' : 'x';
    case 'sweet':
      if (!passes()) return 'x';
      return choiceState(satisfiesChoice('sweetness', subject, inputs));
    case 'flavour':
      return choiceState(satisfiesChoice('flavours', subject, inputs));
    default:
      return choiceState(satisfiesChoice('body', subject, inputs));
  }
}

/** One facet per orderable, tagged item. */
export function menuFacets(items: MenuItem[], traitsById: Map<string, MenuItemTraits>): MenuFacet[] {
  const out: MenuFacet[] = [];
  for (const item of items) {
    const traits = traitsById.get(item.id);
    if (!traits || !isMenuItemAvailable(item)) continue;
    const subject: ChoiceSubject = { name: item.name, traits, sugarAdjustable: isSugarAdjustable(item) };
    out.push({
      kind: traits.kind,
      states: FACET_OPTIONS.map((option) => stateOf(option, item, traits, subject)).join(''),
    });
  }
  return out;
}

const INDEX = new Map<FacetOption, number>(FACET_OPTIONS.map((o, i) => [o, i]));

function groupOf(option: FacetOption): string {
  return option.split(':')[0];
}

/**
 * The options that lead nowhere given what is already chosen: no item of the
 * ticked kinds keeps the option AND is compatible with every other selected
 * group (single-select: not ruled out by the selected option; flavours, which
 * are OR: not ruled out by at least one selected family). Selected options are
 * never returned, so a chip can always be tapped again to clear it.
 */
export function unavailableOptions(
  selection: { kinds: readonly TraitKind[]; options: readonly FacetOption[] },
  facets: readonly MenuFacet[],
): Set<FacetOption> {
  const selected = new Set<FacetOption>(selection.options);
  const byGroup = new Map<string, FacetOption[]>();
  for (const option of selection.options) {
    const g = groupOf(option);
    byGroup.set(g, [...(byGroup.get(g) ?? []), option]);
  }
  const pool = facets.filter((f) => selection.kinds.includes(f.kind));

  const compatible = (facet: MenuFacet, group: string): boolean => {
    const options = byGroup.get(group);
    if (!options || options.length === 0) return true;
    return options.some((o) => facet.states[INDEX.get(o) as number] !== 'x');
  };

  const out = new Set<FacetOption>();
  for (const option of FACET_OPTIONS) {
    if (selected.has(option)) continue;
    const idx = INDEX.get(option) as number;
    const own = groupOf(option);
    const available = pool.some(
      (facet) =>
        facet.states[idx] === 'k' &&
        [...byGroup.keys()].every((g) => g === own || compatible(facet, g)),
    );
    if (!available) out.add(option);
  }
  return out;
}
