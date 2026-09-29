// Phase 7 · SUG-4 — validating what a model (or an HTTP request body) hands
// us (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.4 "Validation", playbook S-2).
// A model output is DATA: ids are checked against the shortlist, text is
// linted, nothing here is ever trusted outright.
//
// Coffey v2 (docs/COFFEY-SPEC.md §2): validateSuggestInputs() accepts a v1 OR
// a v2 body and ALWAYS returns v2, so the engine only ever sees one shape.
//
// Pure: no Supabase, no 'server-only'.

import { isLegacyInputsBody, upgradeV1Inputs } from './inputs';
import { deterministicPicks, templateReason } from './templates';
import { lintReason, sanitizeNote } from './tone';
import type {
  BasePref,
  BodyPref,
  Budget,
  Candidate,
  DeciderResult,
  FlavourFamily,
  LegacyBudget,
  LegacyExtra,
  LegacyNeed,
  LegacySuggestInputs,
  Mood,
  Need,
  StrengthPref,
  SuggestInputs,
  SuggestRequest,
  SuggestionPick,
  SweetnessPref,
  TemperaturePref,
  TraitKind,
} from './types';
import {
  BODY_PREFS,
  BUDGETS,
  FLAVOUR_FAMILIES,
  KINDS,
  LEGACY_BUDGETS,
  LEGACY_EXTRAS,
  LEGACY_NEEDS,
  MOODS,
  NEEDS,
  STRENGTH_PREFS,
  SUGGEST_LIMITS,
  SWEETNESS_PREFS,
} from './types';

// ---------------------------------------------------------------------------
// §5.4 "Validation": drop off-shortlist ids, dedupe, lint every reason
// (replacing a failing one with the deterministic template for that item),
// then top up from the deterministic order to SUGGEST_LIMITS.picks.
// ---------------------------------------------------------------------------

const VALID_REASON_CODES = new Set<SuggestionPick['reasonCode']>([...MOODS, 'trait', 'usual', 'popular']);

function isValidReasonCode(v: unknown): v is SuggestionPick['reasonCode'] {
  return typeof v === 'string' && VALID_REASON_CODES.has(v as SuggestionPick['reasonCode']);
}

export function validateDeciderPicks(
  deciderPicks: DeciderResult['picks'],
  shortlist: Candidate[],
  inputs: SuggestInputs,
): SuggestionPick[] {
  const byId = new Map(shortlist.map((c) => [c.menuItemId, c]));
  const seen = new Set<string>();
  const out: SuggestionPick[] = [];

  for (const pick of deciderPicks) {
    if (out.length >= SUGGEST_LIMITS.picks) break;
    if (!pick || typeof pick.menuItemId !== 'string') continue;

    // S-2 — an id the model invented (or an unavailable/over-budget item
    // that never made the hard-filtered shortlist in the first place) is
    // dropped outright, never rendered.
    const candidate = byId.get(pick.menuItemId);
    if (!candidate) continue;
    if (seen.has(pick.menuItemId)) continue; // dedupe
    seen.add(pick.menuItemId);

    const reasonCode = isValidReasonCode(pick.reasonCode) ? pick.reasonCode : 'trait';
    const lint = typeof pick.reason === 'string' ? lintReason(pick.reason) : { ok: false as const };
    const reason = lint.ok
      ? (pick.reason as string)
      : templateReason(candidate.traits, inputs, reasonCode, candidate.name, candidate.sugarAdjustable);

    out.push({ menuItemId: pick.menuItemId, reason, reasonCode });
  }

  if (out.length < SUGGEST_LIMITS.picks) {
    for (const fallback of deterministicPicks(shortlist, inputs)) {
      if (out.length >= SUGGEST_LIMITS.picks) break;
      if (seen.has(fallback.menuItemId)) continue;
      seen.add(fallback.menuItemId);
      out.push(fallback);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// §5.4 API validation — the /api/suggest route's first line of defence
// against a malformed body. Returns the typed value, or a plain string
// that's the 400 error message (never throws).
// ---------------------------------------------------------------------------

function isOneOf<T extends string>(v: unknown, allowed: readonly T[]): v is T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v);
}

function hasNoDuplicates(arr: readonly string[]): boolean {
  return new Set(arr).size === arr.length;
}

const TEMPERATURE_OPTIONS: readonly TemperaturePref[] = ['hot', 'iced', 'either'];
const BASE_OPTIONS: readonly BasePref[] = ['coffee', 'no_coffee', 'either'];

/** A v1 mood: every mood except 'focus' and 'unwind', which v1 never had
 * (LegacySuggestInputs). */
const LEGACY_MOODS: readonly Exclude<Mood, 'focus' | 'unwind'>[] = MOODS.filter(
  (m): m is Exclude<Mood, 'focus' | 'unwind'> => m !== 'focus' && m !== 'unwind',
);

/**
 * The pre-Coffey body — checked strictly against the v1 vocabularies (including
 * v1's own budget values, which v2 replaced with ceilings), with the same
 * messages as before Coffey, then upgraded (COFFEY-SPEC §2).
 */
function validateLegacyInputs(b: Record<string, unknown>): SuggestInputs | string {
  if (!isOneOf(b.temperature, TEMPERATURE_OPTIONS)) return 'invalid temperature';
  if (!isOneOf(b.base, BASE_OPTIONS)) return 'invalid base';

  if (!Array.isArray(b.extras) || !b.extras.every((e) => isOneOf(e, LEGACY_EXTRAS))) return 'invalid extras';
  const extras = b.extras as LegacyExtra[];
  if (!hasNoDuplicates(extras)) return 'duplicate extras';

  if (!Array.isArray(b.needs) || !b.needs.every((n) => isOneOf(n, LEGACY_NEEDS))) return 'invalid needs';
  const needs = b.needs as LegacyNeed[];
  if (!hasNoDuplicates(needs)) return 'duplicate needs';

  if (!isOneOf<LegacyBudget>(b.budget, LEGACY_BUDGETS)) return 'invalid budget';
  if (!isOneOf(b.mood, LEGACY_MOODS)) return 'invalid mood';

  if (b.note !== undefined && typeof b.note !== 'string') return 'invalid note';
  const note = sanitizeNote(typeof b.note === 'string' ? b.note : '');

  const legacy: LegacySuggestInputs = {
    temperature: b.temperature,
    base: b.base,
    extras,
    needs,
    budget: b.budget,
    mood: b.mood,
    note,
  };
  return upgradeV1Inputs(legacy);
}

/** The Coffey (v2) body — strict on every field (COFFEY-SPEC §2). Only
 * `secondaryMood` (missing or null → null) and `note` (missing → '') may be
 * left out. */
function validateV2Inputs(b: Record<string, unknown>): SuggestInputs | string {
  if (!isOneOf<Mood>(b.mood, MOODS)) return 'invalid mood';
  const mood = b.mood;

  let secondaryMood: Mood | null = null;
  if (b.secondaryMood !== undefined && b.secondaryMood !== null) {
    if (!isOneOf<Mood>(b.secondaryMood, MOODS)) return 'invalid secondaryMood';
    if (b.secondaryMood === mood) return 'secondaryMood must differ from mood';
    secondaryMood = b.secondaryMood;
  }

  if (!Array.isArray(b.kinds) || b.kinds.length === 0 || !b.kinds.every((k) => isOneOf(k, KINDS))) {
    return 'invalid kinds';
  }
  const kinds = b.kinds as TraitKind[];
  if (!hasNoDuplicates(kinds)) return 'duplicate kinds';

  if (!isOneOf(b.temperature, TEMPERATURE_OPTIONS)) return 'invalid temperature';
  if (!isOneOf(b.base, BASE_OPTIONS)) return 'invalid base';
  if (!isOneOf<StrengthPref>(b.strength, STRENGTH_PREFS)) return 'invalid strength';
  if (!isOneOf<SweetnessPref>(b.sweetness, SWEETNESS_PREFS)) return 'invalid sweetness';
  if (!isOneOf<BodyPref>(b.body, BODY_PREFS)) return 'invalid body';

  if (!Array.isArray(b.flavours) || !b.flavours.every((f) => isOneOf(f, FLAVOUR_FAMILIES))) return 'invalid flavours';
  const flavours = b.flavours as FlavourFamily[];
  if (!hasNoDuplicates(flavours)) return 'duplicate flavours';

  if (!Array.isArray(b.needs) || !b.needs.every((n) => isOneOf(n, NEEDS))) return 'invalid needs';
  const needs = b.needs as Need[];
  if (!hasNoDuplicates(needs)) return 'duplicate needs';

  if (!isOneOf<Budget>(b.budget, BUDGETS)) return 'invalid budget';

  if (b.note !== undefined && typeof b.note !== 'string') return 'invalid note';
  const note = sanitizeNote(typeof b.note === 'string' ? b.note : '');

  return {
    mood,
    secondaryMood,
    kinds,
    temperature: b.temperature,
    base: b.base,
    strength: b.strength,
    sweetness: b.sweetness,
    body: b.body,
    flavours,
    needs,
    budget: b.budget,
    note,
  };
}

/**
 * Accepts a Coffey (v2) body or a pre-Coffey (v1) one and always returns v2
 * (COFFEY-SPEC §2): the browser bundle that was open before the deploy, a
 * stored session and the eval fixtures all keep working. The wire shape is
 * told apart by isLegacyInputsBody() (neither `kinds` nor `sweetness`).
 */
export function validateSuggestInputs(body: unknown): SuggestInputs | string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'inputs must be an object';
  const b = body as Record<string, unknown>;
  return isLegacyInputsBody(b) ? validateLegacyInputs(b) : validateV2Inputs(b);
}

export function validateSuggestRequest(body: unknown): SuggestRequest | string {
  if (typeof body !== 'object' || body === null) return 'request body must be an object';
  const b = body as Record<string, unknown>;

  const inputs = validateSuggestInputs(b.inputs);
  if (typeof inputs === 'string') return inputs;

  if (b.anonId !== undefined && typeof b.anonId !== 'string') return 'invalid anonId';
  if (b.refineOf !== undefined && typeof b.refineOf !== 'string') return 'invalid refineOf';

  let excludeItemIds: string[] | undefined;
  if (b.excludeItemIds !== undefined) {
    if (!Array.isArray(b.excludeItemIds) || !b.excludeItemIds.every((x) => typeof x === 'string')) {
      return 'invalid excludeItemIds';
    }
    if (b.excludeItemIds.length > SUGGEST_LIMITS.excludeMax) return 'too many excludeItemIds';
    excludeItemIds = b.excludeItemIds as string[];
  }

  const request: SuggestRequest = { inputs };
  if (b.anonId !== undefined) request.anonId = b.anonId as string;
  if (b.refineOf !== undefined) request.refineOf = b.refineOf as string;
  if (excludeItemIds !== undefined) request.excludeItemIds = excludeItemIds;
  return request;
}
