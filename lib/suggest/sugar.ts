// Coffey v2 — sugar presets (docs/COFFEY-SPEC.md §4.7).
//
// Sugar is a CUSTOMISATION, not a fixed trait: the live menu's "Choice of
// Sugar" group (Stevia ₹10 / Brown Sugar / No Sugar / Normal, required) sits on
// every hot coffee bar two, every cold brew and most iced coffees, and on
// nothing else. So an item's sweetness is its INHERENT sweetness plus, where
// the group exists, an optional lift ("Normal" sugar adds SWEETNESS_SCALE.
// sugarAdds). "Not too sweet" must not hide a latte that can be made without
// sugar (§0), and a customer who chose a sweetness on the wizard gets the sugar
// option already set for them (§1 step 3).
//
// Pure: no Supabase, no 'server-only'. Everything here reads only the
// addon_groups already on the MenuItem rows the engine is handed.

import type { AddonGroup, AddonOption, MenuItem } from '@/lib/types';
import { sweetnessTarget } from './sweetness';
import { SWEETNESS_SCALE, type SugarPreset, type SweetnessPref } from './types';

/** A qualifying sugar group together with the two options the engine steers
 * between. */
export interface SugarGroupMatch {
  group: AddonGroup;
  noSugar: AddonOption;
  normal: AddonOption;
}

/** "No Sugar", "no  sugar " and "NO SUGAR" are the same option. */
function normalisedName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** An option the customer can actually pick right now (menu switches switch
 * options off with `is_available: false`; absent means on). */
function isOn(option: AddonOption): boolean {
  return option.is_available !== false;
}

/**
 * §4.7 — the item's sugar group: the addon group whose `name` is 'Sugar'
 * (case-insensitive) or whose `display_name` mentions sugar, AND which offers
 * both a "No Sugar" and a "Normal" option that are switched on. Anything less
 * (a syrup group, a group with only Stevia) is not a sugar choice we can steer.
 * The first qualifying group in menu order wins.
 */
export function findSugarGroup(item: Pick<MenuItem, 'addon_groups'>): SugarGroupMatch | null {
  for (const group of item.addon_groups ?? []) {
    const looksLikeSugar = normalisedName(group.name) === 'sugar' || /sugar/i.test(group.display_name ?? '');
    if (!looksLikeSugar) continue;

    const options = (group.options ?? []).filter(isOn);
    const noSugar = options.find((o) => normalisedName(o.name) === 'no sugar');
    const normal = options.find((o) => normalisedName(o.name) === 'normal');
    if (noSugar && normal) return { group, noSugar, normal };
  }
  return null;
}

/** The item offers a sugar choice, so its sweetness can be raised above its
 * inherent level (§4.2 `Candidate.sugarAdjustable`). */
export function isSugarAdjustable(item: Pick<MenuItem, 'addon_groups'>): boolean {
  return findSugarGroup(item) !== null;
}

/**
 * §4.2 — the sweetness the customer can actually get from this item: its
 * inherent level, or, when sugar is adjustable, the point of
 * `[base, min(10, base + sugarAdds)]` closest to what they asked for. Sugar can
 * be added, never taken out, so nothing here ever goes below `baseLevel`.
 */
export function achievableSweetness(baseLevel: number, adjustable: boolean, target: number): number {
  if (!adjustable) return baseLevel;
  const ceiling = Math.min(SWEETNESS_SCALE.max, baseLevel + SWEETNESS_SCALE.sugarAdds);
  return Math.min(ceiling, Math.max(baseLevel, target));
}

/**
 * §4.7 — the sugar option to preselect for a customer who chose `pref`.
 *
 * `null` for 'any' (they expressed no view) or when the item has no sugar
 * group. Otherwise it chooses between exactly two options: **No Sugar**, which
 * leaves the item at `baseLevel`, and **Normal**, which lifts it to
 * `min(10, baseLevel + sugarAdds)` — whichever ends closer to the target, with
 * a tie going to No Sugar (the customer can always add, so start light).
 *
 * It never picks Stevia (paid) or Brown Sugar (a flavour choice), and never an
 * unavailable option (findSugarGroup skips those). Should the kitchen ever
 * charge for No Sugar or Normal, that option is not auto-selected either: a
 * preset must never quietly add to the bill.
 */
export function sugarPresetFor(
  item: Pick<MenuItem, 'addon_groups'>,
  pref: SweetnessPref,
  baseLevel: number,
): SugarPreset | null {
  const target = sweetnessTarget(pref);
  if (target === null) return null;
  const match = findSugarGroup(item);
  if (!match) return null;

  const options: { option: AddonOption; achieves: number }[] = [
    { option: match.noSugar, achieves: baseLevel },
    { option: match.normal, achieves: Math.min(SWEETNESS_SCALE.max, baseLevel + SWEETNESS_SCALE.sugarAdds) },
  ];

  let best: { option: AddonOption; distance: number } | null = null;
  for (const { option, achieves } of options) {
    if (option.price_inr > 0) continue; // never auto-select a paid option
    const distance = Math.abs(achieves - target);
    // Strictly closer replaces; equal keeps the earlier one, i.e. No Sugar.
    if (!best || distance < best.distance) best = { option, distance };
  }
  if (!best) return null;

  return { groupId: match.group.id, optionId: best.option.id, label: best.option.name };
}
