// Pure copy and rules for Coffey's add-on flavour suggestion on /suggest
// (docs/COFFEY-ADDONS-PAIRINGS-SPEC.md §1.1). Kept out of the React files so the
// rules that matter (what the card says, when Add must open the modal, what the
// modal is told, and in what order the hints stack) can be unit-tested
// (tests/suggestAddonUi.test.ts).
//
// Tone (PHASE-7 spec §4): warm and brief. The card names the add-on but never its
// price, and nothing here pressures. The one hard rule is §4.7: a preset must
// never quietly add to the bill, so the suggested option is HIGHLIGHTED in the
// customise modal and never preselected — `customizeModalProps` keeps it out of
// `initialSelection` by construction.

import { suggestedOptionIds, vetPresets } from '@/lib/menu/customization';
import { isSoldByWeight } from '@/lib/menu/weight';
import { FLAVOUR_FAMILY_INFO } from '@/lib/suggest/traitVocabulary';
import type { AddonPreset, FlavourAddonSuggestion, SugarPreset, SuggestionPick } from '@/lib/suggest/types';
import type { MenuItem } from '@/lib/types';

/** The quiet line under a card's match tags. No price, by design. */
export function coffeyTip(addon: FlavourAddonSuggestion): string {
  return `Coffey tip: try it with ${addon.label}`;
}

/**
 * The customise-modal hint for a flavour add-on. The family is named by its chip
 * label (the words the customer tapped on step 2: "Nutty", "Warm spice",
 * "Caramel & toffee"), lower-cased to sit mid-sentence. `phrase` reads worse here
 * ("rich chocolate notes" + "notes" doubles up); `tag` is identical to `label`
 * for every family.
 */
export function flavourAddonHint(addon: FlavourAddonSuggestion): string {
  const family = FLAVOUR_FAMILY_INFO[addon.family].label.toLowerCase();
  return `For the ${family} notes you asked for, Coffey suggests ${addon.label} — tap it to add.`;
}

/** The existing sugar hint (COFFEY-SPEC §4.7), moved here unchanged. */
export function sugarPresetHint(preset: SugarPreset): string {
  return `Coffey set sugar to “${preset.label}” for you — change it anytime.`;
}

/**
 * Add on a pick opens the customise modal — never the one-tap path — when the
 * item needs a choice (several sizes, any add-on group, or how many grams of a
 * sold-by-weight item) OR the pick carries a flavour add-on (§1.1): the
 * customer has to be able to see and tap the suggestion, even on an item that
 * would otherwise be "simple".
 */
export function needsCustomizeModal(
  item: Pick<MenuItem, 'variants' | 'addon_groups' | 'sold_by_weight'>,
  pick: Pick<SuggestionPick, 'flavourAddon'> & Partial<Pick<SuggestionPick, 'addonPresets' | 'sugarPreset'>>,
): boolean {
  if (pick.flavourAddon) return true;
  // Coffey preselected something (a ticked add-on or the sugar option): the
  // customer must see the price before it goes in the cart, so never one tap.
  if (pick.addonPresets?.length || pick.sugarPreset) return true;
  if (isSoldByWeight(item)) return true;
  return !(item.variants.length === 1 && item.addon_groups.length === 0);
}

/** True when this preset is a free option: no price is written for it. */
const priceSuffix = (p: Pick<AddonPreset, 'priceInr'>) => (p.priceInr > 0 ? ` (+₹${p.priceInr})` : '');

/**
 * The sentence naming everything Coffey set, for the modal. `added` are the
 * add-ons that survived vetting, `sugar` the vetted sugar option (or null).
 */
export function presetsHint(added: AddonPreset[], sugar: SugarPreset | null): string {
  if (added.length === 0) return sugar ? sugarPresetHint(sugar) : '';
  const names = added.map((p) => `${p.label}${priceSuffix(p)}`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  if (sugar) {
    const comma = names.length > 1 ? ',' : '';
    return `Coffey added ${list}${comma} and set sugar to ${sugar.label}. Untick anything you don't want.`;
  }
  return names.length === 1
    ? `Coffey added ${list}. Untick it if you'd rather not.`
    : `Coffey added ${list}. Untick anything you don't want.`;
}

/** Why the ticked add-ons are on the card, in plain words (no talk of value). */
export function presetReasonLine(presets: AddonPreset[]): string {
  const sentences: string[] = [];
  const seen = new Set<string>();
  for (const p of presets) {
    if (p.purpose !== 'flavour') continue;
    const family = p.family ? FLAVOUR_FAMILY_INFO[p.family].label.toLowerCase() : null;
    const sentence = family ? `Added for the ${family} flavour.` : 'Added for the flavour you asked for.';
    if (!seen.has(sentence)) {
      seen.add(sentence);
      sentences.push(sentence);
    }
  }
  if (presets.some((p) => p.purpose === 'strength')) sentences.push('An extra shot makes it strong.');
  return sentences.join(' ');
}

/** What a pick looks like on the card, and what the customise screen gets. */
export interface PresetView {
  /** Add-on chips to draw (valid on the item), ticked or not. */
  chips: AddonPreset[];
  /** Add-ons that are ticked AND survive vetting: the ones that go in the cart. */
  ticked: AddonPreset[];
  /** The sugar chip to draw (null: none) and whether it is ticked. */
  sugar: SugarPreset | null;
  sugarTicked: boolean;
  tags: string[];
  reason: string;
  /** "Without Hazelnut syrup: not nutty", or null. */
  withoutLine: string | null;
}

const single = (p: { groupId: string; optionId: string }) => ({ [p.groupId]: [p.optionId] });

/**
 * The ONE derivation behind both the card and the customise screen
 * (`tickedPick` wraps it), so they can never disagree.
 *  - Presets the customise screen would drop (missing option, switched off, over
 *    a group's limit: `vetPresets`) are never shown as ticked; they count as
 *    un-ticked for tags, reason and the "Without…" line but get no chip.
 *  - Un-ticked or dropped add-ons remove their tag, revert the reason to
 *    `pick.plain.reason`, and add a "Without X: not Y" line.
 *  - When a flavour add-on is not in, the sugar option becomes
 *    `pick.plain.sugarPreset` (chosen for the item's own sweetness).
 *  - The customer's own un-tick of the sugar chip wins, keyed by the option id
 *    shown. `item` may be omitted (no vetting).
 */
export function presetView(
  item: Pick<MenuItem, 'addon_groups'> | undefined,
  pick: SuggestionPick,
  unticked: ReadonlySet<string>,
): PresetView {
  const all = pick.addonPresets ?? [];
  const valid = item ? all.filter((p) => Object.keys(vetPresets(item, single(p))).length > 0) : all;
  const wanted = valid.filter((p) => !unticked.has(p.optionId));
  const flavourOff = all.some((p) => p.purpose === 'flavour' && !wanted.includes(p));
  const candidate = flavourOff && pick.plain ? pick.plain.sugarPreset : (pick.sugarPreset ?? null);

  let ticked = wanted;
  let sugar = candidate;
  if (item) {
    const requested: Record<string, string[]> = {};
    const ask = (p: { groupId: string; optionId: string }) => {
      requested[p.groupId] = [...(requested[p.groupId] ?? []), p.optionId];
    };
    if (candidate) ask(candidate);
    wanted.forEach(ask);
    const vetted = vetPresets(item, requested);
    const has = (p: { groupId: string; optionId: string }) => vetted[p.groupId]?.includes(p.optionId) ?? false;
    ticked = wanted.filter(has);
    sugar = candidate && has(candidate) ? candidate : null;
  }
  const chips = valid.filter((p) => !wanted.includes(p) || ticked.includes(p));
  const off = all.filter((p) => !ticked.includes(p));
  const offTags = new Set(off.map((p) => p.tag).filter((t): t is string => !!t));
  const lines = off
    .filter((p) => p.tag)
    .map((p) => {
      const what =
        p.purpose === 'strength' ? 'strong' : p.family ? FLAVOUR_FAMILY_INFO[p.family].label.toLowerCase() : p.tag!.toLowerCase();
      return `Without ${p.label}: not ${what}`;
    });
  return {
    chips,
    ticked,
    sugar,
    sugarTicked: sugar !== null && !unticked.has(sugar.optionId),
    tags: (pick.matchTags ?? []).filter((t) => !offTags.has(t)),
    reason: off.length > 0 && pick.plain ? pick.plain.reason : pick.reason,
    withoutLine: lines.length > 0 ? lines.join(' · ') : null,
  };
}

/**
 * The pick as the customise screen should see it: exactly `presetView`'s
 * ticked add-ons and sugar. When the pick has add-on presets the older
 * `flavourAddon` is nulled (it is a fallback for picks without them).
 */
export function tickedPick(
  pick: SuggestionPick,
  unticked: ReadonlySet<string>,
  item?: Pick<MenuItem, 'addon_groups'>,
): SuggestionPick {
  const view = presetView(item, pick, unticked);
  const hasPresets = !!pick.addonPresets?.length;
  return {
    ...pick,
    addonPresets: hasPresets ? view.ticked : pick.addonPresets,
    sugarPreset: view.sugarTicked ? view.sugar : null,
    flavourAddon: hasPresets ? null : pick.flavourAddon,
    matchTags: pick.matchTags ? view.tags : pick.matchTags,
    reason: view.reason,
  };
}

export interface CustomizeModalProps {
  /** Preselected options: Coffey's ticked add-on presets and sugar option, vetted
   * against the item. The older `flavourAddon` highlight is never in here. */
  initialSelection?: Record<string, string[]>;
  /** Options to mark with a "Coffey's pick" pill and list in the strip: every
   * preselected option (add-ons and sugar), or
   * (older fallback) the highlighted flavour add-on, which is not chosen. */
  suggestedOptions?: Record<string, string[]>;
  /** Hint lines for the top of the modal, sugar first. */
  hint?: string[];
}

/**
 * What the wizard tells MenuItemCustomizeModal about a pick. The flavour hint is
 * only written when the suggestion is real on this item (its group and option
 * exist and the option is on), so the modal never says "tap it" about a row that
 * isn't there — the modal vets `suggestedOptions` the same way before drawing a
 * pill. Absent fields are omitted, so a pick with neither is exactly today's
 * "nothing extra".
 */
export function customizeModalProps(
  item: Pick<MenuItem, 'addon_groups'>,
  extras: {
    sugarPreset?: SugarPreset | null;
    flavourAddon?: FlavourAddonSuggestion | null;
    /** The TICKED add-on presets (the caller drops un-ticked ones). */
    addonPresets?: AddonPreset[];
  },
): CustomizeModalProps {
  const { sugarPreset, flavourAddon, addonPresets } = extras;
  const props: CustomizeModalProps = {};
  const hint: string[] = [];

  if (addonPresets && addonPresets.length > 0) {
    // New path: preselect through the same vetted initialSelection as sugar.
    // Sugar goes first so it wins a shared group's limited seats.
    const requested: Record<string, string[]> = {};
    const ask = (groupId: string, optionId: string) => {
      requested[groupId] = [...(requested[groupId] ?? []), optionId];
    };
    if (sugarPreset) ask(sugarPreset.groupId, sugarPreset.optionId);
    for (const p of addonPresets) ask(p.groupId, p.optionId);
    const vetted = vetPresets(item, requested);
    const has = (groupId: string, optionId: string) => vetted[groupId]?.includes(optionId) ?? false;
    const added = addonPresets.filter((p) => has(p.groupId, p.optionId));
    const sugar = sugarPreset && has(sugarPreset.groupId, sugarPreset.optionId) ? sugarPreset : null;
    if (Object.keys(vetted).length > 0) props.initialSelection = vetted;
    // Every option Coffey preselected, the sugar option too: the customise
    // screen's "Coffey set this up for you" strip and the "Coffey's pick" pills
    // are both drawn from this one map.
    if (added.length > 0 || sugar) {
      const suggested: Record<string, string[]> = {};
      if (sugar) suggested[sugar.groupId] = [sugar.optionId];
      for (const p of added) {
        suggested[p.groupId] = [...(suggested[p.groupId] ?? []), p.optionId];
      }
      props.suggestedOptions = suggested;
    }
    const line = presetsHint(added, sugar);
    if (line) props.hint = [line];
    return props;
  }

  if (sugarPreset) {
    props.initialSelection = { [sugarPreset.groupId]: [sugarPreset.optionId] };
    hint.push(sugarPresetHint(sugarPreset));
  }

  if (flavourAddon) {
    const suggestedOptions = { [flavourAddon.groupId]: [flavourAddon.optionId] };
    props.suggestedOptions = suggestedOptions;
    if (suggestedOptionIds(item, suggestedOptions).size > 0) hint.push(flavourAddonHint(flavourAddon));
  }

  if (hint.length > 0) props.hint = hint;
  return props;
}
