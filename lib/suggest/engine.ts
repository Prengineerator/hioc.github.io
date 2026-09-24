// Phase 7 · SUG-4 — pure orchestration (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §5, the numbered pipeline). Composes the already-built pure libs — never
// duplicates their logic:
//
//   1. filter    lib/suggest/filter.ts    filterCandidates / relaxHintFor
//   2. score     lib/suggest/score.ts     scoreCandidates / buildShortlist
//   3. decide    an injected `Decider` (lib/suggest/llm.ts's opusDecider in
//                production; a fake in tests), guarded by a HARD timeout this
//                file itself enforces — a decider that never resolves cannot
//                blow the response's latency budget, regardless of whether it
//                honours the AbortSignal it's handed.
//   4. validate  lib/suggest/validate.ts  validateDeciderPicks (drops
//                off-shortlist ids, dedupes, tops up — S-2: model output is data)
//   5. usual     lib/suggest/profile.ts   pickUsual, excluded from picks
//   6. relaxHint lib/suggest/filter.ts    relaxHintFor
//   7. tone      lib/suggest/tone.ts      lintReason on the header
//
// Pure: no Supabase, no 'server-only', no network — every dependency is
// either a pure lib or injected (`decider`), so this runs in a unit test with
// no DB and no network (SUG-4).

import { filterCandidates, relaxHintFor } from './filter';
import { buildShortlist, scoreCandidates } from './score';
import { deterministicPicks, templateHeader, templateReason } from './templates';
import { lintReason } from './tone';
import { pickUsual, summarizeProfile } from './profile';
import { daypartFor } from './daypart';
import { validateDeciderPicks } from './validate';
import { DeciderError } from './deciderError';
import { SUGGEST_LIMITS } from './types';
import type {
  Candidate,
  Decider,
  FallbackReason,
  MenuItemTraits,
  RelaxHint,
  SuggestInputs,
  SuggestRequest,
  SuggestionPick,
  SuggestionSource,
  TasteProfile,
} from './types';
import type { MenuItem } from '@/lib/types';

export interface RunSuggestArgs {
  request: SuggestRequest;
  /** Available menu items (already availability-filtered is NOT required —
   * filterCandidates re-checks isMenuItemAvailable itself; passing the full
   * catalog is fine and simplest for callers). */
  menu: MenuItem[];
  traitsById: Map<string, MenuItemTraits>;
  profile: TasteProfile | null;
  popularity: Map<string, number>;
  recentItemIds: string[];
  now: Date;
  /** null ⇒ never call an LLM at all (§5.6: disabled / no key / over budget /
   * rate-limited). Pass `fallbackReason` alongside it so that's what lands on
   * the persisted session — the engine itself never invents one of those four
   * reasons, only the four decider-failure reasons below. */
  decider: Decider | null;
  fallbackReason?: FallbackReason;
}

export interface RunSuggestUsage {
  model: string | null;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsdMicros: number;
}

export interface RunSuggestResult {
  header: string;
  usual: SuggestionPick | null;
  picks: SuggestionPick[];
  relaxHint: RelaxHint | null;
  /** Shaped menu rows for usual + picks, usual first — ready for
   * SuggestResponse.items with no second fetch. */
  items: MenuItem[];
  source: SuggestionSource;
  fallbackReason: FallbackReason | null;
  candidateIds: string[];
  pickIds: string[];
  usualItemId: string | null;
  usage: RunSuggestUsage;
  latencyMs: number;
}

const EMPTY_USAGE: RunSuggestUsage = { model: null, inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsdMicros: 0 };

/** Fills `picks` back up to SUGGEST_LIMITS.picks from the shortlist,
 * skipping any id already in `exclude` — used both for the decider's normal
 * top-up (validateDeciderPicks already does that internally) and here again
 * after the usual is removed from picks, so subtracting a duplicate never
 * shorts the count (SUG-4 AC: "usual never duplicated in picks"). */
function topUpPicks(picks: SuggestionPick[], shortlist: Candidate[], inputs: SuggestInputs, exclude: Set<string>): SuggestionPick[] {
  const out = [...picks];
  const seen = new Set([...exclude, ...out.map((p) => p.menuItemId)]);
  for (const c of shortlist) {
    if (out.length >= SUGGEST_LIMITS.picks) break;
    if (seen.has(c.menuItemId)) continue;
    seen.add(c.menuItemId);
    const reasonCode: SuggestionPick['reasonCode'] = c.traits.moods.includes(inputs.mood) ? inputs.mood : 'trait';
    out.push({ menuItemId: c.menuItemId, reason: templateReason(c.traits, inputs, reasonCode, c.name), reasonCode });
  }
  return out;
}

export async function runSuggest(args: RunSuggestArgs): Promise<RunSuggestResult> {
  const { request, menu, traitsById, profile, popularity, recentItemIds, now, decider, fallbackReason: forcedFallbackReason } = args;
  const inputs = request.inputs;
  const excludeIds = request.excludeItemIds ?? [];
  const startedAt = Date.now();

  const daypart = daypartFor(now);

  // 1 — hard filter (§5.2).
  const filtered = filterCandidates(menu, traitsById, inputs, excludeIds);

  // 2 — score + shortlist, with diversity rules (§5.3).
  const scored = scoreCandidates({ candidates: filtered, inputs, profile, daypart, popularity, recentItemIds });
  const shortlist = buildShortlist(scored, inputs);
  const candidateIds = shortlist.map((c) => c.menuItemId);

  // 6 — relaxHint is computed against the SAME hard filter, independent of
  // the decider — it's a property of the menu + today's chips, not of who
  // answered (§5.2 last paragraph).
  const relaxHint = relaxHintFor(menu, traitsById, inputs, excludeIds);

  // 5 — "usual" (§3.2): the signed-in customer's most-ordered item that still
  // clears TODAY's hard constraints. Computed up front so it can be excluded
  // from `picks` below regardless of which path produced them.
  const usualItemId = pickUsual(profile, menu, traitsById, inputs);

  let source: SuggestionSource = 'fallback';
  let fallbackReason: FallbackReason | null = null;
  let picks: SuggestionPick[];
  let header: string;
  let usage: RunSuggestUsage = EMPTY_USAGE;

  const shouldCallDecider = decider !== null && shortlist.length > 0;

  if (!shouldCallDecider) {
    // §5.4 fallback triggers: disabled / no key / over budget / rate-limited
    // (decided by the caller, never invented here) — or simply nothing to
    // shortlist, which isn't a decider failure at all (relaxHint explains why).
    picks = deterministicPicks(shortlist, inputs);
    header = templateHeader(inputs.mood);
    fallbackReason = forcedFallbackReason ?? null;
  } else {
    // 3 — decide, under a HARD timeout this file enforces itself (a decider
    // that never resolves — the SUG-4 "hanging decider" AC — must not block
    // the response past the budget, whether or not it honours the signal).
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new DeciderError('timeout', 'decider exceeded the timeout budget'));
      }, SUGGEST_LIMITS.deciderTimeoutMs);
    });

    try {
      const result = await Promise.race([
        decider!({ inputs, shortlist, profile: profile ? summarizeProfile(profile) : null, daypart, signal: controller.signal }),
        timeoutPromise,
      ]);
      // 4 — validate: ids ⊆ shortlist, dedupe, tone-lint each reason, top up
      // from the deterministic order (S-2: model output is data).
      picks = validateDeciderPicks(result.picks, shortlist, inputs);
      header = result.header ?? templateHeader(inputs.mood);
      source = 'llm';
      usage = {
        model: result.model,
        inputTokens: result.inputTokens,
        cacheReadTokens: result.cacheReadTokens,
        outputTokens: result.outputTokens,
        costUsdMicros: result.costUsdMicros,
      };
    } catch (err) {
      picks = deterministicPicks(shortlist, inputs);
      header = templateHeader(inputs.mood);
      fallbackReason = err instanceof DeciderError ? err.kind : 'error';
    } finally {
      clearTimeout(timer!);
    }
  }

  // 5 (cont.) — the usual is never duplicated in `picks`; removing it never
  // shorts the count below SUGGEST_LIMITS.picks when the shortlist can cover it.
  if (usualItemId && picks.some((p) => p.menuItemId === usualItemId)) {
    picks = topUpPicks(
      picks.filter((p) => p.menuItemId !== usualItemId),
      shortlist,
      inputs,
      new Set([usualItemId]),
    );
  }

  const usualTraits = usualItemId ? traitsById.get(usualItemId) : undefined;
  const usualName = usualItemId ? menu.find((m) => m.id === usualItemId)?.name : undefined;
  const usual: SuggestionPick | null = usualItemId && usualTraits
    ? { menuItemId: usualItemId, reason: templateReason(usualTraits, inputs, 'usual', usualName), reasonCode: 'usual' }
    : null;

  // 7 — tone lint on the header (model-written OR our own template — belt and
  // braces): a failing header is replaced, never shown raw (§4 Enforcement).
  if (!lintReason(header).ok) header = templateHeader(inputs.mood);

  const pickIds = picks.map((p) => p.menuItemId);
  const itemsById = new Map(menu.map((m) => [m.id, m]));
  const items = [...(usualItemId ? [usualItemId] : []), ...pickIds]
    .map((id) => itemsById.get(id))
    .filter((i): i is MenuItem => Boolean(i));

  return {
    header,
    usual,
    picks,
    relaxHint,
    items,
    source,
    fallbackReason,
    candidateIds,
    pickIds,
    usualItemId,
    usage,
    latencyMs: Date.now() - startedAt,
  };
}
