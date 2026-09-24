// Phase 7 · SUG-4 — validating what a model (or an HTTP request body) hands
// us (docs/PHASE-7-SUGGESTION-ENGINE-SPEC.md §5.4 "Validation", playbook S-2).
// A model output is DATA: ids are checked against the shortlist, text is
// linted, nothing here is ever trusted outright.
//
// Pure: no Supabase, no 'server-only'.

import { deterministicPicks, templateReason } from './templates';
import { lintReason, sanitizeNote } from './tone';
import type {
  BasePref,
  Budget,
  Candidate,
  DeciderResult,
  Extra,
  Mood,
  Need,
  SuggestInputs,
  SuggestRequest,
  SuggestionPick,
  TemperaturePref,
} from './types';
import { BUDGETS, EXTRAS, MOODS, NEEDS, SUGGEST_LIMITS } from './types';

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
    const reason = lint.ok ? (pick.reason as string) : templateReason(candidate.traits, inputs, reasonCode);

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

export function validateSuggestInputs(body: unknown): SuggestInputs | string {
  if (typeof body !== 'object' || body === null) return 'inputs must be an object';
  const b = body as Record<string, unknown>;

  const temperatureOptions: readonly TemperaturePref[] = ['hot', 'iced', 'either'];
  if (!isOneOf(b.temperature, temperatureOptions)) return 'invalid temperature';

  const baseOptions: readonly BasePref[] = ['coffee', 'no_coffee', 'either'];
  if (!isOneOf(b.base, baseOptions)) return 'invalid base';

  if (!Array.isArray(b.extras) || !b.extras.every((e) => isOneOf(e, EXTRAS))) return 'invalid extras';
  const extras = b.extras as Extra[];
  if (!hasNoDuplicates(extras)) return 'duplicate extras';

  if (!Array.isArray(b.needs) || !b.needs.every((n) => isOneOf(n, NEEDS))) return 'invalid needs';
  const needs = b.needs as Need[];
  if (!hasNoDuplicates(needs)) return 'duplicate needs';

  if (!isOneOf<Budget>(b.budget, BUDGETS)) return 'invalid budget';
  if (!isOneOf<Mood>(b.mood, MOODS)) return 'invalid mood';

  if (b.note !== undefined && typeof b.note !== 'string') return 'invalid note';
  const note = sanitizeNote(typeof b.note === 'string' ? b.note : '');

  return {
    temperature: b.temperature as TemperaturePref,
    base: b.base as BasePref,
    extras,
    needs,
    budget: b.budget as Budget,
    mood: b.mood as Mood,
    note,
  };
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
