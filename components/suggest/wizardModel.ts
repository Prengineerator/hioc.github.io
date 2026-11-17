// The /suggest wizard's non-visual logic (COFFEY-SPEC §1), kept pure so it can
// be unit-tested without a DOM. SuggestWizard.tsx owns the React state and calls
// these; nothing here touches the network, the DOM or React.
//
// The model: every step-2 group is a toggle, and "cleared" (null / empty) means
// "no preference". buildInputs() turns the state into a complete, valid v2
// SuggestInputs, sending neutral values for everything cleared or hidden.

import { FACET_OPTIONS, unavailableOptions, type FacetOption, type MenuFacet } from '@/lib/suggest/facets';
import { FLAVOUR_FAMILY_INFO, MOOD_INFO } from '@/lib/suggest/traitVocabulary';
import {
  BUDGET_CAPS,
  FLAVOUR_FAMILIES,
  FLAVOUR_OFFER_MIN,
  KINDS,
  SUGGEST_LIMITS,
} from '@/lib/suggest/types';
import type {
  Budget,
  FlavourCounts,
  FlavourFamily,
  HonouredChoice,
  Mood,
  RelaxHint,
  SuggestInputs,
  TraitKind,
} from '@/lib/suggest/types';

// ---------------------------------------------------------------------------
// Vocabulary (the customer's own chip words)
// ---------------------------------------------------------------------------

export const KIND_INFO: Record<TraitKind, { label: string; icon: string }> = {
  drink: { label: 'A drink', icon: '☕' },
  dessert: { label: 'Something sweet to eat', icon: '🧇' },
  food: { label: 'Something savoury', icon: '🥪' },
};

export const TEMPERATURES = ['hot', 'iced'] as const;
export type TemperatureChoice = (typeof TEMPERATURES)[number];
export const TEMPERATURE_LABEL: Record<TemperatureChoice, string> = { hot: 'Hot', iced: 'Iced' };

/** "Coffee?" is one question that maps onto base + strength. */
export const COFFEE_CHOICES = ['strong', 'smooth', 'none'] as const;
export type CoffeeChoice = (typeof COFFEE_CHOICES)[number];
export const COFFEE_LABEL: Record<CoffeeChoice, string> = {
  strong: 'Strong coffee',
  smooth: 'Smooth & milky coffee',
  none: 'No coffee',
};

export const SWEETNESS_CHOICES = ['none', 'light', 'sweet'] as const;
export type SweetnessChoice = (typeof SWEETNESS_CHOICES)[number];
export const SWEETNESS_LABEL: Record<SweetnessChoice, string> = {
  none: 'Not sweet',
  light: 'Lightly sweet',
  sweet: 'Sweet',
};

export const BUDGET_CHOICES = ['under_100', 'under_150', 'under_200'] as const satisfies readonly Budget[];
export type BudgetChoice = (typeof BUDGET_CHOICES)[number];
// Read off the contract's caps, so the labels can't drift from what the engine
// filters on.
export const BUDGET_LABEL: Record<BudgetChoice, string> = {
  under_100: `Up to ₹${BUDGET_CAPS.under_100}`,
  under_150: `Up to ₹${BUDGET_CAPS.under_150}`,
  under_200: `Up to ₹${BUDGET_CAPS.under_200}`,
};

export const BODY_CHOICES = ['light', 'rich'] as const;
export type BodyChoice = (typeof BODY_CHOICES)[number];
export const BODY_LABEL: Record<BodyChoice, string> = {
  light: 'Light & refreshing',
  rich: 'Rich & filling',
};

export const MORE_OPTIONS_LABEL = 'More options';
export const CAFFEINE_FREE_LABEL = 'Caffeine-free';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface WizardState {
  /** The one feeling picked on step 1; null before that. */
  mood: Mood | null;
  /** Never empty: a request needs something in it. */
  kinds: TraitKind[];
  /** null = cleared = no preference. */
  temperature: TemperatureChoice | null;
  coffee: CoffeeChoice | null;
  sweetness: SweetnessChoice | null;
  flavours: FlavourFamily[];
  caffeineFree: boolean;
  budget: BudgetChoice | null;
  body: BodyChoice | null;
  note: string;
  /** Context defaults fill a group only if the customer has not touched it … */
  touched: { kinds: boolean; temperature: boolean };
  /** … and only once per feeling, so going Back and forth never undoes an edit. */
  appliedMoods: Mood[];
}

export function initialState(): WizardState {
  return {
    mood: null,
    kinds: ['drink'],
    temperature: null,
    coffee: null,
    sweetness: null,
    flavours: [],
    caffeineFree: false,
    budget: null,
    body: null,
    note: '',
    touched: { kinds: false, temperature: false },
    appliedMoods: [],
  };
}

export function wantsDrink(state: WizardState): boolean {
  return state.kinds.includes('drink');
}

// ---------------------------------------------------------------------------
// Transitions (all pure: they return a new state)
// ---------------------------------------------------------------------------

/**
 * Step 1: the customer tapped a feeling. Applies the context defaults, once per
 * feeling and only to groups they have not touched: `celebrate` ticks the sweet
 * kind, `cool` selects Iced.
 */
export function selectMood(state: WizardState, mood: Mood): WizardState {
  const next: WizardState = { ...state, mood };
  if (state.appliedMoods.includes(mood)) return next;
  next.appliedMoods = [...state.appliedMoods, mood];
  if (mood === 'celebrate' && !state.touched.kinds && !state.kinds.includes('dessert')) {
    next.kinds = [...state.kinds, 'dessert'];
  }
  if (mood === 'cool' && !state.touched.temperature) {
    next.temperature = 'iced';
  }
  return next;
}

/** Multi-select; the last ticked kind cannot be unticked. */
export function toggleKind(state: WizardState, kind: TraitKind): WizardState {
  let kinds: TraitKind[];
  if (!state.kinds.includes(kind)) kinds = [...state.kinds, kind];
  else kinds = state.kinds.length > 1 ? state.kinds.filter((k) => k !== kind) : state.kinds;
  return { ...state, kinds, touched: { ...state.touched, kinds: true } };
}

export function toggleTemperature(state: WizardState, value: TemperatureChoice): WizardState {
  return {
    ...state,
    temperature: state.temperature === value ? null : value,
    touched: { ...state.touched, temperature: true },
  };
}

/** Strong and smooth coffee are not available while Caffeine-free is on. */
export function toggleCoffee(state: WizardState, value: CoffeeChoice): WizardState {
  if (state.caffeineFree && value !== 'none') return state;
  return { ...state, coffee: state.coffee === value ? null : value };
}

export function toggleSweetness(state: WizardState, value: SweetnessChoice): WizardState {
  return { ...state, sweetness: state.sweetness === value ? null : value };
}

export function toggleFlavour(state: WizardState, family: FlavourFamily): WizardState {
  return {
    ...state,
    flavours: state.flavours.includes(family)
      ? state.flavours.filter((f) => f !== family)
      : [...state.flavours, family],
  };
}

/** Turning it on clears Strong / Smooth (there is no caffeine-free coffee). */
export function toggleCaffeineFree(state: WizardState): WizardState {
  const caffeineFree = !state.caffeineFree;
  const coffee = caffeineFree && (state.coffee === 'strong' || state.coffee === 'smooth') ? null : state.coffee;
  return { ...state, caffeineFree, coffee };
}

export function toggleBudget(state: WizardState, value: BudgetChoice): WizardState {
  return { ...state, budget: state.budget === value ? null : value };
}

export function toggleBody(state: WizardState, value: BodyChoice): WizardState {
  return { ...state, body: state.body === value ? null : value };
}

/** "Show me more options": clear the one choice the engine named. */
export function relaxState(state: WizardState, constraint: RelaxHint['constraint']): WizardState {
  switch (constraint) {
    case 'temperature':
      return { ...state, temperature: null };
    case 'sweetness':
      return { ...state, sweetness: null };
    case 'base':
      return { ...state, coffee: null };
    case 'needs':
      return { ...state, caffeineFree: false };
    case 'budget':
      return { ...state, budget: null };
    default:
      // 'extras' (the v1 composition rule) is never offered by the v2 engine.
      return state;
  }
}

// ---------------------------------------------------------------------------
// Flavours
// ---------------------------------------------------------------------------

/**
 * The flavour families worth offering for the ticked kinds, in the contract's
 * order. With counts: a family needs FLAVOUR_OFFER_MIN items across the ticked
 * kinds. Without counts (the menu could not be read): all seven, except that a
 * savoury-only request offers none.
 */
export function offeredFlavours(kinds: readonly TraitKind[], flavourCounts: FlavourCounts | null): FlavourFamily[] {
  if (flavourCounts === null) {
    return kinds.some((k) => k !== 'food') ? [...FLAVOUR_FAMILIES] : [];
  }
  return FLAVOUR_FAMILIES.filter((family) => {
    const total = kinds.reduce((sum, kind) => sum + (flavourCounts[kind]?.[family] ?? 0), 0);
    return total >= FLAVOUR_OFFER_MIN;
  });
}

/** The selected flavours that are still on offer, in contract order. */
export function activeFlavours(state: WizardState, flavourCounts: FlavourCounts | null): FlavourFamily[] {
  const offered = offeredFlavours(state.kinds, flavourCounts);
  return offered.filter((f) => state.flavours.includes(f));
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

/** A complete, valid v2 body. Cleared and hidden groups go out as neutral. */
export function buildInputs(state: WizardState, flavourCounts: FlavourCounts | null): SuggestInputs {
  const drink = wantsDrink(state);
  const coffee = drink ? state.coffee : null;
  const base: SuggestInputs['base'] = coffee === 'none' ? 'no_coffee' : coffee ? 'coffee' : 'either';
  const strength: SuggestInputs['strength'] = coffee === 'strong' ? 'strong' : coffee === 'smooth' ? 'mild' : 'any';
  return {
    // The 'surprise' fallback is unreachable in practice (step 2 is only
    // reached after a feeling is tapped); it satisfies the type.
    mood: state.mood ?? 'surprise',
    secondaryMood: null,
    kinds: KINDS.filter((k) => state.kinds.includes(k)),
    temperature: drink && state.temperature ? state.temperature : 'either',
    base,
    strength,
    sweetness: state.sweetness ?? 'any',
    body: state.body ?? 'any',
    flavours: activeFlavours(state, flavourCounts),
    needs: state.caffeineFree ? ['no_caffeine'] : [],
    budget: state.budget ?? 'any',
    note: state.note.trim().slice(0, SUGGEST_LIMITS.noteMaxChars),
  };
}

// ---------------------------------------------------------------------------
// Words for what is set
// ---------------------------------------------------------------------------

/**
 * The recap under the results heading: the feeling first, then only the choices
 * that are set, in the customer's own chip words. Kinds appear only when they
 * are not just "A drink"; the drink-only groups only while a drink is ticked.
 */
export function recapLabels(state: WizardState, flavourCounts: FlavourCounts | null): string[] {
  const labels: string[] = [];
  if (state.mood) labels.push(MOOD_INFO[state.mood].card);
  const justDrink = state.kinds.length === 1 && state.kinds[0] === 'drink';
  if (!justDrink) {
    for (const kind of KINDS) if (state.kinds.includes(kind)) labels.push(KIND_INFO[kind].label);
  }
  if (wantsDrink(state)) {
    if (state.temperature) labels.push(TEMPERATURE_LABEL[state.temperature]);
    if (state.coffee) labels.push(COFFEE_LABEL[state.coffee]);
  }
  if (state.sweetness) labels.push(SWEETNESS_LABEL[state.sweetness]);
  for (const family of activeFlavours(state, flavourCounts)) labels.push(FLAVOUR_FAMILY_INFO[family].label);
  if (state.caffeineFree) labels.push(CAFFEINE_FREE_LABEL);
  if (state.budget) labels.push(BUDGET_LABEL[state.budget]);
  if (state.body) labels.push(BODY_LABEL[state.body]);
  return labels;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The customer's current value for a choice, in chip words (flavour labels keep
 * their capital, the rest are lower-case so they read inside a sentence). */
function choicePhrase(choice: HonouredChoice, state: WizardState, flavourCounts: FlavourCounts | null): string | null {
  switch (choice) {
    case 'flavours': {
      const names = activeFlavours(state, flavourCounts).map((f) => FLAVOUR_FAMILY_INFO[f].label);
      return names.length > 0 ? names.join(' or ') : null;
    }
    case 'strength':
      return state.coffee === 'strong' || state.coffee === 'smooth' ? lowerFirst(COFFEE_LABEL[state.coffee]) : null;
    case 'sweetness':
      return state.sweetness ? lowerFirst(SWEETNESS_LABEL[state.sweetness]) : null;
    case 'body':
      return state.body ? lowerFirst(BODY_LABEL[state.body]) : null;
  }
}

/**
 * One plain line above the cards when the menu could not keep every choice for
 * every pick. The detail is on each card (missLabel), so this only says so.
 * Null when nothing is unmet.
 */
export function unmetLine(
  unmet: readonly HonouredChoice[] | undefined,
  _state?: WizardState,
  _flavourCounts: FlavourCounts | null = null,
): string | null {
  if (!unmet || unmet.length === 0) return null;
  return "Some picks are the closest we have — each card says what's different.";
}

/**
 * The per-card line for a pick that misses some of the customer's choices:
 * "Closest we have: not Chocolatey", "Closest we have: not strong coffee or
 * lightly sweet". Null when it misses nothing (or none of them is set any more).
 */
export function missLabel(
  misses: readonly HonouredChoice[] | undefined,
  state: WizardState,
  flavourCounts: FlavourCounts | null = null,
): string | null {
  if (!misses || misses.length === 0) return null;
  const phrases: string[] = [];
  for (const choice of misses) {
    const phrase = choicePhrase(choice, state, flavourCounts);
    if (phrase) phrases.push(phrase);
  }
  return phrases.length > 0 ? `Closest we have: not ${phrases.join(' or ')}` : null;
}

// ---------------------------------------------------------------------------
// Options that lead nowhere (lib/suggest/facets.ts)
// ---------------------------------------------------------------------------

export const tempOption = (v: TemperatureChoice): FacetOption => `temp:${v}`;
export const coffeeOption = (v: CoffeeChoice): FacetOption => (v === 'smooth' ? 'coffee:mild' : `coffee:${v}`);
export const sweetOption = (v: SweetnessChoice): FacetOption => `sweet:${v}`;
export const flavourOption = (f: FlavourFamily): FacetOption => `flavour:${f}`;
export const budgetOption = (v: BudgetChoice): FacetOption => `budget:${v}`;
export const bodyOption = (v: BodyChoice): FacetOption => `body:${v}`;
export const CAFFEINE_FREE_OPTION: FacetOption = 'caffeineFree';

/** What buildInputs would actually send, as facet option keys: hidden drink-only
 * groups and no-longer-offered flavours are left out. */
export function selectedOptions(state: WizardState, flavourCounts: FlavourCounts | null = null): FacetOption[] {
  const out: FacetOption[] = [];
  if (wantsDrink(state)) {
    if (state.temperature) out.push(tempOption(state.temperature));
    if (state.coffee) out.push(coffeeOption(state.coffee));
  }
  if (state.caffeineFree) out.push(CAFFEINE_FREE_OPTION);
  if (state.sweetness) out.push(sweetOption(state.sweetness));
  for (const f of activeFlavours(state, flavourCounts)) out.push(flavourOption(f));
  if (state.budget) out.push(budgetOption(state.budget));
  if (state.body) out.push(bodyOption(state.body));
  return FACET_OPTIONS.filter((o) => out.includes(o));
}

/** Options no pick can satisfy together with the current choices. Empty without facets. */
export function disabledOptions(
  state: WizardState,
  facets: readonly MenuFacet[] | null,
  flavourCounts: FlavourCounts | null = null,
): Set<FacetOption> {
  if (facets === null) return new Set();
  return unavailableOptions({ kinds: state.kinds, options: selectedOptions(state, flavourCounts) }, facets);
}

/** Is anything inside "More options" set? */
export function moreOptionsSet(state: WizardState): boolean {
  return state.caffeineFree || state.budget !== null || state.body !== null || state.note.trim() !== '';
}

/**
 * The collapsed section's label: what is set inside it ("Caffeine-free · Up to
 * ₹150"), or plain "More options" when nothing is.
 */
export function moreOptionsSummary(state: WizardState): string {
  const parts: string[] = [];
  if (state.caffeineFree) parts.push(CAFFEINE_FREE_LABEL);
  if (state.budget) parts.push(BUDGET_LABEL[state.budget]);
  if (state.body) parts.push(BODY_LABEL[state.body]);
  if (state.note.trim() !== '') parts.push('Note added');
  return parts.length > 0 ? parts.join(' · ') : MORE_OPTIONS_LABEL;
}
