// Coffey add-ons (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §2.3) — validation of the
// owner's override of ONE add-on option, for PATCH /api/owner/suggest/addon-traits.
// Every rule here MUST mirror the named CHECK constraints in
// supabase/2026-10-coffey-addons-pairings.sql exactly (change both together or
// neither; tests/suggestAddonTraitsValidate.test.ts reads the SQL file and pins
// each list and bound to the constants below). A browser is untrusted input.
//
// The body is the WHOLE override, not a partial edit: the route upserts every
// column, so a field left out would silently reset to a default. Unknown keys
// are rejected rather than ignored, so a typo can't be mistaken for a saved edit.
//
//   { optionId, role, flavour_families, sweetness_delta, intensity_delta,
//     indulgence_delta, textures }
//
// Pure: no Supabase, no 'server-only', so the owner Add-ons editor (a client
// component) reads the same bounds from here.

import { TEXTURES } from './traitVocabulary';
import { ADDON_ROLES, FLAVOUR_FAMILIES, type AddonRole, type AddonTraits, type FlavourFamily, type Texture } from './types';

/** addon_option_traits_flavour_families_check: at most two families. */
export const ADDON_FAMILIES_MAX = 2;
/** addon_option_traits_textures_check: at most two textures. */
export const ADDON_TEXTURES_MAX = 2;
/** addon_option_traits_sweetness_delta_check: 0–5 on the 0–10 item scale. */
export const ADDON_SWEETNESS_DELTA_MAX = 5;
/** addon_option_traits_intensity_delta_check: 0–2 (an espresso shot is 1). */
export const ADDON_INTENSITY_DELTA_MAX = 2;
/** addon_option_traits_indulgence_delta_check: 0–2. */
export const ADDON_INDULGENCE_DELTA_MAX = 2;

/** Every key a PATCH body may carry, in the order they are checked. */
export const ADDON_PATCH_KEYS = [
  'optionId',
  'role',
  'flavour_families',
  'sweetness_delta',
  'intensity_delta',
  'indulgence_delta',
  'textures',
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_SET: ReadonlySet<string> = new Set(ADDON_ROLES);

/** Is this an add-on option id (a UUID)? Shared with the DELETE route. */
export function isAddonOptionId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** An integer in [0, max]. `-0` (which JSON can carry) becomes 0. */
function deltaBetween0And(max: number, value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) return undefined;
  return value === 0 ? 0 : value;
}

/** A list of at most `max` DISTINCT members of `allowed`, in the order given;
 * undefined when it is not one. The length check comes first so an oversized
 * array is refused without being walked. */
function distinctSubset<T extends string>(value: unknown, allowed: readonly T[], max: number): T[] | undefined {
  if (!Array.isArray(value) || value.length > max) return undefined;
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.includes(entry as T) || seen.has(entry)) return undefined;
    seen.add(entry);
  }
  return [...(value as T[])];
}

/** An unknown key worth naming back to the owner: short and word-like. Anything
 * else is not echoed. */
function describeUnknownKey(key: string): string {
  return /^[\w.-]{1,40}$/.test(key) ? `Unknown field "${key}"` : 'Unknown field in request';
}

/**
 * Validates an owner PATCH for one add-on option. Returns the option id and the
 * traits to store, or a message fit to show the owner (never a stack trace or a
 * database error).
 *
 *  - `optionId` — a UUID.
 *  - `role` — one of ADDON_ROLES.
 *  - `flavour_families` — at most two distinct FLAVOUR_FAMILIES. Returned in
 *    FLAVOUR_FAMILIES order whatever order they arrived in, so the same set
 *    always stores the same way.
 *  - `sweetness_delta` — an integer 0–5; `intensity_delta` and
 *    `indulgence_delta` — integers 0–2.
 *  - `textures` — at most two distinct TEXTURES, in the order given (the same
 *    as the trait editor).
 *
 * Every field is required, a duplicate chip is refused (never quietly merged),
 * and a key outside the list above is refused.
 */
export function validateAddonTraitsPatch(body: unknown): { optionId: string; traits: AddonTraits } | string {
  if (!isPlainObject(body)) return 'Request body must be a JSON object';

  const allowed: ReadonlySet<string> = new Set(ADDON_PATCH_KEYS);
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) return describeUnknownKey(key);
  }
  for (const key of ADDON_PATCH_KEYS) {
    if (!(key in body)) return key === 'optionId' ? 'A valid option id is required' : `Missing value for "${key}"`;
  }

  if (!isAddonOptionId(body.optionId)) return 'A valid option id is required';

  const role = body.role;
  if (typeof role !== 'string' || !ROLE_SET.has(role)) return 'Invalid value for "role"';

  const families = distinctSubset<FlavourFamily>(body.flavour_families, FLAVOUR_FAMILIES, ADDON_FAMILIES_MAX);
  if (!families) return 'Invalid value for "flavour_families"';

  const sweetness = deltaBetween0And(ADDON_SWEETNESS_DELTA_MAX, body.sweetness_delta);
  if (sweetness === undefined) return 'Invalid value for "sweetness_delta"';

  const intensity = deltaBetween0And(ADDON_INTENSITY_DELTA_MAX, body.intensity_delta);
  if (intensity === undefined) return 'Invalid value for "intensity_delta"';

  const indulgence = deltaBetween0And(ADDON_INDULGENCE_DELTA_MAX, body.indulgence_delta);
  if (indulgence === undefined) return 'Invalid value for "indulgence_delta"';

  const textures = distinctSubset<Texture>(body.textures, TEXTURES, ADDON_TEXTURES_MAX);
  if (!textures) return 'Invalid value for "textures"';

  return {
    optionId: body.optionId,
    traits: {
      role: role as AddonRole,
      flavour_families: FLAVOUR_FAMILIES.filter((f) => families.includes(f)),
      sweetness_delta: sweetness,
      intensity_delta: intensity,
      indulgence_delta: indulgence,
      textures,
    },
  };
}
