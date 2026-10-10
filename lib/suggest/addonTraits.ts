// Coffey add-ons — a small taste profile for every add-on option, and the
// "reach a flavour through an add-on" rule built on it
// (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §2).
//
// The live menu's flavour is often an add-on: "Add a Syrup" (Salted Caramel /
// Vanilla / Hazelnut / Caramel, ₹35) sits on 50 of 117 items, and a Cappucino
// has no nutty note of its own even though the kitchen will make it nutty for
// ₹35 (§0). An option only has a name and a price, so §2.2 DERIVES its profile
// (role, flavour families, sweetness / strength / indulgence lift, textures)
// from the group and option names, by an ordered rule table; the owner can
// override any option (addon_option_traits, §2.3), and resolveAddonTraits()
// puts the override first.
//
// §2.4 turns that into engine behaviour: reachableAddonFamilies() lists the
// flavours the customer asked for that an item lacks natively but can get from
// a reachable option (so the scorer can give it partial credit), and
// flavourAddonFor() names the single best option to point to. Sugar is NOT
// handled here — lib/suggest/sugar.ts matches that group by name — and milk,
// ice and sides never change what the item itself tastes of, so they are never
// reached for a flavour.
//
// Pure: no Supabase, no 'server-only'. Reads only the addon_groups already on
// the MenuItem rows the engine is handed, plus the optional override map.

import type { AddonGroup, AddonOption, MenuItem } from '@/lib/types';
import { flavourFamiliesOf } from './flavor';
import { sweetnessLevel, sweetnessTarget } from './sweetness';
import { FLAVOUR_FAMILY_INFO } from './traitVocabulary';
import {
  ADDON_SUGGEST_LIMITS,
  FLAVOUR_FAMILIES,
  FLAVOUR_REACH_ROLES,
  SWEETNESS_SCALE,
  type AddonRole,
  type AddonTraits,
  type FlavourAddonSuggestion,
  type FlavourFamily,
  type MenuItemTraits,
  type SuggestInputs,
  type Texture,
} from './types';

// ---------------------------------------------------------------------------
// §2.2 Derived defaults
// ---------------------------------------------------------------------------

/** What a rule needs to know: G is `group.name + ' ' + group.display_name`, O is
 * the option name (both trimmed; every pattern below is case-insensitive). */
interface RoleRule {
  when: (g: string, o: string) => boolean;
  role: AddonRole;
  sweetness: number;
  intensity: number;
  indulgence: number;
  textures?: (o: string) => Texture[];
}

/** The texture(s) a topping name implies (rule 9's note), at most TEXTURES_MAX. */
function toppingTextures(o: string): Texture[] {
  const out: Texture[] = [];
  const add = (t: Texture) => {
    if (!out.includes(t)) out.push(t);
  };
  if (/marshmallow/i.test(o)) add('soft');
  if (/chip/i.test(o)) add('crunchy');
  if (/nuts?:|almond|hazelnut/i.test(o)) add('crunchy');
  return out;
}

/** Rule 11's note: a fizzy upgrade. */
function serveTextures(o: string): Texture[] {
  return /sparkling|tonic|ginger ale|coke/i.test(o) ? ['fizzy'] : [];
}

/** §2.2, in order. The first rule whose `when` holds decides the role. */
const ROLE_RULES: readonly RoleRule[] = [
  { when: (g) => /sugar/i.test(g), role: 'sweetener', sweetness: 0, intensity: 0, indulgence: 0 },
  { when: (g) => /milk/i.test(g), role: 'milk', sweetness: 0, intensity: 0, indulgence: 0 },
  { when: (g) => /\bice\b/i.test(g) && !/ice ?cream/i.test(g), role: 'ice', sweetness: 0, intensity: 0, indulgence: 0 },
  { when: (_g, o) => /espresso shot|extra shot/i.test(o), role: 'shot', sweetness: 0, intensity: 1, indulgence: 0 },
  {
    when: (_g, o) => /whipped cream/i.test(o) && !/^no /i.test(o),
    role: 'topping',
    sweetness: 1,
    intensity: 0,
    indulgence: 1,
    textures: () => ['creamy'],
  },
  {
    when: (_g, o) => /ice ?cream/i.test(o),
    role: 'topping',
    sweetness: 2,
    intensity: 0,
    indulgence: 2,
    textures: () => ['creamy'],
  },
  { when: (g) => /syrup/i.test(g), role: 'flavour', sweetness: 2, intensity: 0, indulgence: 0 },
  { when: (_g, o) => /sauce/i.test(o), role: 'flavour', sweetness: 2, intensity: 0, indulgence: 1 },
  {
    when: (g) => /topping|extras|treat yourself|base- ?add on/i.test(g),
    role: 'topping',
    sweetness: 1,
    intensity: 0,
    indulgence: 1,
    textures: toppingTextures,
  },
  { when: (g) => /side|slider|croissant/i.test(g), role: 'side', sweetness: 0, intensity: 0, indulgence: 0 },
  {
    when: (g) => /brew|specialized/i.test(g),
    role: 'serve',
    sweetness: 0,
    intensity: 0,
    indulgence: 0,
    textures: serveTextures,
  },
  { when: (g) => /dip/i.test(g), role: 'topping', sweetness: 0, intensity: 0, indulgence: 0 },
];

/** Rule 13 — packaging, "No Whipped Cream", "Default". */
const OTHER_RULE: RoleRule = {
  when: () => true,
  role: 'other',
  sweetness: 0,
  intensity: 0,
  indulgence: 0,
};

/** These roles never carry a flavour family: they change how the item is made,
 * not what it tastes of. */
const FAMILYLESS_ROLES: readonly AddonRole[] = ['sweetener', 'milk', 'ice', 'other'];

/** AddonTraits.flavour_families and .textures are capped at this (§2.1). */
const FAMILIES_MAX = 2;
const TEXTURES_MAX = 2;

/**
 * §2.2 — the traits an add-on option gets with no owner override. The rules
 * run in order against G (group name + display name) and O (option name), and
 * the first one that matches decides the role and the three deltas.
 *
 * `flavour_families` reuses the item patterns (FLAVOUR_FAMILY_INFO.pattern) on
 * the option name, in FLAVOUR_FAMILIES order, at most two — "Hazelnut" is
 * nutty, "Nutella" is chocolatey + nutty, "Sparkling Water(peach)" is fruity —
 * except for a sweetener, milk, ice or other, which always get none. Vanilla
 * has no family, because vanilla is not one of the wizard's families.
 */
export function deriveAddonTraits(
  group: Pick<AddonGroup, 'name' | 'display_name'>,
  option: Pick<AddonOption, 'name'>,
): AddonTraits {
  const g = `${group.name ?? ''} ${group.display_name ?? ''}`.trim();
  const o = (option.name ?? '').trim();

  const rule = ROLE_RULES.find((r) => r.when(g, o)) ?? OTHER_RULE;
  const textures = (rule.textures?.(o) ?? []).slice(0, TEXTURES_MAX);
  const flavour_families: FlavourFamily[] = FAMILYLESS_ROLES.includes(rule.role)
    ? []
    : FLAVOUR_FAMILIES.filter((f) => FLAVOUR_FAMILY_INFO[f].pattern.test(o)).slice(0, FAMILIES_MAX);

  return {
    role: rule.role,
    flavour_families,
    sweetness_delta: rule.sweetness,
    intensity_delta: rule.intensity,
    indulgence_delta: rule.indulgence,
    textures,
  };
}

/** §2.3 — the owner's override for this option when there is one (keyed by
 * option id), otherwise the derived defaults. */
export function resolveAddonTraits(
  group: Pick<AddonGroup, 'name' | 'display_name'>,
  option: Pick<AddonOption, 'id' | 'name'>,
  overrides?: Map<string, AddonTraits>,
): AddonTraits {
  return overrides?.get(option.id) ?? deriveAddonTraits(group, option);
}

// ---------------------------------------------------------------------------
// §2.4 Label
// ---------------------------------------------------------------------------

/**
 * §2.4 — the customer-facing name of an option: `(new)` and `(newly launched)`
 * stripped (case-insensitive), whitespace collapsed, and, in a syrup group
 * whose option name lacks "syrup", " syrup" appended — so "Salted Caramel
 * (newly Launched)" in "Add a Syrup" reads "Salted Caramel syrup", and
 * "Chocolate Sauce" is unchanged.
 */
export function addonLabel(group: Pick<AddonGroup, 'name' | 'display_name'>, option: Pick<AddonOption, 'name'>): string {
  const raw = option.name ?? '';
  const stripped = raw
    .replace(/\(\s*(?:new|newly\s+launched)\s*\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const label = stripped || raw.trim();
  const g = `${group.name ?? ''} ${group.display_name ?? ''}`;
  return /syrup/i.test(g) && !/syrup/i.test(label) ? `${label} syrup` : label;
}

// ---------------------------------------------------------------------------
// §2.4 Flavour reach
// ---------------------------------------------------------------------------

/** A requested family an item lacks natively, and one option that provides it. */
interface Reach {
  family: FlavourFamily;
  /** The family's position in `inputs.flavours` (earlier is preferred). */
  familyIndex: number;
  /** Position of the option's role in FLAVOUR_REACH_ROLES (flavour < topping < serve). */
  roleIndex: number;
  group: AddonGroup;
  option: AddonOption;
  traits: AddonTraits;
}

/**
 * Every (requested family, option) pair the item can reach (§2.4). An option is
 * reachable when it belongs to any of the item's add-on groups (optional or
 * required), is switched on (`is_available !== false`), costs at most
 * ADDON_SUGGEST_LIMITS.maxPriceInr, has a role in FLAVOUR_REACH_ROLES and has a
 * flavour family. It counts for a family when the customer asked for it, the
 * item does not have it natively (flavourFamiliesOf), and — if the customer
 * set a sweetness — the item's own level plus the option's lift stays within
 * the sweetness tolerance of what they chose ("Not sweet + caramel" never
 * routes through a syrup that blows the ceiling). No requested flavours means
 * no reach at all.
 */
function reachesFor(
  item: Pick<MenuItem, 'name' | 'addon_groups'>,
  traits: Pick<MenuItemTraits, 'flavor_notes' | 'sweetness' | 'sweetness_level'>,
  inputs: Pick<SuggestInputs, 'flavours' | 'sweetness'>,
  overrides?: Map<string, AddonTraits>,
): Reach[] {
  const wanted = [...new Set(inputs.flavours)];
  if (wanted.length === 0) return [];

  const native = flavourFamiliesOf(item.name, traits.flavor_notes ?? []);
  const missing = wanted.filter((f) => !native.includes(f));
  if (missing.length === 0) return [];

  const baseLevel = sweetnessLevel(traits);
  const target = sweetnessTarget(inputs.sweetness);
  const ceiling = target === null ? Number.POSITIVE_INFINITY : target + SWEETNESS_SCALE.tolerance;
  const reachRoles: readonly AddonRole[] = FLAVOUR_REACH_ROLES;

  const out: Reach[] = [];
  for (const group of item.addon_groups ?? []) {
    for (const option of group.options ?? []) {
      if (option.is_available === false) continue;
      if (!(option.price_inr <= ADDON_SUGGEST_LIMITS.maxPriceInr)) continue;

      const optionTraits = resolveAddonTraits(group, option, overrides);
      const roleIndex = reachRoles.indexOf(optionTraits.role);
      if (roleIndex === -1) continue;
      if (baseLevel + optionTraits.sweetness_delta > ceiling) continue;

      for (const family of missing) {
        if (!optionTraits.flavour_families.includes(family)) continue;
        out.push({ family, familyIndex: wanted.indexOf(family), roleIndex, group, option, traits: optionTraits });
      }
    }
  }
  return out;
}

/**
 * §2.4 — the families the customer asked for that this item lacks natively but
 * can get from a reachable add-on option, in the order they were asked for.
 * `[]` when they asked for no flavours, the item already has them all, or
 * nothing it offers provides one (or provides it within the sweetness guard).
 */
export function reachableAddonFamilies(
  item: Pick<MenuItem, 'name' | 'addon_groups'>,
  traits: Pick<MenuItemTraits, 'flavor_notes' | 'sweetness' | 'sweetness_level'>,
  inputs: Pick<SuggestInputs, 'flavours' | 'sweetness'>,
  overrides?: Map<string, AddonTraits>,
): FlavourFamily[] {
  const reached = new Set(reachesFor(item, traits, inputs, overrides).map((r) => r.family));
  return [...new Set(inputs.flavours)].filter((f) => reached.has(f));
}

/** §2.4's tie-break chain, as a comparator over two reaches. */
function byPreference(a: Reach, b: Reach): number {
  return (
    a.familyIndex - b.familyIndex ||
    a.roleIndex - b.roleIndex ||
    a.traits.sweetness_delta - b.traits.sweetness_delta ||
    a.option.price_inr - b.option.price_inr ||
    a.group.sort_order - b.group.sort_order ||
    a.option.sort_order - b.option.sort_order ||
    (a.option.id < b.option.id ? -1 : a.option.id > b.option.id ? 1 : 0)
  );
}

/**
 * §2.4 — the one add-on to point to for a requested flavour the item lacks, or
 * null when `reachableAddonFamilies` is empty. Chosen by, in order: the
 * requested family's position in `inputs.flavours`; role (flavour, then
 * topping, then serve); the smaller `sweetness_delta`; the lower price; group
 * `sort_order`; option `sort_order`; option id. Never a switched-off option and
 * never one dearer than ADDON_SUGGEST_LIMITS.maxPriceInr.
 */
export function flavourAddonFor(
  item: Pick<MenuItem, 'name' | 'addon_groups'>,
  traits: Pick<MenuItemTraits, 'flavor_notes' | 'sweetness' | 'sweetness_level'>,
  inputs: Pick<SuggestInputs, 'flavours' | 'sweetness'>,
  overrides?: Map<string, AddonTraits>,
): FlavourAddonSuggestion | null {
  const best = reachesFor(item, traits, inputs, overrides).sort(byPreference)[0];
  if (!best) return null;
  return {
    groupId: best.group.id,
    optionId: best.option.id,
    label: addonLabel(best.group, best.option),
    priceInr: best.option.price_inr,
    family: best.family,
  };
}
