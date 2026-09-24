// Phase 7 · SUG-3 — deterministic scorer (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.3).
//
// score = 0.35·mood + 0.20·extras + 0.15·daypart + 0.20·profile + 0.10·popularity,
// each term clamped to [0,1], then a flat −0.1 "seen it last 3 visits"
// explore nudge, then clamped to [0,1] again. Weights are exported constants,
// not env — a change here is a reviewed diff + eval re-run (spec, end of §5.3).
//
// Pure: no Supabase, no 'server-only'. Runs in <20ms per spec §1 so it's a
// safe fallback path when the LLM is slow/down/over budget.

import type { FilteredCandidate } from './filter';
import type { Candidate, Daypart, Mood, MenuItemTraits, SuggestInputs, TasteProfile } from './types';
import { SUGGEST_LIMITS } from './types';

// ---------------------------------------------------------------------------
// Weights (§5.3) — the exact numbers from the spec.
// ---------------------------------------------------------------------------

export const MOOD_WEIGHT = 0.35;
export const EXTRAS_WEIGHT = 0.2;
export const DAYPART_WEIGHT = 0.15;
export const PROFILE_WEIGHT = 0.2;
export const POPULARITY_WEIGHT = 0.1;

/** §5.3 — items ordered in the last 3 visits get this flat penalty so the
 * picks explore while the "usual" card covers habit. */
export const RECENT_ITEM_PENALTY = 0.1;

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

// ---------------------------------------------------------------------------
// mood term (§5.3): "1 if the mood key ∈ moods; plus a mood-specific trait
// bonus". Membership alone already saturates the term at 1, so the bonus
// only matters when an item ISN'T tagged with the mood but still fits it by
// trait (e.g. a high-caffeine drink the tagger didn't mark 'boost') — it's
// how such an item earns partial credit instead of a flat 0. Split as
// 0.7 membership / 0.3 trait-bonus (both are ours to choose; the spec fixes
// only the top-level 0.35 weight) so the two additive terms clamp cleanly.
// ---------------------------------------------------------------------------

const MOOD_MATCH_SHARE = 0.7;
const MOOD_TRAIT_BONUS_SHARE = 0.3;

function moodTraitBonusApplies(mood: Mood, traits: MenuItemTraits, profile: TasteProfile | null): boolean {
  switch (mood) {
    case 'boost':
      return traits.caffeine === 'high' || traits.caffeine === 'medium';
    case 'cosy':
      return traits.temperature === 'hot' && traits.body === 'rich';
    case 'celebrate':
      return traits.kind === 'dessert' || traits.sweetness >= 2;
    case 'comfort':
      return traits.body === 'rich' || traits.sweetness >= 2;
    case 'cool':
      return traits.temperature === 'iced';
    case 'surprise': {
      // Novelty: not one of the customer's own top items. With no profile
      // (guest) everything is equally novel, so the bonus applies.
      if (!profile) return true;
      return !profile.topItems.some((t) => t.menu_item_id === traits.menu_item_id);
    }
  }
}

function moodScore(inputs: SuggestInputs, traits: MenuItemTraits, profile: TasteProfile | null): number {
  let s = 0;
  if (traits.moods.includes(inputs.mood)) s += MOOD_MATCH_SHARE;
  if (moodTraitBonusApplies(inputs.mood, traits, profile)) s += MOOD_TRAIT_BONUS_SHARE;
  return clamp01(s);
}

// ---------------------------------------------------------------------------
// extras term (§5.3): fraction of chosen extras satisfied. No extras chosen
// is treated as fully satisfied (1) — there's nothing to fall short of, and
// scoring it 0 would wrongly punish every candidate whenever the customer
// left this step blank (all-optional per §3.2).
// ---------------------------------------------------------------------------

function extraSatisfied(extra: SuggestInputs['extras'][number], traits: MenuItemTraits): boolean {
  switch (extra) {
    case 'sweet':
      return traits.sweetness >= 2;
    case 'eat':
      return traits.kind === 'food' || traits.kind === 'dessert';
    case 'light':
      return traits.body === 'light';
    case 'filling':
      return traits.body === 'rich';
  }
}

function extrasScore(inputs: SuggestInputs, traits: MenuItemTraits): number {
  if (inputs.extras.length === 0) return 1;
  const satisfied = inputs.extras.filter((e) => extraSatisfied(e, traits)).length;
  return clamp01(satisfied / inputs.extras.length);
}

// ---------------------------------------------------------------------------
// daypart term (§5.3): 1 if the current IST daypart is one this item suits.
// ---------------------------------------------------------------------------

function daypartScore(daypart: Daypart, traits: MenuItemTraits): number {
  return traits.dayparts.includes(daypart) ? 1 : 0;
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
}

/** Sorted desc by score; ties break on menuItemId ascending, so ordering is
 * fully deterministic (same inputs ⇒ same shortlist, every time). */
export function scoreCandidates(args: ScoreCandidatesArgs): Candidate[] {
  const { candidates, inputs, profile, daypart, popularity, recentItemIds } = args;
  const popularityFor = popularityNormalizer(popularity);
  const recent = new Set(recentItemIds);

  const scored: Candidate[] = candidates.map((c) => {
    const minPrice = Math.min(...c.item.variants.map((v) => v.price_inr));
    const weighted =
      MOOD_WEIGHT * moodScore(inputs, c.traits, profile) +
      EXTRAS_WEIGHT * extrasScore(inputs, c.traits) +
      DAYPART_WEIGHT * daypartScore(daypart, c.traits) +
      PROFILE_WEIGHT * profileScore(c, minPrice, profile) +
      POPULARITY_WEIGHT * popularityFor(c.item.id);

    const penalised = recent.has(c.item.id) ? weighted - RECENT_ITEM_PENALTY : weighted;

    return {
      menuItemId: c.item.id,
      score: clamp01(penalised),
      minPriceInr: minPrice,
      category: c.item.category,
      traits: c.traits,
    };
  });

  return scored.sort((a, b) => b.score - a.score || a.menuItemId.localeCompare(b.menuItemId));
}

/**
 * §5.3 diversity rules: at most `maxPerCategoryInShortlist` per category, and
 * (when "Something to eat" was chosen) at least one food/dessert item
 * guaranteed somewhere in the top-`shortlist` list.
 */
export function buildShortlist(scored: Candidate[], inputs: SuggestInputs): Candidate[] {
  const perCategory = new Map<string, number>();
  const shortlist: Candidate[] = [];

  for (const c of scored) {
    if (shortlist.length >= SUGGEST_LIMITS.shortlist) break;
    const count = perCategory.get(c.category) ?? 0;
    if (count >= SUGGEST_LIMITS.maxPerCategoryInShortlist) continue;
    shortlist.push(c);
    perCategory.set(c.category, count + 1);
  }

  const wantsToEat = inputs.extras.includes('eat');
  const hasFoodOrDessert = shortlist.some((c) => c.traits.kind === 'food' || c.traits.kind === 'dessert');
  if (wantsToEat && !hasFoodOrDessert) {
    const inShortlist = new Set(shortlist.map((c) => c.menuItemId));
    const bestFood = scored.find(
      (c) => (c.traits.kind === 'food' || c.traits.kind === 'dessert') && !inShortlist.has(c.menuItemId),
    );
    if (bestFood) {
      if (shortlist.length < SUGGEST_LIMITS.shortlist) {
        shortlist.push(bestFood);
      } else {
        // Replace the lowest-scored pick (list is already sorted desc from
        // `scored`, so the last slot is the weakest) to make room without
        // growing past the limit.
        const worst = shortlist[shortlist.length - 1];
        perCategory.set(worst.category, (perCategory.get(worst.category) ?? 1) - 1);
        shortlist[shortlist.length - 1] = bestFood;
      }
      perCategory.set(bestFood.category, (perCategory.get(bestFood.category) ?? 0) + 1);
    }
  }

  return shortlist;
}
