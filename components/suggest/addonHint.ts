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

import { suggestedOptionIds } from '@/lib/menu/customization';
import { FLAVOUR_FAMILY_INFO } from '@/lib/suggest/traitVocabulary';
import type { FlavourAddonSuggestion, SugarPreset, SuggestionPick } from '@/lib/suggest/types';
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
 * item needs a choice (several sizes or any add-on group) OR the pick carries a
 * flavour add-on (§1.1): the customer has to be able to see and tap the
 * suggestion, even on an item that would otherwise be "simple".
 */
export function needsCustomizeModal(
  item: Pick<MenuItem, 'variants' | 'addon_groups'>,
  pick: Pick<SuggestionPick, 'flavourAddon'>,
): boolean {
  if (pick.flavourAddon) return true;
  return !(item.variants.length === 1 && item.addon_groups.length === 0);
}

export interface CustomizeModalProps {
  /** Preselected options. Sugar only: the flavour add-on is never in here (§4.7). */
  initialSelection?: Record<string, string[]>;
  /** Options to highlight with a "Coffey's pick" pill. Nothing is chosen. */
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
  extras: { sugarPreset?: SugarPreset | null; flavourAddon?: FlavourAddonSuggestion | null },
): CustomizeModalProps {
  const { sugarPreset, flavourAddon } = extras;
  const props: CustomizeModalProps = {};
  const hint: string[] = [];

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
