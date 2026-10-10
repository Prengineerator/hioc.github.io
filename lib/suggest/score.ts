// Phase 7 · SUG-3 — deterministic scorer (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.3,
// as rewritten by docs/COFFEY-SPEC.md §4.2).
//
// score = 0.30·mood + 0.25·preference + 0.10·daypart + 0.20·profile
//       + 0.10·popularity + 0.05·note,
// each term clamped to [0,1], then a flat −0.1 "seen it last 3 visits" explore
// nudge, then clamped to [0,1] again. Weights are exported constants, not env —
// a change here is a reviewed diff + eval re-run (spec, end of §5.3).
//
// Pure: no Supabase, no 'server-only'. Runs in <20ms per spec §1 so it's a
// safe fallback path when the LLM is slow/down/over budget.

import { reachableAddonFamilies } from './addonTraits';
import { flavourFamiliesOf } from './flavor';
import type { FilteredCandidate } from './filter';
import { moodsOf } from './inputs';
import { achievableSweetness, isSugarAdjustable } from './sugar';
import { sweetnessLevel, sweetnessTarget } from './sweetness';
import { FLAVOUR_FAMILY_INFO } from './traitVocabulary';
import type {
  AddonTraits,
  Candidate,
  Daypart,
  FlavourFamily,
  MenuItemTraits,
  Mood,
  SuggestInputs,
  TasteProfile,
  TraitBody,
  TraitCaffeine,
  TraitKind,
} from './types';
import { ADDON_SUGGEST_LIMITS, KINDS, SUGGEST_LIMITS, SWEETNESS_SCALE } from './types';

// ---------------------------------------------------------------------------
// Weights (COFFEY-SPEC §4.2) — the exact numbers from the spec.
// ---------------------------------------------------------------------------

export const MOOD_WEIGHT = 0.3;
export const PREFERENCE_WEIGHT = 0.25;
export const DAYPART_WEIGHT = 0.1;
export const PROFILE_WEIGHT = 0.2;
export const POPULARITY_WEIGHT = 0.1;
export const NOTE_WEIGHT = 0.05;

/** §5.3 — items ordered in the last 3 visits get this flat penalty so the
 * picks explore while the "usual" card covers habit. */
export const RECENT_ITEM_PENALTY = 0.1;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** What the customer-facing terms need to know about one item. A Candidate
 * satisfies it structurally, and so does a usual built from a menu row. */
export interface ScoredSubject {
  name: string;
  traits: MenuItemTraits;
  /** The item offers a sugar choice (lib/suggest/sugar.ts findSugarGroup). */
  sugarAdjustable: boolean;
  /** Requested flavour families the item lacks natively but can get from one of
   * its add-ons (lib/suggest/addonTraits.ts reachableAddonFamilies,
   * COFFEY-ADDONS-PAIRINGS-SPEC §3.1). Absent means none. */
  addonFlavourFamilies?: FlavourFamily[];
}

// ---------------------------------------------------------------------------
// mood term (§4.2): the MEAN over [mood, secondaryMood] of moodFit().
//
// moodFit is BLENDED when Jev's graded fit is on the row:
//   (1 − CHARACTER_SHARE)·clamp01(mood_fit[m] / 3) + CHARACTER_SHARE·moodCharacter(m).
// Why: a mood's top grade can be shared by most of the menu — on the live menu 81
// of 117 items have `celebrate` fit 3 (a dessert café) — so `mood_fit / 3` alone
// ties them and the deterministic ranker returns the same three items for every
// "celebrate" request. moodCharacter is how strongly the item has the trait that
// DEFINES that feeling (a real treat for celebrate, a hot low-refreshment cup for
// cosy, …), so it breaks the tie without overriding Jev's grade (COFFEY-SPEC §4.2).
//
// Rows tagged before Coffey have no mood_fit, and v1's rule for them ("1 if the mood key ∈
// moods, plus an all-or-nothing trait bonus") scored a thick Oreo shake exactly
// like an iced americano for "cool me down" — the 2026-09-29 baseline eval hit
// 0% on cool and celebrate, and popularity decided every tie. So the legacy fit
// is GRADED: 0.5·[m ∈ moods] + 0.5·g(m), where g(m) is how well the item's own
// traits serve that feeling, on a 0–1 scale.
// ---------------------------------------------------------------------------

const BOOST_BY_CAFFEINE: Record<TraitCaffeine, number> = { high: 1, medium: 0.6, low: 0.3, none: 0 };
const FOCUS_CAFFEINE: Record<TraitCaffeine, number> = { high: 1, medium: 1, low: 0.5, none: 0 };
/** Easy on the caffeine: a decaf is the best fit, a strong coffee the worst. */
const UNWIND_BY_CAFFEINE: Record<TraitCaffeine, number> = { none: 1, low: 0.7, medium: 0.3, high: 0 };
/** Something warm is more soothing than something cold, but cold is not far off. */
const UNWIND_COLD_FACTOR = 0.8;
const COSY_BY_BODY: Record<TraitBody, number> = { rich: 1, medium: 0.7, light: 0.4 };
const COMFORT_BY_BODY: Record<TraitBody, number> = { rich: 1, medium: 0.5, light: 0 };
const COOL_BY_BODY: Record<TraitBody, number> = { light: 1, medium: 0.7, rich: 0.3 };

/** g(m) — §4.2's table. `level` is sweetnessLevel(traits), so a legacy 0–3 row
 * and a v2 0–10 row are graded on the same scale. */
function traitGrade(mood: Mood, traits: MenuItemTraits, profile: TasteProfile | null): number {
  const level = sweetnessLevel(traits);
  switch (mood) {
    case 'boost':
      return BOOST_BY_CAFFEINE[traits.caffeine] ?? 0;
    case 'focus': {
      // Steady alertness: caffeine, not too sweet, not heavy.
      const caff = FOCUS_CAFFEINE[traits.caffeine] ?? 0;
      const sweet = level <= 3 ? 1 : level <= 6 ? 0.6 : 0.2;
      const bodyF = traits.body === 'rich' ? 0.5 : 1;
      return caff * sweet * bodyF;
    }
    case 'unwind':
      // Stressed: something soothing and gentle on the nerves — little or no
      // caffeine, and warmer is better.
      return (UNWIND_BY_CAFFEINE[traits.caffeine] ?? 0) * (traits.temperature === 'hot' ? 1 : UNWIND_COLD_FACTOR);
    case 'cosy':
      return traits.temperature === 'hot' ? (COSY_BY_BODY[traits.body] ?? 0) : 0;
    case 'comfort':
      return Math.max(COMFORT_BY_BODY[traits.body] ?? 0, level / SWEETNESS_SCALE.max);
    case 'celebrate':
      return traits.kind === 'dessert' ? 1 : level / SWEETNESS_SCALE.max;
    case 'cool':
      return traits.temperature === 'iced' ? (COOL_BY_BODY[traits.body] ?? 0) : 0;
    case 'surprise':
      // Novelty: not one of the customer's own top items. With no profile
      // (guest) everything is equally novel.
      return profile && profile.topItems.some((t) => t.menu_item_id === traits.menu_item_id) ? 0 : 1;
  }
}

/** How much of a graded moodFit comes from the mood's defining traits (§4.2). */
export const CHARACTER_SHARE = 0.25;

/**
 * How strongly the item has the trait that DEFINES `mood`, in [0,1] (§4.2). It
 * reads the v2 fields (0–3 fields as x/3); when any v2 field the mood's formula
 * needs is null/undefined it falls back to traitGrade, so a partly-tagged row is
 * still graded rather than scored 0. Exported for tests.
 */
export function moodCharacter(mood: Mood, traits: MenuItemTraits, profile: TasteProfile | null = null): number {
  const { indulgence, novelty, refreshment, intensity } = traits;
  const hot = traits.temperature === 'hot' ? 1 : 0;
  switch (mood) {
    case 'celebrate':
      if (!isFiniteNumber(indulgence) || !isFiniteNumber(novelty)) break;
      return clamp01(0.6 * (indulgence / 3) + 0.25 * (novelty / 3) + 0.15 * (traits.kind === 'dessert' ? 1 : 0));
    case 'comfort':
      if (!isFiniteNumber(indulgence) || !isFiniteNumber(novelty)) break;
      return clamp01(
        0.5 * (indulgence / 3) + 0.3 * (1 - novelty / 3) + 0.2 * (COMFORT_BY_BODY[traits.body] ?? 0),
      );
    case 'cosy':
      if (!isFiniteNumber(refreshment)) break;
      return clamp01(
        0.5 * hot + 0.3 * (1 - refreshment / 3) + 0.2 * (hot ? (COSY_BY_BODY[traits.body] ?? 0) : 0),
      );
    case 'boost':
      if (!isFiniteNumber(intensity)) break;
      return clamp01(0.7 * (BOOST_BY_CAFFEINE[traits.caffeine] ?? 0) + 0.3 * (intensity / 3));
    case 'focus':
      return clamp01(traitGrade('focus', traits, profile)); // no v2 dependency
    case 'unwind':
      if (!isFiniteNumber(intensity)) break;
      return clamp01(0.7 * traitGrade('unwind', traits, profile) + 0.3 * (1 - intensity / 3));
    case 'cool':
      if (!isFiniteNumber(refreshment)) break;
      return clamp01(0.7 * (refreshment / 3) + 0.3 * (traits.temperature === 'iced' ? 1 : 0));
    case 'surprise': {
      if (!isFiniteNumber(novelty)) break;
      const known = profile?.topItems.some((t) => t.menu_item_id === traits.menu_item_id) ?? false;
      return clamp01(0.7 * (novelty / 3) + 0.3 * (known ? 0 : 1));
    }
  }
  return clamp01(traitGrade(mood, traits, profile));
}

/** How well the item fits ONE feeling, in [0,1] (§4.2). */
export function moodFit(traits: MenuItemTraits, mood: Mood, profile: TasteProfile | null = null): number {
  const graded = traits.mood_fit?.[mood];
  if (isFiniteNumber(graded)) {
    return clamp01(
      (1 - CHARACTER_SHARE) * clamp01(graded / 3) + CHARACTER_SHARE * moodCharacter(mood, traits, profile),
    );
  }
  const member = traits.moods.includes(mood) ? 1 : 0;
  return clamp01(0.5 * member + 0.5 * traitGrade(mood, traits, profile));
}

function moodScore(inputs: SuggestInputs, traits: MenuItemTraits, profile: TasteProfile | null): number {
  const moods = moodsOf(inputs);
  return clamp01(moods.reduce((sum, m) => sum + moodFit(traits, m, profile), 0) / moods.length);
}

// ---------------------------------------------------------------------------
// preference term (§4.2): the mean of the sub-fits that APPLY — sweetness, body,
// strength, flavours — each in [0,1]. A sub-fit applies only when the customer
// expressed a view ('any' / no flavours = no view), so leaving the whole step
// blank scores 1 (nothing to fall short of; scoring it 0 would wrongly punish
// every candidate whenever the customer skipped it). All four are SOFT — the
// hard limits live in filter.ts.
//
// preferenceFits() is exported so match tags (templates.ts matchTagsFor) can ask
// "did this item actually match?" from the SAME numbers the ranking used.
// ---------------------------------------------------------------------------

/** A sub-fit, or null when the customer expressed no view on it. */
export interface PreferenceFits {
  sweetness: number | null;
  body: number | null;
  strength: number | null;
  flavours: number | null;
}

const LIGHT_BODY_FIT: Record<TraitBody, number> = { light: 1, medium: 0.5, rich: 0 };
const RICH_BODY_FIT: Record<TraitBody, number> = { rich: 1, medium: 0.5, light: 0 };
/** intensity (0 gentle → 3 bold) for a row with no v2 intensity: derived from caffeine. */
const INTENSITY_FROM_CAFFEINE: Record<TraitCaffeine, number> = { high: 3, medium: 2, low: 1, none: 0 };

export function preferenceFits(inputs: SuggestInputs, subject: ScoredSubject): PreferenceFits {
  const { traits } = subject;
  const fits: PreferenceFits = { sweetness: null, body: null, strength: null, flavours: null };

  // Sweetness: how close can the customer get? The item's inherent level, lifted
  // by optional table sugar where the item has a sugar choice — never lowered.
  const target = sweetnessTarget(inputs.sweetness);
  if (target !== null) {
    const achievable = achievableSweetness(sweetnessLevel(traits), subject.sugarAdjustable, target);
    fits.sweetness = clamp01(1 - Math.abs(achievable - target) / SWEETNESS_SCALE.max);
  }

  // Body. "Light" is also about refreshment, so when Jev has graded it the light
  // fit is averaged with refreshment / 3.
  if (inputs.body === 'light') {
    let fit = LIGHT_BODY_FIT[traits.body] ?? 0;
    if (isFiniteNumber(traits.refreshment)) fit = (fit + clamp01(traits.refreshment / 3)) / 2;
    fits.body = clamp01(fit);
  } else if (inputs.body === 'rich') {
    fits.body = RICH_BODY_FIT[traits.body] ?? 0;
  }

  // Strength is about COFFEE: a hot chocolate has no "strength" to be strong or
  // mild about, so for anything but a coffee drink this sub-fit doesn't apply.
  if (inputs.strength !== 'any' && traits.kind === 'drink' && traits.is_coffee) {
    const intensity = isFiniteNumber(traits.intensity) ? traits.intensity : (INTENSITY_FROM_CAFFEINE[traits.caffeine] ?? 0);
    if (inputs.strength === 'strong') fits.strength = clamp01(intensity / 3);
    else if (inputs.strength === 'mild') fits.strength = clamp01(1 - intensity / 3);
    else fits.strength = clamp01(1 - Math.abs(intensity - 1.5) / 1.5); // balanced
  }

  // Flavours: OR semantics — any one picked family is enough. One the item has
  // natively is a full match; one it can only get from an add-on (a Cappucino
  // with Hazelnut syrup) is a partial one (COFFEY-ADDONS-PAIRINGS-SPEC §3.1).
  if (inputs.flavours.length > 0) {
    const families = flavourFamiliesOf(subject.name, traits.flavor_notes);
    const viaAddon = subject.addonFlavourFamilies ?? [];
    if (inputs.flavours.some((f) => families.includes(f))) fits.flavours = 1;
    else if (inputs.flavours.some((f) => viaAddon.includes(f))) fits.flavours = ADDON_SUGGEST_LIMITS.flavourFit;
    else fits.flavours = 0;
  }

  return fits;
}

function preferenceScore(inputs: SuggestInputs, subject: ScoredSubject): number {
  const applicable = Object.values(preferenceFits(inputs, subject)).filter((v): v is number => v !== null);
  if (applicable.length === 0) return 1;
  return clamp01(applicable.reduce((a, b) => a + b, 0) / applicable.length);
}

// ---------------------------------------------------------------------------
// daypart term (§4.2): 1 if the current IST daypart is one this item suits.
//
// A quiet nudge, never in copy (the tone guide bans health claims): caffeine
// taken within about six hours of bedtime disrupts sleep even when people don't
// notice it, so for a medium- or high-caffeine item the term is halved in the
// evening (17:00–20:59) and is 0 late (21:00+) — however the item is tagged.
//
// The nudge is waived only for an EXPLICIT ask for caffeine: a feeling of boost
// (primary or secondary), coffee as the base, or a strength preference. 'focus'
// is deliberately NOT exempt — studying late is exactly when the sleep cost bites.
// ---------------------------------------------------------------------------

/** The customer asked for caffeine in so many words. */
function askedForCaffeine(inputs: SuggestInputs): boolean {
  return moodsOf(inputs).includes('boost') || inputs.base === 'coffee' || inputs.strength !== 'any';
}

/** What a caffeinated item's daypart term is multiplied by in the evening. */
const EVENING_CAFFEINE_FACTOR = 0.5;

export function daypartScore(daypart: Daypart, traits: MenuItemTraits, inputs: SuggestInputs): number {
  if (!traits.dayparts.includes(daypart)) return 0;
  const caffeinated = traits.caffeine === 'medium' || traits.caffeine === 'high';
  if (!caffeinated || askedForCaffeine(inputs)) return 1;
  if (daypart === 'late') return 0;
  if (daypart === 'evening') return EVENING_CAFFEINE_FACTOR;
  return 1;
}

// ---------------------------------------------------------------------------
// note term (§4.2): the customer's free text ("studying late", "sharing with a
// friend") as a keyword-affinity, on top of what the decider reads. 1 when a
// MEANINGFUL note token matches a token of the item's name, a flavour note, a
// texture or a family label; otherwise 0.
//
// The note is UNTRUSTED customer text (playbook S-2): this only ever compares
// words, so it can steer a score by at most NOTE_WEIGHT and can't do anything
// else. No regex is built from it.
// ---------------------------------------------------------------------------

/** Words ignored as note tokens: function words and generic request filler that
 * would otherwise "match" menu words ("the" in "On The Rocks"). Deliberately
 * small — menu words like "coffee", "iced" or "cake" are real preferences. */
const NOTE_STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'these', 'those', 'have', 'has', 'had', 'was', 'were', 'are',
  'you', 'your', 'our', 'but', 'too', 'all', 'any', 'one', 'out', 'its', 'can', 'could', 'would', 'should', 'will',
  'get', 'got', 'give', 'want', 'need', 'like', 'love', 'some', 'something', 'anything', 'please', 'really', 'very',
  'just', 'also', 'more', 'most', 'much', 'than', 'then', 'them', 'they', 'what', 'when', 'where', 'who', 'how', 'why',
  'feel', 'feeling', 'bit', 'lot', 'lots', 'little', 'today', 'tonight', 'now', 'about', 'into', 'maybe', 'thing',
  'things', 'okay',
]);

/** A negator turns the next NEGATION_WINDOW words into things the customer does
 * NOT want ("no strawberry", "without nuts", "don't like mint"). */
const NOTE_NEGATORS: ReadonlySet<string> = new Set(['no', 'not', 'without', 'less', 'avoid', 'hate', 'dont']);
const NEGATION_WINDOW = 2;
const MIN_TOKEN_LETTERS = 3;
/** Two different words match when they share at least this many leading letters
 * — enough for "strawberries" ~ "strawberry" and "chocolatey" ~ "chocolate". */
const MIN_SHARED_PREFIX = 5;

/** Lowercase a–z words: accents folded ("café" → "cafe"), apostrophes dropped
 * ("don't" → "dont"), everything else a separator. */
function wordsOf(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .split(/[^a-z]+/)
    .filter((w) => w.length > 0);
}

/** The words of the note that state something wanted: ≥3 letters, not a
 * stop-word, and not within NEGATION_WINDOW words after a negator. Punctuation
 * ends a negation ("no sugar, strawberry please" still wants strawberry). */
function meaningfulNoteTokens(note: string): string[] {
  const tokens: string[] = [];
  for (const clause of note.split(/[.,;:!?()\r\n]+/)) {
    let negatedThrough = -1;
    wordsOf(clause).forEach((word, i) => {
      if (NOTE_NEGATORS.has(word)) {
        negatedThrough = i + NEGATION_WINDOW;
        return;
      }
      if (i <= negatedThrough) return;
      if (word.length >= MIN_TOKEN_LETTERS && !NOTE_STOP_WORDS.has(word)) tokens.push(word);
    });
  }
  return tokens;
}

function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const limit = Math.min(a.length, b.length);
  let shared = 0;
  while (shared < limit && a[shared] === b[shared]) shared++;
  return shared >= MIN_SHARED_PREFIX;
}

/** Everything an item can be matched on: its name, flavour notes, textures and
 * the labels of the flavour families it belongs to. */
function itemTokens(item: Pick<ScoredSubject, 'name' | 'traits'>): string[] {
  const { traits } = item;
  const families = flavourFamiliesOf(item.name, traits.flavor_notes).map((f) => FLAVOUR_FAMILY_INFO[f].label);
  const texts = [item.name, ...(traits.flavor_notes ?? []), ...(traits.textures ?? []), ...families];
  return texts.flatMap(wordsOf).filter((w) => w.length >= MIN_TOKEN_LETTERS);
}

/**
 * §4.2 — 1 when a meaningful token of the customer's note matches a token of
 * the item (an equal word, or a shared prefix of ≥5 letters), else 0. Negated
 * words never count: "no strawberry" must not pull in the strawberry creme.
 */
export function noteAffinity(note: string, item: Pick<ScoredSubject, 'name' | 'traits'>): number {
  if (typeof note !== 'string' || note.trim().length === 0) return 0;
  const wanted = meaningfulNoteTokens(note);
  if (wanted.length === 0) return 0;
  const have = itemTokens(item);
  return wanted.some((w) => have.some((h) => tokensMatch(w, h))) ? 1 : 0;
}

// ---------------------------------------------------------------------------
// profile term (§5.3 + §5.5): "category affinity + trait affinity (hot/iced
// ratio, sweetness preference) + price-comfort fit", plus the orderingMood
// bonuses §5.5 describes ("treating adds a small dessert/add-on bonus;
// saving a value bonus; explorer the novelty bonus"). 'routine' has no
// per-item scoring effect — §5.5 says it "raises the usual card's
// prominence", which is a display concern for the engine/page, not a score
// term. 0 when signed out (no profile).
//
// The three base sub-terms are each their own [0,1] score, averaged, then
// the orderingMood bonus is added on top and the whole thing is clamped —
// sub-splits inside the 0.20 top-level weight are ours to choose (as with
// the mood term above); the spec fixes only what feeds in and what the
// price-comfort rule must do at the edges (budget customers lean to ≤p75,
// premium gets no penalty).
//
// UNCHANGED by Coffey (§4.2): it deliberately keeps reading the legacy 0–3
// `sweetness` column, because the taste profile's meanSweetness is built from
// that same column (and every v2 write keeps it derived).
// ---------------------------------------------------------------------------

const ORDERING_MOOD_BONUS = 0.15;

function priceComfortFit(minPrice: number, profile: TasteProfile): number {
  if (profile.priceComfort === 'premium') return 1; // "no penalty" — never scored down.
  if (minPrice <= profile.ticket.p75) return 1;
  const p75 = Math.max(profile.ticket.p75, 1);
  return clamp01(1 - (minPrice - profile.ticket.p75) / p75);
}

function profileScore(candidate: FilteredCandidate, minPrice: number, profile: TasteProfile | null): number {
  if (!profile) return 0;

  const categoryScore = clamp01(profile.categoryAffinity[candidate.item.category] ?? 0);

  const { temperature, sweetness } = candidate.traits;
  let icedHotAlignment = 0.5; // 'either'/'ambient': neutral, always decently aligned.
  if (temperature === 'iced') icedHotAlignment = profile.traitLean.icedShare;
  else if (temperature === 'hot') icedHotAlignment = 1 - profile.traitLean.icedShare;
  const sweetnessCloseness = clamp01(1 - Math.abs(sweetness - profile.traitLean.meanSweetness) / 3);
  const traitScore = clamp01((icedHotAlignment + sweetnessCloseness) / 2);

  const priceFitScore = priceComfortFit(minPrice, profile);

  let score = clamp01((categoryScore + traitScore + priceFitScore) / 3);

  if (profile.orderingMood === 'treating' && candidate.traits.kind !== 'drink') {
    score += ORDERING_MOOD_BONUS;
  } else if (profile.orderingMood === 'saving' && minPrice <= profile.ticket.median) {
    score += ORDERING_MOOD_BONUS;
  } else if (
    profile.orderingMood === 'explorer' &&
    !profile.topItems.some((t) => t.menu_item_id === candidate.item.id)
  ) {
    score += ORDERING_MOOD_BONUS;
  }

  return clamp01(score);
}

// ---------------------------------------------------------------------------
// popularity term (§5.3): 30-day units, min-max normalised ACROSS THE MENU
// (the whole popularity map passed in), not just across today's candidates —
// otherwise a shortlist of uniformly-slow-selling items would wrongly look
// as popular as the bestsellers.
// ---------------------------------------------------------------------------

function popularityNormalizer(popularity: Map<string, number>): (menuItemId: string) => number {
  const values = [...popularity.values()];
  if (values.length === 0) return () => 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === min) return () => 0; // no spread — no signal either way.
  return (menuItemId: string) => clamp01(((popularity.get(menuItemId) ?? 0) - min) / (max - min));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScoreCandidatesArgs {
  candidates: FilteredCandidate[];
  inputs: SuggestInputs;
  profile: TasteProfile | null;
  daypart: Daypart;
  /** menuItemId → units sold in the last 30 days, across the WHOLE menu. */
  popularity: Map<string, number>;
  /** Items ordered in the customer's last 3 visits (§5.3 explore nudge). */
  recentItemIds: string[];
  /** The owner's add-on trait overrides, keyed by option id
   * (COFFEY-ADDONS-PAIRINGS-SPEC §2.3). Absent means the derived defaults. */
  addonTraitsById?: Map<string, AddonTraits>;
}

/** Sorted desc by score; ties break on menuItemId ascending, so ordering is
 * fully deterministic (same inputs ⇒ same shortlist, every time). */
export function scoreCandidates(args: ScoreCandidatesArgs): Candidate[] {
  const { candidates, inputs, profile, daypart, popularity, recentItemIds, addonTraitsById } = args;
  const popularityFor = popularityNormalizer(popularity);
  const recent = new Set(recentItemIds);

  const scored: Candidate[] = candidates.map((c) => {
    const minPrice = Math.min(...c.item.variants.map((v) => v.price_inr));
    const maxPrice = Math.max(...c.item.variants.map((v) => v.price_inr));
    const subject: ScoredSubject = {
      name: c.item.name,
      traits: c.traits,
      sugarAdjustable: isSugarAdjustable(c.item),
      addonFlavourFamilies: reachableAddonFamilies(c.item, c.traits, inputs, addonTraitsById),
    };
    const weighted =
      MOOD_WEIGHT * moodScore(inputs, c.traits, profile) +
      PREFERENCE_WEIGHT * preferenceScore(inputs, subject) +
      DAYPART_WEIGHT * daypartScore(daypart, c.traits, inputs) +
      PROFILE_WEIGHT * profileScore(c, minPrice, profile) +
      POPULARITY_WEIGHT * popularityFor(c.item.id) +
      NOTE_WEIGHT * noteAffinity(inputs.note, subject);

    const penalised = recent.has(c.item.id) ? weighted - RECENT_ITEM_PENALTY : weighted;

    return {
      menuItemId: c.item.id,
      name: c.item.name,
      score: clamp01(penalised),
      minPriceInr: minPrice,
      maxPriceInr: maxPrice,
      category: c.item.category,
      description: c.item.description,
      traits: c.traits,
      sugarAdjustable: subject.sugarAdjustable,
      addonFlavourFamilies: subject.addonFlavourFamilies,
    };
  });

  return scored.sort(byScoreThenId);
}

function byScoreThenId(a: Candidate, b: Candidate): number {
  return b.score - a.score || a.menuItemId.localeCompare(b.menuItemId);
}

/** The index of the weakest shortlist entry that can be dropped without leaving
 * a requested kind unrepresented, or -1. Lowest score wins; among equals the
 * later entry goes first (the list is best-first). */
function weakestEvictable(list: Candidate[], requested: readonly TraitKind[]): number {
  const held = new Map<TraitKind, number>();
  for (const c of list) held.set(c.traits.kind, (held.get(c.traits.kind) ?? 0) + 1);

  let weakest = -1;
  list.forEach((c, i) => {
    const soleHolderOfRequestedKind = requested.includes(c.traits.kind) && held.get(c.traits.kind) === 1;
    if (soleHolderOfRequestedKind) return;
    if (weakest === -1 || c.score <= list[weakest].score) weakest = i;
  });
  return weakest;
}

/**
 * §5.3 diversity rules, plus COFFEY-SPEC §4.3 kind coverage: at most
 * `maxPerCategoryInShortlist` per category — deliberately generous (8, not a
 * tight 2) so the decider actually sees the menu's full spread of, say, hot
 * coffees rather than only its top 2 — out of `shortlist` entries in total; and,
 * when the customer asked for more than one kind ("a drink and something
 * sweet"), the best-scoring candidate of EACH requested kind is guaranteed to be
 * in the list. That generalises v1's "one food/dessert when they chose to eat".
 * The guarantee is what lets the picks pair a drink with a dessert even when a
 * wide-open drink pool would otherwise fill all the slots.
 */
export function buildShortlist(scored: Candidate[], inputs: SuggestInputs): Candidate[] {
  const perCategory = new Map<string, number>();
  const shortlist: Candidate[] = [];
  const add = (c: Candidate) => {
    shortlist.push(c);
    perCategory.set(c.category, (perCategory.get(c.category) ?? 0) + 1);
  };

  for (const c of scored) {
    if (shortlist.length >= SUGGEST_LIMITS.shortlist) break;
    if ((perCategory.get(c.category) ?? 0) >= SUGGEST_LIMITS.maxPerCategoryInShortlist) continue;
    add(c);
  }

  if (inputs.kinds.length > 1) {
    const requested = KINDS.filter((k) => inputs.kinds.includes(k));
    let changed = false;
    for (const kind of requested) {
      const best = scored.find((c) => c.traits.kind === kind);
      if (!best || shortlist.some((c) => c.menuItemId === best.menuItemId)) continue;

      if (shortlist.length < SUGGEST_LIMITS.shortlist) {
        add(best);
      } else {
        // Make room without growing past the limit: drop the weakest entry that
        // isn't the only one holding a requested kind, and keep the category
        // counts consistent with what is actually in the list.
        const evict = weakestEvictable(shortlist, requested);
        if (evict === -1) continue;
        const [dropped] = shortlist.splice(evict, 1);
        perCategory.set(dropped.category, (perCategory.get(dropped.category) ?? 1) - 1);
        add(best);
      }
      changed = true;
    }
    // Forced entries went in at the end: restore the best-first order.
    if (changed) shortlist.sort(byScoreThenId);
  }

  return shortlist;
}
