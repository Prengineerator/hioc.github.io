// Phase 7 · SUG-2 — trait-row validation, shared by the Opus tagger
// (lib/suggest/traitsPrompt.ts) and the owner PATCH route
// (app/api/owner/suggest/traits/route.ts). Every allowed value here MUST
// mirror the CHECK constraints in supabase/2026-09-suggestion-engine.sql
// exactly — a model or a browser is untrusted input either way (playbook S-2).
//
// Pure: no Supabase, no 'server-only'.

import { DAYPARTS, MOODS, type Daypart, type Mood, type MenuItemTraits, type TraitBody, type TraitCaffeine, type TraitKind, type TraitTemperature } from './types';

export const TRAIT_TEMPERATURES: readonly TraitTemperature[] = ['hot', 'iced', 'either', 'ambient'];
export const TRAIT_CAFFEINE: readonly TraitCaffeine[] = ['none', 'low', 'medium', 'high'];
export const TRAIT_BODY: readonly TraitBody[] = ['light', 'medium', 'rich'];
export const TRAIT_KIND: readonly TraitKind[] = ['drink', 'food', 'dessert'];

const MOOD_SET = new Set<string>(MOODS);
const DAYPART_SET = new Set<string>(DAYPARTS);
const MAX_FLAVOR_NOTES = 5;
const MAX_FLAVOR_NOTE_CHARS = 24;

/** The trait fields an owner or Opus can set — everything except the row's
 * identity (`menu_item_id`) and provenance (`source`, `confirmed`, `updated_at`),
 * which the route itself decides. */
export type TraitContent = Pick<
  MenuItemTraits,
  'temperature' | 'caffeine' | 'is_coffee' | 'sweetness' | 'body' | 'kind' | 'moods' | 'dayparts' | 'flavor_notes'
>;

export interface ValidatedTraitRow extends TraitContent {
  menu_item_id: string;
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function isStringArraySubset(value: unknown, allowed: Set<string>): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && allowed.has(v));
}

function validateFlavorNotes(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_FLAVOR_NOTES) return undefined;
  const notes: string[] = [];
  for (const note of value) {
    if (typeof note !== 'string') return undefined;
    const trimmed = note.trim().slice(0, MAX_FLAVOR_NOTE_CHARS);
    if (!trimmed) continue; // blank entries (e.g. a trailing comma) are dropped, not rejected
    notes.push(trimmed);
  }
  return notes;
}

// One validator per field: returns the coerced value, or undefined when the
// input is not one of the migration's allowed values.
const FIELD_VALIDATORS: { [K in keyof TraitContent]: (v: unknown) => TraitContent[K] | undefined } = {
  temperature: (v) => (typeof v === 'string' && TRAIT_TEMPERATURES.includes(v as TraitTemperature) ? (v as TraitTemperature) : undefined),
  caffeine: (v) => (typeof v === 'string' && TRAIT_CAFFEINE.includes(v as TraitCaffeine) ? (v as TraitCaffeine) : undefined),
  is_coffee: (v) => (typeof v === 'boolean' ? v : undefined),
  sweetness: (v) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3 ? ((v as number) as 0 | 1 | 2 | 3) : undefined),
  body: (v) => (typeof v === 'string' && TRAIT_BODY.includes(v as TraitBody) ? (v as TraitBody) : undefined),
  kind: (v) => (typeof v === 'string' && TRAIT_KIND.includes(v as TraitKind) ? (v as TraitKind) : undefined),
  moods: (v) => (isStringArraySubset(v, MOOD_SET) ? dedupe(v as Mood[]) : undefined),
  dayparts: (v) => (isStringArraySubset(v, DAYPART_SET) ? dedupe(v as Daypart[]) : undefined),
  flavor_notes: validateFlavorNotes,
};

const FIELD_KEYS = Object.keys(FIELD_VALIDATORS) as (keyof TraitContent)[];

/**
 * Validates whatever trait fields are present in `input` (an owner PATCH may
 * send just one or two). Unknown keys are ignored; a present-but-invalid
 * value fails the whole call with a message naming the field, so a bad value
 * never gets silently dropped and the rest silently written.
 */
export function validateTraitPatch(input: Record<string, unknown>): { patch: Partial<TraitContent>; error: string | null } {
  const patch: Partial<TraitContent> = {};
  for (const key of FIELD_KEYS) {
    if (!(key in input)) continue;
    const value = FIELD_VALIDATORS[key](input[key]) as TraitContent[typeof key] | undefined;
    if (value === undefined) return { patch: {}, error: `Invalid value for "${key}"` };
    (patch as Record<string, unknown>)[key] = value;
  }
  return { patch, error: null };
}

/** Validates a FULL trait row (every field required) — used for Opus output,
 * where a partial row is as useless as a wrong one. Returns null on any
 * missing or invalid field. */
export function validateTraitContent(input: unknown): TraitContent | null {
  if (typeof input !== 'object' || input === null) return null;
  const { patch, error } = validateTraitPatch(input as Record<string, unknown>);
  if (error) return null;
  for (const key of FIELD_KEYS) if (!(key in patch)) return null;
  return patch as TraitContent;
}

/**
 * Validates a batch of Opus-generated rows against the ids that were actually
 * sent in that batch. An id the model invents, or copies from a different
 * batch, is dropped rather than trusted (SUG-2's "never trust ids not in the
 * batch"); a duplicate id keeps its first valid occurrence.
 */
export function validateOpusTraitRows(rows: unknown, allowedIds: ReadonlySet<string> | readonly string[]): ValidatedTraitRow[] {
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);
  if (!Array.isArray(rows)) return [];

  const seen = new Set<string>();
  const out: ValidatedTraitRow[] = [];
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = r.menu_item_id;
    if (typeof id !== 'string' || !allowed.has(id) || seen.has(id)) continue;
    const content = validateTraitContent(r);
    if (!content) continue;
    seen.add(id);
    out.push({ menu_item_id: id, ...content });
  }
  return out;
}
