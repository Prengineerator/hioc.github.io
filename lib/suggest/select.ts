// Coffey v2 — choosing three DIFFERENT picks (docs/COFFEY-SPEC.md §4.4).
//
// Shared by Jev (lib/suggest/jevDecider.ts hands it the blended scores) and the
// deterministic fallback (lib/suggest/templates.ts deterministicPicks hands it
// each candidate's own score). It replaces v1's pickWithVarietyTieBreak, which
// only ever nudged near-equal scores apart: the 2026-09-29 production sessions
// showed picks #2 and #3 copying #1 ("Cappuccino Iced, Latte Iced, Brookie
// Creme"), because the ranking scored the same thing three times.
//
// Pure: no Supabase, no 'server-only'.

import { flavourFamiliesOf } from './flavor';
import type { Candidate, FlavourFamily, SuggestInputs } from './types';
import { KINDS, SUGGEST_LIMITS } from './types';

/** How hard a pick is marked down for resembling one already chosen (§4.4):
 * the most similar possible twin (sim = 1) loses 0.12 of score, which is enough
 * to prefer a clearly different item of nearly the same merit, and too little to
 * ever promote a poor item over a good one. */
export const MMR_LAMBDA = 0.12;

/** What similarity needs to know about a candidate. */
export type SimilarityInput = Pick<Candidate, 'name' | 'category' | 'traits'>;

/** A candidate's flavour families — looked up through a cache during a selection
 * run, so they are worked out once per candidate rather than once per pair. */
type FamilyLookup = (c: SimilarityInput) => ReadonlySet<FlavourFamily>;

function similarity(a: SimilarityInput, b: SimilarityInput, familiesOf: FamilyLookup): number {
  let sim = 0;
  if (a.category === b.category) sim += 0.5;
  const fa = familiesOf(a);
  const fb = familiesOf(b);
  if ([...fa].some((f) => fb.has(f))) sim += 0.3;
  if (a.traits.kind === b.traits.kind && a.traits.temperature === b.traits.temperature) sim += 0.2;
  return sim;
}

function uncachedFamilies(c: SimilarityInput): ReadonlySet<FlavourFamily> {
  return new Set(flavourFamiliesOf(c.name, c.traits.flavor_notes));
}

/**
 * §4.4 — how alike two candidates are, in [0, 1]:
 *   0.5 · same category  +  0.3 · shares a flavour family
 *   +  0.2 · (same kind AND same temperature)
 */
export function pickSimilarity(a: SimilarityInput, b: SimilarityInput): number {
  return similarity(a, b, uncachedFamilies);
}

/**
 * §4.4 — the picks: `count` (default 3) DIFFERENT candidates from `ranked`,
 * returned best score first.
 *
 *  1. Sort defensively (stable — equal scores keep the caller's order), so a
 *     caller may hand the list in any order.
 *  2. Kind coverage: when the customer asked for more than one kind ("a drink
 *     and something sweet"), first take the best-scoring candidate of each
 *     requested kind that exists, in KINDS order (drink, dessert, food) — the
 *     pairing they asked for beats a third drink.
 *  3. Fill the remaining slots by MMR: repeatedly take
 *     argmax(score − MMR_LAMBDA · maxSimilarity(candidate, picked)).
 *  4. Sort the picks by score, descending.
 *
 * `score` is the caller's own (Jev's blended score, or the candidate's
 * deterministic one) — it is deliberately not read from `candidate.score`. The
 * same candidate appearing twice is only ever picked once.
 */
export function selectDiversePicks<T extends Candidate>(
  ranked: { candidate: T; score: number }[],
  inputs: Pick<SuggestInputs, 'kinds'>,
  count: number = SUGGEST_LIMITS.picks,
): T[] {
  // Array.prototype.sort is stable, so equal scores keep their incoming order.
  // A non-finite score (a decider answer that never came) counts as 0, the lowest
  // score there is, rather than poisoning the comparison.
  const pool = ranked
    .map((entry, order) => ({ candidate: entry.candidate, score: Number.isFinite(entry.score) ? entry.score : 0, order }))
    .sort((a, b) => b.score - a.score);

  const familyCache = new Map<string, ReadonlySet<FlavourFamily>>();
  const familiesOf: FamilyLookup = (c) => {
    // Keyed by name + notes rather than object identity, so it is right even if a
    // caller passes distinct-but-equal candidates.
    const key = `${c.name}\u0000${(c.traits.flavor_notes ?? []).join('\u0001')}`;
    let families = familyCache.get(key);
    if (!families) {
      families = uncachedFamilies(c);
      familyCache.set(key, families);
    }
    return families;
  };

  const picked: typeof pool = [];
  const pickedIds = new Set<string>();
  const take = (entry: (typeof pool)[number]) => {
    picked.push(entry);
    pickedIds.add(entry.candidate.menuItemId);
  };

  // 2 — kind coverage.
  if (inputs.kinds.length > 1) {
    for (const kind of KINDS) {
      if (picked.length >= count) break;
      if (!inputs.kinds.includes(kind)) continue;
      const best = pool.find((e) => e.candidate.traits.kind === kind && !pickedIds.has(e.candidate.menuItemId));
      if (best) take(best);
    }
  }

  // 3 — MMR fill.
  while (picked.length < count) {
    let chosen: (typeof pool)[number] | null = null;
    let chosenValue = Number.NEGATIVE_INFINITY;
    for (const entry of pool) {
      if (pickedIds.has(entry.candidate.menuItemId)) continue;
      const maxSim = picked.reduce((m, p) => Math.max(m, similarity(entry.candidate, p.candidate, familiesOf)), 0);
      const value = entry.score - MMR_LAMBDA * maxSim;
      // Strictly greater, so an exact tie goes to the earlier (higher-ranked) entry.
      if (value > chosenValue) {
        chosen = entry;
        chosenValue = value;
      }
    }
    if (!chosen) break; // nothing left to pick
    take(chosen);
  }

  // 4 — best score first; equal scores keep their ranked order.
  return picked.sort((a, b) => b.score - a.score || a.order - b.order).map((e) => e.candidate);
}
