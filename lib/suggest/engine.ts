// Phase 7 · SUG-4 — pure orchestration (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md
// §5, the numbered pipeline). Composes the already-built pure libs — never
// duplicates their logic:
//
//   1. filter    lib/suggest/filter.ts    filterCandidates / relaxHintFor
//   2. score     lib/suggest/score.ts     scoreCandidates / buildShortlist (a
//                requested flavour the item can only get from an add-on counts as a
//                partial match — lib/suggest/addonTraits.ts, COFFEY-ADDONS-PAIRINGS-SPEC §3.1)
//   3. decide    an injected `Decider` (lib/suggest/jevDecider.ts's jevDecider in
//                production; a fake in tests), guarded by a HARD timeout this
//                file itself enforces — a decider that never resolves cannot
//                blow the response's latency budget, regardless of whether it
//                honours the AbortSignal it's handed.
//   4. validate  lib/suggest/validate.ts  validateDeciderPicks (drops
//                off-shortlist ids, dedupes, tops up — S-2: model output is data)
//   5. usual     lib/suggest/profile.ts   pickUsual, excluded from picks
//   6. relaxHint lib/suggest/filter.ts    relaxHintFor
//   7. tone      lib/suggest/tone.ts      lintReason on the header
//   8. decorate  lib/suggest/templates.ts matchTagsFor + lib/suggest/sugar.ts
//                sugarPresetFor + lib/suggest/addonTraits.ts flavourAddonFor on
//                every pick AND the usual (COFFEY-SPEC §4.6, §4.7;
//                COFFEY-ADDONS-PAIRINGS-SPEC §3.2), once the picks are final;
//                a pick with a flavour add-on gets its reason re-templated to
//                name it
//
// Pure: no Supabase, no 'server-only', no network — every dependency is
// either a pure lib or injected (`decider`), so this runs in a unit test with
// no DB and no network (SUG-4).

import { flavourAddonFor, reachableAddonFamilies } from './addonTraits';
import { filterCandidates, relaxHintFor } from './filter';
import { guardTraits } from './traitsGuard';
import { honourChoices, madeToOrder, satisfiesChoice, unmetChoices } from './promises';
import { buildShortlist, scoreCandidates } from './score';
import { isSugarAdjustable, sugarPresetFor } from './sugar';
import { sweetnessLevel } from './sweetness';
import { deterministicPicks, matchTagsFor, reasonCodeFor, templateHeader, templateReason } from './templates';
import { lintReason } from './tone';
import { pickUsual, summarizeProfile } from './profile';
import { daypartFor } from './daypart';
import { validateDeciderPicks } from './validate';
import { DeciderError } from './deciderError';
import { FLAVOUR_FAMILY_INFO } from './traitVocabulary';
import { HONOURED_CHOICES, SUGGEST_LIMITS, SWEETNESS_SCALE } from './types';
import type {
  AddonTraits,
  Candidate,
  Decider,
  FallbackReason,
  HonouredChoice,
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
  /** The owner's add-on trait overrides, keyed by option id
   * (COFFEY-ADDONS-PAIRINGS-SPEC §2.3); absent means the derived defaults. */
  addonTraitsById?: Map<string, AddonTraits>;
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
  /** Set choices a final pick does not keep (usual excluded). */
  unmet: HonouredChoice[];
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
    const reasonCode = reasonCodeFor(c.traits, inputs);
    out.push({
      menuItemId: c.menuItemId,
      reason: templateReason(c.traits, inputs, reasonCode, c.name, c.sugarAdjustable),
      reasonCode,
    });
  }
  return out;
}

/** Pinned candidates (lib/suggest/promises.ts) keep the customer's choices but
 * are too few to fill the picks on their own, so each must be among the final
 * picks whatever the decider said. A missing one is appended when there is room,
 * else replaces the last unpinned pick of its own kind (kind coverage stays), else the
 * last unpinned pick of a kind holding two or more picks; otherwise it is skipped. Pinned picks then come first, in pin order.
 * The count never exceeds SUGGEST_LIMITS.picks and never drops. */
function enforcePins(
  picks: SuggestionPick[],
  pinnedIds: string[],
  usualItemId: string | null,
  shortlist: Candidate[],
  inputs: SuggestInputs,
): SuggestionPick[] {
  if (pinnedIds.length === 0) return picks;
  const pinnedSet = new Set(pinnedIds);
  const byId = new Map(shortlist.map((c) => [c.menuItemId, c]));
  let out = [...picks];
  for (const id of pinnedIds) {
    if (id === usualItemId || out.some((p) => p.menuItemId === id)) continue;
    const c = byId.get(id);
    if (!c) continue;
    const reasonCode = reasonCodeFor(c.traits, inputs);
    const pick: SuggestionPick = {
      menuItemId: c.menuItemId,
      reason: templateReason(c.traits, inputs, reasonCode, c.name, c.sugarAdjustable),
      reasonCode,
    };
    if (out.length < SUGGEST_LIMITS.picks) {
      out.push(pick);
      continue;
    }
    const kindOf = (p: SuggestionPick) => byId.get(p.menuItemId)?.traits.kind;
    const lastWhere = (ok: (p: SuggestionPick) => boolean) => {
      for (let i = out.length - 1; i >= 0; i--) if (!pinnedSet.has(out[i].menuItemId) && ok(out[i])) return i;
      return -1;
    };
    // First choice: the last unpinned pick of the same kind. Otherwise the last
    // unpinned pick whose kind holds two or more picks, so no kind loses its only pick.
    let at = lastWhere((p) => kindOf(p) === c.traits.kind);
    if (at === -1) at = lastWhere((p) => out.filter((q) => kindOf(q) === kindOf(p)).length >= 2);
    if (at !== -1) out[at] = pick;
  }
  const pinnedPicks = pinnedIds.flatMap((id) => out.filter((p) => p.menuItemId === id));
  out = [...pinnedPicks, ...out.filter((p) => !pinnedSet.has(p.menuItemId))];
  return out;
}

/** COFFEY-SPEC §4.6/§4.7 — a final pick (or the usual) with its "why it
 * matches" tags and the sugar option to preselect; COFFEY-ADDONS-PAIRINGS-SPEC
 * §3.2 adds the flavour add-on that gives it a requested flavour it lacks. All
 * three are read off the menu row and its traits — the same for a pick, the
 * usual and a decider's pick — so nothing a decider wrote can affect them. When
 * there is a flavour add-on, the reason is regenerated by the template so it
 * names the add-on (every reason is template-generated already; the reasonCode
 * is kept). Never throws: a pick whose row has gone missing simply carries no
 * tags, no preset and no add-on. */
function decorate(
  pick: SuggestionPick,
  inputs: SuggestInputs,
  itemsById: Map<string, MenuItem>,
  traitsById: Map<string, MenuItemTraits>,
  addonTraitsById?: Map<string, AddonTraits>,
  /** The "Your usual" card: it is the customer's habitual order, so it never gets
   * an add-on preselected, named, tagged for or priced in (§11). */
  isUsual = false,
): SuggestionPick {
  const item = itemsById.get(pick.menuItemId);
  const traits = traitsById.get(pick.menuItemId);
  if (!item || !traits) return { ...pick, matchTags: [], sugarPreset: null, flavourAddon: null };

  const sugarAdjustable = isSugarAdjustable(item);
  const ownSugarPreset = sugarPresetFor(item, inputs.sweetness, sweetnessLevel(traits));
  const addonFlavourFamilies = isUsual ? [] : reachableAddonFamilies(item, traits, inputs, addonTraitsById);
  if (isUsual) {
    return {
      ...pick,
      matchTags: matchTagsFor({ name: item.name, traits, sugarAdjustable, addonFlavourFamilies }, inputs),
      sugarPreset: ownSugarPreset,
      flavourAddon: null,
      addonPresets: [],
    };
  }

  const flavourAddon = flavourAddonFor(item, traits, inputs, addonTraitsById);
  // What making it the customer's way adds (COFFEY-SPEC §11): the add-ons to
  // preselect, and the sweetness / intensity they bring.
  const made = madeToOrder(item, traits, inputs, addonTraitsById);
  const flavourPreset = made.presets.find((p) => p.purpose === 'flavour');
  const nameFlavourAddon = flavourPreset && flavourAddon ? flavourAddon : null;
  const liftedBase = Math.min(SWEETNESS_SCALE.max, sweetnessLevel(traits) + made.sweetnessLift);
  const matchTags = matchTagsFor({ name: item.name, traits, sugarAdjustable, addonFlavourFamilies, made }, inputs);

  // The tag each preset earns, so the card can take it away when the customer
  // un-ticks the add-on: exactly the tags that vanish without `made`.
  const addonPresets = made.presets.map((p) => {
    const tag = p.purpose === 'flavour' && p.family ? FLAVOUR_FAMILY_INFO[p.family].tag : p.purpose === 'strength' ? 'Strong' : undefined;
    return tag && matchTags.includes(tag) ? { ...p, tag } : { ...p };
  });

  return {
    ...pick,
    // The reason names the add-on exactly when a flavour add-on is preselected,
    // and describes the made intensity when a shot is.
    reason:
      made.presets.length > 0
        ? templateReason(traits, inputs, pick.reasonCode, item.name, sugarAdjustable, nameFlavourAddon, made)
        : pick.reason,
    matchTags,
    sugarPreset: sugarPresetFor(item, inputs.sweetness, liftedBase),
    flavourAddon,
    addonPresets,
    // The same pick without its add-ons, for when the customer un-ticks them.
    ...(made.presets.length > 0
      ? { plain: { reason: templateReason(traits, inputs, pick.reasonCode, item.name, sugarAdjustable), sugarPreset: ownSugarPreset } }
      : {}),
  };
}

export async function runSuggest(args: RunSuggestArgs): Promise<RunSuggestResult> {
  const {
    request,
    menu,
    traitsById: taggedTraitsById,
    profile,
    popularity,
    recentItemIds,
    addonTraitsById,
    now,
    decider,
    fallbackReason: forcedFallbackReason,
  } = args;
  // A drink whose own name says "Iced" is iced whatever its row says
  // (lib/suggest/traitsGuard.ts): corrected once here, so the filter, the score,
  // the tags and the brief all read the same value.
  const traitsById = guardTraits(menu, taggedTraitsById);
  const inputs = request.inputs;
  const excludeIds = request.excludeItemIds ?? [];
  const startedAt = Date.now();

  const daypart = daypartFor(now);

  // 1 — hard filter (§5.2).
  const filtered = filterCandidates(menu, traitsById, inputs, excludeIds);
  // 1b — keep the customer's flavour / strength / sweetness / texture choices
  // whenever the menu can (lib/suggest/promises.ts); only ever removes items.
  const { pool: honoured, pinnedIds } = honourChoices(filtered, inputs, addonTraitsById);

  // 2 — score + shortlist, with diversity rules (§5.3).
  const scored = scoreCandidates({ candidates: honoured, inputs, profile, daypart, popularity, recentItemIds, addonTraitsById });
  const shortlist = buildShortlist(scored, inputs, new Set(pinnedIds));
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

  picks = enforcePins(picks, pinnedIds, usualItemId, shortlist, inputs);

  const itemsById = new Map(menu.map((m) => [m.id, m]));
  const usualItem = usualItemId ? itemsById.get(usualItemId) : undefined;
  const usualTraits = usualItemId ? traitsById.get(usualItemId) : undefined;
  const usualBase: SuggestionPick | null =
    usualItemId && usualItem && usualTraits
      ? {
          menuItemId: usualItemId,
          reason: templateReason(usualTraits, inputs, 'usual', usualItem.name, isSugarAdjustable(usualItem)),
          reasonCode: 'usual',
        }
      : null;

  // 7 — tone lint on the header (model-written OR our own template — belt and
  // braces): a failing header is replaced, never shown raw (§4 Enforcement).
  if (!lintReason(header).ok) header = templateHeader(inputs.mood);

  // 8 — decorate, now that the picks (LLM or fallback, usual removed) are final.
  // `misses`: the customer's choices THIS pick does not keep, so its card can say
  // "closest we have" instead of passing for a match. Same predicate as the
  // narrowing, the tags and `unmet`. Picks only: the usual is shown as a habit,
  // not as an answer to today's choices.
  picks = picks.map((p) => {
    const decorated = decorate(p, inputs, itemsById, traitsById, addonTraitsById);
    const item = itemsById.get(p.menuItemId);
    const traits = traitsById.get(p.menuItemId);
    if (!item || !traits) return decorated;
    const subject = {
      name: item.name,
      traits,
      sugarAdjustable: isSugarAdjustable(item),
      made: madeToOrder(item, traits, inputs, addonTraitsById),
    };
    return { ...decorated, misses: HONOURED_CHOICES.filter((c) => satisfiesChoice(c, subject, inputs) === false) };
  });
  const usual = usualBase ? decorate(usualBase, inputs, itemsById, traitsById, addonTraitsById, true) : null;

  const unmet = unmetChoices(
    picks.flatMap((p) => {
      const item = itemsById.get(p.menuItemId);
      const traits = traitsById.get(p.menuItemId);
      return item && traits
        ? [{ name: item.name, traits, sugarAdjustable: isSugarAdjustable(item), made: madeToOrder(item, traits, inputs, addonTraitsById) }]
        : [];
    }),
    inputs,
  );

  const pickIds = picks.map((p) => p.menuItemId);
  const items = [...(usualItemId ? [usualItemId] : []), ...pickIds]
    .map((id) => itemsById.get(id))
    .filter((i): i is MenuItem => Boolean(i));

  return {
    header,
    usual,
    picks,
    relaxHint,
    unmet,
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
