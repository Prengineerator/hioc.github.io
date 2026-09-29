// Coffey v2 — the 0–10 sweetness scale (docs/COFFEY-SPEC.md §3.1, §4.1).
// Every reader of an item's sweetness goes through sweetnessLevel(), so a row
// tagged before the v2 migration (legacy 0–3 `sweetness` only) and a v2 row
// (`sweetness_level` 0–10) are compared on the same scale.
//
// Pure: no Supabase, no 'server-only'.

import { SWEETNESS_SCALE, type MenuItemTraits, type SweetnessPref } from './types';

function clampLevel(n: number): number {
  return Math.min(SWEETNESS_SCALE.max, Math.max(0, Math.round(n)));
}

/** The item's INHERENT sweetness on 0–10 — as the kitchen makes it, before any
 * optional table sugar. Falls back to the legacy 0–3 column (0→0, 1→3, 2→6, 3→9). */
export function sweetnessLevel(traits: Pick<MenuItemTraits, 'sweetness' | 'sweetness_level'>): number {
  if (typeof traits.sweetness_level === 'number' && Number.isFinite(traits.sweetness_level)) {
    return clampLevel(traits.sweetness_level);
  }
  return SWEETNESS_SCALE.legacyToLevel[traits.sweetness] ?? 0;
}

/** The legacy 0–3 value written alongside every v2 row, so older readers
 * (the taste profile's meanSweetness, the v1 owner column) keep working. */
export function legacySweetnessFromLevel(level: number): 0 | 1 | 2 | 3 {
  const l = clampLevel(level);
  if (l <= 1) return 0;
  if (l <= 4) return 1;
  if (l <= 7) return 2;
  return 3;
}

/** The customer's choice on the item scale, or null for 'any'. */
export function sweetnessTarget(pref: SweetnessPref): number | null {
  return pref === 'any' ? null : SWEETNESS_SCALE.targets[pref];
}
