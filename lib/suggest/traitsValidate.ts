// Phase 7 · SUG-2 + Coffey v2 (docs/COFFEY-SPEC.md §3) — trait-row validation,
// shared by the Jev tagger (lib/suggest/traitsPrompt.ts) and the owner PATCH
// route (app/api/owner/suggest/traits/route.ts). Every allowed value here MUST
// mirror the CHECK constraints in supabase/2026-09-suggestion-engine.sql and
// supabase/2026-10-coffey-traits-v2.sql exactly — a model or a browser is
// untrusted input either way (playbook S-2).
//
// Two field groups:
//   * v1 — temperature, caffeine, is_coffee, sweetness (0–3), body, kind,
//     moods, dayparts, flavor_notes.
//   * v2 (COFFEY-SPEC §3.1) — sweetness_level (0–10), intensity, refreshment,
//     indulgence, novelty (0–3), textures (≤ 3 of TEXTURES), mood_fit (a graded
//     0–3 fit per mood, one decimal).
// An owner PATCH may edit either group. `traits_version`, `source` and
// `confirmed` are provenance, decided by the route, and are NEVER patchable —
// they are simply not validators here, so a browser that sends them has them
// ignored like any other unknown key.
//
// Pure: no Supabase, no 'server-only', so the owner Traits tab (a client
// component) imports the derivation helpers from here too.

import { DAYPARTS, MOODS, type Daypart, type MenuItemTraits, type Mood, type Texture, type TraitBody, type TraitCaffeine, type TraitKind, type TraitTemperature } from './types';
import { TEXTURES } from './traitVocabulary';

export const TRAIT_TEMPERATURES: readonly TraitTemperature[] = ['hot', 'iced', 'either', 'ambient'];
export const TRAIT_CAFFEINE: readonly TraitCaffeine[] = ['none', 'low', 'medium', 'high'];
export const TRAIT_BODY: readonly TraitBody[] = ['light', 'medium', 'rich'];
export const TRAIT_KIND: readonly TraitKind[] = ['drink', 'food', 'dessert'];

const MOOD_SET = new Set<string>(MOODS);
const DAYPART_SET = new Set<string>(DAYPARTS);
const TEXTURE_SET = new Set<string>(TEXTURES);
const MAX_FLAVOR_NOTES = 5;
const MAX_FLAVOR_NOTE_CHARS = 24;

/** COFFEY-SPEC §3.1: sweetness_level is 0–10, the four 0–N dimensions are 0–3,
 * an item carries at most three textures and mood_fit is graded 0–3. */
export const SWEETNESS_LEVEL_MAX = 10;
export const TRAIT_SCORE_MAX = 3;
export const MAX_TEXTURES = 3;
export const MOOD_FIT_MAX = 3;
/** COFFEY-SPEC §3.2: an item "suits" a mood when its fit is at least this… */
export const MOOD_FIT_THRESHOLD = 2;
/** …and is tagged with at most this many moods, best fit first. */
export const MAX_MOODS_PER_ITEM = 3;

/** The v1 trait fields an owner or the model can set — everything except the
 * row's identity (`menu_item_id`) and provenance (`source`, `confirmed`,
 * `traits_version`, `updated_at`), which the route itself decides. */
export type TraitContent = Pick<
  MenuItemTraits,
  'temperature' | 'caffeine' | 'is_coffee' | 'sweetness' | 'body' | 'kind' | 'moods' | 'dayparts' | 'flavor_notes'
>;

/** v1 + the Coffey v2 fields (COFFEY-SPEC §3.1), all required — what Jev
 * writes for every item. */
export interface TraitContentV2 extends TraitContent {
  sweetness_level: number; // 0–10, inherent (before optional table sugar)
  intensity: number; // 0–3
  refreshment: number; // 0–3
  indulgence: number; // 0–3
  novelty: number; // 0–3
  textures: Texture[]; // ≤ 3, de-duplicated
  mood_fit: Partial<Record<Mood, number>>; // 0–3 per mood, one decimal
}

export interface ValidatedTraitRow extends TraitContent {
  menu_item_id: string;
}

export interface ValidatedTraitRowV2 extends TraitContentV2 {
  menu_item_id: string;
  /** Carried through when the assembling code stamped one (traitsPrompt.ts
   * always stamps CURRENT_TRAITS_VERSION); validated as an integer ≥ 1 when
   * present. The generate route never trusts it — it writes
   * CURRENT_TRAITS_VERSION itself. */
  traits_version?: number;
}

function dedupe<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function isStringArraySubset(value: unknown, allowed: Set<string>): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && allowed.has(v));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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

/** An integer in [min, max] — the shape of every v2 scale column. */
function integerBetween(min: number, max: number): (v: unknown) => number | undefined {
  return (v) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined);
}

/** ≤ 3 textures, every one from TEXTURES. Duplicates are collapsed first —
 * what is stored is what the DB's `cardinality(textures) <= 3` sees. */
function validateTextures(value: unknown): Texture[] | undefined {
  if (!isStringArraySubset(value, TEXTURE_SET)) return undefined;
  const unique = dedupe(value as Texture[]);
  return unique.length <= MAX_TEXTURES ? unique : undefined;
}

/** One-decimal rounding for a fit value. -0 becomes 0; NaN stays NaN, so the
 * validator rejects it rather than a garbage answer quietly becoming "no fit". */
export function roundFit(n: number): number {
  const rounded = Math.round(n * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}

/** A plain object whose keys are all MOODS and whose values are finite numbers
 * in [0, 3], rounded to one decimal. `{}` is valid ("not graded yet"). */
function validateMoodFit(value: unknown): Partial<Record<Mood, number>> | undefined {
  if (!isPlainObject(value)) return undefined;
  const fit: Partial<Record<Mood, number>> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!MOOD_SET.has(key)) return undefined;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > MOOD_FIT_MAX) return undefined;
    fit[key as Mood] = roundFit(raw);
  }
  return fit;
}

// One validator per field: returns the coerced value, or undefined when the
// input is not one of the migrations' allowed values.
const FIELD_VALIDATORS: { [K in keyof TraitContentV2]: (v: unknown) => TraitContentV2[K] | undefined } = {
  temperature: (v) => (typeof v === 'string' && TRAIT_TEMPERATURES.includes(v as TraitTemperature) ? (v as TraitTemperature) : undefined),
  caffeine: (v) => (typeof v === 'string' && TRAIT_CAFFEINE.includes(v as TraitCaffeine) ? (v as TraitCaffeine) : undefined),
  is_coffee: (v) => (typeof v === 'boolean' ? v : undefined),
  sweetness: (v) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 3 ? ((v as number) as 0 | 1 | 2 | 3) : undefined),
  body: (v) => (typeof v === 'string' && TRAIT_BODY.includes(v as TraitBody) ? (v as TraitBody) : undefined),
  kind: (v) => (typeof v === 'string' && TRAIT_KIND.includes(v as TraitKind) ? (v as TraitKind) : undefined),
  moods: (v) => (isStringArraySubset(v, MOOD_SET) ? dedupe(v as Mood[]) : undefined),
  dayparts: (v) => (isStringArraySubset(v, DAYPART_SET) ? dedupe(v as Daypart[]) : undefined),
  flavor_notes: validateFlavorNotes,
  // Coffey v2 (COFFEY-SPEC §3.1) — the same bounds as the migration's CHECKs.
  sweetness_level: integerBetween(0, SWEETNESS_LEVEL_MAX),
  intensity: integerBetween(0, TRAIT_SCORE_MAX),
  refreshment: integerBetween(0, TRAIT_SCORE_MAX),
  indulgence: integerBetween(0, TRAIT_SCORE_MAX),
  novelty: integerBetween(0, TRAIT_SCORE_MAX),
  textures: validateTextures,
  mood_fit: validateMoodFit,
};

/** The v1 fields, in the order the migration declared them. */
export const TRAIT_V1_FIELDS = ['temperature', 'caffeine', 'is_coffee', 'sweetness', 'body', 'kind', 'moods', 'dayparts', 'flavor_notes'] as const satisfies readonly (keyof TraitContent)[];

/** The moods only the v2 migration's widened `moods` CHECK allows
 * (supabase/2026-10-coffey-traits-v2.sql §3) — until it is applied, writing one
 * of these is a constraint violation, so the owner PATCH treats it like a v2
 * column (409, not 500) and the Traits tab doesn't offer them. */
export const V2_ONLY_MOODS: readonly Mood[] = ['focus', 'unwind'];

/** The Coffey v2 fields — the columns supabase/2026-10-coffey-traits-v2.sql
 * adds (bar `traits_version`, which is provenance, not content). */
export const TRAIT_V2_FIELDS = ['sweetness_level', 'intensity', 'refreshment', 'indulgence', 'novelty', 'textures', 'mood_fit'] as const satisfies readonly (keyof TraitContentV2)[];

const ALL_FIELDS: readonly (keyof TraitContentV2)[] = [...TRAIT_V1_FIELDS, ...TRAIT_V2_FIELDS];

function validateFields(
  input: Record<string, unknown>,
  keys: readonly (keyof TraitContentV2)[],
): { patch: Partial<TraitContentV2>; error: string | null } {
  const patch: Partial<TraitContentV2> = {};
  for (const key of keys) {
    if (!(key in input)) continue;
    const value = FIELD_VALIDATORS[key](input[key]);
    if (value === undefined) return { patch: {}, error: `Invalid value for "${key}"` };
    (patch as Record<string, unknown>)[key] = value;
  }
  return { patch, error: null };
}

/**
 * Validates whatever trait fields — v1 or v2 — are present in `input` (an
 * owner PATCH may send just one or two). Unknown keys are ignored (that
 * includes `traits_version`, `source` and `confirmed`, which are never
 * patchable); a present-but-invalid value fails the whole call with a message
 * naming the field, so a bad value never gets silently dropped and the rest
 * silently written.
 */
export function validateTraitPatch(input: Record<string, unknown>): { patch: Partial<TraitContentV2>; error: string | null } {
  return validateFields(input, ALL_FIELDS);
}

/** Validates a FULL v1 trait row (every v1 field required; v2 keys are
 * ignored) — the pre-Coffey shape. Returns null on any missing or invalid
 * field. */
export function validateTraitContent(input: unknown): TraitContent | null {
  if (typeof input !== 'object' || input === null) return null;
  const { patch, error } = validateFields(input as Record<string, unknown>, TRAIT_V1_FIELDS);
  if (error) return null;
  for (const key of TRAIT_V1_FIELDS) if (!(key in patch)) return null;
  return patch as TraitContent;
}

/** Validates a FULL v1 + v2 trait row — every one of the 16 fields required.
 * Used for model output, where a partial row is as useless as a wrong one.
 * Returns null on any missing or invalid field. */
export function validateTraitContentV2(input: unknown): TraitContentV2 | null {
  if (typeof input !== 'object' || input === null) return null;
  const { patch, error } = validateFields(input as Record<string, unknown>, ALL_FIELDS);
  if (error) return null;
  for (const key of ALL_FIELDS) if (!(key in patch)) return null;
  return patch as TraitContentV2;
}

/**
 * Validates a batch of model-generated rows against the ids that were actually
 * sent in that batch. An id the model invents, or copies from a different
 * batch, is dropped rather than trusted (SUG-2's "never trust ids not in the
 * batch"); a duplicate id keeps its first valid occurrence.
 */
export function validateModelTraitRows(rows: unknown, allowedIds: ReadonlySet<string> | readonly string[]): ValidatedTraitRow[] {
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

/**
 * The Coffey v2 twin of validateModelTraitRows (COFFEY-SPEC §3.2): every v1
 * AND every v2 field is required, so a model answer that skipped a question is
 * dropped, not half-written. Same id rules — an id that was never in the batch
 * is dropped, a duplicate keeps its first valid occurrence.
 *
 * `traits_version` is optional on input; when present it must be an integer
 * ≥ 1 (a row with a junk one is dropped) and is carried through to the output.
 */
export function validateModelTraitRowsV2(rows: unknown, allowedIds: ReadonlySet<string> | readonly string[]): ValidatedTraitRowV2[] {
  const allowed = allowedIds instanceof Set ? allowedIds : new Set(allowedIds);
  if (!Array.isArray(rows)) return [];

  const seen = new Set<string>();
  const out: ValidatedTraitRowV2[] = [];
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const id = r.menu_item_id;
    if (typeof id !== 'string' || !allowed.has(id) || seen.has(id)) continue;
    const version = r.traits_version;
    if (version !== undefined && !(typeof version === 'number' && Number.isInteger(version) && version >= 1)) continue;
    const content = validateTraitContentV2(r);
    if (!content) continue;
    seen.add(id);
    out.push(version === undefined ? { menu_item_id: id, ...content } : { menu_item_id: id, ...content, traits_version: version });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derivations shared by the Jev tagger (server) and the owner Traits tab
// (client): keep `moods` consistent with `mood_fit` the same way in both.
// ---------------------------------------------------------------------------

/** `moods` from a graded fit (COFFEY-SPEC §3.2): the moods whose fit is ≥ 2,
 * best fit first (ties in MOODS order), at most three; if none reach 2, the
 * single best. A mood missing from `fit` counts as 0. */
export function moodsFromFit(fit: Partial<Record<Mood, number>>): Mood[] {
  // Array.prototype.sort is stable, so equal fits keep their MOODS order.
  const ranked = MOODS.map((mood) => ({ mood, fit: fit[mood] ?? 0 })).sort((a, b) => b.fit - a.fit);
  const strong = ranked.filter((r) => r.fit >= MOOD_FIT_THRESHOLD).slice(0, MAX_MOODS_PER_ITEM);
  return (strong.length > 0 ? strong : ranked.slice(0, 1)).map((r) => r.mood);
}

// ---------------------------------------------------------------------------
// Schema probes — "is the v2 migration applied yet?" (COFFEY-SPEC §3.3).
//
// PostgREST reports a missing column as Postgres 42703 ("column … does not
// exist") or, when its schema cache is stale or the column came in through the
// request body, PGRST204 / "…in the schema cache". A missing TABLE (the v1
// migration was never applied) is a different problem with a different fix, so
// it is told apart first.
// ---------------------------------------------------------------------------

export interface DbErrorLike {
  code?: string | null;
  message?: string | null;
}

export type TraitsSchemaProblem = 'missing_table' | 'missing_column' | 'other';

export function classifyTraitsSchemaError(error: DbErrorLike | null | undefined): TraitsSchemaProblem | null {
  if (!error) return null;
  const msg = (error.message ?? '').toLowerCase();
  if (
    error.code === '42P01' ||
    error.code === 'PGRST205' ||
    /could not find the table/.test(msg) ||
    /relation .* does not exist/.test(msg)
  ) {
    return 'missing_table';
  }
  if (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    msg.includes('schema cache') ||
    /column .* does not exist/.test(msg) ||
    /could not find the .* column/.test(msg)
  ) {
    return 'missing_column';
  }
  return 'other';
}

/** True when `error` means a v2 column isn't there yet — the migration is
 * pending. */
export function isMissingColumnError(error: DbErrorLike | null | undefined): boolean {
  return classifyTraitsSchemaError(error) === 'missing_column';
}

/** What the generate route answers 409 with before the migration is applied
 * (COFFEY-SPEC §3.3) — the owner PATCH has its own wording, "…then save again". */
export const TRAITS_V2_MIGRATION_HINT = 'Apply supabase/2026-10-coffey-traits-v2.sql in Supabase, then press Regenerate again.';
