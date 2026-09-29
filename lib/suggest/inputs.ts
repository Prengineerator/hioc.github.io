// Coffey v2 — the request-inputs helpers (docs/COFFEY-SPEC.md §2). Pure: no
// Supabase, no 'server-only', safe to import from client components, tests and
// the eval script.
//
// Three small jobs live here:
//   * upgradeV1Inputs()   maps a pre-Coffey request body ({ extras, needs:
//                         ['less_sugar'], … }) onto the v2 shape, so an old
//                         browser bundle, a stored session or an eval fixture
//                         keeps meaning what it meant (the table in §2).
//   * isLegacyInputsBody() tells the two wire shapes apart (validate.ts).
//   * withInputDefaults() / moodsOf() are conveniences the engine, the tests
//                         and the eval script share.

import {
  FLAVOUR_FAMILIES,
  KINDS,
  type BodyPref,
  type Budget,
  type FlavourFamily,
  type LegacySuggestInputs,
  type Mood,
  type Need,
  type SuggestInputs,
  type SweetnessPref,
  type TraitKind,
} from './types';

/**
 * COFFEY-SPEC §2 — v1 → v2, row by row. This is a lossless mapping of v1
 * BEHAVIOUR (not of its labels): what v1's composition rule admitted, v2's
 * `kinds` now says out loud.
 *
 *   (always)                 kinds starts as ['drink']
 *   extras: eat              kinds += dessert, food
 *   extras: filling          kinds += dessert, food; body 'rich'
 *   extras: light            body 'light' (light AND filling → body 'any')
 *   extras: sweet            kinds += dessert; sweetness 'sweet'
 *   mood: celebrate          kinds += dessert (v1's composition rule)
 *   extras: chocolatey/fruity flavours += chocolatey / fruity
 *   needs: less_sugar        sweetness 'light' — wins over extras: sweet —
 *                            and is dropped from needs
 *   budget: under_150        under_150; 150_300, treat and any → any. v1's
 *                            "₹150–₹300" was a BAND that hid everything under
 *                            ₹150, and "Treat myself" filtered exactly like
 *                            "Any" (§1): v2 budgets are ceilings, so the only v1
 *                            budget that constrained anything and still means
 *                            something is the ceiling.
 *
 * `kinds` comes out de-duplicated, in KINDS order, and always starts with
 * 'drink'. Everything not set above stays neutral ('any' / null).
 */
export function upgradeV1Inputs(v1: LegacySuggestInputs): SuggestInputs {
  const extras = new Set<string>(v1.extras);

  const wanted = new Set<TraitKind>(['drink']);
  if (extras.has('eat') || extras.has('filling')) {
    wanted.add('dessert');
    wanted.add('food');
  }
  if (extras.has('sweet') || v1.mood === 'celebrate') wanted.add('dessert');
  const kinds = KINDS.filter((k) => wanted.has(k));

  // 'light' and 'filling' pull in opposite directions; asking for both is
  // asking for neither.
  const light = extras.has('light');
  const filling = extras.has('filling');
  const body: BodyPref = light && filling ? 'any' : light ? 'light' : filling ? 'rich' : 'any';

  // 'less_sugar' is the customer's explicit limit, so it beats the soft 'sweet'.
  let sweetness: SweetnessPref = 'any';
  if (extras.has('sweet')) sweetness = 'sweet';
  if (v1.needs.includes('less_sugar')) sweetness = 'light';

  // FLAVOUR_FAMILIES order (chocolatey before fruity) — the same priority v1's
  // reason template gave the two.
  const flavours: FlavourFamily[] = FLAVOUR_FAMILIES.filter(
    (f) => (f === 'chocolatey' || f === 'fruity') && extras.has(f),
  );

  const needs: Need[] = v1.needs.includes('no_caffeine') ? ['no_caffeine'] : [];

  const budget: Budget = v1.budget === 'under_150' ? 'under_150' : 'any';

  return {
    mood: v1.mood,
    secondaryMood: null,
    kinds,
    temperature: v1.temperature,
    base: v1.base,
    strength: 'any',
    sweetness,
    body,
    flavours,
    needs,
    budget,
    note: v1.note,
  };
}

/** A body is the pre-Coffey shape when it carries neither v2-only field
 * (§2: "v1 is detected by the absence of both `kinds` and `sweetness`"). A
 * present-but-wrong value (`kinds: null`) still counts as v2, so it fails v2
 * validation with a v2 message rather than a baffling "invalid extras". */
export function isLegacyInputsBody(b: Record<string, unknown>): boolean {
  return b.kinds === undefined && b.sweetness === undefined;
}

/** Neutral defaults for every field — a convenience for tests and the eval
 * script. Mood 'surprise' is the least opinionated feeling; everything else is
 * "no preference" (`either` / `any` / `[]` / `''`), and the customer wants a
 * drink. Arrays are fresh on every call, so callers can mutate what they get. */
export function withInputDefaults(partial: Partial<SuggestInputs> = {}): SuggestInputs {
  return {
    mood: 'surprise',
    secondaryMood: null,
    kinds: ['drink'],
    temperature: 'either',
    base: 'either',
    strength: 'any',
    sweetness: 'any',
    body: 'any',
    flavours: [],
    needs: [],
    budget: 'any',
    note: '',
    ...partial,
  };
}

/** The feelings the customer picked, primary first: `[mood, secondaryMood]`
 * with the null removed (§4.2's mood term averages over exactly these). */
export function moodsOf(inputs: Pick<SuggestInputs, 'mood' | 'secondaryMood'>): Mood[] {
  return inputs.secondaryMood ? [inputs.mood, inputs.secondaryMood] : [inputs.mood];
}
