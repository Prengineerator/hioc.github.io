// Phase 7 · SUG-3 — deterministic, house-tone copy (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §4 tone guide, §5.4 "Validation" fallback, §3.2 step-3 header), and, from
// Coffey v2 (docs/COFFEY-SPEC.md §4.6), the "why it matches" tags. Every
// string this file produces is deterministic (same inputs ⇒ same text), and is
// every reason Jev's picks carry (Jev can't write text), plus the whole
// response whenever the model is skipped or times out.
//
// Pure: no Supabase, no 'server-only'.

import { flavourFamiliesOf } from './flavor';
import { moodsOf } from './inputs';
import { preferenceFits } from './score';
import { selectDiversePicks } from './select';
import { achievableSweetness } from './sugar';
import { sweetnessLevel, sweetnessTarget } from './sweetness';
import { lintReason, sanitizeNote } from './tone';
import { FLAVOUR_FAMILY_INFO, MOOD_INFO } from './traitVocabulary';
import type {
  Budget,
  Candidate,
  FlavourAddonSuggestion,
  FlavourFamily,
  MenuItemTraits,
  Mood,
  SuggestInputs,
  SuggestionPick,
  SweetnessPref,
} from './types';
import { CURRENT_TRAITS_VERSION, SUGGEST_LIMITS } from './types';

function capReason(text: string): string {
  const clean = sanitizeNote(text);
  if (clean.length <= SUGGEST_LIMITS.reasonMaxChars) return clean;
  // Safety net only: reasonFrom() below already prefers a shorter variant to a
  // truncated one, so this fires only if even the plainest sentence is too long.
  return `${clean.slice(0, SUGGEST_LIMITS.reasonMaxChars - 1).trimEnd()}…`;
}

/** The first candidate sentence that fits the cap and passes the tone lint,
 * else the plain `fallback` (a fixed string, so it always does). Every output of
 * templateReason() goes through here: flavour notes come from the database (an
 * owner-edited row can hold anything), so "tone-linted, ≤120 chars" is enforced
 * rather than hoped for. */
function reasonFrom(candidates: string[], fallback: string): string {
  const ok = candidates.find((text) => text.length <= SUGGEST_LIMITS.reasonMaxChars && lintReason(text).ok);
  return capReason(ok ?? fallback);
}

// ---------------------------------------------------------------------------
// Which feeling an item serves
// ---------------------------------------------------------------------------

/**
 * An item "fits" a feeling (COFFEY-SPEC §4.6: "fit ≥ 2 or membership"): when Jev
 * graded it for that feeling (a v2 row), the GRADE decides — ≥2 of 3 — and when
 * it did not, the mood being in the row's `moods` does (all a row tagged before
 * Coffey has). It is the same either/or the score's mood term uses (§4.2:
 * `mood_fit[m] / 3` when present, otherwise the legacy fit), so a pick card never
 * names a feeling the ranking did not see, and it is the same test
 * lib/suggest/brief.ts suitsMood() applies to Jev's `best_for` — the two are
 * checked to agree (tests/suggestJev.test.ts).
 *
 * A graded row's `moods` is derived from its grades (≥2, else the single best
 * feeling of a poor lot), so the only disagreement is that fallback: an item Jev
 * graded 1.4 for its "best" feeling is not presented as a fit for it.
 */
export function fitsMood(traits: MenuItemTraits, mood: Mood): boolean {
  const graded = traits.mood_fit?.[mood];
  if (typeof graded === 'number' && Number.isFinite(graded)) return graded >= 2;
  return traits.moods.includes(mood);
}

/** The reasonCode for a pick: the first of the customer's feelings (primary
 * first) the item fits, else 'trait'. */
export function reasonCodeFor(traits: MenuItemTraits, inputs: Pick<SuggestInputs, 'mood' | 'secondaryMood'>): Mood | 'trait' {
  return moodsOf(inputs).find((m) => fitsMood(traits, m)) ?? 'trait';
}

// ---------------------------------------------------------------------------
// Flavour phrase (§4.6)
// ---------------------------------------------------------------------------

/** The first family the customer asked for that the item belongs to
 * (`inputs.flavours` order), or null. */
function requestedFamilyOf(inputs: SuggestInputs, name: string, traits: MenuItemTraits): FlavourFamily | null {
  if (inputs.flavours.length === 0) return null;
  const families = flavourFamiliesOf(name, traits.flavor_notes);
  return inputs.flavours.find((f) => families.includes(f)) ?? null;
}

interface FlavourPhrase {
  full: string;
  /** A shorter wording (one note instead of two; the family phrase without its
   * "from <add-on>") for when `full` doesn't fit. */
  short: string | null;
}

/**
 * "Name the taste, not the sale" (§4 "Do"). When the customer asked for a
 * flavour family and this item matches it, name that family in the words they
 * picked it by (FLAVOUR_FAMILY_INFO.phrase); when it only gets that family from
 * an add-on, say so — "toasty nutty notes from Hazelnut syrup"
 * (COFFEY-ADDONS-PAIRINGS-SPEC §3.3), with the bare family phrase as the
 * shorter wording; otherwise the item's top two notes. A v2 row's notes read
 * "espresso and roasty notes"; a pre-v2 row keeps v1's bare join ("bold and
 * nutty").
 */
function flavourPhraseFor(
  traits: MenuItemTraits,
  inputs: SuggestInputs,
  name: string,
  v2: boolean,
  addon: FlavourAddonSuggestion | null,
): FlavourPhrase | null {
  const family = requestedFamilyOf(inputs, name, traits);
  if (family) return { full: FLAVOUR_FAMILY_INFO[family].phrase, short: null };

  if (addon && inputs.flavours.includes(addon.family)) {
    const phrase = FLAVOUR_FAMILY_INFO[addon.family].phrase;
    return { full: `${phrase} from ${addon.label}`, short: phrase };
  }

  const notes = (traits.flavor_notes ?? []).filter((n) => typeof n === 'string' && n.trim().length > 0).slice(0, 2);
  if (notes.length === 0) return null;
  if (!v2) return { full: notes.join(' and '), short: null };
  return { full: `${notes.join(' and ')} notes`, short: notes.length > 1 ? `${notes[0]} notes` : null };
}

// ---------------------------------------------------------------------------
// Descriptors (§4.6): what the item IS, led by what the customer asked about
// ---------------------------------------------------------------------------

const INTENSITY_WORD = ['gentle', 'mellow', 'full-flavoured', 'bold'] as const;

/**
 * The word for a sweetness level, aligned to the CUSTOMER'S scale (Not sweet 0 ·
 * Lightly sweet 3 · Medium 5 · Sweet 7 · Very sweet 10) so that a target always
 * reads as its own label — someone who chose "Lightly sweet" is told the pick is
 * "lightly sweet", not "barely sweet":
 *   0–1 unsweetened · 2–3 lightly sweet · 4–5 medium-sweet · 6–8 sweet ·
 *   9–10 dessert-sweet
 */
function sweetnessWord(level: number): string {
  if (level <= 1) return 'unsweetened';
  if (level <= 3) return 'lightly sweet';
  if (level <= 5) return 'medium-sweet';
  if (level <= 8) return 'sweet';
  return 'dessert-sweet';
}

interface Descriptor {
  /** How it reads when it is the only descriptor. */
  alone: string;
  /** How it reads next to another ("Bold and crisp"). */
  paired: string;
  /** The customer asked about this dimension, so it goes first. */
  asked: boolean;
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * At most two descriptors, in this default order — intensity (drinks),
 * sweetness, refreshment, first texture — with the ones the customer asked
 * about (a strength, a sweetness, "light" or "rich") moved to the front.
 *
 * Sweetness is mentioned only when the customer set one, or when the item is at
 * an extreme (≤1 or ≥8) — a mid-sweet item needs no label. A savoury item is
 * never called "unsweetened" unprompted: it is true of garlic bread and adds
 * nothing. When the customer set a sweetness and the item has a sugar choice,
 * the word describes the drink as they will get it (the preset lifts it), not as
 * the kitchen makes it, so the sentence agrees with the sugar note on the card.
 */
function descriptorsFor(traits: MenuItemTraits, inputs: SuggestInputs, sugarAdjustable: boolean): Descriptor[] {
  const all: Descriptor[] = [];

  if (traits.kind === 'drink' && isFiniteNumber(traits.intensity)) {
    const word = INTENSITY_WORD[Math.min(3, Math.max(0, Math.round(traits.intensity)))];
    all.push({ alone: word, paired: word, asked: inputs.strength !== 'any' });
  }

  const inherent = sweetnessLevel(traits);
  const target = sweetnessTarget(inputs.sweetness);
  if (target !== null) {
    const word = sweetnessWord(achievableSweetness(inherent, sugarAdjustable, target));
    all.push({ alone: word, paired: word, asked: true });
  } else if ((inherent <= 1 && traits.kind !== 'food') || inherent >= 8) {
    const word = sweetnessWord(inherent);
    all.push({ alone: word, paired: word, asked: false });
  }

  if (isFiniteNumber(traits.refreshment) && traits.refreshment >= 2) {
    all.push({ alone: 'crisp and refreshing', paired: 'crisp', asked: inputs.body === 'light' });
  }

  const texture = traits.textures?.[0];
  if (typeof texture === 'string' && texture.trim().length > 0) {
    all.push({ alone: texture, paired: texture, asked: inputs.body === 'rich' });
  }

  return [...all.filter((d) => d.asked), ...all.filter((d) => !d.asked)].slice(0, 2);
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** "{Descriptor}{ and descriptor2}{, with <flavour>} — {clause}." — or, with no
 * descriptor to lead with, "A lovely pick{, with <flavour>} — {clause}." */
function richSentence(descriptors: Descriptor[], flavour: string | null, clause: string): string {
  const lead =
    descriptors.length === 0
      ? 'A lovely pick'
      : capitalise(
          descriptors.length === 1 ? descriptors[0].alone : descriptors.map((d) => d.paired).join(' and '),
        );
  return `${lead}${flavour ? `, with ${flavour}` : ''} — ${clause}.`;
}

/** What a 'trait' reason says where a mood reason names the feeling. */
const TRAIT_CLAUSE = 'a lovely match for what you asked for';

/**
 * A single-sentence, tone-linted reason for one item. `reasonCode` decides the
 * shape: a Mood writes that mood's clause (lib/suggest/traitVocabulary.ts
 * MOOD_INFO), 'usual' and 'popular' get their own framing, and 'trait' (the
 * general catch-all) says the pick matches what was asked for.
 *
 * Rows tagged under COFFEY-SPEC §3 (traits_version ≥ CURRENT_TRAITS_VERSION) get
 * the richer sentence of §4.6 — descriptors, the flavour phrase, then the
 * clause. Older rows keep v1's exact shapes. `name` is optional — it is only
 * needed to match the customer's flavour families against the item's own name
 * (flavor_notes alone still work without it, e.g. from a 'usual' call site).
 * `sugarAdjustable` (Candidate.sugarAdjustable) lets the sweetness descriptor
 * agree with the sugar preset; leaving it out describes the drink as made.
 * `addon` (lib/suggest/addonTraits.ts flavourAddonFor, COFFEY-ADDONS-PAIRINGS-SPEC
 * §3.3) is the add-on that gives the item a flavour the customer asked for: when
 * the item has no requested family of its own, the flavour phrase becomes
 * "<family phrase> from <label>", and it loses its " from <label>" before any
 * descriptor is dropped, or if the label fails the tone lint.
 *
 * Whatever the notes hold, the result is ≤ SUGGEST_LIMITS.reasonMaxChars and
 * passes lintReason(): a longer sentence is shortened by dropping detail, never
 * cut mid-word, and a sentence the lint rejects is replaced by the plain one.
 */
export function templateReason(
  traits: MenuItemTraits,
  inputs: SuggestInputs,
  reasonCode: SuggestionPick['reasonCode'],
  name = '',
  sugarAdjustable = false,
  addon: FlavourAddonSuggestion | null = null,
): string {
  const v2 = (traits.traits_version ?? 1) >= CURRENT_TRAITS_VERSION;
  const phrase = flavourPhraseFor(traits, inputs, name, v2, addon);
  const phrases = phrase ? [phrase.full, ...(phrase.short ? [phrase.short] : [])] : [];

  if (reasonCode === 'usual') {
    return reasonFrom(
      phrases.map((p) => `Your usual — ${p}, always a good choice.`),
      'Your usual — always a good choice.',
    );
  }
  if (reasonCode === 'popular') {
    return reasonFrom(
      phrases.map((p) => `Our regulars love this one, with ${p}.`),
      'Our regulars love this one.',
    );
  }

  const clause = reasonCode === 'trait' ? TRAIT_CLAUSE : MOOD_INFO[reasonCode].clause;
  const plain = `A lovely pick — ${clause}.`;

  if (!v2) {
    // v1's shapes, exactly. (The 'trait' clause is v1's too: with no notes it
    // reads "A lovely pick for what you asked for.")
    if (reasonCode === 'trait') {
      return reasonFrom(
        phrases.map((p) => `A lovely pick, with ${p}.`),
        'A lovely pick for what you asked for.',
      );
    }
    return reasonFrom(
      phrases.map((p) => `A lovely pick — ${p}, ${clause}.`),
      plain,
    );
  }

  // v2: richest sentence first, then progressively plainer until one fits.
  const descriptors = descriptorsFor(traits, inputs, sugarAdjustable);
  const attempts: string[] = [];
  for (let d = descriptors.length; d >= 0; d--) {
    for (const p of phrases) attempts.push(richSentence(descriptors.slice(0, d), p, clause));
  }
  for (let d = descriptors.length; d >= 0; d--) attempts.push(richSentence(descriptors.slice(0, d), null, clause));
  return reasonFrom(attempts, plain);
}

// One header per mood (COFFEY-SPEC §4.6), owned by the shared vocabulary.
export function templateHeader(mood: Mood): string {
  return MOOD_INFO[mood].header;
}

// ---------------------------------------------------------------------------
// Match tags (COFFEY-SPEC §4.6): up to three short "why it matches" pills, from
// a fixed vocabulary, in priority order.
// ---------------------------------------------------------------------------

/** The customer's own sweetness labels (COFFEY-SPEC §1, §4.6) — taste levels, not ingredients. */
const SWEETNESS_TAG: Record<Exclude<SweetnessPref, 'any'>, string> = {
  none: 'Not sweet',
  light: 'Lightly sweet',
  medium: 'Medium sweet',
  sweet: 'Sweet',
  very: 'Very sweet',
};

/** The budget label — the ceiling the customer chose (the wizard's chips read
 * "Up to ₹100 / ₹150 / ₹200"). */
const BUDGET_TAG: Record<Exclude<Budget, 'any'>, string> = {
  under_100: 'Up to ₹100',
  under_150: 'Up to ₹150',
  under_200: 'Up to ₹200',
};

/** A strength or body sub-fit at least this good counts as "matched" (2/3: an
 * intensity-2 drink for "strong", an intensity-1 one for "smooth & milky"). */
const TAG_MATCH_FIT = 0.66;

export const MAX_MATCH_TAGS = 3;

/** What a match tag needs to know about an item — a Candidate satisfies it as
 * is, and the "usual" (which isn't a Candidate) is built from its menu row.
 * `addonFlavourFamilies` is optional: absent means none. */
export type MatchTagSubject = Pick<Candidate, 'name' | 'traits' | 'sugarAdjustable' | 'addonFlavourFamilies'>;

/**
 * §4.6 — at most MAX_MATCH_TAGS labels saying why this item suits what the
 * customer asked for, in priority order:
 *  1. the feeling it fits (the first of theirs that it does)
 *  2. the flavour family they asked for that it belongs to — or, when it only
 *     gets one from an add-on, "<Family> add-on" (COFFEY-ADDONS-PAIRINGS-SPEC §3.3)
 *  3. their sweetness label, only when the sweetness they can get from the item
 *     (sugar counted) is in the SAME band as what they chose — the band the
 *     reason's descriptor is drawn from (sweetnessWord), so the tag can never
 *     contradict the sentence beside it
 *  4. Strong / Smooth & milky, when asked for and the coffee is that
 *  5. Iced / Hot, when asked for
 *  6. Light & refreshing / Rich & filling, when asked for and the item is that
 *  7. their budget ceiling ("Up to ₹150")
 *  8. Caffeine-free, when asked for
 * "Matched" uses the same sub-fits the ranking used (score.ts preferenceFits),
 * so a tag never claims what the score didn't see.
 */
export function matchTagsFor(subject: MatchTagSubject, inputs: SuggestInputs): string[] {
  const { traits } = subject;
  const fits = preferenceFits(inputs, subject);
  const tags: string[] = [];

  const mood = moodsOf(inputs).find((m) => fitsMood(traits, m));
  if (mood) tags.push(MOOD_INFO[mood].tag);

  const family = requestedFamilyOf(inputs, subject.name, traits);
  if (family) {
    tags.push(FLAVOUR_FAMILY_INFO[family].tag);
  } else {
    const viaAddon = inputs.flavours.find((f) => subject.addonFlavourFamilies?.includes(f));
    if (viaAddon) tags.push(`${FLAVOUR_FAMILY_INFO[viaAddon].tag} add-on`);
  }

  const target = sweetnessTarget(inputs.sweetness);
  if (target !== null && inputs.sweetness !== 'any') {
    // Same band as the target, not merely near it: an item at 4 for "lightly
    // sweet" (3) reads "medium-sweet" in its reason, so it earns no "Lightly sweet"
    // tag. (The reason describes the SAME achievable level — descriptorsFor.)
    const achievable = achievableSweetness(sweetnessLevel(traits), subject.sugarAdjustable, target);
    if (sweetnessWord(achievable) === sweetnessWord(target)) tags.push(SWEETNESS_TAG[inputs.sweetness]);
  }

  if (fits.strength !== null && fits.strength >= TAG_MATCH_FIT) {
    if (inputs.strength === 'strong') tags.push('Strong');
    else if (inputs.strength === 'mild') tags.push('Smooth & milky');
  }

  if (
    traits.kind === 'drink' &&
    inputs.temperature !== 'either' &&
    (traits.temperature === inputs.temperature || traits.temperature === 'either')
  ) {
    tags.push(inputs.temperature === 'iced' ? 'Iced' : 'Hot');
  }

  if (fits.body !== null && fits.body >= TAG_MATCH_FIT) {
    if (inputs.body === 'light') tags.push('Light & refreshing');
    else if (inputs.body === 'rich') tags.push('Rich & filling');
  }

  if (inputs.budget !== 'any') tags.push(BUDGET_TAG[inputs.budget]);

  if (inputs.needs.includes('no_caffeine') && traits.caffeine === 'none') tags.push('Caffeine-free');

  return tags.slice(0, MAX_MATCH_TAGS);
}

// ---------------------------------------------------------------------------
// Deterministic picks
// ---------------------------------------------------------------------------

/**
 * The deterministic ranking's own top picks (§5.4 "Validation" — what tops
 * up a short decider response, and what the whole response is when the
 * model is skipped). Three DIFFERENT picks (lib/suggest/select.ts, COFFEY-SPEC
 * §4.4: kind coverage, then MMR over each candidate's own score), best first.
 * `reasonCode` is the first of the customer's feelings the item fits, else
 * 'trait'; 'popular' needs a popularity signal this function isn't given (that's
 * the scorer's job upstream). matchTags and sugarPreset are attached later, by
 * the engine, once the picks are final.
 */
export function deterministicPicks(shortlist: Candidate[], inputs: SuggestInputs): SuggestionPick[] {
  const ranked = shortlist.map((candidate) => ({ candidate, score: candidate.score }));
  return selectDiversePicks(ranked, inputs, SUGGEST_LIMITS.picks).map((c) => {
    const reasonCode = reasonCodeFor(c.traits, inputs);
    return {
      menuItemId: c.menuItemId,
      reason: templateReason(c.traits, inputs, reasonCode, c.name, c.sugarAdjustable),
      reasonCode,
    };
  });
}
